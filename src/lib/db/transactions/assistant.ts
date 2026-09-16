import "server-only";
import { nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col, ids, newId } from "@/lib/db/collections";
import { AppError, isErrorCode, type ErrorCode } from "@/lib/errors";
import {
  getDoc,
  getMany,
  requireNotesInTx,
  requireProblemInTx,
  requireSessionInTx,
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
  ChatMessageRow,
  ChatThreadRow,
  JobRow,
  PreparationChoice,
  PreparationState,
  ReferenceSolutionPrivateRow,
  TutorResponseMode,
} from "@/lib/db/types";

/**
 * The server-enforced readiness gate, preparation decisions, chat request
 * creation, and tutor publication. These are the code invariants behind "no
 * mathematical response before a complete, checked reference exists".
 */

// ---------------------------------------------------------------- the gate

export interface GateOptions {
  activationGeneration?: number | null;
  preparationGeneration?: number | null;
  referenceId?: string | null;
  referenceRevision?: number | null;
}

export type GateVerdict =
  | { ok: false; code: ErrorCode; reason: string }
  | {
      ok: true;
      reference_id: string;
      reference_revision: number;
      activation_generation: number;
      preparation_generation: number;
      statement_version: number;
      reference: ReferenceSolutionPrivateRow;
      session: AssistantSessionRow;
    };

/** The single place the gate conditions are written down. Read-only. */
export async function tutorGateInTx(tx: Tx, problemId: string, userId: string, options: GateOptions = {}): Promise<GateVerdict> {
  const problem = await getDoc<{ user_id: string; current_statement_version: number }>(tx, col(COLLECTIONS.problems).doc(problemId));
  // requester owns the problem
  if (!problem || problem.user_id !== userId) return { ok: false, code: "NOT_FOUND", reason: "problem" };

  const session = await getDoc<AssistantSessionRow>(tx, col(COLLECTIONS.assistantSessions).doc(problemId));
  if (!session || session.user_id !== userId) return { ok: false, code: "NOT_FOUND", reason: "session" };

  // assistant is enabled
  if (!session.enabled) return { ok: false, code: "SOLUTION_NOT_READY", reason: "assistant_off" };
  // this activation has an explicit completed preparation choice
  if (!session.preparation_choice) return { ok: false, code: "SOLUTION_NOT_READY", reason: "awaiting_choice" };
  if (!session.selected_reference_id) {
    return { ok: false, code: "SOLUTION_NOT_READY", reason: session.preparation_state.toLowerCase() };
  }

  // request generations match the live session
  if (options.activationGeneration != null && options.activationGeneration !== session.activation_generation) {
    return { ok: false, code: "STALE_REQUEST", reason: "activation_generation" };
  }
  if (options.preparationGeneration != null && options.preparationGeneration !== session.preparation_generation) {
    return { ok: false, code: "STALE_REQUEST", reason: "preparation_generation" };
  }
  if (
    options.referenceId != null &&
    (options.referenceId !== session.selected_reference_id ||
      (options.referenceRevision ?? -1) !== (session.selected_reference_revision ?? -1))
  ) {
    return { ok: false, code: "STALE_REQUEST", reason: "reference_superseded" };
  }

  const reference = await getDoc<ReferenceSolutionPrivateRow>(tx, col(COLLECTIONS.referenceSolutions).doc(session.selected_reference_id));
  if (!reference || reference.user_id !== userId) return { ok: false, code: "SOLUTION_NOT_READY", reason: "no_reference" };

  // reference is READY, unreported, and has a passing check
  if (reference.state !== "READY") return { ok: false, code: "SOLUTION_NOT_READY", reason: reference.state.toLowerCase() };
  if (reference.reported_at) return { ok: false, code: "SOLUTION_NOT_READY", reason: "reported" };
  if (reference.check_result?.passed !== true || !reference.artifact) {
    return { ok: false, code: "SOLUTION_NOT_READY", reason: "check_not_passed" };
  }
  if (reference.revision !== session.selected_reference_revision) {
    return { ok: false, code: "STALE_REQUEST", reason: "reference_revision" };
  }
  // the reference belongs to the statement the learner is looking at
  if (reference.statement_version !== problem.current_statement_version) {
    return { ok: false, code: "STALE_REQUEST", reason: "statement_version" };
  }
  if (
    reference.activation_generation !== session.activation_generation ||
    reference.preparation_generation !== session.preparation_generation
  ) {
    return { ok: false, code: "STALE_REQUEST", reason: "generation_mismatch" };
  }

  return {
    ok: true,
    reference_id: reference.id,
    reference_revision: reference.revision,
    activation_generation: session.activation_generation,
    preparation_generation: session.preparation_generation,
    statement_version: problem.current_statement_version,
    reference,
    session,
  };
}

