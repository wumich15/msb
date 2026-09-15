import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob } from "@/jobs/runtime";
import { createServiceClient } from "@/lib/db/service";
import { accountStillExists } from "@/lib/auth/ownership";
import { readSnapshot } from "@/lib/export/snapshot";
import { buildArchive } from "@/lib/export/archive";
import { limits } from "@/lib/config";
import type { ExportRow, ReferenceSolutionPrivateRow } from "@/lib/db/types";

/**
 * Generates the export archive into a private bucket. The download itself is a
 * short-lived signed URL issued by the status route, never a public object.
 */
export const exportWorkspaceFunction = inngest.createFunction(
  { id: "export-workspace", retries: 2, triggers: [{ event: EVENT_NAME["export-workspace"] }] },
  async ({ event, step }) => {
    const { jobId, userId } = event.data as JobEventData;

    const job = await step.run("claim", () => claimJob(jobId));
    if (!job) return { skipped: true };

    const supabase = createServiceClient();
    if (!(await accountStillExists(supabase, userId))) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    const exportId = job.input.export_id as string;
    const { data: exportRowData } = await supabase
      .from("exports")
      .select("*")
      .eq("id", exportId)
      .eq("user_id", userId)
      .maybeSingle();

    const exportRow = exportRowData as ExportRow | null;
    if (!exportRow) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    await supabase.from("exports").update({ state: "RUNNING" }).eq("id", exportId);

    try {
      const snapshot = await readSnapshot(supabase, userId, exportRow.scope, exportRow.scope_id);

      // Reference solutions are read only when the learner explicitly asked for them.
      const references = new Map<string, ReferenceSolutionPrivateRow[]>();
      if (exportRow.include_references && snapshot.problems.length > 0) {
        const { data } = await supabase
          .from("reference_solutions")
          .select("*")
          .eq("user_id", userId)
          .in("problem_id", snapshot.problems.map((problem) => problem.id))
          .in("state", ["READY", "REPORTED"]);
        for (const row of (data ?? []) as ReferenceSolutionPrivateRow[]) {
          const list = references.get(row.problem_id) ?? [];
          list.push(row);
          references.set(row.problem_id, list);
        }
      }

      const archive = await buildArchive({
        snapshot,
        scope: exportRow.scope,
        scopeId: exportRow.scope_id,
        includeReferences: exportRow.include_references,
        references,
        revealedIdeaProblemIds: new Set(
          snapshot.problems
            .filter((problem) => (snapshot.events.get(problem.id) ?? []).some((event) =>
              event.kind === "reference_revealed" && event.statement_version === problem.current_statement_version,
            ))
            .map((problem) => problem.id),
        ),
      });

      // Objects live under "<user_id>/…", which the storage policy keys on.
      const objectPath = `${userId}/${exportId}.zip`;
      const { error: uploadError } = await supabase.storage
        .from("exports")
        .upload(objectPath, archive.bytes, { contentType: "application/zip", upsert: true });

      if (uploadError) throw new Error(uploadError.message);

      const expiresAt = new Date(Date.now() + limits.exportTtlHours * 60 * 60 * 1000).toISOString();
      await supabase
        .from("exports")
        .update({
          state: "READY",
          object_path: objectPath,
          byte_size: archive.bytes.byteLength,
          expires_at: expiresAt,
        })
        .eq("id", exportId);

      await finishJob(jobId, "SUCCEEDED", { result: { export_id: exportId, bytes: archive.bytes.byteLength } });
      return { exportId, bytes: archive.bytes.byteLength };
    } catch (error) {
      await supabase
        .from("exports")
        .update({ state: "FAILED", error_code: "INTERNAL_ERROR" })
        .eq("id", exportId);
      await finishJob(jobId, "FAILED", {
        errorCode: "INTERNAL_ERROR",
        errorDetail: error instanceof Error ? error.message : "export failed",
      });
      return { failed: true };
    }
  },
);
