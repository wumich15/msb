import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, loadProblemContext } from "@/jobs/runtime";
import { createServiceClient } from "@/lib/db/service";
import { classifyProblem, classificationInputHash, safeTagsFrom, type EvidenceKind } from "@/lib/mathnet/classify";
import { reconcileJobUsage } from "@/lib/ai/usage";
import type { ReferenceSolutionPrivateRow } from "@/lib/db/types";

/**
 * Builds the idea profile for one of the learner's problems.
 *
 * It runs after a substantive statement save, after a reference becomes ready, and
 * on completion or manual retrieval — never on a keystroke, and only when the
 * account preference permits automatic classification.
 */
export const classifyProblemFunction = inngest.createFunction(
  { id: "classify-problem", retries: 2, triggers: [{ event: EVENT_NAME["classify-problem"] }] },
  async ({ event, step }) => {
    const { jobId, userId, problemId } = event.data as JobEventData;

    const job = await step.run("claim", () => claimJob(jobId));
    if (!job || !problemId) return { skipped: true };

    const supabase = createServiceClient();
    const context = await loadProblemContext(userId, problemId);
    if (!context) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    const manual = job.input.reason === "manual";
    const { data: profile } = await supabase
      .from("profiles")
      .select("automatic_recommendations")
      .eq("user_id", userId)
      .maybeSingle();

    // A manual request is an explicit request for AI processing; automatic runs
    // need the account preference.
    if (!manual && profile?.automatic_recommendations === false) {
      await finishJob(jobId, "CANCELLED", { errorCode: "AUTOMATIC_CLASSIFICATION_DISABLED" });
      return { skipped: true };
    }

    // A checked reference gives the strongest evidence; the learner's own completed
    // work is next; the statement alone is provisional.
    const { data: referenceRow } = await supabase
      .from("reference_solutions")
      .select("*")
      .eq("problem_id", problemId)
      .eq("user_id", userId)
      .eq("statement_version", context.problem.current_statement_version)
      .eq("state", "READY")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const reference = (referenceRow as ReferenceSolutionPrivateRow | null) ?? null;
    const completed = context.problem.status === "complete";
    const notes = context.notes?.markdown ?? "";

    // After completion, prefer the approach the learner actually used.
    const evidenceKind: EvidenceKind = completed && notes.trim().length > 200
      ? "user_supplied_work"
      : reference?.artifact
        ? "checked_reference"
        : "statement_only";

    const input = {
      statement: context.statement?.statement_markdown ?? "",
      work: evidenceKind === "user_supplied_work" ? notes : null,
      referenceSolution: reference?.artifact ? JSON.stringify(reference.artifact) : null,
      evidenceKind,
    };

    if (!input.statement.trim()) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND", errorDetail: "no statement" });
      return { skipped: true };
    }

    // Cached by input hash and classifier version.
    const inputHash = classificationInputHash(input);
    const { data: cached } = await supabase
      .from("problem_idea_profiles")
      .select("id")
      .eq("problem_id", problemId)
      .eq("input_hash", inputHash)
      .maybeSingle();

    if (cached) {
      await finishJob(jobId, "SUCCEEDED", { result: { cached: true, profile_id: cached.id } });
      return { cached: true };
    }

    let result: Awaited<ReturnType<typeof classifyProblem>>;
    try {
      result = await classifyProblem(input);
    } catch (error) {
      await reconcileJobUsage(jobId, userId, job.reserved_tokens ?? 0, 0);
      await finishJob(jobId, "FAILED", {
        errorCode: "UPSTREAM_UNAVAILABLE",
        errorDetail: error instanceof Error ? error.message : "classification failed",
        needsBillingReconciliation: true,
      });
      return { failed: true };
    }
    await reconcileJobUsage(
      jobId,
      userId,
      job.reserved_tokens ?? 0,
      result.usage.inputTokens + result.usage.outputTokens,
    );

    const fresh = await loadProblemContext(userId, problemId);
    if (
      !fresh ||
      fresh.problem.current_statement_version !== context.problem.current_statement_version ||
      (job.notes_revision !== null && fresh.notes?.revision !== job.notes_revision)
    ) {
      await finishJob(jobId, "CANCELLED", {
        errorCode: "STALE_REQUEST",
        providerRequestIds: result.usage.requestIds,
      });
      return { superseded: true };
    }

    const { data: inserted, error } = await supabase
      .from("problem_idea_profiles")
      .upsert(
        {
          user_id: userId,
          problem_id: problemId,
          statement_version: context.problem.current_statement_version,
          notes_revision: context.notes?.revision ?? null,
          idea_ids: result.profile.idea_ids,
          secondary_idea_ids: result.profile.secondary_idea_ids,
          mechanism: result.profile.mechanism,
          object_roles: result.profile.object_roles,
          prerequisites: result.profile.prerequisites,
          evidence: result.profile.evidence,
          evidence_kind: evidenceKind,
          estimated_difficulty: result.profile.estimated_difficulty,
          confidence: result.profile.confidence,
          // Statement-only profiles stay provisional.
          is_provisional: evidenceKind === "statement_only",
          safe_tags: safeTagsFrom(result.profile, evidenceKind),
          input_hash: result.inputHash,
          classifier_version: result.classifierVersion,
        },
        { onConflict: "problem_id,input_hash,classifier_version" },
      )
      .select("id")
      .single();

    if (error) {
      await finishJob(jobId, "FAILED", { errorCode: "INTERNAL_ERROR", errorDetail: error.message });
      return { failed: true };
    }

    await finishJob(jobId, "SUCCEEDED", {
      result: { profile_id: inserted.id, evidence_kind: evidenceKind },
      providerRequestIds: result.usage.requestIds,
    });
    return { classified: true };
  },
);
