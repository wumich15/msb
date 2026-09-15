import "server-only";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { AppError } from "@/lib/errors";
import { readOne } from "@/lib/db/transactions/shared";
import type { FolderRow, ProblemRow } from "@/lib/db/types";

/**
 * Ownership helpers. The Admin SDK bypasses security rules, so routes and
 * workers alike call these with the verified user id rather than trusting a
 * client-supplied owner field or a job payload.
 */

export async function requireOwnedProblem(problemId: string, userId: string): Promise<ProblemRow> {
  const problem = await readOne<ProblemRow>(col(COLLECTIONS.problems).doc(problemId));
  // A record belonging to another account is reported as absent.
  if (!problem || problem.user_id !== userId) throw new AppError("NOT_FOUND");
  return problem;
}

export async function requireOwnedFolder(folderId: string, userId: string): Promise<FolderRow> {
  const folder = await readOne<FolderRow>(col(COLLECTIONS.folders).doc(folderId));
  if (!folder || folder.user_id !== userId) throw new AppError("NOT_FOUND");
  return folder;
}

/** True when the account still exists; workers recheck before storing results. */
export async function accountStillExists(userId: string): Promise<boolean> {
  const snapshot = await col(COLLECTIONS.profiles).doc(userId).get();
  return snapshot.exists;
}
