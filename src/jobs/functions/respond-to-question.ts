import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, loadProblemContext } from "@/jobs/runtime";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { readMany, readOne } from "@/lib/db/transactions/shared";
import { publishOperationalMessage, publishTutorResponse, tutorGate } from "@/lib/db/transactions/assistant";
import { loadReferenceForWorker } from "@/lib/ai/reference-store";
import { generateTutorResponse } from "@/lib/ai/tutor";
import { reconcileJobUsage } from "@/lib/ai/usage";
import type { ChatMessageRow, TutorResponseMode } from "@/lib/db/types";

/**
 * Generates one tutoring reply.
 *
 * The response is produced in full, validated, and only then published through a
 * conditional write that rechecks the readiness gate. Nothing is streamed from the
 * model straight to the learner.
 */
export const respondToQuestionFunction = inngest.createFunction(
  {
    id: "respond-to-question",
    retries: 1,
    triggers: [{ event: EVENT_NAME["respond-to-question"] }],
  },
  async ({ event, step }) => {
    const { jobId, userId, problemId } = event.data as JobEventData;

    const job = await step.run("claim", () => claimJob(jobId));
    if (!job || !problemId) return { skipped: true };

    const context = await loadProblemContext(userId, problemId);
    if (!context) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    // The gate runs again here, before any model call is made.
    const verdict = await tutorGate(problemId, userId, {
      activationGeneration: job.activation_generation,
      preparationGeneration: job.preparation_generation,
      referenceId: (job.input.reference_id as string) ?? null,
      referenceRevision: (job.input.reference_revision as number) ?? null,
    });
    if (!verdict.ok) {
      await finishJob(jobId, "CANCELLED", { errorCode: verdict.code, errorDetail: verdict.reason });
      return { superseded: true };
    }

    const messageId = job.input.message_id as string;
    const question = await readOne<ChatMessageRow>(col(COLLECTIONS.chatMessages).doc(messageId));
    if (!question || question.user_id !== userId) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    // The gate names the reference; the worker never takes one from the payload.
    const reference = await loadReferenceForWorker(verdict.reference_id, userId);
    if (!reference.artifact) {
      await finishJob(jobId, "CANCELLED", { errorCode: "SOLUTION_NOT_READY" });
      return { skipped: true };
    }

    // Only turns about the current statement version enter tutoring context.
    const history = (
      await readMany<ChatMessageRow>(
        col(COLLECTIONS.chatMessages)
          .where("problem_id", "==", problemId)
          .where("user_id", "==", userId)
          .where("statement_version", "==", question.statement_version)
          .orderBy("created_at", "asc")
          .limit(21),
      )
    ).filter((row) => row.id !== question.id && !row.is_operational);

    const requestedMode = (question.response_mode === "operational" ? "default" : question.response_mode) as Exclude<
      TutorResponseMode,
      "operational"
    >;

    let outcome: Awaited<ReturnType<typeof generateTutorResponse>>;
    try {
      outcome = await generateTutorResponse({
        statement: context.statement?.statement_markdown ?? "",
        statementVersion: question.statement_version,
        reference: reference.artifact,
        // The snapshot captures what the learner meant when asking, even if they
        // have kept editing since.
        notesSnapshot: question.notes_snapshot ?? "",
        notesRevision: question.notes_revision ?? 0,
        selectedExcerpt: question.selected_excerpt,
        question: question.content,
        responseMode: requestedMode,
        history,
      });
    } catch (error) {
      await reconcileJobUsage(jobId, 0);
      await finishJob(jobId, "FAILED", {
        errorCode: "UPSTREAM_UNAVAILABLE",
        errorDetail: error instanceof Error ? error.message : "tutor failed",
        needsBillingReconciliation: true,
      });
      return { failed: true };
    }

    await reconcileJobUsage(jobId, outcome.usage.inputTokens + outcome.usage.outputTokens);

    if (outcome.status !== "published") {
      // An abstention and a too-large context are operational messages: they carry
      // no mathematics and are marked as such in the conversation.
      await publishOperationalMessage({
        userId,
        problemId,
        jobId,
        threadId: question.thread_id,
        text: outcome.message,
        statementVersion: job.statement_version ?? question.statement_version,
      });
      await finishJob(jobId, "SUCCEEDED", {
        result: { status: outcome.status },
        providerRequestIds: outcome.usage.requestIds,
      });
      return { status: outcome.status };
    }

    const publication = await publishTutorResponse({
      jobId,
      content: outcome.response.text,
      responseMode: mapMode(outcome.response.mode, requestedMode),
      citedNoteExcerpt: outcome.response.cited_note_excerpt,
      spoilerLevel: outcome.response.spoiler_level,
    });

    if (!publication.ok) {
      // A newer statement, activation, or preparation decision replaced this run.
      return { superseded: true, code: publication.code };
    }

    return { status: "published" };
  },
);

function mapMode(
  modelMode: string,
  requestedMode: Exclude<TutorResponseMode, "operational">,
): TutorResponseMode {
  if (modelMode === "full_solution") return "full_solution";
  if (modelMode === "stronger_hint") return "stronger_hint";
  if (requestedMode === "discuss_note_question") return "discuss_note_question";
  return "default";
}
