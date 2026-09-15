import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { reportSchema } from "@/lib/validation";
import { reportReference } from "@/lib/db/transactions/assistant";

type Params = { params: Promise<{ id: string }> };

/**
 * Reporting an issue makes the reference ineligible immediately and returns the
 * session to the preparation prompt, so tutoring stops until a new reference has
 * been prepared and checked.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(id, userId);
  const body = await parseBody(request, reportSchema);

  await reportReference(userId, id, body.reason);

  return ok({
    reported: true,
    preparationState: "AWAITING_SOLUTION",
    preparationLabel: "Waiting for your choice",
  });
});
