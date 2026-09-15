import { requireSession } from "@/lib/auth/session";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { recommendationFeedbackSchema } from "@/lib/validation";
import { AppError } from "@/lib/errors";

type Params = { params: Promise<{ runId: string; itemId: string }> };

/** Dismissal and relevance feedback, retained for evaluation. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { runId, itemId } = await params;
  const body = await parseBody(request, recommendationFeedbackSchema);

  const patch: Record<string, unknown> = {};
  if (body.dismissed !== undefined) patch.dismissed_at = body.dismissed ? new Date().toISOString() : null;
  if (body.relevance !== undefined) patch.relevance_feedback = body.relevance;
  if (Object.keys(patch).length === 0) throw new AppError("INVALID_REQUEST", "nothing to update");

  const { data, error } = await supabase
    .from("recommendation_items")
    .update(patch)
    .eq("id", itemId)
    .eq("run_id", runId)
    .eq("user_id", userId)
    .select("id, dismissed_at, relevance_feedback")
    .maybeSingle();
  assertRpcOk(error);
  if (!data) throw new AppError("NOT_FOUND");

  return ok({ item: data });
});
