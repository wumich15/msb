import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { assistantToggleSchema } from "@/lib/validation";
import { reusableReferenceExists } from "@/lib/ai/reference-store";
import { PREPARATION_LABELS } from "@/lib/db/projections";
import type { PreparationState } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/**
 * Turning the assistant on always advances the activation generation and returns
 * to "Waiting for your choice". A previous choice is never carried over silently,
 * and silence is never treated as a decision.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(supabase, id, userId);
  const body = await parseBody(request, assistantToggleSchema);

  const { data, error } = await supabase.rpc("set_assistant_enabled", {
    p_problem_id: id,
    p_enabled: body.enabled,
  });
  assertRpcOk(error);

  const result = data as {
    enabled: boolean;
    activation_generation: number;
    preparation_generation: number;
    preparation_state: PreparationState;
    statement_version: number;
  };

  return ok({
    enabled: result.enabled,
    activationGeneration: result.activation_generation,
    preparationGeneration: result.preparation_generation,
    preparationState: result.preparation_state,
    preparationLabel: PREPARATION_LABELS[result.preparation_state],
    statementVersion: result.statement_version,
    // Offered alongside the prompt when an unchanged checked reference exists.
    canReuseSavedReference: body.enabled
      ? await reusableReferenceExists(userId, id, problem.current_statement_version)
      : false,
  });
});