export async function tutorGate(problemId: string, userId: string, options: GateOptions = {}): Promise<GateVerdict> {
  return runTransaction(async (tx) => tutorGateInTx(tx, problemId, userId, options));
}

/** Throws the gate's operational code; never mathematical content. */
export function assertGate(verdict: GateVerdict): asserts verdict is Extract<GateVerdict, { ok: true }> {
  if (!verdict.ok) throw new AppError(isErrorCode(verdict.code) ? verdict.code : "SOLUTION_NOT_READY", verdict.reason);
}

// ---------------------------------------------------- enable / disable

export interface AssistantToggleResult {
  enabled: boolean;
  activation_generation: number;
  preparation_generation: number;
  preparation_state: PreparationState;
  statement_version: number;
}

/** Off-to-on bumps the activation generation and asks again. No choice is carried over. */
export async function setAssistantEnabled(userId: string, problemId: string, enabled: boolean): Promise<AssistantToggleResult> {
  return runTransaction(async (tx) => {
    const problem = await requireProblemInTx(tx, problemId, userId);
    const session = await requireSessionInTx(tx, problemId, userId);
    const activeJobs = enabled ? [] : await activeJobsForProblemInTx(tx, problemId, ["prepare-reference", "respond-to-question"]);
    const pendingReferences = enabled
      ? []
      : await getMany<ReferenceSolutionPrivateRow>(
          tx,
          col(COLLECTIONS.referenceSolutions).where("problem_id", "==", problemId).where("state", "in", ["PENDING", "CHECKING"]),
        );
    const ref = col(COLLECTIONS.assistantSessions).doc(problemId);
    const now = nowIso();

    if (enabled && !session.enabled) {
      const patch = {
        enabled: true,
        activation_generation: session.activation_generation + 1,
        preparation_generation: session.preparation_generation + 1,
        preparation_choice: null,
        preparation_state: "AWAITING_SOLUTION" as PreparationState,
        preparation_message: null,
        selected_reference_id: null,
        selected_reference_revision: null,
        statement_version: problem.current_statement_version,
        updated_at: now,
      };
      tx.update(ref, patch);
      return {
        enabled: true,
        activation_generation: patch.activation_generation,
        preparation_generation: patch.preparation_generation,
        preparation_state: patch.preparation_state,
        statement_version: problem.current_statement_version,
      };
    }

    if (!enabled) {
      tx.update(ref, {
        enabled: false,
        preparation_state: "OFF",
        preparation_choice: null,
        preparation_message: null,
        selected_reference_id: null,
        selected_reference_revision: null,
        updated_at: now,
      });
      // Switching tutoring off cancels and suppresses tutor activity.
      cancelJobsInTx(tx, activeJobs);
      for (const reference of pendingReferences) {
        tx.update(col(COLLECTIONS.referenceSolutions).doc(reference.id), { state: "CANCELLED", updated_at: now });
      }
      return {
        enabled: false,
        activation_generation: session.activation_generation,
        preparation_generation: session.preparation_generation,
        preparation_state: "OFF",
        statement_version: problem.current_statement_version,
      };
    }

    return {
      enabled: session.enabled,
      activation_generation: session.activation_generation,
      preparation_generation: session.preparation_generation,
      preparation_state: session.preparation_state,
      statement_version: problem.current_statement_version,
    };
  });
}

// ------------------------------------------------- provide / find / reuse

export interface PreparationChoiceResult {
  activation_generation: number;
  preparation_generation: number;
  preparation_state: PreparationState;
  statement_version: number;
  reference_id: string | null;
  job_id: string | null;
}

/**
 * Records an explicit decision. Every provide/find/reuse/retry action replaces
 * the current preparation decision: the generation advances, the old selection is
 * cleared, and older preparation jobs can no longer select a reference.
 */
