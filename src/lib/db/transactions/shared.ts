import "server-only";
import type { DocumentReference, DocumentSnapshot, Query, Transaction } from "firebase-admin/firestore";
import { db, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { AppError } from "@/lib/errors";
import type { AssistantSessionRow, FolderRow, NotesRow, ProblemRow, ProfileRow } from "@/lib/db/types";

/**
 * Small helpers shared by the transaction modules.
 *
 * Firestore transactions require every read to happen before the first write, so
 * each compound operation below reads what it needs, decides, then writes. An
 * AppError thrown inside `runTransaction` aborts the transaction and reaches the
 * route unchanged; that is how NOTES_CONFLICT, STATEMENT_CONFLICT and
 * STALE_REQUEST travel without parsing prose.
 */

export type Tx = Transaction;

export async function getDoc<T>(tx: Tx, ref: DocumentReference): Promise<(T & { id: string }) | null> {
  const snapshot = await tx.get(ref);
  return snapshotData<T>(snapshot);
}

export function snapshotData<T>(snapshot: DocumentSnapshot): (T & { id: string }) | null {
  if (!snapshot.exists) return null;
  return { ...(snapshot.data() as T), id: snapshot.id };
}

export async function getMany<T>(tx: Tx, query: Query): Promise<Array<T & { id: string }>> {
  const snapshot = await tx.get(query);
  return snapshot.docs.map((doc) => ({ ...(doc.data() as T), id: doc.id }));
}

export async function readMany<T>(query: Query): Promise<Array<T & { id: string }>> {
  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ ...(doc.data() as T), id: doc.id }));
}

export async function readOne<T>(ref: DocumentReference): Promise<(T & { id: string }) | null> {
  return snapshotData<T>(await ref.get());
}

/** Loads an owned problem or reports it absent. Another account's record is NOT_FOUND. */
export async function requireProblemInTx(tx: Tx, problemId: string, userId: string): Promise<ProblemRow> {
  const problem = await getDoc<ProblemRow>(tx, col(COLLECTIONS.problems).doc(problemId));
  if (!problem || problem.user_id !== userId) throw new AppError("NOT_FOUND");
  return problem;
}

export async function requireFolderInTx(tx: Tx, folderId: string, userId: string): Promise<FolderRow> {
  const folder = await getDoc<FolderRow>(tx, col(COLLECTIONS.folders).doc(folderId));
  if (!folder || folder.user_id !== userId) throw new AppError("NOT_FOUND");
  return folder;
}

export async function requireNotesInTx(tx: Tx, problemId: string, userId: string): Promise<NotesRow> {
  const notes = await getDoc<NotesRow>(tx, col(COLLECTIONS.notes).doc(problemId));
  if (!notes || notes.user_id !== userId) throw new AppError("NOT_FOUND");
  return notes;
}

export async function requireSessionInTx(tx: Tx, problemId: string, userId: string): Promise<AssistantSessionRow> {
  const session = await getDoc<AssistantSessionRow>(tx, col(COLLECTIONS.assistantSessions).doc(problemId));
  if (!session || session.user_id !== userId) throw new AppError("NOT_FOUND");
  return session;
}

export async function readProfileInTx(tx: Tx, userId: string): Promise<ProfileRow | null> {
  return getDoc<ProfileRow>(tx, col(COLLECTIONS.profiles).doc(userId));
}

export function runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().runTransaction(fn);
}

export { nowIso };
