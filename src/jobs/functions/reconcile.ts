import { inngest } from "@/jobs/client";
import { reconcileUndispatchedJobs } from "@/jobs/dispatch";
import { createServiceClient } from "@/lib/db/service";
import { limits } from "@/lib/config";
import { reconcileJobUsage } from "@/lib/ai/usage";
import type { JobRow } from "@/lib/db/types";

/**
 * Closes the gap between a committed state change and a failed event delivery,
 * and clears expired export objects. Runs on a schedule rather than in a request.
 */
export const reconcileJobsFunction = inngest.createFunction(
  { id: "reconcile-pending-jobs", retries: 1, triggers: [{ cron: "*/2 * * * *" }] },
  async () => {
    const resent = await reconcileUndispatchedJobs();
    const supabase = createServiceClient();
    const now = new Date().toISOString();
    const { data: timedOut } = await supabase
      .from("jobs")
      .update({ run_state: "TIMED_OUT", error_code: "JOB_EXPIRED" })
      .in("run_state", ["QUEUED", "RUNNING"])
      .lt("expires_at", now)
      .select("*");
    for (const job of (timedOut ?? []) as JobRow[]) {
      if (job.job_type === "prepare-reference" && job.problem_id) {
        await supabase
          .from("assistant_sessions")
          .update({ preparation_state: "BLOCKED", preparation_message: "Solution preparation timed out. You can retry." })
          .eq("problem_id", job.problem_id)
          .eq("user_id", job.user_id)
          .eq("activation_generation", job.activation_generation)
          .eq("preparation_generation", job.preparation_generation)
          .eq("statement_version", job.statement_version);
      }
    }

    const { data: abandoned } = await supabase
      .from("jobs")
      .select("*")
      .gt("reserved_tokens", 0)
      .eq("usage_reconciled", false)
      .in("run_state", ["FAILED", "CANCELLED", "TIMED_OUT"])
      .limit(100);
    for (const job of (abandoned ?? []) as JobRow[]) {
      await reconcileJobUsage(job.id, job.user_id, job.reserved_tokens, 0);
    }

    return { resent, reservationsReleased: abandoned?.length ?? 0 };
  },
);

/** Generated archives are deleted after their short lifetime. */
export const expireExportsFunction = inngest.createFunction(
  { id: "expire-exports", retries: 1, triggers: [{ cron: "17 * * * *" }] },
  async () => {
    const supabase = createServiceClient();
    const cutoff = new Date(Date.now() - limits.exportTtlHours * 60 * 60 * 1000).toISOString();

    const { data } = await supabase
      .from("exports")
      .select("id, user_id, object_path")
      .eq("state", "READY")
      .lt("expires_at", new Date().toISOString())
      .limit(100);

    const rows = (data ?? []) as Array<{ id: string; object_path: string | null }>;
    for (const row of rows) {
      if (row.object_path) await supabase.storage.from("exports").remove([row.object_path]);
      await supabase.from("exports").update({ state: "EXPIRED", object_path: null }).eq("id", row.id);
    }

    // Cached third-party lookups age out on the same schedule.
    await supabase.from("mse_lookup_cache").delete().lt("expires_at", cutoff);

    return { expired: rows.length };
  },
);
