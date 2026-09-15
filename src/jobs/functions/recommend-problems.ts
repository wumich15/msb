import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, loadProblemContext } from "@/jobs/runtime";
import { db, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col, newId } from "@/lib/db/collections";
import { readMany } from "@/lib/db/transactions/shared";
import { readJob } from "@/lib/db/transactions/jobs";
import { recommendationCacheKey, retrieveRelatedProblems, type RetrievalSource } from "@/lib/mathnet/retrieval";
import { reconcileJobUsage } from "@/lib/ai/usage";
import { versions } from "@/lib/config";
import type { IdeaProfilePrivateRow, RecommendationItemRow, RecommendationRunRow } from "@/lib/db/types";

/**
 * Finds related MathNET problems for one run.
 *
 * Both the completion trigger and the manual button arrive here. A failure leaves
 * the completion and the notes untouched: this job owns only the recommendation
 * run it was given.
 */
export const recommendProblemsFunction = inngest.createFunction(
  { id: "recommend-problems", retries: 2, triggers: [{ event: EVENT_NAME["recommend-problems"] }] },
  async ({ event, step }) => {
    const { jobId, userId, problemId } = event.data as JobEventData;

    const job = await step.run("claim", () => claimJob(jobId));
    if (!job || !problemId) return { skipped: true };

    const context = await loadProblemContext(userId, problemId);
    if (!context) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    const trigger = (job.input.trigger as "completion" | "manual") ?? "manual";

    // Completion retrieval waits for the profile built from the learner's final
    // notes. This makes the dependency explicit instead of racing two jobs.
    const dependencyId = job.input.depends_on_job_id as string | undefined;
    if (dependencyId) {
      let dependencyState: string | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const dependency = await readJob(dependencyId);
        dependencyState = dependency && dependency.user_id === userId ? dependency.run_state : null;
        if (dependencyState === "SUCCEEDED") break;
        if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(dependencyState ?? "")) break;
        await step.sleep(`wait-for-classification-${attempt}`, "3s");
      }
      if (dependencyState !== "SUCCEEDED") {
        await finishJob(jobId, "FAILED", {
          errorCode: "UPSTREAM_UNAVAILABLE",
          errorDetail: `classification dependency ended as ${dependencyState ?? "unknown"}`,
        });
        return { failed: true, dependencyState };
      }
    }

    // A newer completion, statement, or profile supersedes this run.
    if (job.statement_version !== null && job.statement_version !== context.problem.current_statement_version) {
      await finishJob(jobId, "CANCELLED", { errorCode: "STALE_REQUEST" });
      return { superseded: true };
    }

    const profile = await latestProfile(userId, problemId, context.problem.current_statement_version);

    const source: RetrievalSource = {
      problemId,
      userId,
      statement: context.statement?.statement_markdown ?? "",
      statementVersion: context.problem.current_statement_version,
      ideaIds: profile?.idea_ids ?? [],
      mechanism: profile?.mechanism ?? null,
      // Without checked solution evidence, every result is labelled tentative.
      hasSolutionEvidence: profile?.evidence_kind === "checked_reference" || profile?.evidence_kind === "user_supplied_work",
    };

    if (!source.statement.trim()) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND", errorDetail: "no statement" });
      return { skipped: true };
    }

    const runId = newId();
    const runRef = col(COLLECTIONS.recommendationRuns).doc(runId);
    const run: RecommendationRunRow = {
      id: runId,
      user_id: userId,
      problem_id: problemId,
      statement_version: source.statementVersion,
      notes_revision: context.notes?.revision ?? null,
      profile_hash: "pending",
      cache_key: "pending",
      trigger,
      release_id: null,
      index_version: 0,
      retrieval_version: versions.retrieval,
      state: "RUNNING",
      candidates: [],
      error_code: null,
      created_at: nowIso(),
      completed_at: null,
    };
    await runRef.set(run);

    try {
      const result = await retrieveRelatedProblems(source);
      await reconcileJobUsage(jobId, result.usage.inputTokens + result.usage.outputTokens);

      const fresh = await loadProblemContext(userId, problemId);
      if (
        !fresh ||
        fresh.problem.current_statement_version !== source.statementVersion ||
        fresh.notes?.revision !== context.notes?.revision
      ) {
        await runRef.update({ state: "FAILED", error_code: "STALE_REQUEST", completed_at: nowIso() });
        await finishJob(jobId, "CANCELLED", { errorCode: "STALE_REQUEST" });
        return { superseded: true };
      }

      const cacheKey = recommendationCacheKey({
        userId,
        problemId,
        statementVersion: source.statementVersion,
        notesRevision: context.notes?.revision ?? null,
        profileHash: result.profileHash,
        releaseId: result.releaseId,
        indexVersion: result.indexVersion,
      });

      const batch = db().batch();
      batch.update(runRef, {
        state: result.state,
        release_id: result.releaseId,
        index_version: result.indexVersion,
        profile_hash: result.profileHash,
        cache_key: cacheKey,
        candidates: result.items,
        completed_at: nowIso(),
      });
      for (const item of result.items) {
        const row: RecommendationItemRow = {
          id: newId(),
          run_id: runId,
          user_id: userId,
          mathnet_problem_id: item.mathnetProblemId,
          rank: item.rank,
          fusion_score: item.fusionScore,
          relationship: item.relationship,
          is_tentative: item.isTentative,
          saved_problem_id: null,
          dismissed_at: null,
          relevance_feedback: null,
          excluded: false,
          created_at: nowIso(),
        };
        batch.set(col(COLLECTIONS.recommendationItems).doc(row.id), row);
      }
      await batch.commit();

      await finishJob(jobId, "SUCCEEDED", {
        result: { run_id: runId, count: result.items.length, state: result.state },
        providerRequestIds: result.usage.requestIds,
      });
      return { runId, count: result.items.length };
    } catch (error) {
      await runRef.update({ state: "FAILED", error_code: "UPSTREAM_UNAVAILABLE", completed_at: nowIso() }).catch(() => undefined);
      await finishJob(jobId, "FAILED", {
        errorCode: "UPSTREAM_UNAVAILABLE",
        errorDetail: error instanceof Error ? error.message : "retrieval failed",
      });
      return { failed: true };
    }
  },
);

export async function latestProfile(userId: string, problemId: string, statementVersion: number): Promise<IdeaProfilePrivateRow | null> {
  const rows = await readMany<IdeaProfilePrivateRow>(
    col(COLLECTIONS.ideaProfiles)
      .where("user_id", "==", userId)
      .where("problem_id", "==", problemId)
      .where("statement_version", "==", statementVersion)
      .orderBy("created_at", "desc")
      .limit(1),
  );
  return rows[0] ?? null;
}
