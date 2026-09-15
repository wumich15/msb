import { requireSession } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { saveRecommendationSchema } from "@/lib/validation";
import { saveRecommendationItem } from "@/lib/db/transactions/mathnet";

type Params = { params: Promise<{ runId: string; itemId: string }> };

/**
 * Copies a verified candidate into an owned folder as a new not-started problem.
 * Only the statement and attribution travel with it — never a solution — and a
 * repeated request returns the problem already created.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { runId, itemId } = await params;
  const body = await parseBody(request, saveRecommendationSchema);

  const result = await saveRecommendationItem(userId, runId, itemId, body.folderId);
  return ok({ duplicate: result.duplicate, problemId: result.problem_id });
});
