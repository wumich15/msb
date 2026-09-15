import { requireSession } from "@/lib/auth/session";
import { requireOwnedFolder, requireOwnedProblem } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { problemUpdateSchema } from "@/lib/validation";
import { projectAssistantState, projectProblemSummary } from "@/lib/db/projections";
import { reusableReferenceExists } from "@/lib/ai/reference-store";
import type { AssistantSessionRow, NotesRow, ProblemRow, ProblemVersionRow } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/** Full editor payload: statement, notes, status, and safe assistant state. */
export const GET = route(async (_request: Request, { params }: Params) => {
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(supabase, id, userId);

  const [versionResult, notesResult, sessionResult] = await Promise.all([
    supabase
      .from("problem_versions")
      .select("*")
      .eq("problem_id", id)
      .eq("version", problem.current_statement_version)
      .maybeSingle(),
    supabase.from("notes").select("*").eq("problem_id", id).maybeSingle(),
    supabase.from("assistant_sessions").select("*").eq("problem_id", id).maybeSingle(),
  ]);

  assertRpcOk(versionResult.error);
  assertRpcOk(notesResult.error);
  assertRpcOk(sessionResult.error);

  const version = versionResult.data as ProblemVersionRow | null;
  const notes = notesResult.data as NotesRow | null;
  const session = sessionResult.data as AssistantSessionRow | null;

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

  const { data, error } = await supabase
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

  const { error } = await supabase.from("problems").delete().eq("id", id).eq("user_id", userId);
  assertRpcOk(error);

  return ok({ deleted: true });
});
