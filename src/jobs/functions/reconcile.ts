import { inngest } from "@/jobs/client";
import { reconcileUndispatchedJobs } from "@/jobs/dispatch";
import { exportsBucket, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { readMany } from "@/lib/db/transactions/shared";
import { abandonedReservations, expireOverdueJobs } from "@/lib/db/transactions/jobs";
import { setPreparationStateForJob } from "@/lib/db/transactions/assistant";
import { reconcileJobUsage } from "@/lib/ai/usage";
import { deleteExpiredLookups } from "@/lib/stackexchange/client";
import type { ExportRow } from "@/lib/db/types";

/**
 * Closes the gap between a committed state change and a failed event delivery,
 * times out overdue jobs, and releases abandoned reservations. Runs on a schedule
 * rather than in a request.
 */
export const reconcileJobsFunction = inngest.createFunction(
  { id: "reconcile-pending-jobs", retries: 1, triggers: [{ cron: "*/2 * * * *" }] },
  async () => {
    const resent = await reconcileUndispatchedJobs();

    const timedOut = await expireOverdueJobs();
    for (const job of timedOut) {
      if (job.job_type === "prepare-reference" && job.problem_id) {
        await setPreparationStateForJob(job, "BLOCKED", "Solution preparation timed out. You can retry.");
      }
    }

    const abandoned = await abandonedReservations();
    for (const job of abandoned) await reconcileJobUsage(job.id, 0);

    return { resent, timedOut: timedOut.length, reservationsReleased: abandoned.length };
  },
);

/** Generated archives are deleted after their short lifetime. */
export const expireExportsFunction = inngest.createFunction(
  { id: "expire-exports", retries: 1, triggers: [{ cron: "17 * * * *" }] },
  async () => {
    const rows = await readMany<ExportRow>(
      col(COLLECTIONS.exports).where("state", "==", "READY").where("expires_at", "<", nowIso()).limit(100),
    );
    for (const row of rows) {
      if (row.object_path) await exportsBucket().file(row.object_path).delete({ ignoreNotFound: true }).catch(() => undefined);
      await col(COLLECTIONS.exports).doc(row.id).update({ state: "EXPIRED", object_path: null, updated_at: nowIso() });
    }

    // Cached third-party lookups age out on the same schedule.
    const lookups = await deleteExpiredLookups();

    return { expired: rows.length, lookupsDeleted: lookups };
  },
);