export async function setPreparationChoice(
  userId: string,
  problemId: string,
  choice: PreparationChoice,
  expectedStatementVersion: number | null,
  submittedText: string | null,
  researchRelated = false,
): Promise<PreparationChoiceResult> {
  return runTransaction(async (tx) => {
    const problem = await requireProblemInTx(tx, problemId, userId);
    const statementVersion = problem.current_statement_version;
    if (expectedStatementVersion !== null && statementVersion !== expectedStatementVersion) {
      throw new AppError("STATEMENT_CONFLICT", String(statementVersion));
    }
    const session = await requireSessionInTx(tx, problemId, userId);
    if (!session.enabled) throw new AppError("STALE_REQUEST", "assistant disabled");

    const activeJobs = await activeJobsForProblemInTx(tx, problemId, ["prepare-reference"]);
    const pending = await getMany<ReferenceSolutionPrivateRow>(
      tx,
      col(COLLECTIONS.referenceSolutions).where("problem_id", "==", problemId).where("state", "in", ["PENDING", "CHECKING"]),
    );
    const reusable =
      choice === "reuse"
        ? (
            await getMany<ReferenceSolutionPrivateRow>(
              tx,
              col(COLLECTIONS.referenceSolutions)
                .where("user_id", "==", userId)
                .where("problem_id", "==", problemId)
                .where("statement_version", "==", statementVersion)
                .where("state", "==", "READY")
                .orderBy("created_at", "desc")
                .limit(5),
            )
          ).find((row) => !row.reported_at) ?? null
        : null;
    if (choice === "reuse" && !reusable) throw new AppError("SOLUTION_NOT_READY", "no_reusable_reference");

    const activation = session.activation_generation;
    const preparation = session.preparation_generation + 1;
    const idempotencyKey = `prepare:${problemId}:${activation}:${preparation}`;
    const existingJob = choice === "reuse" ? null : await readJobByKeyInTx(tx, userId, idempotencyKey);

    const now = nowIso();
    const state: PreparationState = choice === "find" ? "SEARCHING_MSE" : "VALIDATING";
    tx.update(col(COLLECTIONS.assistantSessions).doc(problemId), {
      preparation_generation: preparation,
      preparation_choice: choice,
      preparation_state: state,
      preparation_message: null,
      selected_reference_id: null,
      selected_reference_revision: null,
      statement_version: statementVersion,
      updated_at: now,
    });
    cancelJobsInTx(tx, activeJobs);
    for (const reference of pending) {
      if (reference.preparation_generation < preparation) {
        tx.update(col(COLLECTIONS.referenceSolutions).doc(reference.id), { state: "SUPERSEDED", updated_at: now });
      }
    }

    let referenceId: string | null = null;
    if (choice === "provide") {
      // A pasted solution is stored immediately so the job payload carries only ids.
      referenceId = newId();
      tx.set(col(COLLECTIONS.referenceSolutions).doc(referenceId), referenceRow({
        id: referenceId,
        userId,
        problemId,
        statementVersion,
        activation,
        preparation,
        state: "PENDING",
        provenance: "user_supplied",
        submittedText,
        now,
      }));
    }

    if (choice === "reuse" && reusable) {
      // Reuse copies the still-valid checked reference forward under the new
      // generations, so the gate's equality checks stay exact.
      referenceId = newId();
      tx.set(col(COLLECTIONS.referenceSolutions).doc(referenceId), referenceRow({
        id: referenceId,
        userId,
        problemId,
        statementVersion,
        activation,
        preparation,
        state: "READY",
        provenance: reusable.provenance,
        submittedText: reusable.submitted_text,
        artifact: reusable.artifact,
        checkResult: reusable.check_result,
        sourceUrls: reusable.source_urls,
        attribution: reusable.attribution,
        modelVersions: reusable.model_versions,
        promptVersions: reusable.prompt_versions,
        now,
      }));
      tx.update(col(COLLECTIONS.assistantSessions).doc(problemId), {
        selected_reference_id: referenceId,
        selected_reference_revision: 1,
        preparation_state: "READY",
        updated_at: now,
      });
      return {
        activation_generation: activation,
        preparation_generation: preparation,
        preparation_state: "READY",
        statement_version: statementVersion,
        reference_id: referenceId,
        job_id: null,
      };
    }

    // The preparation job is bound to this exact generation.
    const jobId = await enqueueJobInTx(tx, existingJob, {
      userId,
      jobType: "prepare-reference",
      problemId,
      input: { choice, reference_id: referenceId, related_research: researchRelated },
      idempotencyKey,
      activationGeneration: activation,
      preparationGeneration: preparation,
      statementVersion,
      maxAttempts: 3,
      expiresInMs: 15 * 60 * 1000,
    });

    return {
      activation_generation: activation,
      preparation_generation: preparation,
      preparation_state: state,
      statement_version: statementVersion,
      reference_id: referenceId,
      job_id: jobId,
    };
  });
}

