import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { reportSchema } from "@/lib/validation";

type Params = { params: Promise<{ id: string }> };

/**
 * Reporting an issue makes the reference ineligible immediately and returns the
 * session to the preparation prompt, so tutoring stops until a new reference has
 * been prepared and checked.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);
  const body = await parseBody(request, reportSchema);

  const { error } = await supabase.rpc("report_reference", { p_problem_id: id, p_reason: body.reason });
  assertRpcOk(error);

  return ok({
    reported: true,
    preparationState: "AWAITING_SOLUTION",
    preparationLabel: "Waiting for your choice",
  });
});
