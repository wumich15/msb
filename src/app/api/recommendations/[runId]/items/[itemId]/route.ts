import { requireSession } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { recommendationFeedbackSchema } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import { updateRecommendationItem } from "@/lib/db/transactions/mathnet";

type Params = { params: Promise<{ runId: string; itemId: string }> };

/** Dismissal and relevance feedback, retained for evaluation. */
export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { runId, itemId } = await params;
  const body = await parseBody(request, recommendationFeedbackSchema);

  if (body.dismissed === undefined && body.relevance === undefined) throw new AppError("INVALID_REQUEST", "nothing to update");

  const item = await updateRecommendationItem(userId, runId, itemId, { dismissed: body.dismissed, relevance: body.relevance });
  return ok({ item });
});
