import "server-only";
import { inngest, EVENT_NAME } from "@/jobs/client";
import {
  markDispatchFailed,
  markJobDispatched,
  pendingJobsForReconciliation,
  readJob,
} from "@/lib/db/transactions/jobs";
import type { JobType } from "@/lib/db/types";

/**
 * Dispatch happens after the transaction that wrote the pending job record has
 * committed. If the send fails, the record simply stays PENDING and the scheduled
 * reconciliation function resends it: a successful save is never lost because an
 * event failed to deliver.
 */
export async function dispatchJob(job: { id: string; user_id: string; problem_id: string | null; job_type: JobType }) {
  try {
    await inngest.send({
      name: EVENT_NAME[job.job_type],
      data: { jobId: job.id, userId: job.user_id, problemId: job.problem_id ?? undefined },
      // Duplicate delivery of the same triggering action collapses to one run.
      id: `${job.job_type}:${job.id}`,
    });
    await markJobDispatched(job.id);
    return { dispatched: true as const };
  } catch (error) {
    await markDispatchFailed(job.id, errorText(error));
    console.warn("[jobs] dispatch failed, left for reconciliation", { jobId: job.id });
    return { dispatched: false as const };
  }
}

/** Loads the pending record by id and dispatches it. Used by route handlers. */
export async function dispatchJobById(jobId: string): Promise<void> {
  if (!jobId) return;
  const job = await readJob(jobId);
  if (!job || job.dispatch_state === "DISPATCHED") return;
  await dispatchJob(job);
}

export async function reconcileUndispatchedJobs(olderThanMs = 30_000): Promise<number> {
  const rows = await pendingJobsForReconciliation(olderThanMs).catch(() => []);
  let resent = 0;
  for (const row of rows) {
    const result = await dispatchJob(row);
    if (result.dispatched) resent += 1;
  }
  return resent;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
