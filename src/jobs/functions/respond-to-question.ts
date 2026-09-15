import { inngest, EVENT_NAME, type JobEventData } from "@/jobs/client";
import { claimJob, finishJob, loadProblemContext } from "@/jobs/runtime";
import { createServiceClient } from "@/lib/db/service";
import { loadReferenceForWorker } from "@/lib/ai/reference-store";
import { generateTutorResponse } from "@/lib/ai/tutor";
import { reconcileUsage, TOKEN_ESTIMATES } from "@/lib/ai/usage";
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

    const supabase = createServiceClient();
    const context = await loadProblemContext(userId, problemId);
    if (!context) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    // The gate runs again here, before any model call is made.
    const { data: gate } = await supabase.rpc("tutor_gate", {
      p_problem_id: problemId,
      p_user_id: userId,
      p_activation_generation: job.activation_generation,
      p_preparation_generation: job.preparation_generation,
      p_reference_id: (job.input.reference_id as string) ?? null,
      p_reference_revision: (job.input.reference_revision as number) ?? null,
    });

    const verdict = gate as { ok: boolean; code?: string; reason?: string; reference_id?: string };
    if (!verdict?.ok) {
      await finishJob(jobId, "CANCELLED", { errorCode: verdict?.code ?? "STALE_REQUEST", errorDetail: verdict?.reason });
      return { superseded: true };
    }

    const messageId = job.input.message_id as string;
    const { data: userMessage } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("id", messageId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!userMessage) {
      await finishJob(jobId, "CANCELLED", { errorCode: "NOT_FOUND" });
      return { skipped: true };
    }

    const question = userMessage as ChatMessageRow;
    // The gate names the reference; the worker never takes one from the payload.
    const reference = await loadReferenceForWorker(verdict.reference_id ?? "", userId);
    if (!reference.artifact) {
      await finishJob(jobId, "CANCELLED", { errorCode: "SOLUTION_NOT_READY" });
      return { skipped: true };
    }

    // Only turns about the current statement version enter tutoring context.
    const { data: history } = await supabase
      .from("chat_messages")
      .select("role, content, statement_version")
      .eq("problem_id", problemId)
      .eq("user_id", userId)
      .eq("statement_version", question.statement_version)
      .neq("id", question.id)
      .order("created_at", { ascending: true })
      .limit(20);

    const requestedMode = (question.response_mode === "operational" ? "default" : question.response_mode) as Exclude<
      TutorResponseMode,
      "operational"
    >;

    const outcome = await generateTutorResponse({
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
      history: (history ?? []) as ChatMessageRow[],
    });

    await reconcileUsage(
      userId,
      TOKEN_ESTIMATES["respond-to-question"],
      outcome.usage.inputTokens + outcome.usage.outputTokens,
    );

    if (outcome.status !== "published") {
      // An abstention and a too-large context are operational messages: they carry
      // no mathematics and are marked as such in the conversation.
      await publishOperational(problemId, userId, job.id, question.thread_id, outcome.message, job.statement_version ?? 0);
      await finishJob(jobId, "SUCCEEDED", {
        result: { status: outcome.status },
        providerRequestIds: outcome.usage.requestIds,
      });
      return { status: outcome.status };
    }

    const { data: published } = await supabase.rpc("publish_tutor_response", {
      p_job_id: jobId,
      p_content: outcome.response.text,
      p_response_mode: mapMode(outcome.response.mode, requestedMode),
      p_cited_note_excerpt: outcome.response.cited_note_excerpt,
      p_spoiler_level: outcome.response.spoiler_level,
    });

    const publication = published as { ok: boolean; code?: string };
    if (!publication?.ok) {
      // A newer statement, activation, or preparation decision replaced this run.
      return { superseded: true, code: publication?.code };
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

async function publishOperational(
  problemId: string,
  userId: string,
  jobId: string,
  threadId: string,
  text: string,
  statementVersion: number,
): Promise<void> {
  const supabase = createServiceClient();
  const { data: last } = await supabase
    .from("chat_messages")
    .select("sequence")
    .eq("problem_id", problemId)
    .eq("thread_id", threadId)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();

  await supabase.from("chat_messages").insert({
    user_id: userId,
    problem_id: problemId,
    thread_id: threadId,
    sequence: ((last?.sequence as number | undefined) ?? 0) + 1,
    role: "assistant",
    content: text,
    request_id: `operational:${jobId}`,
    statement_version: statementVersion,
    response_mode: "operational",
    is_operational: true,
  });
}
