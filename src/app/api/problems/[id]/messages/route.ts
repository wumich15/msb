import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { messageSchema } from "@/lib/validation";
import { projectChatMessage } from "@/lib/db/projections";
import { reserveBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
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

  await reserveBudget(userId, TOKEN_ESTIMATES["respond-to-question"]);

  const { data, error } = await supabase.rpc("create_chat_request", {
    p_problem_id: id,
    p_request_id: body.requestId,
    p_question: body.question,
    p_expected_notes_revision: body.expectedNotesRevision,
    p_selected_excerpt: body.selectedExcerpt ?? null,
    p_response_mode: body.responseMode,
    p_thread_id: null,
  });
  assertRpcOk(error);

  const result = data as {
    duplicate: boolean;
    message_id: string;
    job_id: string | null;
    thread_id?: string;
    notes_revision?: number;
  };

  if (result.job_id) await dispatchJobById(result.job_id).catch(() => undefined);

  return accepted({
    duplicate: result.duplicate,
    messageId: result.message_id,
    jobId: result.job_id,
    threadId: result.thread_id ?? null,
    notesRevision: result.notes_revision ?? null,
  });
});
