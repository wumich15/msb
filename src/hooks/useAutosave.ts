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
  const inFlight = useRef<Promise<void> | null>(null);
  const revisionRef = useRef(options.initialRevision);
  const saveRef = useRef(options.save);
  const loadedProblemId = useRef(options.problemId);

  useEffect(() => {
    saveRef.current = options.save;
  }, [options.save]);

  useEffect(() => {
    // Switching problems resets the field to that problem's saved content.
    // A successful save also changes initialRevision; that is not a switch and
    // must not wipe a newer draft that was typed while the request was running.
    if (loadedProblemId.current === options.problemId) return;
    loadedProblemId.current = options.problemId;
    setValue(options.initialValue);
    setRevision(options.initialRevision);
    revisionRef.current = options.initialRevision;
    setState("saved");
    setConflictRevision(null);
    pending.current = null;
  }, [options.problemId, options.initialValue, options.initialRevision]);

  const persist = useCallback(async () => {
    // Drain saves in order. A response for an older draft must never clear text
    // entered while that request was in flight.
    while (pending.current !== null) {
      while (inFlight.current) await inFlight.current;
      const next = pending.current;
      if (next === null) return;

      let failed = false;
      const request = (async () => {
        setState("saving");
        try {
          const newRevision = await saveRef.current(next, revisionRef.current);
          revisionRef.current = newRevision;
          setRevision(newRevision);
          if (pending.current === next) {
            pending.current = null;
            setState("saved");
            clearRecoveryDraft(options.userId, options.problemId, options.field);
          } else {
            setState("unsaved");
          }
        } catch (error) {
          failed = true;
          if (error instanceof ApiError && (error.code === "NOTES_CONFLICT" || error.code === "STATEMENT_CONFLICT")) {
            const current = Number(error.detail);
            setConflictRevision(Number.isFinite(current) ? current : null);
            setState("conflict");
          } else {
            setState("failed");
          }
          saveRecoveryDraft(options.userId, options.problemId, {
            field: options.field,
            value: pending.current ?? next,
            baseRevision: revisionRef.current,
            savedAt: Date.now(),
          });
        }
      })();
      inFlight.current = request;
      await request;
      if (inFlight.current === request) inFlight.current = null;
      if (failed) return;
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
    void persist();
  }, [conflictRevision, persist, value]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { value, revision, state, conflictRevision, change, flush, resolveConflictKeepingMine, setValue };
}
