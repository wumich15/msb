import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { statementSchema } from "@/lib/validation";

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
  return ok({ version, changed: version !== body.expectedVersion });
});
