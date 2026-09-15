import { requireSession } from "@/lib/auth/session";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { saveRecommendationSchema } from "@/lib/validation";

type Params = { params: Promise<{ runId: string; itemId: string }> };

/**
 * Copies a verified candidate into an owned folder as a new not-started problem.
 * Only the statement and attribution travel with it — never a solution — and a
 * repeated request returns the problem already created.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase } = await requireSession();
  const { runId, itemId } = await params;
  const body = await parseBody(request, saveRecommendationSchema);

  const { data, error } = await supabase.rpc("save_recommendation_item", {
    p_run_id: runId,
    p_item_id: itemId,
    p_folder_id: body.folderId,
  });
  assertRpcOk(error);

  const result = data as { duplicate: boolean; problem_id: string };
  return ok({ duplicate: result.duplicate, problemId: result.problem_id });
});
