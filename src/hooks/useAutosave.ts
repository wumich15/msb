"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api-client";
import { limits } from "@/lib/config";
import { clearRecoveryDraft, saveRecoveryDraft, type RecoveryDraft } from "@/lib/drafts";

export type SaveState = "saved" | "unsaved" | "saving" | "failed" | "conflict";

export const SAVE_STATE_LABELS: Record<SaveState, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  failed: "Save failed — your text is kept here",
  conflict: "This was changed elsewhere",
};

interface AutosaveOptions {
  userId: string;
  problemId: string;
  field: RecoveryDraft["field"];
  initialValue: string;
  initialRevision: number;
  save: (value: string, expectedRevision: number) => Promise<number>;
}

/**
 * Debounced autosave with an explicit unsaved state.
 *
 * A failed save keeps the draft in memory and in browser storage rather than
 * discarding it, and `flush` is called before chat, completion, navigation, and
 * export so a question is never asked against notes the server has not seen.
 */
export function useAutosave(options: AutosaveOptions) {
  const [value, setValue] = useState(options.initialValue);
  const [revision, setRevision] = useState(options.initialRevision);
  const [state, setState] = useState<SaveState>("saved");
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const inFlight = useRef(false);
  const revisionRef = useRef(options.initialRevision);
  const saveRef = useRef(options.save);

  useEffect(() => {
    saveRef.current = options.save;
  }, [options.save]);

  useEffect(() => {
    // Switching problems resets the field to that problem's saved content.
    setValue(options.initialValue);
    setRevision(options.initialRevision);
    revisionRef.current = options.initialRevision;
    setState("saved");
    setConflictRevision(null);
    pending.current = null;
  }, [options.problemId, options.initialValue, options.initialRevision]);

  const persist = useCallback(async () => {
    const next = pending.current;
    if (next === null || inFlight.current) return;

    inFlight.current = true;
    setState("saving");
    try {
      const newRevision = await saveRef.current(next, revisionRef.current);
      revisionRef.current = newRevision;
      setRevision(newRevision);
      pending.current = null;
      setState("saved");
      clearRecoveryDraft(options.userId, options.problemId, options.field);
    } catch (error) {
      if (error instanceof ApiError && (error.code === "NOTES_CONFLICT" || error.code === "STATEMENT_CONFLICT")) {
        const current = Number(error.detail);
        setConflictRevision(Number.isFinite(current) ? current : null);
        setState("conflict");
      } else {
        setState("failed");
      }
      // The draft survives either way.
      saveRecoveryDraft(options.userId, options.problemId, {
        field: options.field,
        value: next,
        baseRevision: revisionRef.current,
        savedAt: Date.now(),
      });
    } finally {
      inFlight.current = false;
    }
  }, [options.field, options.problemId, options.userId]);

  const change = useCallback(
    (next: string) => {
      setValue(next);
      pending.current = next;
      setState("unsaved");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(), limits.autosaveDebounceMs);
    },
    [persist],
  );

  /** Saves any pending text immediately; resolves false when it did not land. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current === null) return state !== "failed" && state !== "conflict";
    await persist();
    return pending.current === null;
  }, [persist, state]);

  /** Takes the server's revision, keeping the learner's text as the new draft. */
  const resolveConflictKeepingMine = useCallback(() => {
    if (conflictRevision === null) return;
    revisionRef.current = conflictRevision;
    setRevision(conflictRevision);
    setConflictRevision(null);
    setState("unsaved");
    pending.current = value;
  }, [conflictRevision, value]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { value, revision, state, conflictRevision, change, flush, resolveConflictKeepingMine, setValue };
}
