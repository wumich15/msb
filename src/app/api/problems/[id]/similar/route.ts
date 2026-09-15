import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { similarSchema } from "@/lib/validation";
import { createServiceClient } from "@/lib/db/service";
import { projectRecommendation } from "@/lib/db/projections";
import { releaseBudgetReservation, reserveBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import { profileHashFor } from "@/lib/mathnet/retrieval";
import { versions } from "@/lib/config";
import type { IdeaProfilePrivateRow, MathnetProblemRow, RecommendationItemRow, RecommendationRunRow } from "@/lib/db/types";

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
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(supabase, id, userId);
  const body = await parseBody(request, similarSchema);

  const service = createServiceClient();

  if (!body.refresh) {
    const cacheInputs = await Promise.all([
      service.from("problem_versions").select("statement_markdown").eq("problem_id", id).eq("version", problem.current_statement_version).maybeSingle(),
      service.from("notes").select("revision").eq("problem_id", id).maybeSingle(),
      service.from("problem_idea_profiles").select("*").eq("user_id", userId).eq("problem_id", id).eq("statement_version", problem.current_statement_version).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      service.from("mathnet_releases").select("id, index_version").eq("is_active", true).maybeSingle(),
    ]);
    for (const input of cacheInputs) assertRpcOk(input.error);
    const [{ data: statement }, { data: notes }, { data: profile }, { data: release }] = cacheInputs;
    const ideaProfile = profile as IdeaProfilePrivateRow | null;
    const profileHash = profileHashFor({
      problemId: id,
      userId,
      statement: statement?.statement_markdown ?? "",
      statementVersion: problem.current_statement_version,
      ideaIds: ideaProfile?.idea_ids ?? [],
      mechanism: ideaProfile?.mechanism ?? null,
      hasSolutionEvidence: ideaProfile?.evidence_kind === "checked_reference" || ideaProfile?.evidence_kind === "user_supplied_work",
    });
    const cached = await readCachedRun(
      service,
      userId,
      id,
      problem.current_statement_version,
      notes?.revision ?? null,
      profileHash,
      release?.id ?? null,
      release?.index_version ?? 0,
    );
    if (cached) return ok(cached);
  }

  const reservation = TOKEN_ESTIMATES["recommend-problems"];
  await reserveBudget(userId, reservation);

  // A manual search is an explicit request for AI processing, so it runs whatever
  // the automatic-recommendation preference says.
  const idempotencyKey = `recommend:${id}:${problem.current_statement_version}:${Date.now()}`;
  const { data: jobId, error } = await service.rpc("enqueue_job", {
    p_user_id: userId,
    p_job_type: "recommend-problems",
    p_problem_id: id,
    p_input: { trigger: "manual" },
    p_idempotency_key: idempotencyKey,
    p_activation_generation: null,
    p_preparation_generation: null,
    p_statement_version: problem.current_statement_version,
    p_notes_revision: null,
  });
  try {
    assertRpcOk(error);
  } catch (enqueueError) {
    await releaseBudgetReservation(userId, reservation);
    throw enqueueError;
  }
  const { error: reservationError } = await service.from("jobs").update({ reserved_tokens: reservation }).eq("id", jobId as string);
  if (reservationError) {
    await releaseBudgetReservation(userId, reservation);
    await service.from("jobs").update({ run_state: "CANCELLED", error_code: "INTERNAL_ERROR" }).eq("id", jobId as string);
    throw reservationError;
  }

  await dispatchJobById(jobId as string).catch(() => undefined);
  return accepted({ jobId, state: "QUEUED", items: [] });
});

async function readCachedRun(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  problemId: string,
  statementVersion: number,
  notesRevision: number | null,
  profileHash: string,
  releaseId: string | null,
  indexVersion: number,
) {
  let query = service
    .from("recommendation_runs")
    .select("*")
    .eq("user_id", userId)
    .eq("problem_id", problemId)
    .eq("statement_version", statementVersion)
    .eq("profile_hash", profileHash)
    .eq("index_version", indexVersion)
    .eq("retrieval_version", versions.retrieval)
    .in("state", ["READY", "NO_MATCH"])
    .order("created_at", { ascending: false })
    .limit(1);
  query = notesRevision === null ? query.is("notes_revision", null) : query.eq("notes_revision", notesRevision);
  query = releaseId === null ? query.is("release_id", null) : query.eq("release_id", releaseId);
  const { data: runRows, error: runError } = await query;
  assertRpcOk(runError);

  const run = ((runRows ?? [])[0] as RecommendationRunRow | undefined) ?? null;
  if (!run) return null;

  const { data: itemRows, error: itemError } = await service
    .from("recommendation_items")
    .select("*")
    .eq("run_id", run.id)
    .eq("user_id", userId)
    .order("rank");
  assertRpcOk(itemError);

  // Saved and dismissed entries are refiltered on every read, not only at build time.
  const items = ((itemRows ?? []) as RecommendationItemRow[]).filter(
    (item) => item.dismissed_at === null && item.saved_problem_id === null,
  );

  if (items.length === 0) return { runId: run.id, state: run.state, items: [], cached: true };

  const { data: problemRows, error: problemError } = await service
    .from("mathnet_problems")
    .select("*")
    .in("id", items.map((item) => item.mathnet_problem_id));
  assertRpcOk(problemError);

  const problems = new Map(((problemRows ?? []) as MathnetProblemRow[]).map((row) => [row.id, row]));

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
