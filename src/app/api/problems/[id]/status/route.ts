import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { statusSchema } from "@/lib/validation";
import { dispatchJobById } from "@/jobs/dispatch";
import { reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { createServiceClient } from "@/lib/db/service";

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
    classification_job_id?: string | null;
    recommendation_job_id?: string | null;
  };

  const service = createServiceClient();
  let classificationScheduled = !result.classification_job_id;
  if (result.classification_job_id) {
    const reserved = await reserveExistingJobBudget(result.classification_job_id, TOKEN_ESTIMATES["classify-problem"]).catch(() => false);
    classificationScheduled = reserved;
    if (reserved) await dispatchJobById(result.classification_job_id).catch(() => undefined);
    else await service.from("jobs").update({ run_state: "CANCELLED", error_code: "AI_LIMIT_REACHED" }).eq("id", result.classification_job_id);
  }
  if (result.recommendation_job_id) {
    // Recommendation generation may fail; completing the problem already succeeded.
    const reserved = classificationScheduled && await reserveExistingJobBudget(result.recommendation_job_id, TOKEN_ESTIMATES["recommend-problems"]).catch(() => false);
    if (reserved) await dispatchJobById(result.recommendation_job_id).catch(() => undefined);
    else await service.from("jobs").update({ run_state: "CANCELLED", error_code: "AI_LIMIT_REACHED" }).eq("id", result.recommendation_job_id);
  }

  return ok({
    ...result,
    classificationJobId: result.classification_job_id ?? null,
    recommendationJobId: result.recommendation_job_id ?? null,
  });
});
