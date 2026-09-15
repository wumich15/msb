import "server-only";
import type { Query } from "firebase-admin/firestore";
import { db, exportsBucket, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { AppError } from "@/lib/errors";
import { readMany, readOne } from "@/lib/db/transactions/shared";
import { ACTIVE_RUN_STATES } from "@/lib/db/transactions/jobs";
import type { ExportRow, FolderRow, JobRow, ProblemRow } from "@/lib/db/types";

/**
 * Cascade deletes. Firestore has no foreign keys, so a parent's children are
 * removed explicitly, in batches of at most 500 writes. Deleting the parent
 * document first means a late worker finds no owner and stops.
 */

const BATCH = 400;

async function deleteQuery(query: Query): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snapshot = await query.limit(BATCH).get();
    if (snapshot.empty) return deleted;
    const batch = db().batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snapshot.size;
    if (snapshot.size < BATCH) return deleted;
  }
}

const PROBLEM_CHILD_COLLECTIONS = [
  COLLECTIONS.problemVersions,
  COLLECTIONS.studyEvents,
  COLLECTIONS.referenceSolutions,
  COLLECTIONS.chatThreads,
  COLLECTIONS.chatMessages,
  COLLECTIONS.ideaProfiles,
  COLLECTIONS.recommendationRuns,
  COLLECTIONS.jobs,
] as const;

export async function deleteProblemCascade(userId: string, problemId: string): Promise<void> {
  const problem = await readOne<ProblemRow>(col(COLLECTIONS.problems).doc(problemId));
  if (!problem || problem.user_id !== userId) throw new AppError("NOT_FOUND");

  // Parent first, so nothing new can be attached and late workers stop.
  const head = db().batch();
  head.delete(col(COLLECTIONS.problems).doc(problemId));
  head.delete(col(COLLECTIONS.notes).doc(problemId));
  head.delete(col(COLLECTIONS.assistantSessions).doc(problemId));
  await head.commit();

  const runs = await readMany<{ id: string }>(col(COLLECTIONS.recommendationRuns).where("problem_id", "==", problemId));
  for (const run of runs) await deleteQuery(col(COLLECTIONS.recommendationItems).where("run_id", "==", run.id));
  for (const name of PROBLEM_CHILD_COLLECTIONS) {
    await deleteQuery(col(name).where("problem_id", "==", problemId));
  }
}

export async function deleteFolderCascade(userId: string, folderId: string): Promise<number> {
  const folder = await readOne<FolderRow>(col(COLLECTIONS.folders).doc(folderId));
  if (!folder || folder.user_id !== userId) throw new AppError("NOT_FOUND");
  const problems = await readMany<ProblemRow>(col(COLLECTIONS.problems).where("user_id", "==", userId).where("folder_id", "==", folderId));
  for (const problem of problems) await deleteProblemCascade(userId, problem.id);
  await col(COLLECTIONS.folders).doc(folderId).delete();
  return problems.length;
}

/**
 * Removes every owned record, cached private result, and export object. In-flight
 * jobs are cancelled first so nothing writes back after the records are gone.
 */
export async function deleteAccountData(userId: string): Promise<void> {
  const active = await readMany<JobRow>(col(COLLECTIONS.jobs).where("user_id", "==", userId).where("run_state", "in", ACTIVE_RUN_STATES));
  if (active.length) {
    const batch = db().batch();
    const now = nowIso();
    for (const job of active) {
      batch.update(col(COLLECTIONS.jobs).doc(job.id), { run_state: "CANCELLED", error_code: "ACCOUNT_DELETED", finished_at: now, updated_at: now });
    }
    await batch.commit();
  }

  const exports = await readMany<ExportRow>(col(COLLECTIONS.exports).where("user_id", "==", userId));
  for (const row of exports) {
    if (row.object_path) await exportsBucket().file(row.object_path).delete({ ignoreNotFound: true }).catch(() => undefined);
  }

  // Profile first: any late worker rechecks account existence and stops.
  await col(COLLECTIONS.profiles).doc(userId).delete();

  const ownedCollections = [
    COLLECTIONS.problems,
    COLLECTIONS.notes,
    COLLECTIONS.assistantSessions,
    COLLECTIONS.folders,
    COLLECTIONS.problemVersions,
    COLLECTIONS.studyEvents,
    COLLECTIONS.referenceSolutions,
    COLLECTIONS.chatThreads,
    COLLECTIONS.chatMessages,
    COLLECTIONS.ideaProfiles,
    COLLECTIONS.recommendationItems,
    COLLECTIONS.recommendationRuns,
    COLLECTIONS.jobs,
    COLLECTIONS.exports,
  ] as const;
  for (const name of ownedCollections) await deleteQuery(col(name).where("user_id", "==", userId));

  await deleteQuery(col(COLLECTIONS.aiUsage).where("user_id", "==", userId));
}
