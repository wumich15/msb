import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { referenceChoiceSchema } from "@/lib/validation";
import { reserveBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import { PREPARATION_LABELS } from "@/lib/db/projections";
import type { PreparationState } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/**
 * Records the learner's explicit provide / find / reuse decision.
 *
 * Every such action replaces the current preparation decision, so the generation
 * advances and older preparation jobs and replies become ineligible even when the
 * statement has not changed.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);
  const body = await parseBody(request, referenceChoiceSchema);

  // Budget is reserved before dispatch and reconciled against actual usage later.
  if (body.choice !== "reuse") {
    await reserveBudget(userId, TOKEN_ESTIMATES["prepare-reference"]);
  }

  const { data, error } = await supabase.rpc("set_preparation_choice", {
    p_problem_id: id,
    p_choice: body.choice,
    p_expected_statement_version: body.expectedStatementVersion,
    p_submitted_text: body.choice === "provide" ? (body.workedSolution ?? null) : null,
  });
  assertRpcOk(error);

  const result = data as {
    activation_generation: number;
    preparation_generation: number;
    preparation_state: PreparationState;
    statement_version: number;
    job_id: string | null;
  };

  const payload = {
    activationGeneration: result.activation_generation,
    preparationGeneration: result.preparation_generation,
    preparationState: result.preparation_state,
    preparationLabel: PREPARATION_LABELS[result.preparation_state],
    statementVersion: result.statement_version,
    jobId: result.job_id,
  };

  // Reuse resolves synchronously; the other paths become durable jobs.
  if (!result.job_id) return ok(payload);

  await dispatchJobById(result.job_id).catch(() => undefined);
  return accepted(payload);
});
