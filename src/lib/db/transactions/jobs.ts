import "server-only";
import { db, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col, ids } from "@/lib/db/collections";
import { getDoc, getMany, readMany, runTransaction, type Tx } from "@/lib/db/transactions/shared";
import type { JobRow, JobRunState, JobType } from "@/lib/db/types";

/**
 * Durable job records.
 *
 * A pending job is written in the same transaction as the state change that
 * triggers it; dispatch happens after commit, and a scheduled reconciliation pass
 * resends anything still PENDING. Delivery may happen more than once, so the job
 * id is derived from (owner, idempotency key) and every effect is guarded.
 */

export const ACTIVE_RUN_STATES: JobRunState[] = ["QUEUED", "RUNNING"];
export const TERMINAL_RUN_STATES: JobRunState[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"];
export const AI_JOB_TYPES: JobType[] = ["prepare-reference", "respond-to-question", "classify-problem", "recommend-problems"];

export interface EnqueueJobInput {
  userId: string;
  jobType: JobType;
  problemId: string | null;
  input: Record<string, unknown>;
  idempotencyKey: string;
  activationGeneration?: number | null;
  preparationGeneration?: number | null;
  statementVersion?: number | null;
  notesRevision?: number | null;
  maxAttempts?: number;
  expiresInMs?: number;
}

/**
 * Writes the pending record inside the caller's transaction. Because the id is
 * deterministic, a duplicate delivery of the same triggering action reuses the
 * existing job rather than creating a second one.
 */
export async function enqueueJobInTx(tx: Tx, existing: JobRow | null, input: EnqueueJobInput): Promise<string> {
  const jobId = ids.job(input.userId, input.idempotencyKey);
  const ref = col(COLLECTIONS.jobs).doc(jobId);
  const now = nowIso();
  if (existing) {
    tx.update(ref, { updated_at: now });
    return jobId;
  }
  const row: JobRow = {
    id: jobId,
    user_id: input.userId,
    job_type: input.jobType,
    problem_id: input.problemId,
    input: input.input,
    idempotency_key: input.idempotencyKey,
    dispatch_state: "PENDING",
    dispatched_at: null,
    run_state: "QUEUED",
    attempts: 0,
    max_attempts: input.maxAttempts ?? 3,
    stage: null,
    error_code: null,
    error_detail: null,
    result: null,
    activation_generation: input.activationGeneration ?? null,
    preparation_generation: input.preparationGeneration ?? null,
    statement_version: input.statementVersion ?? null,
    notes_revision: input.notesRevision ?? null,
    provider_request_ids: [],
    needs_billing_reconciliation: false,
    reserved_tokens: 0,
    usage_reconciled: false,
    expires_at: new Date(Date.now() + (input.expiresInMs ?? 60 * 60 * 1000)).toISOString(),
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
  };
  tx.set(ref, row);
  return jobId;
}

/** Reads the job that an idempotency key would map to, for the read phase of a transaction. */
export async function readJobByKeyInTx(tx: Tx, userId: string, idempotencyKey: string): Promise<JobRow | null> {
  return getDoc<JobRow>(tx, col(COLLECTIONS.jobs).doc(ids.job(userId, idempotencyKey)));
}

/** Standalone enqueue for routes that do not have a surrounding state change. */
export async function enqueueJob(input: EnqueueJobInput): Promise<string> {
  return runTransaction(async (tx) => {
    const existing = await readJobByKeyInTx(tx, input.userId, input.idempotencyKey);
    return enqueueJobInTx(tx, existing, input);
  });
}

/** Active jobs of the given types for a problem, read inside a transaction. */
export async function activeJobsForProblemInTx(tx: Tx, problemId: string, jobTypes: JobType[]): Promise<JobRow[]> {
  const rows = await getMany<JobRow>(
    tx,
    col(COLLECTIONS.jobs).where("problem_id", "==", problemId).where("run_state", "in", ACTIVE_RUN_STATES),
  );
  return rows.filter((row) => jobTypes.includes(row.job_type));
}

/** Cancels active jobs of the given types; the caller has already done its reads. */
export function cancelJobsInTx(tx: Tx, jobs: JobRow[], errorCode = "STALE_REQUEST"): void {
  const now = nowIso();
  for (const job of jobs) {
    tx.update(col(COLLECTIONS.jobs).doc(job.id), {
      run_state: "CANCELLED",
      error_code: errorCode,
      finished_at: now,
      updated_at: now,
    });
  }
}

export interface ClaimResult {
  ok: boolean;
  code?: string;
  job?: JobRow;
}

/** Marks a job RUNNING once per attempt; terminal, expired, or exhausted jobs are refused. */
export async function claimJob(jobId: string): Promise<ClaimResult> {
  return runTransaction(async (tx) => {
    const ref = col(COLLECTIONS.jobs).doc(jobId);
    const job = await getDoc<JobRow>(tx, ref);
    if (!job) return { ok: false, code: "NOT_FOUND" };
    const now = nowIso();
    if (TERMINAL_RUN_STATES.includes(job.run_state)) return { ok: false, code: "ALREADY_TERMINAL" };
    if (job.expires_at && job.expires_at < now) {
      tx.update(ref, { run_state: "TIMED_OUT", finished_at: now, error_code: "JOB_EXPIRED", updated_at: now });
      return { ok: false, code: "JOB_EXPIRED" };
    }
    if (job.attempts >= job.max_attempts) {
      tx.update(ref, { run_state: "FAILED", finished_at: now, error_code: "ATTEMPTS_EXHAUSTED", updated_at: now });
      return { ok: false, code: "ATTEMPTS_EXHAUSTED" };
    }
    const patch = {
      run_state: "RUNNING" as JobRunState,
      attempts: job.attempts + 1,
      started_at: job.started_at ?? now,
      dispatch_state: "DISPATCHED" as const,
      dispatched_at: job.dispatched_at ?? now,
      updated_at: now,
    };
    tx.update(ref, patch);
    return { ok: true, job: { ...job, ...patch } };
  });
}

export interface FinishOptions {
  errorCode?: string;
  errorDetail?: string;
  result?: Record<string, unknown>;
  providerRequestIds?: string[];
  needsBillingReconciliation?: boolean;
}

/** Records the terminal outcome. A late worker may not overwrite a cancellation. */
export async function finishJob(jobId: string, runState: JobRunState, options: FinishOptions = {}): Promise<void> {
  await runTransaction(async (tx) => {
    const ref = col(COLLECTIONS.jobs).doc(jobId);
    const job = await getDoc<JobRow>(tx, ref);
    if (!job || job.run_state === "CANCELLED") return;
    const now = nowIso();
    tx.update(ref, {
      run_state: runState,
      error_code: options.errorCode ?? null,
      error_detail: options.errorDetail?.slice(0, 500) ?? null,
      result: options.result ?? job.result ?? null,
      provider_request_ids: [...(job.provider_request_ids ?? []), ...(options.providerRequestIds ?? [])],
      needs_billing_reconciliation: Boolean(job.needs_billing_reconciliation || options.needsBillingReconciliation),
      finished_at: ACTIVE_RUN_STATES.includes(runState) ? null : now,
      updated_at: now,
    });
  });
}

export async function setJobStage(jobId: string, stage: string): Promise<void> {
  await col(COLLECTIONS.jobs).doc(jobId).update({ stage, updated_at: nowIso() });
}

export async function markJobDispatched(jobId: string): Promise<void> {
  await runTransaction(async (tx) => {
    const ref = col(COLLECTIONS.jobs).doc(jobId);
    const job = await getDoc<JobRow>(tx, ref);
    if (!job || job.dispatch_state === "DISPATCHED") return;
    tx.update(ref, { dispatch_state: "DISPATCHED", dispatched_at: nowIso(), updated_at: nowIso() });
  });
}

export async function markDispatchFailed(jobId: string, detail: string): Promise<void> {
  await col(COLLECTIONS.jobs)
    .doc(jobId)
    .update({ dispatch_state: "FAILED_DISPATCH", error_detail: detail.slice(0, 500), updated_at: nowIso() })
    .catch(() => undefined);
}

/** Jobs that committed but whose event delivery never confirmed. */
export async function pendingJobsForReconciliation(olderThanMs = 30_000): Promise<JobRow[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await readMany<JobRow>(
    col(COLLECTIONS.jobs)
      .where("run_state", "==", "QUEUED")
      .where("dispatch_state", "in", ["PENDING", "FAILED_DISPATCH"])
      .where("created_at", "<", cutoff)
      .orderBy("created_at", "asc")
      .limit(100),
  );
  const now = nowIso();
  return rows.filter((row) => !row.expires_at || row.expires_at > now);
}

export async function readJob(jobId: string): Promise<JobRow | null> {
  const snapshot = await col(COLLECTIONS.jobs).doc(jobId).get();
  return snapshot.exists ? ({ ...(snapshot.data() as JobRow), id: snapshot.id }) : null;
}

/** Cancels a job outside a transaction, for routes that could not attach a reservation. */
export async function cancelJob(jobId: string, errorCode: string): Promise<void> {
  await finishJob(jobId, "CANCELLED", { errorCode });
}

/** Active jobs for a problem, ordered newest first, for the editor payload. */
export async function activeJobsForProblem(userId: string, problemId: string): Promise<JobRow[]> {
  return readMany<JobRow>(
    col(COLLECTIONS.jobs)
      .where("problem_id", "==", problemId)
      .where("user_id", "==", userId)
      .where("run_state", "in", ACTIVE_RUN_STATES)
      .orderBy("created_at", "desc"),
  );
}

/** Expires overdue jobs and returns the rows it changed. */
export async function expireOverdueJobs(): Promise<JobRow[]> {
  const now = nowIso();
  const rows = await readMany<JobRow>(
    col(COLLECTIONS.jobs).where("run_state", "in", ACTIVE_RUN_STATES).where("expires_at", "<", now).limit(100),
  );
  const batch = db().batch();
  for (const row of rows) {
    batch.update(col(COLLECTIONS.jobs).doc(row.id), {
      run_state: "TIMED_OUT",
      error_code: "JOB_EXPIRED",
      finished_at: now,
      updated_at: now,
    });
  }
  if (rows.length) await batch.commit();
  return rows;
}

/** Terminal jobs whose reservation was never closed. */
export async function abandonedReservations(): Promise<JobRow[]> {
  return readMany<JobRow>(
    col(COLLECTIONS.jobs)
      .where("usage_reconciled", "==", false)
      .where("run_state", "in", TERMINAL_RUN_STATES)
      .where("reserved_tokens", ">", 0)
      .limit(100),
  );
}
