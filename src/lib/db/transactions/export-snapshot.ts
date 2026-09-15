import "server-only";
import type { Transaction } from "firebase-admin/firestore";
import { db, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, chunk, col } from "@/lib/db/collections";
import { AppError } from "@/lib/errors";
import { getDoc, getMany } from "@/lib/db/transactions/shared";
import type {
  ChatMessageRow,
  ExportScope,
  FolderRow,
  IdeaProfilePrivateRow,
  MathnetProblemRow,
  NotesRow,
  ProblemRow,
  ProblemVersionRow,
  RecommendationItemRow,
  RecommendationRunRow,
  ReferenceSolutionPrivateRow,
  StudyEventRow,
} from "@/lib/db/types";

export interface RawExportSnapshot {
  snapshotAt: string;
  folders: FolderRow[];
  problems: ProblemRow[];
  statements: ProblemVersionRow[];
  notes: NotesRow[];
  events: StudyEventRow[];
  messages: ChatMessageRow[];
  ideaProfiles: IdeaProfilePrivateRow[];
  /** Populated only when the export explicitly includes reference solutions. */
  references: ReferenceSolutionPrivateRow[];
  recommendations: Array<{
    problemId: string;
    sourceId: string;
    title: string | null;
    relationship: string | null;
    sourceUrl: string | null;
    attribution: Record<string, unknown>;
  }>;
}

/**
 * Reads the whole export inside one read-only transaction, which Firestore
 * serves from a single consistent snapshot, so related records agree with each
 * other instead of being observed at different revisions.
 */
export async function readExportSnapshot(
  userId: string,
  scope: ExportScope,
  scopeId: string | null,
  includeReferences: boolean,
): Promise<RawExportSnapshot> {
  if (scope !== "account" && !scopeId) throw new AppError("INVALID_REQUEST", `${scope} export needs a scope id`);

  return db().runTransaction(
    async (tx: Transaction) => {
      const snapshotAt = nowIso();

      let problems: ProblemRow[];
      if (scope === "account") {
        problems = await getMany<ProblemRow>(tx, col(COLLECTIONS.problems).where("user_id", "==", userId));
      } else if (scope === "problem") {
        const problem = await getDoc<ProblemRow>(tx, col(COLLECTIONS.problems).doc(scopeId as string));
        problems = problem && problem.user_id === userId ? [problem] : [];
      } else {
        problems = await getMany<ProblemRow>(
          tx,
          col(COLLECTIONS.problems).where("user_id", "==", userId).where("folder_id", "==", scopeId as string),
        );
      }
      if (scope !== "account" && problems.length === 0) throw new AppError("NOT_FOUND");
      problems.sort((a, b) => a.created_at.localeCompare(b.created_at));

      const problemIds = problems.map((problem) => problem.id);
      const folderIds = [...new Set(problems.map((problem) => problem.folder_id))];

      const folders: FolderRow[] = [];
      for (const ids of chunk(folderIds, 30)) {
        const refs = ids.map((id) => col(COLLECTIONS.folders).doc(id));
        if (refs.length === 0) continue;
        const docs = await tx.getAll(...refs);
        for (const doc of docs) {
          const data = doc.data() as FolderRow | undefined;
          if (doc.exists && data && data.user_id === userId) folders.push({ ...data, id: doc.id });
        }
      }
      folders.sort((a, b) => a.created_at.localeCompare(b.created_at));

      const byProblem = async <T>(name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS]): Promise<T[]> => {
        const rows: T[] = [];
        for (const ids of chunk(problemIds, 30)) {
          if (ids.length === 0) continue;
          rows.push(...(await getMany<T>(tx, col(name).where("user_id", "==", userId).where("problem_id", "in", ids))));
        }
        return rows;
      };

      const notes: NotesRow[] = [];
      for (const ids of chunk(problemIds, 30)) {
        if (ids.length === 0) continue;
        const docs = await tx.getAll(...ids.map((id) => col(COLLECTIONS.notes).doc(id)));
        for (const doc of docs) {
          const data = doc.data() as NotesRow | undefined;
          if (doc.exists && data && data.user_id === userId) notes.push(data);
        }
      }

      const [statements, events, messages, ideaProfiles, runs] = await Promise.all([
        byProblem<ProblemVersionRow>(COLLECTIONS.problemVersions),
        byProblem<StudyEventRow>(COLLECTIONS.studyEvents),
        byProblem<ChatMessageRow>(COLLECTIONS.chatMessages),
        byProblem<IdeaProfilePrivateRow>(COLLECTIONS.ideaProfiles),
        byProblem<RecommendationRunRow>(COLLECTIONS.recommendationRuns),
      ]);
      const references = includeReferences
        ? (await byProblem<ReferenceSolutionPrivateRow>(COLLECTIONS.referenceSolutions)).filter((row) =>
            row.state === "READY" || row.state === "REPORTED",
          )
        : [];

      const items: RecommendationItemRow[] = [];
      for (const ids of chunk(runs.map((run) => run.id), 30)) {
        if (ids.length === 0) continue;
        items.push(...(await getMany<RecommendationItemRow>(tx, col(COLLECTIONS.recommendationItems).where("user_id", "==", userId).where("run_id", "in", ids))));
      }
      const mathnetById = new Map<string, MathnetProblemRow>();
      for (const ids of chunk([...new Set(items.map((item) => item.mathnet_problem_id))], 30)) {
        if (ids.length === 0) continue;
        const docs = await tx.getAll(...ids.map((id) => col(COLLECTIONS.mathnetProblems).doc(id)));
        for (const doc of docs) if (doc.exists) mathnetById.set(doc.id, { ...(doc.data() as MathnetProblemRow), id: doc.id });
      }
      const runById = new Map(runs.map((run) => [run.id, run]));
      const recommendations = items
        .map((item) => {
          const run = runById.get(item.run_id);
          const source = mathnetById.get(item.mathnet_problem_id);
          if (!run || !source) return null;
          return {
            problemId: run.problem_id,
            sourceId: source.source_id,
            title: source.title,
            relationship: item.relationship,
            sourceUrl: source.source_locator?.explorer_url ?? source.source_locator?.url ?? null,
            attribution: source.attribution,
            rank: item.rank,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => a.problemId.localeCompare(b.problemId) || a.rank - b.rank)
        .map(({ rank: _rank, ...entry }) => entry);

      const byCreated = <T extends { created_at: string }>(rows: T[]) => rows.sort((a, b) => a.created_at.localeCompare(b.created_at));

      return {
        snapshotAt,
        folders,
        problems,
        statements: statements.sort((a, b) => a.problem_id.localeCompare(b.problem_id) || a.version - b.version),
        notes,
        events: byCreated(events),
        messages: byCreated(messages),
        ideaProfiles: byCreated(ideaProfiles),
        references,
        recommendations,
      };
    },
    { readOnly: true },
  );
}
