# Workspace Editor

## Summary
The workspace editor owns the problem statement and mathematical notes editing surfaces, their autosave queue, recovery drafts, and the compact hierarchy of problem metadata around them.

## Key Points
- Autosave serializes requests and only clears the exact draft acknowledged by a response, so typing during an in-flight save remains queued.
- Saved revision updates for the current problem do not reset the controlled textarea; only a problem identity change loads new initial content.
- Recovery drafts survive a page reload and are cleared after a successful save or explicit sign-out, not during workspace initialization.
- The short problem statement stays above the larger notes surface; formatting help and destructive metadata controls are disclosed on demand.

## Relevant Files
- `src/hooks/useAutosave.ts`: Ordered autosave queue, conflicts, and recovery persistence.
- `src/components/WorkspaceClient.tsx`: Statement/notes UI and problem metadata hierarchy.
- `src/app/globals.css`: Compact statement and expanded notes sizing.

## Dev Mode
TESTING

## State Log
- 2026-09-16: Fixed the in-flight autosave race and reload recovery loss, then compacted the statement and secondary controls so notes remain the primary writing surface.
