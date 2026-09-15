import "server-only";
import { nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col, ids, newId, sha256 } from "@/lib/db/collections";
import { AppError } from "@/lib/errors";
import {
  getDoc,
  getMany,
  readProfileInTx,
  requireFolderInTx,
  requireNotesInTx,
  requireProblemInTx,
  runTransaction,
  type Tx,
} from "@/lib/db/transactions/shared";
import {
  activeJobsForProblemInTx,
  cancelJobsInTx,
  enqueueJobInTx,
  readJobByKeyInTx,
} from "@/lib/db/transactions/jobs";
import type {
  AssistantSessionRow,
  NotesRow,
  ProblemRow,
  ProblemStatus,
  ProblemVersionRow,
  ReferenceSolutionPrivateRow,
  StudyEventRow,
} from "@/lib/db/types";

/**
 * Compound atomic writes for study records: problem creation, note saves with
 * optimistic concurrency, immutable statement versions, and status transitions
 * with their milestone snapshot and completion jobs.
 */

export interface CreateProblemInput {
  userId: string;
  folderId: string;
  title: string;
  statement: string;
  sourceKind?: "user" | "mathnet" | "import";
  sourceMetadata?: Record<string, unknown>;
  importedMathnetId?: string | null;
  importedSourceId?: string | null;
}

