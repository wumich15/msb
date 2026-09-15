import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertSameOrigin, ok, route } from "@/lib/http";
import { revealReference } from "@/lib/ai/reference-store";
import { tutorGate } from "@/lib/db/transactions/assistant";
import { appendEventInTx } from "@/lib/db/transactions/core";
import { runTransaction } from "@/lib/db/transactions/shared";
import { AppError } from "@/lib/errors";

type Params = { params: Promise<{ id: string }> };

/**
 * The explicit spoiler action. The readiness gate runs first: an unprepared or
 * superseded reference produces an operational code and no mathematical content.
 */
export const POST = route(async (_request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(id, userId);

  const verdict = await tutorGate(id, userId);
  if (!verdict.ok) {
    throw new AppError(verdict.code === "STALE_REQUEST" ? "STALE_REQUEST" : "SOLUTION_NOT_READY", verdict.reason);
  }

  const revealed = await revealReference(userId, id);
  // The reveal is a study event so exports can apply the same spoiler decision.
  await runTransaction(async (tx) => {
    appendEventInTx(tx, {
      user_id: userId,
      problem_id: id,
      kind: "reference_revealed",
      from_status: null,
      to_status: null,
      statement_version: problem.current_statement_version,
      notes_revision: null,
      notes_snapshot: null,
      detail: { explicit_spoiler_action: true },
    });
  });
  return ok({ reference: revealed });
});