function referenceRow(input: {
  id: string;
  userId: string;
  problemId: string;
  statementVersion: number;
  activation: number;
  preparation: number;
  state: ReferenceSolutionPrivateRow["state"];
  provenance: ReferenceSolutionPrivateRow["provenance"];
  submittedText: string | null;
  artifact?: ReferenceSolutionPrivateRow["artifact"];
  checkResult?: ReferenceSolutionPrivateRow["check_result"];
  sourceUrls?: ReferenceSolutionPrivateRow["source_urls"];
  attribution?: Record<string, unknown>;
  modelVersions?: Record<string, string>;
  promptVersions?: Record<string, string>;
  now: string;
}): ReferenceSolutionPrivateRow {
  return {
    id: input.id,
    user_id: input.userId,
    problem_id: input.problemId,
    statement_version: input.statementVersion,
    revision: 1,
    activation_generation: input.activation,
    preparation_generation: input.preparation,
    state: input.state,
    provenance: input.provenance,
    submitted_text: input.submittedText,
    artifact: input.artifact ?? null,
    check_result: input.checkResult ?? null,
    source_urls: input.sourceUrls ?? [],
    attribution: input.attribution ?? {},
    model_versions: input.modelVersions ?? {},
    prompt_versions: input.promptVersions ?? {},
    reported_at: null,
    report_reason: null,
    created_at: input.now,
    updated_at: input.now,
  };
}

// -------------------------------------------------------- chat requests

export interface ChatRequestResult {
  duplicate: boolean;
  message_id: string;
  job_id: string | null;
  thread_id: string;
  sequence?: number;
  notes_revision?: number;
}

/**
 * Gate first, then snapshot the notes and enqueue the response, atomically. A
 * pre-ready request throws SOLUTION_NOT_READY and writes nothing; a duplicate
 * request id is a no-op rather than a second turn.
 */
export async function createChatRequest(input: {
  userId: string;
  problemId: string;
  requestId: string;
  question: string;
  expectedNotesRevision: number | null;
  selectedExcerpt: string | null;
  responseMode: TutorResponseMode;
  reservedTokens: number;
}): Promise<ChatRequestResult> {
  const { userId, problemId } = input;
  return runTransaction(async (tx) => {
    const messageId = ids.chatRequest(userId, problemId, input.requestId);
    const existingMessage = await getDoc<ChatMessageRow>(tx, col(COLLECTIONS.chatMessages).doc(messageId));
    const existingJob = await readJobByKeyInTx(tx, userId, `chat:${input.requestId}`);
    if (existingMessage) {
      return { duplicate: true, message_id: messageId, job_id: existingJob?.id ?? null, thread_id: existingMessage.thread_id };
    }

    const gate = await tutorGateInTx(tx, problemId, userId);
    assertGate(gate);

    const notes = await requireNotesInTx(tx, problemId, userId);
    if (input.expectedNotesRevision !== null && notes.revision !== input.expectedNotesRevision) {
      throw new AppError("NOTES_CONFLICT", String(notes.revision));
    }

    // One active tutor response per problem keeps conversation order stable.
    const active = await activeJobsForProblemInTx(tx, problemId, ["respond-to-question"]);
    if (active.length > 0) throw new AppError("RATE_LIMITED", "one_active_response");

    const threadId = ids.threadDoc(problemId, gate.statement_version);
    const thread = await getDoc<ChatThreadRow>(tx, col(COLLECTIONS.chatThreads).doc(threadId));
    const sequence = thread?.next_sequence ?? 1;
    const now = nowIso();

    if (thread) {
      tx.update(col(COLLECTIONS.chatThreads).doc(threadId), { next_sequence: sequence + 1, updated_at: now });
    } else {
      tx.set(col(COLLECTIONS.chatThreads).doc(threadId), {
        id: threadId,
        user_id: userId,
        problem_id: problemId,
        statement_version: gate.statement_version,
        next_sequence: sequence + 1,
        created_at: now,
        updated_at: now,
      } satisfies ChatThreadRow);
    }

    const message: ChatMessageRow = {
      id: messageId,
      user_id: userId,
      problem_id: problemId,
      thread_id: threadId,
      sequence,
      role: "user",
      content: input.question,
      request_id: input.requestId,
      notes_revision: notes.revision,
      // The immutable snapshot is copied in the same transaction as the check.
      notes_snapshot: notes.markdown,
      selected_excerpt: input.selectedExcerpt,
      statement_version: gate.statement_version,
      activation_generation: gate.activation_generation,
      preparation_generation: gate.preparation_generation,
      reference_id: gate.reference_id,
      reference_revision: gate.reference_revision,
      response_mode: input.responseMode,
      cited_note_excerpt: null,
      spoiler_level: null,
      is_operational: false,
      created_at: now,
    };
    tx.set(col(COLLECTIONS.chatMessages).doc(messageId), message);

    const jobId = await enqueueJobInTx(tx, existingJob, {
      userId,
      jobType: "respond-to-question",
      problemId,
      input: {
        message_id: messageId,
        thread_id: threadId,
        response_mode: input.responseMode,
        reference_id: gate.reference_id,
        reference_revision: gate.reference_revision,
      },
      idempotencyKey: `chat:${input.requestId}`,
      activationGeneration: gate.activation_generation,
      preparationGeneration: gate.preparation_generation,
      statementVersion: gate.statement_version,
      notesRevision: notes.revision,
      maxAttempts: 2,
      expiresInMs: 10 * 60 * 1000,
    });
    if (input.reservedTokens > 0 && !existingJob) {
      tx.update(col(COLLECTIONS.jobs).doc(jobId), { reserved_tokens: input.reservedTokens });
    }

    return { duplicate: false, message_id: messageId, job_id: jobId, thread_id: threadId, sequence, notes_revision: notes.revision };
  });
}

