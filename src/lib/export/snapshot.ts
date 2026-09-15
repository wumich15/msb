import "server-only";
import { readExportSnapshot, type RawExportSnapshot } from "@/lib/db/transactions/export-snapshot";
import type {
  ChatMessageRow,
  ExportScope,
  FolderRow,
  IdeaProfilePrivateRow,
  NotesRow,
  ProblemRow,
  ProblemVersionRow,
  ReferenceSolutionPrivateRow,
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
  /** Populated only when the learner explicitly asked to include references. */
  references: Map<string, ReferenceSolutionPrivateRow[]>;
  recommendations: Array<{
    problemId: string;
    sourceId: string;
    title: string | null;
    relationship: string | null;
    sourceUrl: string | null;
    attribution: Record<string, unknown>;
  }>;
}

/** Reads the whole export through one read-only, consistent database snapshot. */
export async function readSnapshot(
  userId: string,
  scope: ExportScope,
  scopeId: string | null,
  includeReferences: boolean,
): Promise<ExportSnapshot> {
  const raw: RawExportSnapshot = await readExportSnapshot(userId, scope, scopeId, includeReferences);

  return {
    snapshotAt: raw.snapshotAt,
    folders: raw.folders,
    problems: raw.problems,
    statements: groupBy(raw.statements, (row) => row.problem_id),
    notes: new Map(raw.notes.map((row) => [row.problem_id, row])),
    events: groupBy(raw.events, (row) => row.problem_id),
    messages: groupBy(raw.messages, (row) => row.problem_id),
    ideaProfiles: groupBy(raw.ideaProfiles, (row) => row.problem_id),
    references: groupBy(raw.references, (row) => row.problem_id),
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
