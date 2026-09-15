import "server-only";
import { createServiceClient } from "@/lib/db/service";
import { limits } from "@/lib/config";
import { AppError } from "@/lib/errors";

/**
 * Per-account budget. Reserved atomically before dispatch, reconciled against
 * actual usage afterwards, so an in-flight job cannot be double-spent by a second
 * request that starts before the first reports back.
 */

export async function reserveBudget(userId: string, estimatedTokens: number): Promise<void> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("reserve_ai_budget", {
    p_user_id: userId,
    p_tokens: estimatedTokens,
    p_daily_token_limit: limits.dailyTokenLimit,
    p_max_concurrent_jobs: limits.maxConcurrentAiJobs,
  });
  if (error) throw new AppError("INTERNAL_ERROR", error.message);

  const result = data as { ok: boolean; code?: string; reason?: string };
  if (!result?.ok) {
    throw new AppError("AI_LIMIT_REACHED", result?.reason ?? "budget");
  }
}

/** Reserves quota for a job already committed with an automatic state change. */
export async function reserveExistingJobBudget(jobId: string, estimatedTokens: number): Promise<boolean> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("reserve_ai_budget_for_job", {
    p_job_id: jobId,
    p_tokens: estimatedTokens,
    p_daily_token_limit: limits.dailyTokenLimit,
    p_max_concurrent_jobs: limits.maxConcurrentAiJobs,
  });
  if (error) throw new AppError("INTERNAL_ERROR", error.message);
  return Boolean((data as { ok?: boolean } | null)?.ok);
}

export async function reconcileUsage(
  userId: string,
  reservedTokens: number,
  actualTokens: number,
  actualMicroUsd = 0,
): Promise<void> {
  const supabase = createServiceClient();
  await supabase.rpc("record_ai_usage", {
    p_user_id: userId,
    p_reserved_tokens: reservedTokens,
    p_actual_tokens: actualTokens,
    p_actual_micro_usd: actualMicroUsd,
  });
}

/** Releases a reservation when a job is rejected before any provider call. */
export async function releaseBudgetReservation(userId: string, reservedTokens: number): Promise<void> {
  if (reservedTokens <= 0) return;
  await reconcileUsage(userId, reservedTokens, 0, 0);
}

/** Reconciles one durable job exactly once and marks its reservation closed. */
export async function reconcileJobUsage(
  jobId: string,
  _userId: string,
  _reservedTokens: number,
  actualTokens: number,
  actualMicroUsd = 0,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("reconcile_job_usage", {
    p_job_id: jobId,
    p_actual_tokens: actualTokens,
    p_actual_micro_usd: actualMicroUsd,
  });
  if (error) throw new AppError("INTERNAL_ERROR", error.message);
}

/** Rough per-job reservations, refined by measurement rather than guessed again. */
export const TOKEN_ESTIMATES = {
  "prepare-reference": 40_000,
  "respond-to-question": 12_000,
  "classify-problem": 6_000,
  "recommend-problems": 10_000,
  "export-workspace": 0,
} as const;
