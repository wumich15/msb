import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { accepted, assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { similarSchema } from "@/lib/validation";
import { createServiceClient } from "@/lib/db/service";
import { projectRecommendation } from "@/lib/db/projections";
import { reserveBudget, TOKEN_ESTIMATES } from "@/lib/ai/usage";
import { dispatchJobById } from "@/jobs/dispatch";
import type { MathnetProblemRow, RecommendationItemRow, RecommendationRunRow } from "@/lib/db/types";

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
    const cached = await readCachedRun(service, userId, id, problem.current_statement_version);
    if (cached) return ok(cached);
  }

  await reserveBudget(userId, TOKEN_ESTIMATES["recommend-problems"]);

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
  assertRpcOk(error);

  await dispatchJobById(jobId as string).catch(() => undefined);
  return accepted({ jobId, state: "QUEUED", items: [] });
});

async function readCachedRun(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  problemId: string,
  statementVersion: number,
) {
  const { data: runRow } = await service
    .from("recommendation_runs")
    .select("*")
    .eq("user_id", userId)
    .eq("problem_id", problemId)
    .eq("statement_version", statementVersion)
    .in("state", ["READY", "NO_MATCH"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const run = runRow as RecommendationRunRow | null;
  if (!run) return null;

  const { data: itemRows } = await service
    .from("recommendation_items")
    .select("*")
    .eq("run_id", run.id)
    .eq("user_id", userId)
    .order("rank");

  // Saved and dismissed entries are refiltered on every read, not only at build time.
  const items = ((itemRows ?? []) as RecommendationItemRow[]).filter(
    (item) => item.dismissed_at === null && item.saved_problem_id === null,
  );

  if (items.length === 0) return { runId: run.id, state: run.state, items: [], cached: true };

  const { data: problemRows } = await service
    .from("mathnet_problems")
    .select("*")
    .in("id", items.map((item) => item.mathnet_problem_id));

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
