import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { statusSchema } from "@/lib/validation";
import { dispatchJobById } from "@/jobs/dispatch";

type Params = { params: Promise<{ id: string }> };

/**
 * The transition, its study event, the completion notes snapshot, and any
 * recommendation job are written in one transaction. Dispatch happens after the
 * commit, and a failed dispatch never undoes the completion.
 */
export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);

  const body = await parseBody(request, statusSchema);

  const { data, error } = await supabase.rpc("change_status", {
    p_problem_id: id,
    p_to_status: body.status,
    p_expected_statement_version: body.expectedStatementVersion ?? null,
    p_expected_notes_revision: body.expectedNotesRevision ?? null,
  });
  assertRpcOk(error);

  const result = data as {
    changed: boolean;
    status: string;
    recommendation_job_id?: string | null;
  };

  if (result.recommendation_job_id) {
    // Recommendation generation may fail; completing the problem already succeeded.
    await dispatchJobById(result.recommendation_job_id).catch(() => undefined);
  }

  return ok({ ...result, recommendationJobId: result.recommendation_job_id ?? null });
});
