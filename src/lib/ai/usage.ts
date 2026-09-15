import "server-only";
import { limits } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  reconcileJobUsage as reconcileJobUsageTx,
  recordAiUsage,
  reserveAiBudget,
  reserveAiBudgetForJob,
} from "@/lib/db/transactions/usage";

/**
 * Per-account budget. Reserved atomically before dispatch, reconciled against
 * actual usage afterwards, so an in-flight job cannot be double-spent by a second
 * request that starts before the first reports back.
 */

export async function reserveBudget(userId: string, estimatedTokens: number): Promise<void> {
  const verdict = await reserveAiBudget(userId, estimatedTokens, limits.dailyTokenLimit, limits.maxConcurrentAiJobs);
  if (!verdict.ok) throw new AppError("AI_LIMIT_REACHED", verdict.reason ?? "budget");
}

/** Reserves quota for a job already committed with an automatic state change. */
export async function reserveExistingJobBudget(jobId: string, estimatedTokens: number): Promise<boolean> {
  const verdict = await reserveAiBudgetForJob(jobId, estimatedTokens, limits.dailyTokenLimit, limits.maxConcurrentAiJobs);
  return verdict.ok;
}

/** Releases a reservation when a job is rejected before any provider call. */
export async function releaseBudgetReservation(userId: string, reservedTokens: number): Promise<void> {
  if (reservedTokens <= 0) return;
  await recordAiUsage(userId, reservedTokens, 0, 0);
}

/** Reconciles one durable job exactly once and marks its reservation closed. */
export async function reconcileJobUsage(jobId: string, actualTokens: number, actualMicroUsd = 0): Promise<void> {
  await reconcileJobUsageTx(jobId, actualTokens, actualMicroUsd);
}

/** Rough per-job reservations, refined by measurement rather than guessed again. */
export const TOKEN_ESTIMATES = {
  "prepare-reference": 40_000,
  "respond-to-question": 12_000,
  "classify-problem": 6_000,
  "recommend-problems": 10_000,
  "export-workspace": 0,
} as const;
