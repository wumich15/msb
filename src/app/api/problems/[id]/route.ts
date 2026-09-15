import { requireSession } from "@/lib/auth/session";
import { requireOwnedFolder, requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { problemUpdateSchema } from "@/lib/validation";
import { projectAssistantState, projectIdeaTags, projectJob, projectProblemSummary } from "@/lib/db/projections";
import { reusableReferenceExists } from "@/lib/ai/reference-store";
import { createServiceClient } from "@/lib/db/service";
import type { AssistantSessionRow, IdeaProfilePrivateRow, JobRow, NotesRow, ProblemRow, ProblemVersionRow } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/** Full editor payload: statement, notes, status, and safe assistant state. */
export const GET = route(async (_request: Request, { params }: Params) => {
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(supabase, id, userId);

  const service = createServiceClient();
  const [versionResult, notesResult, sessionResult, profileResult, jobsResult] = await Promise.all([
    supabase
      .from("problem_versions")
      .select("*")
      .eq("problem_id", id)
      .eq("version", problem.current_statement_version)
      .maybeSingle(),
    supabase.from("notes").select("*").eq("problem_id", id).maybeSingle(),
    supabase.from("assistant_sessions").select("*").eq("problem_id", id).maybeSingle(),
    service
      .from("problem_idea_profiles")
      .select("*")
      .eq("user_id", userId)
      .eq("problem_id", id)
      .eq("statement_version", problem.current_statement_version)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select("*")
      .eq("problem_id", id)
      .eq("user_id", userId)
      .in("run_state", ["QUEUED", "RUNNING"])
      .order("created_at", { ascending: false }),
  ]);

  assertRpcOk(versionResult.error);
  assertRpcOk(notesResult.error);
  assertRpcOk(sessionResult.error);
  assertRpcOk(profileResult.error);
  assertRpcOk(jobsResult.error);

  const version = versionResult.data as ProblemVersionRow | null;
  const notes = notesResult.data as NotesRow | null;
  const session = sessionResult.data as AssistantSessionRow | null;
  const profile = profileResult.data as IdeaProfilePrivateRow | null;

  return ok({
    problem: projectProblemSummary(problem),
    statement: {
      version: problem.current_statement_version,
      markdown: version?.statement_markdown ?? "",
      sourceKind: version?.source_kind ?? "user",
      sourceMetadata: version?.source_metadata ?? {},
    },
    notes: { revision: notes?.revision ?? 0, markdown: notes?.markdown ?? "", savedAt: notes?.saved_at ?? null },
    assistant: session
      ? projectAssistantState(session, {
          reusableReferenceExists: await reusableReferenceExists(userId, id, problem.current_statement_version),
        })
      : null,
    ideas: projectIdeaTags(profile, { problemComplete: problem.status === "complete", explicitlyRevealed: false }),
    activeJobs: ((jobsResult.data ?? []) as JobRow[]).map(projectJob),
  });
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);
  const body = await parseBody(request, problemUpdateSchema);

  if (body.folderId) await requireOwnedFolder(supabase, body.folderId, userId);

  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.folderId !== undefined) patch.folder_id = body.folderId;
  if (Object.keys(patch).length === 0) {
    const problem = await requireOwnedProblem(supabase, id, userId);
    return ok({ problem: projectProblemSummary(problem) });
  }

  const service = createServiceClient();
  const { data, error } = await service
    .from("problems")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single();
  assertRpcOk(error);

  return ok({ problem: projectProblemSummary(data as ProblemRow) });
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);

  const service = createServiceClient();
  const { error } = await service.from("problems").delete().eq("id", id).eq("user_id", userId);
  assertRpcOk(error);

  return ok({ deleted: true });
});
