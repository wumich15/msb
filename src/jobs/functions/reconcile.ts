import { inngest } from "@/jobs/client";
import { reconcileUndispatchedJobs } from "@/jobs/dispatch";
import { createServiceClient } from "@/lib/db/service";
import { limits } from "@/lib/config";

/**
 * Closes the gap between a committed state change and a failed event delivery,
 * and clears expired export objects. Runs on a schedule rather than in a request.
 */
export const reconcileJobsFunction = inngest.createFunction(
  { id: "reconcile-pending-jobs", retries: 1, triggers: [{ cron: "*/2 * * * *" }] },
  async () => {
    const resent = await reconcileUndispatchedJobs();
    return { resent };
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
