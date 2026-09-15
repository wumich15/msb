import { requireSession } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { statementSchema } from "@/lib/validation";
import { reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { readOne } from "@/lib/db/transactions/shared";
import { saveStatement } from "@/lib/db/transactions/core";
import { cancelJob, enqueueJob } from "@/lib/db/transactions/jobs";
import type { NotesRow, ProfileRow } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/**
 * Saving a changed statement creates a new immutable version and, in the same
 * transaction, invalidates the selected reference, cancels in-flight tutor work,
 * and marks preparation stale. An identical re-save changes nothing.
 */
export const PUT = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const body = await parseBody(request, statementSchema);

  const version = await saveStatement(userId, id, body.expectedVersion, body.statement);

  if (version !== body.expectedVersion && body.statement.trim().length >= 80) {
    const [profile, notes] = await Promise.all([
      readOne<ProfileRow>(col(COLLECTIONS.profiles).doc(userId)),
      readOne<NotesRow>(col(COLLECTIONS.notes).doc(id)),
    ]);
    // Provisional statement-only classification, only when the account allows it.
    if (profile?.automatic_recommendations !== false) {
      const jobId = await enqueueJob({
        userId,
        jobType: "classify-problem",
        problemId: id,
        input: { reason: "statement_saved" },
        idempotencyKey: `classify:statement:${id}:${version}`,
        statementVersion: version,
        notesRevision: notes?.revision ?? null,
      }).catch(() => null);
      if (jobId && (await reserveExistingJobBudget(jobId, TOKEN_ESTIMATES["classify-problem"]).catch(() => false))) {
        await dispatchJobById(jobId).catch(() => undefined);
      } else if (jobId) {
        await cancelJob(jobId, "AI_LIMIT_REACHED");
      }
    }
  }
  return ok({ version, changed: version !== body.expectedVersion });
});
