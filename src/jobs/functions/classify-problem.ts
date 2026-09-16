import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, loadProblemContext } from "@/jobs/runtime";
import { COLLECTIONS, col, ids } from "@/lib/db/collections";
import { nowIso } from "@/lib/db/admin";
import { readOne } from "@/lib/db/transactions/shared";
import { latestReadyReference } from "@/lib/ai/reference-store";
import { classifyProblem, classificationInputHash, safeTagsFrom, type EvidenceKind } from "@/lib/mathnet/classify";
import { reconcileJobUsage, reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { versions } from "@/lib/config";
import { classifierPrompt } from "@/prompts";
import { cancelJob, enqueueJob } from "@/lib/db/transactions/jobs";
import { dispatchJobById } from "@/jobs/dispatch";
import type { IdeaProfilePrivateRow, ProfileRow } from "@/lib/db/types";

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

    const context = await loadProblemContext(userId, problemId);
    if (!context) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    const manual = job.input.reason === "manual" || job.input.recommend_after === true;
    const profile = await readOne<ProfileRow>(col(COLLECTIONS.profiles).doc(userId));

    // A manual request is an explicit request for AI processing; automatic runs
    // need the account preference.
    if (!manual && profile?.automatic_recommendations === false) {
      await finishJob(jobId, "CANCELLED", { errorCode: "AUTOMATIC_CLASSIFICATION_DISABLED" });
      return { skipped: true };
    }

    // A checked reference gives the strongest evidence; the learner's own completed
    // work is next; the statement alone is provisional.
    const reference = await latestReadyReference(userId, problemId, context.problem.current_statement_version);
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
    const classifierVersion = `${versions.classifier}:${classifierPrompt.version}`;
    const cacheId = ids.ideaProfile(problemId, inputHash, classifierVersion);
    const cached = await readOne<IdeaProfilePrivateRow>(col(COLLECTIONS.ideaProfiles).doc(cacheId));

    if (cached) {
      await enqueueRecommendationAfterResearch(job, userId, problemId, context.problem.current_statement_version, context.notes?.revision ?? null);
      await finishJob(jobId, "SUCCEEDED", { result: { cached: true, profile_id: cached.id } });
      return { cached: true };
    }

    let result: Awaited<ReturnType<typeof classifyProblem>>;
    try {
      result = await classifyProblem(input);
    } catch (error) {
      await reconcileJobUsage(jobId, 0);
      await finishJob(jobId, "FAILED", {
        errorCode: "UPSTREAM_UNAVAILABLE",
        errorDetail: error instanceof Error ? error.message : "classification failed",
        needsBillingReconciliation: true,
      });
      return { failed: true };
    }
    await reconcileJobUsage(jobId, result.usage.inputTokens + result.usage.outputTokens);

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

    const profileId = ids.ideaProfile(problemId, result.inputHash, result.classifierVersion);
    const row: IdeaProfilePrivateRow = {
      id: profileId,
      user_id: userId,
      problem_id: problemId,
      statement_version: context.problem.current_statement_version,
      notes_revision: context.notes?.revision ?? null,
      problem_categories: result.profile.problem_categories,
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
      created_at: nowIso(),
    };
    try {
      await col(COLLECTIONS.ideaProfiles).doc(profileId).set(row);
    } catch (error) {
      await finishJob(jobId, "FAILED", { errorCode: "INTERNAL_ERROR", errorDetail: error instanceof Error ? error.message : "write failed" });
      return { failed: true };
    }

    await enqueueRecommendationAfterResearch(job, userId, problemId, context.problem.current_statement_version, context.notes?.revision ?? null);
    await finishJob(jobId, "SUCCEEDED", {
      result: { profile_id: profileId, evidence_kind: evidenceKind },
      providerRequestIds: result.usage.requestIds,
    });
    return { classified: true };
  },
);

async function enqueueRecommendationAfterResearch(
  job: { id: string; input: Record<string, unknown> },
  userId: string,
  problemId: string,
  statementVersion: number,
  notesRevision: number | null,
): Promise<void> {
  if (job.input.recommend_after !== true) return;
  const recommendationId = await enqueueJob({
    userId,
    jobType: "recommend-problems",
    problemId,
    input: { trigger: "manual", research_source_job_id: job.id },
    idempotencyKey: `recommend:research:${job.id}`,
    statementVersion,
    notesRevision,
  });
  if (await reserveExistingJobBudget(recommendationId, TOKEN_ESTIMATES["recommend-problems"]).catch(() => false)) {
    await dispatchJobById(recommendationId);
  } else {
    await cancelJob(recommendationId, "AI_LIMIT_REACHED");
  }
}
