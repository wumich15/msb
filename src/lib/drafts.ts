/**
 * Per-account, per-problem recovery drafts in browser storage.
 *
 * These exist so a failed save does not lose typing. They are not offline
 * synchronization: the server copy is authoritative, and a draft is cleared once
 * its revision has been saved. Drafts are cleared on sign-out and on account
 * change so one person's work never appears under another's session.
 */

const PREFIX = "msb.draft.v1";

export interface RecoveryDraft {
  field: "notes" | "statement" | "question";
  value: string;
  baseRevision: number;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // Private windows and blocked site data.
  }
}

function key(userId: string, problemId: string, field: RecoveryDraft["field"]): string {
  return `${PREFIX}.${userId}.${problemId}.${field}`;
}

export function saveRecoveryDraft(
  userId: string,
  problemId: string,
  draft: RecoveryDraft,
): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key(userId, problemId, draft.field), JSON.stringify(draft));
  } catch {
    // Quota or blocked storage: the unsaved-state indicator still tells the truth.
  }
}

export function readRecoveryDraft(
  userId: string,
  problemId: string,
  field: RecoveryDraft["field"],
): RecoveryDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key(userId, problemId, field));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecoveryDraft;
    return typeof parsed?.value === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRecoveryDraft(
  userId: string,
  problemId: string,
  field: RecoveryDraft["field"],
): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key(userId, problemId, field));
  } catch {
    /* ignore */
  }
}

/** Called on sign-out and whenever the signed-in account changes. */
export function clearAllRecoveryDrafts(exceptUserId?: string): void {
  const store = storage();
  if (!store) return;
  try {
    const doomed: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (!name || !name.startsWith(PREFIX)) continue;
      if (exceptUserId && name.startsWith(`${PREFIX}.${exceptUserId}.`)) continue;
      doomed.push(name);
    }
    for (const name of doomed) store.removeItem(name);
  } catch {
    /* ignore */
  }
}
