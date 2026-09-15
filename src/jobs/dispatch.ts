import "server-only";
import { createServiceClient } from "@/lib/db/service";
import { inngest, EVENT_NAME } from "@/jobs/client";
import type { JobRow, JobType } from "@/lib/db/types";

/**
 * Dispatch happens after the transaction that wrote the pending job record has
 * committed. If the send fails, the record simply stays PENDING and the scheduled
 * reconciliation function resends it: a successful save is never lost because an
 * event failed to deliver.
 */
export async function dispatchJob(job: { id: string; user_id: string; problem_id: string | null; job_type: JobType }) {
  const supabase = createServiceClient();
  try {
    await inngest.send({
      name: EVENT_NAME[job.job_type],
      data: { jobId: job.id, userId: job.user_id, problemId: job.problem_id ?? undefined },
      // Duplicate delivery of the same triggering action collapses to one run.
      id: `${job.job_type}:${job.id}`,
    });
    await supabase.rpc("mark_job_dispatched", { p_job_id: job.id });
    return { dispatched: true as const };
  } catch (error) {
    await supabase
      .from("jobs")
      .update({ dispatch_state: "FAILED_DISPATCH", error_detail: errorText(error) })
      .eq("id", job.id);
    console.warn("[jobs] dispatch failed, left for reconciliation", { jobId: job.id });
    return { dispatched: false as const };
  }
}

/** Loads the pending record by id and dispatches it. Used by route handlers. */
export async function dispatchJobById(jobId: string): Promise<void> {
  if (!jobId) return;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, user_id, problem_id, job_type, dispatch_state")
    .eq("id", jobId)
    .maybeSingle();
  if (!data || data.dispatch_state === "DISPATCHED") return;
  await dispatchJob(data as JobRow);
}

export async function reconcileUndispatchedJobs(olderThan = "30 seconds"): Promise<number> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("pending_jobs_for_reconciliation", { p_older_than: olderThan });
  if (error || !data) return 0;

  const rows = data as JobRow[];
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
