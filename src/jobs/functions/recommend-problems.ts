import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, loadProblemContext } from "@/jobs/runtime";
import { createServiceClient } from "@/lib/db/service";
import { retrieveRelatedProblems, type RetrievalSource } from "@/lib/mathnet/retrieval";
import { reconcileUsage, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { versions } from "@/lib/config";
import type { IdeaProfilePrivateRow } from "@/lib/db/types";

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

    const supabase = createServiceClient();
    const context = await loadProblemContext(userId, problemId);
    if (!context) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    const trigger = (job.input.trigger as "completion" | "manual") ?? "manual";

    // A newer completion, statement, or profile supersedes this run.
    if (job.statement_version !== null && job.statement_version !== context.problem.current_statement_version) {
      await finishJob(jobId, "CANCELLED", { errorCode: "STALE_REQUEST" });
      return { superseded: true };
    }

    const { data: profileRow } = await supabase
      .from("problem_idea_profiles")
      .select("*")
      .eq("problem_id", problemId)
      .eq("user_id", userId)
      .eq("statement_version", context.problem.current_statement_version)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const profile = (profileRow as IdeaProfilePrivateRow | null) ?? null;

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

    const { data: run, error: runError } = await supabase
      .from("recommendation_runs")
      .insert({
        user_id: userId,
        problem_id: problemId,
        statement_version: source.statementVersion,
        notes_revision: context.notes?.revision ?? null,
        profile_hash: "pending",
        trigger,
        retrieval_version: versions.retrieval,
        state: "RUNNING",
      })
      .select("id")
      .single();

    if (runError || !run) {
      await finishJob(jobId, "FAILED", { errorCode: "INTERNAL_ERROR", errorDetail: runError?.message });
      return { failed: true };
    }

    try {
      const result = await retrieveRelatedProblems(source);
      await reconcileUsage(
        userId,
        TOKEN_ESTIMATES["recommend-problems"],
        result.usage.inputTokens + result.usage.outputTokens,
      );

      await supabase
        .from("recommendation_runs")
        .update({
          state: result.state,
          release_id: result.releaseId,
          index_version: result.indexVersion,
          profile_hash: result.profileHash,
          candidates: result.items,
          completed_at: new Date().toISOString(),
        })
        .eq("id", run.id);

      if (result.items.length > 0) {
        await supabase.from("recommendation_items").insert(
          result.items.map((item) => ({
            run_id: run.id,
            user_id: userId,
            mathnet_problem_id: item.mathnetProblemId,
            rank: item.rank,
            fusion_score: item.fusionScore,
            relationship: item.relationship,
            is_tentative: item.isTentative,
          })),
        );
      }

      await finishJob(jobId, "SUCCEEDED", {
        result: { run_id: run.id, count: result.items.length, state: result.state },
        providerRequestIds: result.usage.requestIds,
      });
      return { runId: run.id, count: result.items.length };
    } catch (error) {
      await supabase
        .from("recommendation_runs")
        .update({ state: "FAILED", error_code: "UPSTREAM_UNAVAILABLE", completed_at: new Date().toISOString() })
        .eq("id", run.id);
      await finishJob(jobId, "FAILED", {
        errorCode: "UPSTREAM_UNAVAILABLE",
        errorDetail: error instanceof Error ? error.message : "retrieval failed",
      });
      return { failed: true };
    }
  },
);
