import { beforeAll, describe, expect, it } from "vitest";
import { EMULATOR_AVAILABLE, clearEmulator, freshUser } from "./helpers";

/**
 * Two accounts, one emulator. Every assertion here is about a code invariant the
 * specification calls non-negotiable: ownership isolation, optimistic concurrency,
 * immutable statement versions, single status events, and completion jobs.
 */
describe.skipIf(!EMULATOR_AVAILABLE)("study records (Firestore emulator)", () => {
  let core: typeof import("@/lib/db/transactions/core");
  let ownership: typeof import("@/lib/auth/ownership");
  let session: typeof import("@/lib/auth/session");
  let jobs: typeof import("@/lib/db/transactions/jobs");
  let cascade: typeof import("@/lib/db/transactions/cascade");
  let collections: typeof import("@/lib/db/collections");
  let admin: typeof import("@/lib/db/admin");

  const alice = freshUser();
  const bob = freshUser();

  beforeAll(async () => {
    await clearEmulator();
    core = await import("@/lib/db/transactions/core");
    ownership = await import("@/lib/auth/ownership");
    session = await import("@/lib/auth/session");
    jobs = await import("@/lib/db/transactions/jobs");
    cascade = await import("@/lib/db/transactions/cascade");
    collections = await import("@/lib/db/collections");
    admin = await import("@/lib/db/admin");
    await session.ensureProfile(alice, "alice@example.test");
    await session.ensureProfile(bob, "bob@example.test");
  });

  async function folderFor(userId: string): Promise<string> {
    const { COLLECTIONS, col, newId } = collections;
    const id = newId();
    const now = admin.nowIso();
    await col(COLLECTIONS.folders).doc(id).set({ id, user_id: userId, name: "Project", created_at: now, updated_at: now });
    return id;
  }

  it("creates a problem with its first version, notes row, session, and event", async () => {
    const folder = await folderFor(alice);
    const problemId = await core.createProblem({ userId: alice, folderId: folder, title: "Sum of squares", statement: "Prove $1+1=2$." });
    const problem = await ownership.requireOwnedProblem(problemId, alice);
    expect(problem.current_statement_version).toBe(1);
    expect(problem.status).toBe("not_started");

    const { COLLECTIONS, col, ids } = collections;
    expect((await col(COLLECTIONS.notes).doc(problemId).get()).data()).toMatchObject({ revision: 0, markdown: "" });
    expect((await col(COLLECTIONS.assistantSessions).doc(problemId).get()).data()).toMatchObject({ enabled: false, preparation_state: "OFF" });
    expect((await col(COLLECTIONS.problemVersions).doc(ids.versionDoc(problemId, 1)).get()).exists).toBe(true);
    const events = await col(COLLECTIONS.studyEvents).where("problem_id", "==", problemId).get();
    expect(events.docs.map((doc) => doc.get("kind"))).toEqual(["problem_created"]);
  });

  it("reports another account's problem and folder as absent, never as forbidden", async () => {
    const folder = await folderFor(alice);
    const problemId = await core.createProblem({ userId: alice, folderId: folder, title: "Private", statement: "x" });
    await expect(ownership.requireOwnedProblem(problemId, bob)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ownership.requireOwnedFolder(folder, bob)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(core.saveNotes(bob, problemId, 0, "stolen")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(core.createProblem({ userId: bob, folderId: folder, title: "Into Alice's folder", statement: "" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Alice's notes are untouched.
    expect((await collections.col(collections.COLLECTIONS.notes).doc(problemId).get()).get("markdown")).toBe("");
  });

  it("enforces optimistic concurrency on notes without losing either draft", async () => {
    const folder = await folderFor(alice);
    const problemId = await core.createProblem({ userId: alice, folderId: folder, title: "Notes", statement: "" });
    expect(await core.saveNotes(alice, problemId, 0, "first tab")).toBe(1);
    await expect(core.saveNotes(alice, problemId, 0, "second tab")).rejects.toMatchObject({ code: "NOTES_CONFLICT", detail: "1" });
    expect((await collections.col(collections.COLLECTIONS.notes).doc(problemId).get()).get("markdown")).toBe("first tab");
    expect(await core.saveNotes(alice, problemId, 1, "second tab, reconciled")).toBe(2);
  });

  it("treats an identical statement re-save as no new version", async () => {
    const folder = await folderFor(alice);
    const problemId = await core.createProblem({ userId: alice, folderId: folder, title: "Versions", statement: "Original" });
    expect(await core.saveStatement(alice, problemId, 1, "Original")).toBe(1);
    expect(await core.saveStatement(alice, problemId, 1, "Changed")).toBe(2);
    await expect(core.saveStatement(alice, problemId, 1, "Stale tab")).rejects.toMatchObject({ code: "STATEMENT_CONFLICT", detail: "2" });
    const v1 = await collections.col(collections.COLLECTIONS.problemVersions).doc(collections.ids.versionDoc(problemId, 1)).get();
    expect(v1.get("statement_markdown")).toBe("Original");
  });

  it("appends one event per real transition and enqueues completion jobs once", async () => {
    const folder = await folderFor(alice);
    const problemId = await core.createProblem({ userId: alice, folderId: folder, title: "Status", statement: "s" });
    await core.saveNotes(alice, problemId, 0, "my work");

    const first = await core.changeStatus(alice, problemId, "in_progress", 1, 1);
    expect(first.changed).toBe(true);
    const repeat = await core.changeStatus(alice, problemId, "in_progress", 1, 1);
    expect(repeat.changed).toBe(false);

    await expect(core.changeStatus(alice, problemId, "complete", 1, 0)).rejects.toMatchObject({ code: "NOTES_CONFLICT" });

    const done = await core.changeStatus(alice, problemId, "complete", 1, 1);
    expect(done.changed).toBe(true);
    expect(done.classification_job_id).toBeTruthy();
    expect(done.recommendation_job_id).toBeTruthy();

    const { COLLECTIONS, col } = collections;
    const events = await col(COLLECTIONS.studyEvents).where("problem_id", "==", problemId).get();
    const transitions = events.docs.filter((doc) => doc.get("kind") === "status_changed");
    expect(transitions).toHaveLength(2);
    const completion = transitions.find((doc) => doc.get("to_status") === "complete");
    expect(completion?.get("notes_snapshot")).toBe("my work");

    const job = await jobs.readJob(done.recommendation_job_id as string);
    expect(job).toMatchObject({ user_id: alice, run_state: "QUEUED", dispatch_state: "PENDING", job_type: "recommend-problems" });
    expect(job?.input.depends_on_job_id).toBe(done.classification_job_id);
  });

  it("deduplicates jobs by idempotency key and refuses to claim terminal jobs twice", async () => {
    const first = await jobs.enqueueJob({ userId: alice, jobType: "export-workspace", problemId: null, input: { export_id: "e1" }, idempotencyKey: "export:e1" });
    const second = await jobs.enqueueJob({ userId: alice, jobType: "export-workspace", problemId: null, input: { export_id: "e1" }, idempotencyKey: "export:e1" });
    expect(second).toBe(first);
    // The same key under another account is a different job.
    const bobs = await jobs.enqueueJob({ userId: bob, jobType: "export-workspace", problemId: null, input: { export_id: "e1" }, idempotencyKey: "export:e1" });
    expect(bobs).not.toBe(first);

    expect((await jobs.claimJob(first)).ok).toBe(true);
    await jobs.finishJob(first, "SUCCEEDED", { result: { done: true } });
    expect((await jobs.claimJob(first))).toMatchObject({ ok: false, code: "ALREADY_TERMINAL" });
    // A late worker cannot overwrite a cancellation.
    await jobs.finishJob(bobs, "CANCELLED", { errorCode: "STALE_REQUEST" });
    await jobs.finishJob(bobs, "SUCCEEDED");
    expect((await jobs.readJob(bobs))?.run_state).toBe("CANCELLED");
  });

  it("cascades a folder delete through problems and children, only for the owner", async () => {
    const folder = await folderFor(alice);
    const problemId = await core.createProblem({ userId: alice, folderId: folder, title: "Doomed", statement: "gone" });
    await core.saveNotes(alice, problemId, 0, "notes");
    await expect(cascade.deleteFolderCascade(folder, bob)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await cascade.deleteFolderCascade(alice, folder)).toBe(1);
    const { COLLECTIONS, col } = collections;
    expect((await col(COLLECTIONS.problems).doc(problemId).get()).exists).toBe(false);
    expect((await col(COLLECTIONS.notes).doc(problemId).get()).exists).toBe(false);
    expect((await col(COLLECTIONS.problemVersions).where("problem_id", "==", problemId).get()).empty).toBe(true);
    expect((await col(COLLECTIONS.studyEvents).where("problem_id", "==", problemId).get()).empty).toBe(true);
  });
});
