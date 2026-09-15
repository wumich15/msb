import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { notesSchema } from "@/lib/validation";

type Params = { params: Promise<{ id: string }> };

/**
 * Optimistic concurrency on the notes revision. A mismatch returns
 * 409 NOTES_CONFLICT with the current revision so the client can keep its draft
 * and let the learner reconcile it; another tab's work is never overwritten.
 */
export const PUT = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);

  const body = await parseBody(request, notesSchema);

  const { data, error } = await supabase.rpc("save_notes", {
    p_problem_id: id,
    p_expected_revision: body.expectedRevision,
    p_markdown: body.markdown,
  });
  assertRpcOk(error);

  return ok({ revision: data as number, savedAt: new Date().toISOString() });
});