// ------------------------------------------------- worker-side selection

/**
 * A worker may mark a reference READY only for its own activation and
 * preparation generation. A late worker cannot restore READY after a newer
 * statement, activation, or preparation decision replaced it.
 */
export async function selectReference(
  referenceId: string,
  activationGeneration: number,
  preparationGeneration: number,
): Promise<{ ok: boolean; code?: string; reference_id?: string; reference_revision?: number }> {
  return runTransaction(async (tx) => {
    const ref = col(COLLECTIONS.referenceSolutions).doc(referenceId);
    const reference = await getDoc<ReferenceSolutionPrivateRow>(tx, ref);
    if (!reference) return { ok: false, code: "NOT_FOUND" };
    const session = await getDoc<AssistantSessionRow>(tx, col(COLLECTIONS.assistantSessions).doc(reference.problem_id));
    if (!session || session.user_id !== reference.user_id) return { ok: false, code: "NOT_FOUND" };
    const now = nowIso();

    if (
      !session.enabled ||
      session.activation_generation !== activationGeneration ||
      session.preparation_generation !== preparationGeneration ||
      session.statement_version !== reference.statement_version
    ) {
      tx.update(ref, { state: "SUPERSEDED", updated_at: now });
      return { ok: false, code: "STALE_REQUEST" };
    }
    if (reference.check_result?.passed !== true || !reference.artifact) {
      return { ok: false, code: "SOLUTION_NOT_READY" };
    }

    tx.update(ref, { state: "READY", updated_at: now });
    tx.update(col(COLLECTIONS.assistantSessions).doc(reference.problem_id), {
      selected_reference_id: reference.id,
      selected_reference_revision: reference.revision,
      preparation_state: "READY",
      preparation_message: null,
      updated_at: now,
    });
    return { ok: true, reference_id: reference.id, reference_revision: reference.revision };
  });
}

/** Conditional preparation-state write bound to the job's generations. */
export async function setPreparationStateForJob(
  job: Pick<JobRow, "user_id" | "problem_id" | "activation_generation" | "preparation_generation" | "statement_version">,
  state: PreparationState,
  message: string | null = null,
): Promise<boolean> {
  if (!job.problem_id) return false;
  const problemId = job.problem_id;
  return runTransaction(async (tx) => {
    const session = await getDoc<AssistantSessionRow>(tx, col(COLLECTIONS.assistantSessions).doc(problemId));
    if (
      !session ||
      session.user_id !== job.user_id ||
      session.activation_generation !== job.activation_generation ||
      session.preparation_generation !== job.preparation_generation ||
      session.statement_version !== job.statement_version
    ) {
      return false;
    }
    tx.update(col(COLLECTIONS.assistantSessions).doc(problemId), { preparation_state: state, preparation_message: message, updated_at: nowIso() });
    return true;
  });
}

