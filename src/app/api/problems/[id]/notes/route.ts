import { requireSession } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { notesSchema } from "@/lib/validation";
import { saveNotes } from "@/lib/db/transactions/core";

type Params = { params: Promise<{ id: string }> };

/**
 * Optimistic concurrency on the notes revision. A mismatch returns
 * 409 NOTES_CONFLICT with the current revision so the client can keep its draft
 * and let the learner reconcile it; another tab's work is never overwritten.
 */
export const PUT = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const body = await parseBody(request, notesSchema);

  const revision = await saveNotes(userId, id, body.expectedRevision, body.markdown);
  return ok({ revision, savedAt: new Date().toISOString() });
});
