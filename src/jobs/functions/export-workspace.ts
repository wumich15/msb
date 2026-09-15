import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob } from "@/jobs/runtime";
import { exportsBucket, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { readOne } from "@/lib/db/transactions/shared";
import { accountStillExists } from "@/lib/auth/ownership";
import { readSnapshot } from "@/lib/export/snapshot";
import { buildArchive } from "@/lib/export/archive";
import { limits } from "@/lib/config";
import type { ExportRow } from "@/lib/db/types";

/**
 * Generates the export archive into the private bucket. The download itself is a
 * short-lived signed URL or a session-authorized stream issued by the status
 * route, never a public object.
 */
export const exportWorkspaceFunction = inngest.createFunction(
  { id: "export-workspace", retries: 2, triggers: [{ event: EVENT_NAME["export-workspace"] }] },
  async ({ event, step }) => {
    const { jobId, userId } = event.data as JobEventData;

    const job = await step.run("claim", () => claimJob(jobId));
    if (!job) return { skipped: true };

    if (!(await accountStillExists(userId))) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    const exportId = job.input.export_id as string;
    const exportRef = col(COLLECTIONS.exports).doc(exportId);
    const exportRow = await readOne<ExportRow>(exportRef);
    if (!exportRow || exportRow.user_id !== userId) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    await exportRef.update({ state: "RUNNING", updated_at: nowIso() });

    try {
      // Reference solutions are read only when the learner explicitly asked for them.
      const snapshot = await readSnapshot(userId, exportRow.scope, exportRow.scope_id, exportRow.include_references);

      const archive = await buildArchive({
        snapshot,
        scope: exportRow.scope,
        scopeId: exportRow.scope_id,
        includeReferences: exportRow.include_references,
        references: snapshot.references,
        revealedIdeaProblemIds: new Set(
          snapshot.problems
            .filter((problem) => (snapshot.events.get(problem.id) ?? []).some((entry) =>
              entry.kind === "reference_revealed" && entry.statement_version === problem.current_statement_version,
            ))
            .map((problem) => problem.id),
        ),
      });

      // Objects live under "exports/<user_id>/…"; only the worker writes them.
      const objectPath = `exports/${userId}/${exportId}.zip`;
      await exportsBucket().file(objectPath).save(Buffer.from(archive.bytes), {
        contentType: "application/zip",
        resumable: false,
        metadata: { cacheControl: "private, max-age=0, no-store" },
      });

      const expiresAt = new Date(Date.now() + limits.exportTtlHours * 60 * 60 * 1000).toISOString();
      await exportRef.update({
        state: "READY",
        object_path: objectPath,
        byte_size: archive.bytes.byteLength,
        expires_at: expiresAt,
        updated_at: nowIso(),
      });

      await finishJob(jobId, "SUCCEEDED", { result: { export_id: exportId, bytes: archive.bytes.byteLength } });
      return { exportId, bytes: archive.bytes.byteLength };
    } catch (error) {
      await exportRef.update({ state: "FAILED", error_code: "INTERNAL_ERROR", updated_at: nowIso() }).catch(() => undefined);
      await finishJob(jobId, "FAILED", {
        errorCode: "INTERNAL_ERROR",
        errorDetail: error instanceof Error ? error.message : "export failed",
      });
      return { failed: true };
    }
  },
);