/** Operational note about which path produced the reference; never its content. */
export async function setPreparationMessageForJob(
  job: Pick<JobRow, "user_id" | "problem_id" | "activation_generation" | "preparation_generation" | "statement_version">,
  message: string,
): Promise<void> {
  if (!job.problem_id) return;
  const problemId = job.problem_id;
  await runTransaction(async (tx) => {
    const session = await getDoc<AssistantSessionRow>(tx, col(COLLECTIONS.assistantSessions).doc(problemId));
    if (
      !session ||
      session.user_id !== job.user_id ||
      session.activation_generation !== job.activation_generation ||
      session.preparation_generation !== job.preparation_generation ||
      session.statement_version !== job.statement_version
    ) {
      return;
    }
    tx.update(col(COLLECTIONS.assistantSessions).doc(problemId), { preparation_message: message, updated_at: nowIso() });
  });
}

// ----------------------------------------------------------- publication

/** The final version-and-generation check plus the answer write, atomically. */
export async function publishTutorResponse(input: {
  jobId: string;
  content: string;
  responseMode: TutorResponseMode;
  citedNoteExcerpt: string | null;
  spoilerLevel: string | null;
}): Promise<{ ok: boolean; code?: string; reason?: string; message_id?: string }> {
  return runTransaction(async (tx) => {
    const jobRef = col(COLLECTIONS.jobs).doc(input.jobId);
    const job = await getDoc<JobRow>(tx, jobRef);
    if (!job || !job.problem_id) return { ok: false, code: "NOT_FOUND" };
    if (job.run_state === "CANCELLED") return { ok: false, code: "STALE_REQUEST", reason: "cancelled" };
    const now = nowIso();

    // Recheck eligibility at publication time, not only at request time.
    const gate = await tutorGateInTx(tx, job.problem_id, job.user_id, {
      activationGeneration: job.activation_generation,
      preparationGeneration: job.preparation_generation,
      referenceId: (job.input.reference_id as string) ?? null,
      referenceRevision: (job.input.reference_revision as number) ?? null,
    });
    if (!gate.ok) {
      tx.update(jobRef, { run_state: "CANCELLED", error_code: gate.code, finished_at: now, updated_at: now });
      return { ok: false, code: gate.code, reason: gate.reason };
    }
    if (job.statement_version !== gate.statement_version) {
      tx.update(jobRef, { run_state: "CANCELLED", error_code: "STALE_REQUEST", finished_at: now, updated_at: now });
      return { ok: false, code: "STALE_REQUEST", reason: "statement_version" };
    }

    const threadId = job.input.thread_id as string;
    const thread = await getDoc<ChatThreadRow>(tx, col(COLLECTIONS.chatThreads).doc(threadId));
    const messageId = ids.chatRequest(job.user_id, job.problem_id, `response:${input.jobId}`);
    const existing = await getDoc<ChatMessageRow>(tx, col(COLLECTIONS.chatMessages).doc(messageId));
    if (!existing) {
      const sequence = thread?.next_sequence ?? 1;
      tx.set(col(COLLECTIONS.chatThreads).doc(threadId), {
        id: threadId,
        user_id: job.user_id,
        problem_id: job.problem_id,
        statement_version: job.statement_version ?? gate.statement_version,
        next_sequence: sequence + 1,
        created_at: thread?.created_at ?? now,
        updated_at: now,
      } satisfies ChatThreadRow);
      tx.set(col(COLLECTIONS.chatMessages).doc(messageId), {
        id: messageId,
        user_id: job.user_id,
        problem_id: job.problem_id,
        thread_id: threadId,
        sequence,
        role: "assistant",
        content: input.content,
        request_id: `response:${input.jobId}`,
        notes_revision: job.notes_revision,
        notes_snapshot: null,
        selected_excerpt: null,
        statement_version: job.statement_version ?? gate.statement_version,
        activation_generation: job.activation_generation ?? gate.activation_generation,
        preparation_generation: job.preparation_generation ?? gate.preparation_generation,
        reference_id: gate.reference_id,
        reference_revision: gate.reference_revision,
        response_mode: input.responseMode,
        cited_note_excerpt: input.citedNoteExcerpt,
        spoiler_level: input.spoilerLevel,
        is_operational: false,
        created_at: now,
      } satisfies ChatMessageRow);
    }
    tx.update(jobRef, { run_state: "SUCCEEDED", finished_at: now, updated_at: now, result: { message_id: messageId } });
    return { ok: true, message_id: messageId };
  });
}

