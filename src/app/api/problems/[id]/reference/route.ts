import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { referenceChoiceSchema } from "@/lib/validation";
import { releaseBudgetReservation, reserveBudget, reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import { PREPARATION_LABELS } from "@/lib/db/projections";
import { setPreparationChoice } from "@/lib/db/transactions/assistant";
import { cancelJob } from "@/lib/db/transactions/jobs";
import { AppError } from "@/lib/errors";

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
  const { userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(id, userId);
  const body = await parseBody(request, referenceChoiceSchema);

  // Budget is reserved before dispatch and reconciled against actual usage later.
  const reservation = body.choice === "reuse" ? 0 : TOKEN_ESTIMATES["prepare-reference"];
  if (reservation) await reserveBudget(userId, reservation);

  let result: Awaited<ReturnType<typeof setPreparationChoice>>;
  try {
    result = await setPreparationChoice(
      userId,
      id,
      body.choice,
      body.expectedStatementVersion,
      body.choice === "provide" ? (body.workedSolution ?? null) : null,
      body.researchRelated,
    );
  } catch (error) {
    await releaseBudgetReservation(userId, reservation);
    throw error;
  }

  if (result.job_id && reservation) {
    // The request-level reservation is transferred onto the durable job record so
    // the worker reconciles it exactly once; the count is not reserved twice.
    await releaseBudgetReservation(userId, reservation);
    const attached = await reserveExistingJobBudget(result.job_id, reservation).catch(() => false);
    if (!attached) {
      await cancelJob(result.job_id, "AI_LIMIT_REACHED");
      throw new AppError("AI_LIMIT_REACHED", "budget");
    }
  } else if (reservation) {
    await releaseBudgetReservation(userId, reservation);
  }

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
