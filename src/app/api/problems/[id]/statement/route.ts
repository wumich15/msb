import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { statementSchema } from "@/lib/validation";
import { createServiceClient } from "@/lib/db/service";
import { reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";

type Params = { params: Promise<{ id: string }> };

/**
 * Saving a changed statement creates a new immutable version and, in the same
 * transaction, invalidates the selected reference, cancels in-flight tutor work,
 * and marks preparation stale. An identical re-save changes nothing.
 */
export const PUT = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);

  const body = await parseBody(request, statementSchema);

  const { data, error } = await supabase.rpc("save_statement", {
    p_problem_id: id,
    p_expected_version: body.expectedVersion,
    p_statement: body.statement,
  });
  assertRpcOk(error);

  const version = data as number;
  if (version !== body.expectedVersion && body.statement.trim().length >= 80) {
    const service = createServiceClient();
    const [{ data: profile }, { data: notes }] = await Promise.all([
      service.from("profiles").select("automatic_recommendations").eq("user_id", userId).maybeSingle(),
      service.from("notes").select("revision").eq("problem_id", id).eq("user_id", userId).maybeSingle(),
    ]);
    if (profile?.automatic_recommendations !== false) {
      const { data: jobId } = await service.rpc("enqueue_job", {
        p_user_id: userId,
        p_job_type: "classify-problem",
        p_problem_id: id,
        p_input: { reason: "statement_saved" },
        p_idempotency_key: `classify:statement:${id}:${version}`,
        p_activation_generation: null,
        p_preparation_generation: null,
        p_statement_version: version,
        p_notes_revision: notes?.revision ?? null,
      });
      if (jobId && await reserveExistingJobBudget(jobId as string, TOKEN_ESTIMATES["classify-problem"]).catch(() => false)) {
        await dispatchJobById(jobId as string).catch(() => undefined);
      } else if (jobId) {
        await service.from("jobs").update({ run_state: "CANCELLED", error_code: "AI_LIMIT_REACHED" }).eq("id", jobId as string);
      }
    }
  }
  return ok({ version, changed: version !== body.expectedVersion });
});
