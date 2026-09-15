import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, isSuperseded, loadProblemContext, RunBudget, setJobStage, setPreparationState } from "@/jobs/runtime";
import { prepareReference } from "@/lib/ai/preparation";
import { createReference, loadReferenceForWorker, updateReference } from "@/lib/ai/reference-store";
import { selectReference, setPreparationMessageForJob } from "@/lib/db/transactions/assistant";
import { cancelJob, enqueueJob } from "@/lib/db/transactions/jobs";
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

    const context = await loadProblemContext(userId, problemId);
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

    // A pasted submission was stored with the choice, so this payload holds an id.
    let reference: ReferenceSolutionPrivateRow | null = null;
    const existingReferenceId = job.input.reference_id as string | undefined;
    if (existingReferenceId) {
      reference = await loadReferenceForWorker(existingReferenceId, userId).catch(() => null);
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
      await reconcileJobUsage(jobId, 0);
      await setPreparationState(job, "BLOCKED", "Could not prepare a solution. You can retry.");
      await finishJob(jobId, "FAILED", {
        errorCode: "UPSTREAM_UNAVAILABLE",
        errorDetail: error instanceof Error ? error.message : "preparation failed",
        needsBillingReconciliation: true,
      });
      return { failed: true };
    }

    await reconcileJobUsage(jobId, outcome.usage.inputTokens + outcome.usage.outputTokens);

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
          provenance: outcome.candidate.provenance,
          attribution: outcome.candidate.attribution,
          sourceUrls: outcome.candidate.sources,
          modelVersions: outcome.modelVersions,
          promptVersions: outcome.promptVersions,
        })
      : await createReference({
          userId,
          problemId,
          statementVersion: context.problem.current_statement_version,
          activationGeneration: job.activation_generation ?? 0,
          preparationGeneration: job.preparation_generation ?? 0,
          provenance: outcome.candidate.provenance,
          artifact: outcome.candidate.artifact,
          checkResult: outcome.check,
          sourceUrls: outcome.candidate.sources,
          attribution: outcome.candidate.attribution,
          modelVersions: outcome.modelVersions,
          promptVersions: outcome.promptVersions,
        });

    // Selection is conditional on the generations still matching; a late worker
    // cannot restore READY after a newer decision replaced it.
    const selection = await selectReference(stored.id, job.activation_generation ?? 0, job.preparation_generation ?? 0);
    if (!selection.ok) {
      await finishJob(jobId, "CANCELLED", {
        errorCode: selection.code ?? "STALE_REQUEST",
        providerRequestIds: outcome.usage.requestIds,
      });
      return { superseded: true };
    }

    if (outcome.message) {
      // Operational note only: which path produced the reference, not its content.
      await setPreparationMessageForJob(job, outcome.message);
    }

    // A checked reference materially improves method classification. Enqueue it
    // only after the guarded reference selection has succeeded.
    const classificationId = await enqueueJob({
      userId,
      jobType: "classify-problem",
      problemId,
      input: { reason: "reference_ready", reference_id: stored.id },
      idempotencyKey: `classify:reference:${stored.id}`,
      activationGeneration: job.activation_generation,
      preparationGeneration: job.preparation_generation,
      statementVersion: job.statement_version,
      notesRevision: fresh.notes?.revision ?? null,
    });
    if (await reserveExistingJobBudget(classificationId, TOKEN_ESTIMATES["classify-problem"]).catch(() => false)) {
      await dispatchJobById(classificationId);
    } else {
      await cancelJob(classificationId, "AI_LIMIT_REACHED");
    }

    await finishJob(jobId, "SUCCEEDED", {
      result: { reference_id: stored.id, provenance: outcome.candidate.provenance },
      providerRequestIds: outcome.usage.requestIds,
      needsBillingReconciliation: outcome.usage.needsBillingReconciliation,
    });

    return { status: "ready" };
  },
);
