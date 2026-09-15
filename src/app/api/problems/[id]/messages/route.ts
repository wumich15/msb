import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { messageSchema } from "@/lib/validation";
import { projectChatMessage } from "@/lib/db/projections";
import { releaseBudgetReservation, reserveBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import { createServiceClient } from "@/lib/db/service";
import { AppError, isErrorCode } from "@/lib/errors";
import type { ChatMessageRow } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

const PAGE_SIZE = 50;

export const GET = route(async (request: Request, { params }: Params) => {
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(supabase, id, userId);

  const url = new URL(request.url);
  const before = url.searchParams.get("before");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? PAGE_SIZE) || PAGE_SIZE, PAGE_SIZE);

  let query = supabase
    .from("chat_messages")
    .select("*")
    .eq("problem_id", id)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  assertRpcOk(error);

  const rows = ((data ?? []) as ChatMessageRow[]).reverse();
  return ok({
    // Turns about older statement versions stay visible, marked as history.
    messages: rows.map((row) => projectChatMessage(row, problem.current_statement_version)),
    hasMore: rows.length === limit,
  });
});

/**
 * The gate runs before anything is written. A pre-ready request returns
 * 409 SOLUTION_NOT_READY, leaves the draft intact, and creates no assistant
 * message; the client keeps the question as a draft and does not resubmit it.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);
  const body = await parseBody(request, messageSchema);

  // Reject pre-ready requests before reserving quota. create_chat_request repeats
  // this gate in its transaction to close the race with a changed reference.
  const service = createServiceClient();
  const { data: gate, error: gateError } = await service.rpc("tutor_gate", {
    p_problem_id: id,
    p_user_id: userId,
  });
  assertRpcOk(gateError);
  const verdict = gate as { ok?: boolean; code?: string; reason?: string } | null;
  if (!verdict?.ok) {
    throw new AppError(isErrorCode(verdict?.code) ? verdict.code : "SOLUTION_NOT_READY", verdict?.reason);
  }

  const reservation = TOKEN_ESTIMATES["respond-to-question"];
  await reserveBudget(userId, reservation);

  let data: unknown;
  try {
    const created = await supabase.rpc("create_chat_request", {
      p_problem_id: id,
      p_request_id: body.requestId,
      p_question: body.question,
      p_expected_notes_revision: body.expectedNotesRevision,
      p_selected_excerpt: body.selectedExcerpt ?? null,
      p_response_mode: body.responseMode,
      p_thread_id: null,
    });
    assertRpcOk(created.error);
    data = created.data;
  } catch (error) {
    await releaseBudgetReservation(userId, reservation);
    throw error;
  }

  const result = data as {
    duplicate: boolean;
    message_id: string;
    job_id: string | null;
    thread_id?: string;
    notes_revision?: number;
  };

  if (result.duplicate || !result.job_id) {
    await releaseBudgetReservation(userId, reservation);
  } else {
    const { error: reservationError } = await service.from("jobs").update({ reserved_tokens: reservation }).eq("id", result.job_id);
    if (reservationError) {
      await releaseBudgetReservation(userId, reservation);
      await service.from("jobs").update({ run_state: "CANCELLED", error_code: "INTERNAL_ERROR" }).eq("id", result.job_id);
      throw new AppError("INTERNAL_ERROR", "could not attach the usage reservation");
    }
  }

  if (result.job_id) await dispatchJobById(result.job_id).catch(() => undefined);

  return accepted({
    duplicate: result.duplicate,
    messageId: result.message_id,
    jobId: result.job_id,
    threadId: result.thread_id ?? null,
    notesRevision: result.notes_revision ?? null,
  });
});
