import { requireSession } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { statusSchema } from "@/lib/validation";
import { dispatchJobById } from "@/jobs/dispatch";
import { reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { changeStatus } from "@/lib/db/transactions/core";
import { cancelJob } from "@/lib/db/transactions/jobs";

type Params = { params: Promise<{ id: string }> };

/**
 * The transition, its study event, the completion notes snapshot, and any
 * recommendation job are written in one transaction. Dispatch happens after the
 * commit, and a failed dispatch never undoes the completion.
 */
export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const body = await parseBody(request, statusSchema);

  const result = await changeStatus(
    userId,
    id,
    body.status,
    body.expectedStatementVersion ?? null,
    body.expectedNotesRevision ?? null,
  );

  let classificationScheduled = !result.classification_job_id;
  if (result.classification_job_id) {
    const reserved = await reserveExistingJobBudget(result.classification_job_id, TOKEN_ESTIMATES["classify-problem"]).catch(() => false);
    classificationScheduled = reserved;
    if (reserved) await dispatchJobById(result.classification_job_id).catch(() => undefined);
    else await cancelJob(result.classification_job_id, "AI_LIMIT_REACHED");
  }
  if (result.recommendation_job_id) {
    // Recommendation generation may fail; completing the problem already succeeded.
    const reserved =
      classificationScheduled &&
      (await reserveExistingJobBudget(result.recommendation_job_id, TOKEN_ESTIMATES["recommend-problems"]).catch(() => false));
    if (reserved) await dispatchJobById(result.recommendation_job_id).catch(() => undefined);
    else await cancelJob(result.recommendation_job_id, "AI_LIMIT_REACHED");
  }

  return ok({
    ...result,
    classificationJobId: result.classification_job_id ?? null,
    recommendationJobId: result.recommendation_job_id ?? null,
  });
});
