import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { similarSchema } from "@/lib/validation";
import { projectRecommendation } from "@/lib/db/projections";
import { releaseBudgetReservation, reserveBudget, reserveExistingJobBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import { profileHashFor, recommendationCacheKey } from "@/lib/mathnet/retrieval";
import { COLLECTIONS, col, ids } from "@/lib/db/collections";
import { readMany, readOne } from "@/lib/db/transactions/shared";
import { cancelJob, enqueueJob } from "@/lib/db/transactions/jobs";
import { readActiveRelease } from "@/lib/db/transactions/mathnet";
import { AppError } from "@/lib/errors";
import type {
  IdeaProfilePrivateRow,
  MathnetProblemRow,
  NotesRow,
  ProblemVersionRow,
  RecommendationItemRow,
  RecommendationRunRow,
} from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/**
 * Find similar problems. Available at any status and used by both entry points,
 * so the manual button and the completion trigger share one pipeline.
 *
 * A checked reference is not required. Without solution evidence the results are
 * labelled tentative and carry no mathematical advice, and requesting them does
 * not secretly start solution preparation.
 */
export const POST = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(id, userId);
  const body = await parseBody(request, similarSchema);

  if (!body.refresh) {
    const [statement, notes, profiles, release] = await Promise.all([
      problem.current_statement_version > 0
        ? readOne<ProblemVersionRow>(col(COLLECTIONS.problemVersions).doc(ids.versionDoc(id, problem.current_statement_version)))
        : Promise.resolve(null),
      readOne<NotesRow>(col(COLLECTIONS.notes).doc(id)),
      readMany<IdeaProfilePrivateRow>(
        col(COLLECTIONS.ideaProfiles)
          .where("user_id", "==", userId)
          .where("problem_id", "==", id)
          .where("statement_version", "==", problem.current_statement_version)
          .orderBy("created_at", "desc")
          .limit(1),
      ),
      readActiveRelease(),
    ]);
    const ideaProfile = profiles[0] ?? null;
    const profileHash = profileHashFor({
      problemId: id,
      userId,
      statement: statement?.statement_markdown ?? "",
      statementVersion: problem.current_statement_version,
      problemCategories: ideaProfile?.problem_categories ?? [],
      ideaIds: ideaProfile?.idea_ids ?? [],
      mechanism: ideaProfile?.mechanism ?? null,
      hasSolutionEvidence: ideaProfile?.evidence_kind === "checked_reference" || ideaProfile?.evidence_kind === "user_supplied_work",
    });
    const cacheKey = recommendationCacheKey({
      userId,
      problemId: id,
      statementVersion: problem.current_statement_version,
      notesRevision: notes?.revision ?? null,
      profileHash,
      releaseId: release?.id ?? null,
      indexVersion: release?.index_version ?? 0,
    });
    const cached = await readCachedRun(userId, cacheKey);
    if (cached) return ok(cached);
  }

  const reservation = TOKEN_ESTIMATES["recommend-problems"];
  await reserveBudget(userId, reservation);

  // A manual search is an explicit request for AI processing, so it runs whatever
  // the automatic-recommendation preference says.
  const idempotencyKey = `recommend:${id}:${problem.current_statement_version}:${Date.now()}`;
  let jobId: string;
  try {
    jobId = await enqueueJob({
      userId,
      jobType: "recommend-problems",
      problemId: id,
      input: { trigger: "manual" },
      idempotencyKey,
      statementVersion: problem.current_statement_version,
    });
  } catch (error) {
    await releaseBudgetReservation(userId, reservation);
    throw error;
  }
  // Transfer the request-level reservation onto the job so the worker reconciles it once.
  await releaseBudgetReservation(userId, reservation);
  if (!(await reserveExistingJobBudget(jobId, reservation).catch(() => false))) {
    await cancelJob(jobId, "AI_LIMIT_REACHED");
    throw new AppError("AI_LIMIT_REACHED", "budget");
  }

  await dispatchJobById(jobId).catch(() => undefined);
  return accepted({ jobId, state: "QUEUED", items: [] });
});

async function readCachedRun(userId: string, cacheKey: string) {
  const runs = await readMany<RecommendationRunRow>(
    col(COLLECTIONS.recommendationRuns)
      .where("cache_key", "==", cacheKey)
      .where("state", "in", ["READY", "NO_MATCH"])
      .orderBy("created_at", "desc")
      .limit(1),
  );
  const run = runs[0];
  if (!run || run.user_id !== userId) return null;

  const itemRows = await readMany<RecommendationItemRow>(
    col(COLLECTIONS.recommendationItems).where("run_id", "==", run.id).where("user_id", "==", userId).orderBy("rank", "asc"),
  );

  // Saved and dismissed entries are refiltered on every read, not only at build time.
  const items = itemRows.filter((item) => item.dismissed_at === null && item.saved_problem_id === null);
  if (items.length === 0) return { runId: run.id, state: run.state, items: [], cached: true };

  const docs = await col(COLLECTIONS.mathnetProblems).firestore.getAll(
    ...items.map((item) => col(COLLECTIONS.mathnetProblems).doc(item.mathnet_problem_id)),
  );
  const problems = new Map<string, MathnetProblemRow>();
  for (const doc of docs) if (doc.exists) problems.set(doc.id, { ...(doc.data() as MathnetProblemRow), id: doc.id });

  return {
    runId: run.id,
    state: run.state,
    cached: true,
    items: items
      .map((item) => {
        const mathnetProblem = problems.get(item.mathnet_problem_id);
        return mathnetProblem ? projectRecommendation(item, mathnetProblem) : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  };
}
