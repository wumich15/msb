import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors";
import type {
  ChatMessageRow,
  ExportScope,
  FolderRow,
  IdeaProfilePrivateRow,
  NotesRow,
  ProblemRow,
  ProblemVersionRow,
  StudyEventRow,
} from "@/lib/db/types";

/**
 * Reads one consistent snapshot of the requested scope.
 *
 * Related records are read against a single snapshot time so folders, problems,
 * notes, and events agree with one another. Only the requesting user's records are
 * ever included.
 */

export interface ExportSnapshot {
  snapshotAt: string;
  folders: FolderRow[];
  problems: ProblemRow[];
  statements: Map<string, ProblemVersionRow[]>;
  notes: Map<string, NotesRow>;
  events: Map<string, StudyEventRow[]>;
  messages: Map<string, ChatMessageRow[]>;
  ideaProfiles: Map<string, IdeaProfilePrivateRow[]>;
  recommendations: Array<{
    problemId: string;
    sourceId: string;
    title: string | null;
    relationship: string | null;
    sourceUrl: string | null;
    attribution: Record<string, unknown>;
  }>;
}

export async function readSnapshot(
  supabase: SupabaseClient,
  userId: string,
  scope: ExportScope,
  scopeId: string | null,
): Promise<ExportSnapshot> {
  const snapshotAt = new Date().toISOString();

  let problemQuery = supabase.from("problems").select("*").eq("user_id", userId).lte("created_at", snapshotAt);
  if (scope === "problem") {
    if (!scopeId) throw new AppError("INVALID_REQUEST", "a problem export needs a problem id");
    problemQuery = problemQuery.eq("id", scopeId);
  } else if (scope === "folder") {
    if (!scopeId) throw new AppError("INVALID_REQUEST", "a folder export needs a folder id");
    problemQuery = problemQuery.eq("folder_id", scopeId);
  }

  const { data: problemRows, error } = await problemQuery;
  if (error) throw new AppError("INTERNAL_ERROR", error.message);

  const problems = (problemRows ?? []) as ProblemRow[];
  if (problems.length === 0 && scope !== "account") throw new AppError("NOT_FOUND");

  const problemIds = problems.map((problem) => problem.id);
  const folderIds = [...new Set(problems.map((problem) => problem.folder_id))];

  const { data: folderRows } = await supabase
    .from("folders")
    .select("*")
    .eq("user_id", userId)
    .in("id", folderIds.length > 0 ? folderIds : ["00000000-0000-0000-0000-000000000000"]);

  const empty = problemIds.length === 0;
  const [statementRows, noteRows, eventRows, messageRows, profileRows, recommendationRows] = await Promise.all([
    empty ? emptyResult() : supabase.from("problem_versions").select("*").eq("user_id", userId).in("problem_id", problemIds),
    empty ? emptyResult() : supabase.from("notes").select("*").eq("user_id", userId).in("problem_id", problemIds),
    empty ? emptyResult() : supabase.from("study_events").select("*").eq("user_id", userId).in("problem_id", problemIds),
    empty
      ? emptyResult()
      : supabase.from("chat_messages").select("*").eq("user_id", userId).in("problem_id", problemIds).order("created_at"),
    empty ? emptyResult() : supabase.from("problem_idea_profiles").select("*").eq("user_id", userId).in("problem_id", problemIds),
    empty
      ? emptyResult()
      : supabase
          .from("recommendation_items")
          .select("relationship, is_tentative, run_id, mathnet_problem_id, recommendation_runs!inner(problem_id), mathnet_problems!inner(source_id, title, source_locator, attribution)")
          .eq("user_id", userId),
  ]);

  return {
    snapshotAt,
    folders: (folderRows ?? []) as FolderRow[],
    problems,
    statements: groupBy((statementRows.data ?? []) as ProblemVersionRow[], (row) => row.problem_id),
    notes: new Map(((noteRows.data ?? []) as NotesRow[]).map((row) => [row.problem_id, row])),
    events: groupBy((eventRows.data ?? []) as StudyEventRow[], (row) => row.problem_id),
    messages: groupBy((messageRows.data ?? []) as ChatMessageRow[], (row) => row.problem_id),
    ideaProfiles: groupBy((profileRows.data ?? []) as IdeaProfilePrivateRow[], (row) => row.problem_id),
    recommendations: mapRecommendations(recommendationRows.data ?? []),
  };
}

function emptyResult() {
  return Promise.resolve({ data: [] as unknown[], error: null });
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const existing = grouped.get(id);
    if (existing) existing.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

interface RawRecommendation {
  relationship: string | null;
  recommendation_runs?: { problem_id: string } | { problem_id: string }[];
  mathnet_problems?:
    | { source_id: string; title: string | null; source_locator: Record<string, string>; attribution: Record<string, unknown> }
    | Array<{ source_id: string; title: string | null; source_locator: Record<string, string>; attribution: Record<string, unknown> }>;
}

function mapRecommendations(rows: unknown[]): ExportSnapshot["recommendations"] {
  return (rows as RawRecommendation[])
    .map((row) => {
      const run = Array.isArray(row.recommendation_runs) ? row.recommendation_runs[0] : row.recommendation_runs;
      const problem = Array.isArray(row.mathnet_problems) ? row.mathnet_problems[0] : row.mathnet_problems;
      if (!run || !problem) return null;
      return {
        problemId: run.problem_id,
        sourceId: problem.source_id,
        title: problem.title,
        relationship: row.relationship,
        sourceUrl: problem.source_locator?.explorer_url ?? problem.source_locator?.url ?? null,
        attribution: problem.attribution ?? {},
      };
    })
    .filter((entry): entry is ExportSnapshot["recommendations"][number] => entry !== null);
}