/** Setup prompts, status, and abstentions carry no mathematics and are marked as such. */
export async function publishOperationalMessage(input: {
  userId: string;
  problemId: string;
  jobId: string;
  threadId: string;
  text: string;
  statementVersion: number;
}): Promise<void> {
  await runTransaction(async (tx) => {
    const messageId = ids.chatRequest(input.userId, input.problemId, `operational:${input.jobId}`);
    const existing = await getDoc<ChatMessageRow>(tx, col(COLLECTIONS.chatMessages).doc(messageId));
    if (existing) return;
    const thread = await getDoc<ChatThreadRow>(tx, col(COLLECTIONS.chatThreads).doc(input.threadId));
    const sequence = thread?.next_sequence ?? 1;
    const now = nowIso();
    tx.set(col(COLLECTIONS.chatThreads).doc(input.threadId), {
      id: input.threadId,
      user_id: input.userId,
      problem_id: input.problemId,
      statement_version: input.statementVersion,
      next_sequence: sequence + 1,
      created_at: thread?.created_at ?? now,
      updated_at: now,
    } satisfies ChatThreadRow);
    tx.set(col(COLLECTIONS.chatMessages).doc(messageId), {
      id: messageId,
      user_id: input.userId,
      problem_id: input.problemId,
      thread_id: input.threadId,
      sequence,
      role: "assistant",
      content: input.text,
      request_id: `operational:${input.jobId}`,
      notes_revision: null,
      notes_snapshot: null,
      selected_excerpt: null,
      statement_version: input.statementVersion,
      activation_generation: 0,
      preparation_generation: 0,
      reference_id: null,
      reference_revision: null,
      response_mode: "operational",
      cited_note_excerpt: null,
      spoiler_level: null,
      is_operational: true,
      created_at: now,
    } satisfies ChatMessageRow);
  });
}

// ---------------------------------------------------------------- report

/** A reported reference becomes ineligible until rechecked; tutoring stops. */
export async function reportReference(userId: string, problemId: string, reason: string): Promise<void> {
  await runTransaction(async (tx) => {
    const session = await requireSessionInTx(tx, problemId, userId);
    if (!session.selected_reference_id) throw new AppError("NOT_FOUND");
    const reference = await getDoc<ReferenceSolutionPrivateRow>(tx, col(COLLECTIONS.referenceSolutions).doc(session.selected_reference_id));
    // Every READY copy for this statement version is retired too, so the same
    // solution cannot come back through "Use the saved reference".
    const readyCopies = await getMany<ReferenceSolutionPrivateRow>(
      tx,
      col(COLLECTIONS.referenceSolutions)
        .where("user_id", "==", userId)
        .where("problem_id", "==", problemId)
        .where("statement_version", "==", session.statement_version)
        .where("state", "==", "READY"),
    );
    const activeJobs = await activeJobsForProblemInTx(tx, problemId, ["respond-to-question"]);
    const now = nowIso();
    const reported = new Set<string>();
    if (reference && reference.user_id === userId) reported.add(reference.id);
    for (const copy of readyCopies) reported.add(copy.id);
    for (const id of reported) {
      tx.update(col(COLLECTIONS.referenceSolutions).doc(id), {
        state: "REPORTED",
        reported_at: now,
        report_reason: reason.slice(0, 2000),
        updated_at: now,
      });
    }
    tx.update(col(COLLECTIONS.assistantSessions).doc(problemId), {
      selected_reference_id: null,
      selected_reference_revision: null,
      preparation_choice: null,
      preparation_generation: session.preparation_generation + 1,
      preparation_state: "AWAITING_SOLUTION",
      preparation_message: "You reported an issue with the reference. Choose how to prepare a new one.",
      updated_at: now,
    });
    cancelJobsInTx(tx, activeJobs);
  });
}
