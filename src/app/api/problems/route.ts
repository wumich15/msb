import { requireSession } from "@/lib/auth/session";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { problemCreateSchema } from "@/lib/validation";
import { projectProblemSummary } from "@/lib/db/projections";
import type { ProblemRow } from "@/lib/db/types";

export const GET = route(async (request: Request) => {
  const { supabase, userId } = await requireSession();
  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");
  const status = url.searchParams.get("status");

  let query = supabase.from("problems").select("*").eq("user_id", userId).order("updated_at", { ascending: false });
  if (folderId) query = query.eq("folder_id", folderId);
  if (status === "not_started" || status === "in_progress" || status === "complete") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  assertRpcOk(error);

  return ok({ problems: ((data ?? []) as ProblemRow[]).map(projectProblemSummary) });
});

export const POST = route(async (request: Request) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const body = await parseBody(request, problemCreateSchema);

  // One transaction creates the problem, its first immutable statement version,
  // the notes row, the assistant session, and the created event.
  const { data: problemId, error } = await supabase.rpc("create_problem", {
    p_folder_id: body.folderId,
    p_title: body.title,
    p_statement: body.statement ?? "",
  });
  assertRpcOk(error);

  const { data, error: readError } = await supabase
    .from("problems")
    .select("*")
    .eq("id", problemId as string)
    .eq("user_id", userId)
    .single();
  assertRpcOk(readError);

  return ok({ problem: projectProblemSummary(data as ProblemRow) });
});
