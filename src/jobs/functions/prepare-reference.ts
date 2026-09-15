import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, isSuperseded, loadProblemContext, RunBudget, setJobStage, setPreparationState } from "@/jobs/runtime";
import { prepareReference } from "@/lib/ai/preparation";
import { createReference, updateReference } from "@/lib/ai/reference-store";
import { createServiceClient } from "@/lib/db/service";
import { reconcileJobUsage, reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { limits } from "@/lib/config";
import type { ReferenceSolutionPrivateRow } from "@/lib/db/types";
import { dispatchJobById } from "@/jobs/dispatch";

/**
 * Prepares the reference solution the readiness gate requires.
 *
 * Every terminal path leaves a visible state: READY with a selected reference, or
 * BLOCKED with an operational explanation and a retry control. The spinner never
 * runs indefinitely.
 */
export const prepareReferenceFunction = inngest.createFunction(
  {
    id: "prepare-reference",
    // Retries here are for delivery; the model-call budget lives inside the run.
    retries: 1,
    triggers: [{ event: EVENT_NAME["prepare-reference"] }],
  },
  async ({ event, step }) => {
    const { jobId, userId, problemId } = event.data as JobEventData;

    const job = await step.run("claim", () => claimJob(jobId));
    if (!job || !problemId) return { skipped: true };

    const context = await step.run("load-context", () => loadProblemContext(userId, problemId));
    if (!context || !context.session) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    // The learner may have switched the assistant off, edited the statement, or
    // made a newer preparation choice while this job waited.
    if (!context.session.enabled || isSuperseded(job, context)) {
      await finishJob(jobId, "CANCELLED", { errorCode: "STALE_REQUEST" });
      return { superseded: true };
    }

    const choice = (job.input.choice as "provide" | "find") ?? "find";
    const supabase = createServiceClient();

    // A pasted submission was stored with the choice, so this payload holds an id.
    let reference: ReferenceSolutionPrivateRow | null = null;
    const existingReferenceId = job.input.reference_id as string | undefined;
    if (existingReferenceId) {
      const { data } = await supabase
        .from("reference_solutions")
        .select("*")
        .eq("id", existingReferenceId)
        .eq("user_id", userId)
        .maybeSingle();
      reference = (data as ReferenceSolutionPrivateRow | null) ?? null;
    }

    await setJobStage(jobId, choice === "provide" ? "validating" : "searching");
    await setPreparationState(job, choice === "provide" ? "VALIDATING" : "SEARCHING_MSE");

    const budget = new RunBudget(limits.preparationWallClockMs);
    let outcome: Awaited<ReturnType<typeof prepareReference>>;
    try {
      outcome = await prepareReference({
        choice,
        statement: context.statement?.statement_markdown ?? "",
        submittedText: reference?.submitted_text ?? null,
        budget,
      });
    } catch (error) {
      await reconcileJobUsage(jobId, userId, job.reserved_tokens ?? 0, 0);
      await setPreparationState(job, "BLOCKED", "Could not prepare a solution. You can retry.");
      await finishJob(jobId, "FAILED", {
        errorCode: "UPSTREAM_UNAVAILABLE",
        errorDetail: error instanceof Error ? error.message : "preparation failed",
        needsBillingReconciliation: true,
      });
      return { failed: true };
    }

    await reconcileJobUsage(
      jobId,
      userId,
      job.reserved_tokens ?? 0,
      outcome.usage.inputTokens + outcome.usage.outputTokens,
    );

    // Re-read before writing: the decision may have been replaced while we worked.
    const fresh = await loadProblemContext(userId, problemId);
    if (!fresh || !fresh.session?.enabled || isSuperseded(job, fresh)) {
      await finishJob(jobId, "CANCELLED", {
        errorCode: "STALE_REQUEST",
        providerRequestIds: outcome.usage.requestIds,
        needsBillingReconciliation: outcome.usage.needsBillingReconciliation,
      });
      return { superseded: true };
    }

    if (outcome.status === "blocked" || !outcome.candidate || !outcome.check) {
      if (reference) {
        await updateReference(reference.id, { state: "REJECTED", checkResult: outcome.check ?? null });
      }
      await setPreparationState(job, "BLOCKED", outcome.message);
      await finishJob(jobId, "FAILED", {
        errorCode: "PREPARATION_BLOCKED",
        errorDetail: outcome.stage,
        providerRequestIds: outcome.usage.requestIds,
        needsBillingReconciliation: outcome.usage.needsBillingReconciliation,
      });
      return { status: "blocked" };
    }

    const stored = reference
      ? await updateReference(reference.id, {
          artifact: outcome.candidate.artifact,
          checkResult: outcome.check,
          sourceUrls: outcome.candidate.sources,
          modelVersions: outcome.modelVersions,
        })
      : await createReference({
          userId,
          problemId,
          statementVersion: context.problem.current_statement_version,
          activationGeneration: job.activation_generation ?? 0,
          preparationGeneration: job.preparation_generation ?? 0,
          provenance: outcome.candidate.provenance,
          artifact: outcome.candidate.artifact,
          sourceUrls: outcome.candidate.sources,
          attribution: outcome.candidate.attribution,
          modelVersions: outcome.modelVersions,
          promptVersions: outcome.promptVersions,
        });

    if (reference) {
      await supabase
        .from("reference_solutions")
        .update({
          check_result: outcome.check,
          provenance: outcome.candidate.provenance,
          attribution: outcome.candidate.attribution,
          prompt_versions: outcome.promptVersions,
        })
        .eq("id", stored.id);
    }

    // Selection is conditional on the generations still matching; a late worker
    // cannot restore READY after a newer decision replaced it.
    const { data: selection } = await supabase.rpc("select_reference", {
      p_reference_id: stored.id,
      p_activation_generation: job.activation_generation ?? 0,
      p_preparation_generation: job.preparation_generation ?? 0,
    });

    const selectionResult = selection as { ok: boolean; code?: string };
    if (!selectionResult?.ok) {
      await finishJob(jobId, "CANCELLED", {
        errorCode: selectionResult?.code ?? "STALE_REQUEST",
        providerRequestIds: outcome.usage.requestIds,
      });
      return { superseded: true };
    }

    if (outcome.message) {
      // Operational note only: which path produced the reference, not its content.
      await supabase
        .from("assistant_sessions")
        .update({ preparation_message: outcome.message })
        .eq("problem_id", problemId)
        .eq("user_id", userId)
        .eq("activation_generation", job.activation_generation)
        .eq("preparation_generation", job.preparation_generation)
        .eq("statement_version", job.statement_version);
    }

    // A checked reference materially improves method classification. Enqueue it
    // only after the guarded reference selection has succeeded.
    const { data: classificationJobId } = await supabase.rpc("enqueue_job", {
      p_user_id: userId,
      p_job_type: "classify-problem",
      p_problem_id: problemId,
      p_input: { reason: "reference_ready", reference_id: stored.id },
      p_idempotency_key: `classify:reference:${stored.id}`,
      p_activation_generation: job.activation_generation,
      p_preparation_generation: job.preparation_generation,
      p_statement_version: job.statement_version,
      p_notes_revision: fresh.notes?.revision ?? null,
    });
    if (classificationJobId) {
      const classificationId = classificationJobId as string;
      if (await reserveExistingJobBudget(classificationId, TOKEN_ESTIMATES["classify-problem"]).catch(() => false)) {
        await dispatchJobById(classificationId);
      } else {
        await supabase.from("jobs").update({ run_state: "CANCELLED", error_code: "AI_LIMIT_REACHED" }).eq("id", classificationId);
      }
    }

    await finishJob(jobId, "SUCCEEDED", {
      result: { reference_id: stored.id, provenance: outcome.candidate.provenance },
      providerRequestIds: outcome.usage.requestIds,
      needsBillingReconciliation: outcome.usage.needsBillingReconciliation,
    });

    return { status: "ready" };
  },
);
