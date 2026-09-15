import { beforeAll, describe, expect, it } from "vitest";
import { EMULATOR_AVAILABLE, clearEmulator, freshUser } from "./helpers";
import type { CheckResult, ReferenceArtifact } from "@/lib/db/types";

const passingCheck: CheckResult = {
  passed: true,
  statement_match: true,
  logical_step_coverage: true,
  assumptions_and_cases: true,
  conclusion_answers_question: true,
  unresolved_gaps: [],
  counterexample_attempts: [],
  summary: "ok",
};

const artifact: ReferenceArtifact = {
  restated_problem: "p",
  assumptions: [],
  domain_restrictions: [],
  notation: [],
  steps: [{ claim: "c", justification: "j" }],
  boundary_cases: [],
  subparts: [],
  conclusion: "done",
  provenance_note: "test",
};

/**
 * The strict answer gate: no chat request, worker start, or publication passes
 * before a READY, checked, current-generation reference exists — and every
 * replacement decision invalidates what came before.
 */
describe.skipIf(!EMULATOR_AVAILABLE)("readiness gate (Firestore emulator)", () => {
  let core: typeof import("@/lib/db/transactions/core");
  let assistant: typeof import("@/lib/db/transactions/assistant");
  let store: typeof import("@/lib/ai/reference-store");
  let jobs: typeof import("@/lib/db/transactions/jobs");
  let session: typeof import("@/lib/auth/session");
  let collections: typeof import("@/lib/db/collections");
  let admin: typeof import("@/lib/db/admin");

  const alice = freshUser();
  const bob = freshUser();
  let folder: string;

  beforeAll(async () => {
    await clearEmulator();
    core = await import("@/lib/db/transactions/core");
    assistant = await import("@/lib/db/transactions/assistant");
    store = await import("@/lib/ai/reference-store");
    jobs = await import("@/lib/db/transactions/jobs");
    session = await import("@/lib/auth/session");
    collections = await import("@/lib/db/collections");
    admin = await import("@/lib/db/admin");
    await session.ensureProfile(alice, "alice@example.test");
    await session.ensureProfile(bob, "bob@example.test");
    const { COLLECTIONS, col, newId } = collections;
    folder = newId();
    const now = admin.nowIso();
    await col(COLLECTIONS.folders).doc(folder).set({ id: folder, user_id: alice, name: "P", created_at: now, updated_at: now });
  });

  async function problemWithStatement(): Promise<string> {
    return core.createProblem({ userId: alice, folderId: folder, title: "Gate", statement: "Prove something." });
  }

  const chat = (problemId: string, requestId: string, userId = alice) =>
    assistant.createChatRequest({
      userId,
      problemId,
      requestId,
      question: "Is my second line justified?",
      expectedNotesRevision: 0,
      selectedExcerpt: null,
      responseMode: "default",
      reservedTokens: 0,
    });

  it("rejects every pre-ready state with an operational code and writes nothing", async () => {
    const problemId = await problemWithStatement();
    expect(await assistant.tutorGate(problemId, alice)).toMatchObject({ ok: false, code: "SOLUTION_NOT_READY", reason: "assistant_off" });
    await expect(chat(problemId, "r1")).rejects.toMatchObject({ code: "SOLUTION_NOT_READY" });

    const enabled = await assistant.setAssistantEnabled(alice, problemId, true);
    expect(enabled).toMatchObject({ enabled: true, activation_generation: 1, preparation_state: "AWAITING_SOLUTION" });
    // No choice means no solution search and no answers.
    expect(await assistant.tutorGate(problemId, alice)).toMatchObject({ ok: false, reason: "awaiting_choice" });
    await expect(chat(problemId, "r2")).rejects.toMatchObject({ code: "SOLUTION_NOT_READY" });

    const choice = await assistant.setPreparationChoice(alice, problemId, "find", 1, null);
    expect(choice).toMatchObject({ preparation_state: "SEARCHING_MSE", preparation_generation: 2 });
    expect(choice.job_id).toBeTruthy();
    expect(await assistant.tutorGate(problemId, alice)).toMatchObject({ ok: false, reason: "searching_mse" });
    await expect(chat(problemId, "r3")).rejects.toMatchObject({ code: "SOLUTION_NOT_READY" });

    const { COLLECTIONS, col } = collections;
    expect((await col(COLLECTIONS.chatMessages).where("problem_id", "==", problemId).get()).empty).toBe(true);
    // Bob cannot even see the session.
    expect(await assistant.tutorGate(problemId, bob)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses to select a reference without a passing check or with stale generations", async () => {
    const problemId = await problemWithStatement();
    await assistant.setAssistantEnabled(alice, problemId, true);
    const choice = await assistant.setPreparationChoice(alice, problemId, "find", 1, null);

    const unchecked = await store.createReference({
      userId: alice,
      problemId,
      statementVersion: 1,
      activationGeneration: choice.activation_generation,
      preparationGeneration: choice.preparation_generation,
      provenance: "ai_generated",
      artifact,
      checkResult: { ...passingCheck, passed: false },
    });
    expect(await assistant.selectReference(unchecked.id, choice.activation_generation, choice.preparation_generation)).toMatchObject({ ok: false, code: "SOLUTION_NOT_READY" });

    const checked = await store.createReference({
      userId: alice,
      problemId,
      statementVersion: 1,
      activationGeneration: choice.activation_generation,
      preparationGeneration: choice.preparation_generation,
      provenance: "ai_generated",
      artifact,
      checkResult: passingCheck,
    });
    // A newer decision replaced this preparation before the worker finished.
    await assistant.setPreparationChoice(alice, problemId, "find", 1, null);
    expect(await assistant.selectReference(checked.id, choice.activation_generation, choice.preparation_generation)).toMatchObject({ ok: false, code: "STALE_REQUEST" });
    expect((await store.loadReferenceForWorker(checked.id, alice)).state).toBe("SUPERSEDED");
    expect(await assistant.tutorGate(problemId, alice)).toMatchObject({ ok: false, code: "SOLUTION_NOT_READY" });
  });

  it("passes only after selection, then invalidates on statement change, report, and disable", async () => {
    const problemId = await problemWithStatement();
    await assistant.setAssistantEnabled(alice, problemId, true);
    const choice = await assistant.setPreparationChoice(alice, problemId, "find", 1, null);
    const reference = await store.createReference({
      userId: alice,
      problemId,
      statementVersion: 1,
      activationGeneration: choice.activation_generation,
      preparationGeneration: choice.preparation_generation,
      provenance: "math_stack_exchange",
      artifact,
      checkResult: passingCheck,
    });
    expect(await assistant.selectReference(reference.id, choice.activation_generation, choice.preparation_generation)).toMatchObject({ ok: true });
    const verdict = await assistant.tutorGate(problemId, alice);
    expect(verdict).toMatchObject({ ok: true, reference_id: reference.id, statement_version: 1 });

    // A chat request now snapshots the notes and enqueues exactly one job.
    await core.saveNotes(alice, problemId, 0, "line 1\nline 2");
    await expect(chat(problemId, "req-a")).rejects.toMatchObject({ code: "NOTES_CONFLICT" });
    const created = await assistant.createChatRequest({
      userId: alice,
      problemId,
      requestId: "req-a",
      question: "Why?",
      expectedNotesRevision: 1,
      selectedExcerpt: "line 2",
      responseMode: "default",
      reservedTokens: 12,
    });
    expect(created.duplicate).toBe(false);
    expect(created.sequence).toBe(1);
    const duplicate = await assistant.createChatRequest({
      userId: alice,
      problemId,
      requestId: "req-a",
      question: "Why?",
      expectedNotesRevision: 1,
      selectedExcerpt: null,
      responseMode: "default",
      reservedTokens: 12,
    });
    expect(duplicate).toMatchObject({ duplicate: true, message_id: created.message_id, job_id: created.job_id });
    const { COLLECTIONS, col } = collections;
    const message = (await col(COLLECTIONS.chatMessages).doc(created.message_id).get()).data();
    expect(message).toMatchObject({ notes_revision: 1, notes_snapshot: "line 1\nline 2", reference_id: reference.id });
    expect((await jobs.readJob(created.job_id as string))?.reserved_tokens).toBe(12);

    // Publication rechecks the gate; here it still passes.
    const published = await assistant.publishTutorResponse({ jobId: created.job_id as string, content: "What justifies line 2?", responseMode: "default", citedNoteExcerpt: "line 2", spoilerLevel: "none" });
    expect(published.ok).toBe(true);

    // Editing the statement supersedes the reference and cancels tutor work at once.
    await core.saveStatement(alice, problemId, 1, "Prove something else.");
    expect(await assistant.tutorGate(problemId, alice)).toMatchObject({ ok: false });
    expect((await store.loadReferenceForWorker(reference.id, alice)).state).toBe("SUPERSEDED");
    const sessionDoc = (await col(COLLECTIONS.assistantSessions).doc(problemId).get()).data();
    expect(sessionDoc).toMatchObject({ preparation_state: "STALE", selected_reference_id: null, statement_version: 2 });

    // A late publication for the old job is refused.
    const late = await assistant.publishTutorResponse({ jobId: created.job_id as string, content: "late", responseMode: "default", citedNoteExcerpt: null, spoilerLevel: "none" });
    expect(late.ok).toBe(false);
  });

  it("reuse copies a still-valid checked reference forward and report invalidates it", async () => {
    const problemId = await problemWithStatement();
    await assistant.setAssistantEnabled(alice, problemId, true);
    const first = await assistant.setPreparationChoice(alice, problemId, "find", 1, null);
    const reference = await store.createReference({
      userId: alice,
      problemId,
      statementVersion: 1,
      activationGeneration: first.activation_generation,
      preparationGeneration: first.preparation_generation,
      provenance: "user_supplied",
      artifact,
      checkResult: passingCheck,
    });
    await assistant.selectReference(reference.id, first.activation_generation, first.preparation_generation);

    // Off then on: the prompt returns and nothing is carried over silently.
    await assistant.setAssistantEnabled(alice, problemId, false);
    expect(await assistant.tutorGate(problemId, alice)).toMatchObject({ ok: false, reason: "assistant_off" });
    const again = await assistant.setAssistantEnabled(alice, problemId, true);
    expect(again.activation_generation).toBe(2);
    expect(await store.reusableReferenceExists(alice, problemId, 1)).toBe(true);

    const reused = await assistant.setPreparationChoice(alice, problemId, "reuse", 1, null);
    expect(reused).toMatchObject({ preparation_state: "READY", job_id: null });
    const verdict = await assistant.tutorGate(problemId, alice);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.reference_id).not.toBe(reference.id);

    await assistant.reportReference(alice, problemId, "The conclusion is wrong.");
    expect(await assistant.tutorGate(problemId, alice)).toMatchObject({ ok: false, code: "SOLUTION_NOT_READY", reason: "awaiting_choice" });
    // A reported reference, and every READY copy of it, is no longer reusable.
    expect(await store.reusableReferenceExists(alice, problemId, 1)).toBe(false);
    await expect(assistant.setPreparationChoice(alice, problemId, "reuse", 1, null)).rejects.toMatchObject({ code: "SOLUTION_NOT_READY" });
  });

  it("reserves and reconciles budget exactly once per job", async () => {
    const usage = await import("@/lib/db/transactions/usage");
    const jobId = await jobs.enqueueJob({ userId: bob, jobType: "classify-problem", problemId: null, input: {}, idempotencyKey: "budget:1" });
    expect(await usage.reserveAiBudgetForJob(jobId, 6_000, 10_000, 2)).toMatchObject({ ok: true });
    expect(await usage.reserveAiBudgetForJob(jobId, 6_000, 10_000, 2)).toMatchObject({ ok: true, duplicate: true });
    expect(await usage.reserveAiBudget(bob, 6_000, 10_000, 2)).toMatchObject({ ok: false, code: "AI_LIMIT_REACHED", reason: "daily_tokens" });
    expect(await usage.reconcileJobUsage(jobId, 1_234)).toMatchObject({ ok: true });
    expect(await usage.reconcileJobUsage(jobId, 1_234)).toMatchObject({ ok: true, duplicate: true });
    const { COLLECTIONS, col, ids, utcDate } = collections;
    const row = (await col(COLLECTIONS.aiUsage).doc(ids.usage(bob, utcDate())).get()).data();
    expect(row).toMatchObject({ reserved_tokens: 0, actual_tokens: 1_234 });
  });
});