/** Problem, first statement version, notes row, assistant session, created event. */
export function createProblemInTx(tx: Tx, input: CreateProblemInput): string {
  const problemId = newId();
  const now = nowIso();
  const version = input.statement.trim() ? 1 : 0;

  const problem: ProblemRow = {
    id: problemId,
    user_id: input.userId,
    folder_id: input.folderId,
    title: input.title.slice(0, 300),
    status: "not_started",
    current_statement_version: version,
    imported_mathnet_id: input.importedMathnetId ?? null,
    imported_source_id: input.importedSourceId ?? null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  tx.set(col(COLLECTIONS.problems).doc(problemId), problem);

  if (version === 1) {
    const versionRow: ProblemVersionRow = {
      id: ids.versionDoc(problemId, 1),
      user_id: input.userId,
      problem_id: problemId,
      version: 1,
      statement_markdown: input.statement,
      statement_hash: sha256(input.statement),
      source_kind: input.sourceKind ?? "user",
      source_metadata: input.sourceMetadata ?? {},
      created_at: now,
    };
    tx.set(col(COLLECTIONS.problemVersions).doc(versionRow.id), versionRow);
  }

  const notes: NotesRow = { problem_id: problemId, user_id: input.userId, markdown: "", revision: 0, saved_at: now };
  tx.set(col(COLLECTIONS.notes).doc(problemId), notes);

  const session: AssistantSessionRow = {
    problem_id: problemId,
    user_id: input.userId,
    enabled: false,
    activation_generation: 0,
    preparation_generation: 0,
    preparation_choice: null,
    preparation_state: "OFF",
    preparation_message: null,
    selected_reference_id: null,
    selected_reference_revision: null,
    statement_version: version,
    updated_at: now,
  };
  tx.set(col(COLLECTIONS.assistantSessions).doc(problemId), session);

  appendEventInTx(tx, {
    user_id: input.userId,
    problem_id: problemId,
    kind: "problem_created",
    from_status: null,
    to_status: "not_started",
    statement_version: version,
    notes_revision: null,
    notes_snapshot: null,
    detail: {},
  });

  return problemId;
}

export async function createProblem(input: CreateProblemInput): Promise<string> {
  return runTransaction(async (tx) => {
    await requireFolderInTx(tx, input.folderId, input.userId);
    return createProblemInTx(tx, input);
  });
}

export function appendEventInTx(tx: Tx, event: Omit<StudyEventRow, "id" | "created_at">): string {
  const id = newId();
  tx.set(col(COLLECTIONS.studyEvents).doc(id), { ...event, id, created_at: nowIso() } satisfies StudyEventRow);
  return id;
}

/** Optimistic concurrency on the notes revision; a mismatch keeps the caller's draft. */
export async function saveNotes(userId: string, problemId: string, expectedRevision: number, markdown: string): Promise<number> {
  return runTransaction(async (tx) => {
    await requireProblemInTx(tx, problemId, userId);
    const notes = await requireNotesInTx(tx, problemId, userId);
    if (notes.revision !== expectedRevision) {
      // Never silently replace another tab's changes.
      throw new AppError("NOTES_CONFLICT", String(notes.revision));
    }
    const revision = notes.revision + 1;
    tx.update(col(COLLECTIONS.notes).doc(problemId), { markdown, revision, saved_at: nowIso() });
    return revision;
  });
}

/**
 * A changed statement becomes a new immutable version and, in the same
 * transaction, supersedes references, cancels tutor work, and marks preparation
 * stale. An identical re-save changes nothing and invalidates nothing.
 */
export async function saveStatement(userId: string, problemId: string, expectedVersion: number, statement: string): Promise<number> {
  return runTransaction(async (tx) => {
    const problem = await requireProblemInTx(tx, problemId, userId);
    const current = problem.current_statement_version;
    if (current !== expectedVersion) throw new AppError("STATEMENT_CONFLICT", String(current));

    const hash = sha256(statement);
    const previous = current > 0 ? await getDoc<ProblemVersionRow>(tx, col(COLLECTIONS.problemVersions).doc(ids.versionDoc(problemId, current))) : null;
    if (previous && previous.statement_hash === hash) return current;

    const session = await getDoc<AssistantSessionRow>(tx, col(COLLECTIONS.assistantSessions).doc(problemId));
    const liveReferences = await getMany<ReferenceSolutionPrivateRow>(
      tx,
      col(COLLECTIONS.referenceSolutions).where("problem_id", "==", problemId).where("state", "in", ["PENDING", "CHECKING", "READY"]),
    );
    const activeJobs = await activeJobsForProblemInTx(tx, problemId, ["prepare-reference", "respond-to-question"]);

    const next = current + 1;
    const now = nowIso();
    const versionRow: ProblemVersionRow = {
      id: ids.versionDoc(problemId, next),
      user_id: userId,
      problem_id: problemId,
      version: next,
      statement_markdown: statement,
      statement_hash: hash,
      source_kind: "user",
      source_metadata: {},
      created_at: now,
    };
    tx.set(col(COLLECTIONS.problemVersions).doc(versionRow.id), versionRow);
    tx.update(col(COLLECTIONS.problems).doc(problemId), { current_statement_version: next, updated_at: now });

    // Suppress old output and invalidate the reference selection immediately.
    for (const reference of liveReferences) {
      tx.update(col(COLLECTIONS.referenceSolutions).doc(reference.id), { state: "SUPERSEDED", updated_at: now });
    }
    cancelJobsInTx(tx, activeJobs);
    if (session) {
      tx.update(col(COLLECTIONS.assistantSessions).doc(problemId), {
        statement_version: next,
        selected_reference_id: null,
        selected_reference_revision: null,
        preparation_state: session.enabled ? "STALE" : "OFF",
        preparation_message: session.enabled ? "The statement changed, so the saved reference no longer applies." : null,
        updated_at: now,
      });
    }
    appendEventInTx(tx, {
      user_id: userId,
      problem_id: problemId,
      kind: "statement_revised",
      from_status: null,
      to_status: null,
      statement_version: next,
      notes_revision: null,
      notes_snapshot: null,
      detail: {},
    });
    return next;
  });
}

export interface StatusChangeResult {
  changed: boolean;
  status: ProblemStatus;
  from_status?: ProblemStatus;
  statement_version: number;
  notes_revision: number;
  event_id?: string;
  classification_job_id?: string | null;
  recommendation_job_id?: string | null;
}

/**
 * Compares expected versions, snapshots the notes at completion, appends the
 * event, and writes the completion jobs — all in one transaction. A failed
 * recommendation job later never undoes the completion.
 */
export async function changeStatus(
  userId: string,
  problemId: string,
  toStatus: ProblemStatus,
  expectedStatementVersion: number | null,
  expectedNotesRevision: number | null,
): Promise<StatusChangeResult> {
  return runTransaction(async (tx) => {
    const problem = await requireProblemInTx(tx, problemId, userId);
    if (expectedStatementVersion !== null && problem.current_statement_version !== expectedStatementVersion) {
      throw new AppError("STATEMENT_CONFLICT", String(problem.current_statement_version));
    }
    const notes = await requireNotesInTx(tx, problemId, userId);
    if (expectedNotesRevision !== null && notes.revision !== expectedNotesRevision) {
      throw new AppError("NOTES_CONFLICT", String(notes.revision));
    }
    const profile = await readProfileInTx(tx, userId);
    const autoRecommend = profile?.automatic_recommendations ?? true;

    if (problem.status === toStatus) {
      // A repeated identical update creates no duplicate event.
      return { changed: false, status: problem.status, statement_version: problem.current_statement_version, notes_revision: notes.revision };
    }

    const eventId = newId();
    const completing = toStatus === "complete";
    const classifyKey = `classify:${problemId}:${eventId}`;
    const recommendKey = `recommend:${problemId}:${eventId}`;
    const existingClassify = completing && autoRecommend ? await readJobByKeyInTx(tx, userId, classifyKey) : null;
    const existingRecommend = completing && autoRecommend ? await readJobByKeyInTx(tx, userId, recommendKey) : null;

    const now = nowIso();
    tx.update(col(COLLECTIONS.problems).doc(problemId), {
      status: toStatus,
      completed_at: completing ? now : null,
      updated_at: now,
    });
    tx.set(col(COLLECTIONS.studyEvents).doc(eventId), {
      id: eventId,
      user_id: userId,
      problem_id: problemId,
      kind: "status_changed",
      from_status: problem.status,
      to_status: toStatus,
      statement_version: problem.current_statement_version,
      notes_revision: notes.revision,
      notes_snapshot: completing ? notes.markdown : null,
      detail: {},
      created_at: now,
    } satisfies StudyEventRow);

    let classificationJobId: string | null = null;
    let recommendationJobId: string | null = null;
    if (completing && autoRecommend) {
      classificationJobId = await enqueueJobInTx(tx, existingClassify, {
        userId,
        jobType: "classify-problem",
        problemId,
        input: { reason: "completion", event_id: eventId },
        idempotencyKey: classifyKey,
        statementVersion: problem.current_statement_version,
        notesRevision: notes.revision,
      });
      recommendationJobId = await enqueueJobInTx(tx, existingRecommend, {
        userId,
        jobType: "recommend-problems",
        problemId,
        input: { trigger: "completion", event_id: eventId, depends_on_job_id: classificationJobId },
        idempotencyKey: recommendKey,
        statementVersion: problem.current_statement_version,
        notesRevision: notes.revision,
      });
    }

    return {
      changed: true,
      status: toStatus,
      from_status: problem.status,
      statement_version: problem.current_statement_version,
      notes_revision: notes.revision,
      event_id: eventId,
      classification_job_id: classificationJobId,
      recommendation_job_id: recommendationJobId,
    };
  });
}

/** Title and folder edits; the folder must belong to the same account. */
export async function updateProblem(userId: string, problemId: string, patch: { title?: string; folderId?: string }): Promise<ProblemRow> {
  return runTransaction(async (tx) => {
    const problem = await requireProblemInTx(tx, problemId, userId);
    if (patch.folderId) await requireFolderInTx(tx, patch.folderId, userId);
    const update: Partial<ProblemRow> = { updated_at: nowIso() };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.folderId !== undefined) update.folder_id = patch.folderId;
    tx.update(col(COLLECTIONS.problems).doc(problemId), update);
    return { ...problem, ...update };
  });
}
