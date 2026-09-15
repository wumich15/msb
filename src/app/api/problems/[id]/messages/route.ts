import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { messageSchema } from "@/lib/validation";
import { projectChatMessage } from "@/lib/db/projections";
import { releaseBudgetReservation, reserveBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { readMany } from "@/lib/db/transactions/shared";
import { assertGate, createChatRequest, tutorGate } from "@/lib/db/transactions/assistant";
import type { ChatMessageRow } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

const PAGE_SIZE = 50;

export const GET = route(async (request: Request, { params }: Params) => {
  const { userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(id, userId);

  const url = new URL(request.url);
  const before = url.searchParams.get("before");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? PAGE_SIZE) || PAGE_SIZE, PAGE_SIZE);

  let query = col(COLLECTIONS.chatMessages)
    .where("problem_id", "==", id)
    .where("user_id", "==", userId)
    .orderBy("created_at", "desc")
    .limit(limit);
  if (before) query = query.where("created_at", "<", before);

  const rows = (await readMany<ChatMessageRow>(query)).reverse();
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
  const { userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(id, userId);
  const body = await parseBody(request, messageSchema);

  // Reject pre-ready requests before reserving quota. createChatRequest repeats
  // this gate in its transaction to close the race with a changed reference.
  assertGate(await tutorGate(id, userId));

  const reservation = TOKEN_ESTIMATES["respond-to-question"];
  await reserveBudget(userId, reservation);

  let result: Awaited<ReturnType<typeof createChatRequest>>;
  try {
    result = await createChatRequest({
      userId,
      problemId: id,
      requestId: body.requestId,
      question: body.question,
      expectedNotesRevision: body.expectedNotesRevision,
      selectedExcerpt: body.selectedExcerpt ?? null,
      responseMode: body.responseMode,
      reservedTokens: reservation,
    });
  } catch (error) {
    await releaseBudgetReservation(userId, reservation);
    throw error;
  }

  if (result.duplicate || !result.job_id) {
    await releaseBudgetReservation(userId, reservation);
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
