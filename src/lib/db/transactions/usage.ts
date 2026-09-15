import "server-only";
import { COLLECTIONS, col, ids, utcDate } from "@/lib/db/collections";
import { nowIso } from "@/lib/db/admin";
import { getDoc, getMany, runTransaction, type Tx } from "@/lib/db/transactions/shared";
import { ACTIVE_RUN_STATES, AI_JOB_TYPES } from "@/lib/db/transactions/jobs";
import type { AiUsageRow, JobRow } from "@/lib/db/types";

/**
 * Per-account AI budget. Reserved atomically before dispatch, reconciled
 * against actual usage afterwards, so an in-flight job cannot be double-spent by a
 * second request that starts before the first reports back.
 */

export interface BudgetVerdict {
  ok: boolean;
  code?: "AI_LIMIT_REACHED" | "NOT_FOUND" | "STALE_REQUEST";
  reason?: string;
  duplicate?: boolean;
}

async function readUsageInTx(tx: Tx, userId: string): Promise<{ row: AiUsageRow; id: string; exists: boolean }> {
  const id = ids.usage(userId, utcDate());
  const row = await getDoc<AiUsageRow>(tx, col(COLLECTIONS.aiUsage).doc(id));
  return {
    id,
    exists: Boolean(row),
    row: row ?? {
      user_id: userId,
      usage_date: utcDate(),
      reserved_tokens: 0,
      actual_tokens: 0,
      reserved_micro_usd: 0,
      actual_micro_usd: 0,
      job_count: 0,
    },
  };
}

async function activeAiJobCountInTx(tx: Tx, userId: string): Promise<number> {
  const rows = await getMany<JobRow>(
    tx,
    col(COLLECTIONS.jobs).where("user_id", "==", userId).where("run_state", "in", ACTIVE_RUN_STATES),
  );
  return rows.filter((row) => AI_JOB_TYPES.includes(row.job_type)).length;
}

function checkLimits(usage: AiUsageRow, active: number, tokens: number, dailyLimit: number, maxConcurrent: number): BudgetVerdict {
  if (active > maxConcurrent) return { ok: false, code: "AI_LIMIT_REACHED", reason: "concurrent_jobs" };
  if (Math.max(usage.reserved_tokens, usage.actual_tokens) + tokens > dailyLimit) {
    return { ok: false, code: "AI_LIMIT_REACHED", reason: "daily_tokens" };
  }
  return { ok: true };
}

/** Reserves budget for a job that has not been written yet. */
export async function reserveAiBudget(userId: string, tokens: number, dailyLimit: number, maxConcurrent: number): Promise<BudgetVerdict> {
  return runTransaction(async (tx) => {
    const usage = await readUsageInTx(tx, userId);
    const active = await activeAiJobCountInTx(tx, userId);
    // The new job is not yet counted, so ">" mirrors "would exceed after adding one".
    const verdict = checkLimits(usage.row, active, tokens, dailyLimit, maxConcurrent);
    if (!verdict.ok) return verdict;
    tx.set(col(COLLECTIONS.aiUsage).doc(usage.id), {
      ...usage.row,
      reserved_tokens: usage.row.reserved_tokens + tokens,
      job_count: usage.row.job_count + 1,
    });
    return { ok: true };
  });
}

/** Reserves against a job already committed with an automatic state change. */
export async function reserveAiBudgetForJob(jobId: string, tokens: number, dailyLimit: number, maxConcurrent: number): Promise<BudgetVerdict> {
  return runTransaction(async (tx) => {
    const jobRef = col(COLLECTIONS.jobs).doc(jobId);
    const job = await getDoc<JobRow>(tx, jobRef);
    if (!job) return { ok: false, code: "NOT_FOUND" };
    if (job.reserved_tokens > 0 || job.usage_reconciled) return { ok: true, duplicate: true };
    if (!ACTIVE_RUN_STATES.includes(job.run_state)) return { ok: false, code: "STALE_REQUEST" };
    const usage = await readUsageInTx(tx, job.user_id);
    const active = await activeAiJobCountInTx(tx, job.user_id);
    const verdict = checkLimits(usage.row, active, tokens, dailyLimit, maxConcurrent);
    if (!verdict.ok) return verdict;
    tx.set(col(COLLECTIONS.aiUsage).doc(usage.id), {
      ...usage.row,
      reserved_tokens: usage.row.reserved_tokens + tokens,
      job_count: usage.row.job_count + 1,
    });
    tx.update(jobRef, { reserved_tokens: tokens, updated_at: nowIso() });
    return { ok: true };
  });
}

/** Releases a reservation and records measured usage for a request-level reservation. */
export async function recordAiUsage(userId: string, reservedTokens: number, actualTokens: number, actualMicroUsd = 0): Promise<void> {
  await runTransaction(async (tx) => {
    const usage = await readUsageInTx(tx, userId);
    tx.set(col(COLLECTIONS.aiUsage).doc(usage.id), {
      ...usage.row,
      reserved_tokens: Math.max(0, usage.row.reserved_tokens - reservedTokens),
      actual_tokens: usage.row.actual_tokens + Math.max(0, actualTokens),
      actual_micro_usd: usage.row.actual_micro_usd + Math.max(0, actualMicroUsd),
    });
  });
}

/** Closes a durable job's reservation and records measured usage exactly once. */
export async function reconcileJobUsage(jobId: string, actualTokens: number, actualMicroUsd = 0): Promise<BudgetVerdict> {
  return runTransaction(async (tx) => {
    const jobRef = col(COLLECTIONS.jobs).doc(jobId);
    const job = await getDoc<JobRow>(tx, jobRef);
    if (!job) return { ok: false, code: "NOT_FOUND" };
    if (job.usage_reconciled) return { ok: true, duplicate: true };
    const usage = await readUsageInTx(tx, job.user_id);
    tx.set(col(COLLECTIONS.aiUsage).doc(usage.id), {
      ...usage.row,
      reserved_tokens: Math.max(0, usage.row.reserved_tokens - job.reserved_tokens),
      actual_tokens: usage.row.actual_tokens + Math.max(0, actualTokens),
      actual_micro_usd: usage.row.actual_micro_usd + Math.max(0, actualMicroUsd),
    });
    tx.update(jobRef, { usage_reconciled: true, updated_at: nowIso() });
    return { ok: true };
  });
}
