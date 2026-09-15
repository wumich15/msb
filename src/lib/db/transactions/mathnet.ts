import "server-only";
import { nowIso } from "@/lib/db/admin";
import { COLLECTIONS, chunk, col } from "@/lib/db/collections";
import { AppError } from "@/lib/errors";
import { getDoc, getMany, readMany, readOne, requireFolderInTx, runTransaction } from "@/lib/db/transactions/shared";
import { createProblemInTx } from "@/lib/db/transactions/core";
import type {
  MathnetProblemRow,
  MathnetReleaseRow,
  MathnetSolutionDataPrivateRow,
  ProblemRow,
  ProblemVersionRow,
  RecommendationItemRow,
} from "@/lib/db/types";

/** The active pinned catalog release, or null when none has been activated. */
export async function readActiveRelease(): Promise<MathnetReleaseRow | null> {
  const rows = await readMany<MathnetReleaseRow>(col(COLLECTIONS.mathnetReleases).where("is_active", "==", true).limit(1));
  return rows[0] ?? null;
}

/**
 * Everything the learner has already seen: the source problem, saved copies,
 * dismissals, and exact/equivalent duplicates of their own statement. Refiltered
 * on every read.
 */
export async function mathnetExclusionsForUser(userId: string, problemId: string, releaseId: string | null): Promise<string[]> {
  const excluded = new Set<string>();

  const imported = await readMany<ProblemRow>(
    col(COLLECTIONS.problems).where("user_id", "==", userId).where("imported_mathnet_id", ">", ""),
  );
  for (const row of imported) if (row.imported_mathnet_id) excluded.add(row.imported_mathnet_id);

  const items = await readMany<RecommendationItemRow>(
    col(COLLECTIONS.recommendationItems).where("user_id", "==", userId).where("excluded", "==", true),
  );
  for (const item of items) excluded.add(item.mathnet_problem_id);

  if (releaseId) {
    const versions = await readMany<ProblemVersionRow>(col(COLLECTIONS.problemVersions).where("problem_id", "==", problemId));
    const owned = versions.filter((version) => version.user_id === userId);
    for (const hashes of chunk([...new Set(owned.map((version) => version.statement_hash))], 30)) {
      if (hashes.length === 0) continue;
      const duplicates = await readMany<MathnetProblemRow>(
        col(COLLECTIONS.mathnetProblems).where("release_id", "==", releaseId).where("content_hash", "in", hashes),
      );
      for (const duplicate of duplicates) excluded.add(duplicate.id);
    }
  }

  return [...excluded];
}

/**
 * Copies a recommended statement into an owned folder as a new not-started
 * problem. Only the statement and attribution travel with it, never a solution,
 * and a repeated request returns the problem already created.
 */
export async function saveRecommendationItem(
  userId: string,
  runId: string,
  itemId: string,
  folderId: string,
): Promise<{ duplicate: boolean; problem_id: string }> {
  return runTransaction(async (tx) => {
    const item = await getDoc<RecommendationItemRow>(tx, col(COLLECTIONS.recommendationItems).doc(itemId));
    if (!item || item.run_id !== runId || item.user_id !== userId) throw new AppError("NOT_FOUND");
    if (item.saved_problem_id) return { duplicate: true, problem_id: item.saved_problem_id };
    await requireFolderInTx(tx, folderId, userId);

    const source = await getDoc<MathnetProblemRow>(tx, col(COLLECTIONS.mathnetProblems).doc(item.mathnet_problem_id));
    if (!source || !source.is_eligible) throw new AppError("NOT_FOUND");

    const problemId = createProblemInTx(tx, {
      userId,
      folderId,
      title: (source.title ?? "MathNET problem").slice(0, 300),
      statement: source.statement_markdown,
      sourceKind: "mathnet",
      sourceMetadata: { source_id: source.source_id, locator: source.source_locator, attribution: source.attribution },
      importedMathnetId: source.id,
      importedSourceId: source.source_id,
    });
    tx.update(col(COLLECTIONS.recommendationItems).doc(itemId), { saved_problem_id: problemId, excluded: true });
    return { duplicate: false, problem_id: problemId };
  });
}

/** Dismissal / relevance feedback on an owned recommendation item. */
export async function updateRecommendationItem(
  userId: string,
  runId: string,
  itemId: string,
  patch: { dismissed?: boolean; relevance?: string },
): Promise<Pick<RecommendationItemRow, "id" | "dismissed_at" | "relevance_feedback">> {
  return runTransaction(async (tx) => {
    const ref = col(COLLECTIONS.recommendationItems).doc(itemId);
    const item = await getDoc<RecommendationItemRow>(tx, ref);
    if (!item || item.run_id !== runId || item.user_id !== userId) throw new AppError("NOT_FOUND");
    const update: Partial<RecommendationItemRow> = {};
    if (patch.dismissed !== undefined) update.dismissed_at = patch.dismissed ? nowIso() : null;
    if (patch.relevance !== undefined) update.relevance_feedback = patch.relevance;
    const dismissed = update.dismissed_at !== undefined ? update.dismissed_at !== null : item.dismissed_at !== null;
    update.excluded = dismissed || item.saved_problem_id !== null;
    tx.update(ref, update);
    return { id: item.id, dismissed_at: update.dismissed_at ?? item.dismissed_at, relevance_feedback: update.relevance_feedback ?? item.relevance_feedback };
  });
}

/**
 * Validates a fully built release and activates it atomically. The previous
 * release stays in place (inactive) for rollback.
 */
export async function activateMathnetRelease(releaseId: string): Promise<{ ok: true; release_id: string; indexed: number }> {
  const release = await readOne<MathnetReleaseRow>(col(COLLECTIONS.mathnetReleases).doc(releaseId));
  if (!release) throw new AppError("NOT_FOUND");
  if (release.eligible_count < 100) throw new AppError("INVALID_REQUEST", "fewer than 100 eligible fixtures");

  // Count the eligible records whose profile, lexical terms, and both vectors exist.
  let indexed = 0;
  let last: string | null = null;
  for (;;) {
    let query = col(COLLECTIONS.mathnetSolutionData).where("release_id", "==", releaseId).where("is_eligible", "==", true).orderBy("__name__").limit(200);
    if (last) query = query.startAfter(last);
    const page = await readMany<MathnetSolutionDataPrivateRow>(query);
    if (page.length === 0) break;
    for (const row of page) {
      if (row.statement_embedding && row.idea_embedding && (row.search_terms?.length ?? 0) > 0 && (row.idea_ids?.length ?? 0) > 0) {
        indexed += 1;
      }
    }
    last = page[page.length - 1]?.id ?? null;
    if (page.length < 200) break;
  }
  if (indexed !== release.eligible_count) {
    throw new AppError("INVALID_REQUEST", `indexed ${indexed} of ${release.eligible_count} eligible records`);
  }

  await runTransaction(async (tx) => {
    const active = await getMany<MathnetReleaseRow>(tx, col(COLLECTIONS.mathnetReleases).where("is_active", "==", true));
    const now = nowIso();
    for (const row of active) if (row.id !== releaseId) tx.update(col(COLLECTIONS.mathnetReleases).doc(row.id), { is_active: false });
    tx.update(col(COLLECTIONS.mathnetReleases).doc(releaseId), { is_active: true, validated_at: now, activated_at: now });
  });
  return { ok: true, release_id: releaseId, indexed };
}
