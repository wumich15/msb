import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { assistantToggleSchema } from "@/lib/validation";
import { reusableReferenceExists } from "@/lib/ai/reference-store";
import { setAssistantEnabled } from "@/lib/db/transactions/assistant";
import { PREPARATION_LABELS } from "@/lib/db/projections";

type Params = { params: Promise<{ id: string }> };

/**
 * Turning the assistant on always advances the activation generation and returns
 * to "Waiting for your choice". A previous choice is never carried over silently,
 * and silence is never treated as a decision.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(id, userId);
  const body = await parseBody(request, assistantToggleSchema);

  const result = await setAssistantEnabled(userId, id, body.enabled);

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
