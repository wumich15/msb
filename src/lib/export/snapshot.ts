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

interface RawSnapshot {
  snapshotAt: string;
  folders: FolderRow[];
  problems: ProblemRow[];
  statements: ProblemVersionRow[];
  notes: NotesRow[];
  events: StudyEventRow[];
  messages: ChatMessageRow[];
  ideaProfiles: IdeaProfilePrivateRow[];
  recommendations: ExportSnapshot["recommendations"];
}

/** Reads the whole export through one stable database statement/snapshot. */
export async function readSnapshot(
  supabase: SupabaseClient,
  userId: string,
  scope: ExportScope,
  scopeId: string | null,
): Promise<ExportSnapshot> {
  if (scope !== "account" && !scopeId) throw new AppError("INVALID_REQUEST", `${scope} export needs a scope id`);
  const { data, error } = await supabase.rpc("read_export_snapshot", {
    p_user_id: userId,
    p_scope: scope,
    p_scope_id: scopeId,
  });
  if (error) throw new AppError("INTERNAL_ERROR", error.message);
  const raw = data as RawSnapshot | null;
  if (!raw) throw new AppError("INTERNAL_ERROR", "empty export snapshot");
  if (scope !== "account" && raw.problems.length === 0) throw new AppError("NOT_FOUND");

  return {
    snapshotAt: raw.snapshotAt,
    folders: raw.folders,
    problems: raw.problems,
    statements: groupBy(raw.statements, (row) => row.problem_id),
    notes: new Map(raw.notes.map((row) => [row.problem_id, row])),
    events: groupBy(raw.events, (row) => row.problem_id),
    messages: groupBy(raw.messages, (row) => row.problem_id),
    ideaProfiles: groupBy(raw.ideaProfiles, (row) => row.problem_id),
    recommendations: raw.recommendations,
  };
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
