# Workspace Sidebar

## Summary
The workspace sidebar is the left panel of `/workspace` (`.panel-projects`). It owns the
browse-and-create surface for the two things a study session is organized around: **projects**
(folders) and **problems**. It renders the project list with per-project problem counts, the
project rename/delete controls, both add forms, the status filter, and the filtered problem list.

It is one of three panels inside a CSS grid (`.workspace`). On wide screens all three panels are
side by side; at `max-width: 900px` the grid collapses to a single column and the panels become
tabs (`.panel-tabs`). The sidebar reads that breakpoint through `useMediaQuery` so it only honours
the tab selection when tabs are actually on screen.

Creation is server-authoritative. `POST /api/folders` writes a folder document directly;
`POST /api/problems` delegates to the `createProblem` transaction, which creates the problem, its
first immutable statement version, the notes row, the assistant session, and the created event in
one commit. The sidebar holds no optimistic local rows — it appends whatever the server projects
back.

## Key Points
- **Panels may only be hidden on the tab layout.** `hidden` must be gated on `tabbedLayout`, never
  applied at all widths. `.panel-editor` and `.panel-assistant` declare `display: flex`, which is
  an author rule and therefore outranks the user-agent `[hidden] { display: none }` rule, so those
  two stayed visible regardless. `.panel-projects` declares no `display`, so the UA rule won and
  the sidebar disappeared on wide screens — where `.panel-tabs { display: none }` also removed the
  only control that could bring it back. The `.panel[hidden] { display: none }` override that makes
  hiding work correctly lives *inside* the `max-width: 900px` media query. That combination made
  the sidebar, and with it every add control, unreachable on desktop.
- **Hydration safety.** `useMediaQuery` is built on `useSyncExternalStore` with a server snapshot of
  `false`, so the server renders the wide (nothing-hidden) layout and React re-renders with the real
  match after hydration. Reading `window.matchMedia` during render would break SSR.
- **A project must exist before a problem can.** Every problem belongs to exactly one folder, so the
  new-problem form is disabled until a project is selected, and the label names the target project.
  Creating a project selects it immediately, which makes create-project → create-problem a single
  uninterrupted flow.
- **Adding a problem switches to the notes panel.** On the tab layout the new problem's editor is a
  different tab, so without the switch the problem appears to vanish. It is a no-op on wide screens.
- **Both add forms are single-shot.** A `creating` state disables both submit buttons and guards
  both handlers while a request is in flight; `flushEditors()` is awaited *inside* the guarded
  region, since that await was the window in which a second click could create a duplicate.
- **Counts are complete because the list is.** `problemCounts` is derived from the `problems` array,
  which `/api/problems` returns unfiltered for the whole user; the folder filter is applied in
  memory. If problem loading ever becomes per-folder, the counts silently become wrong.
- **Empty states distinguish two causes.** "No problems yet" and "none match this project and
  status" are different problems with different fixes, so they are worded differently.
- **Status is never carried by colour alone.** `.row-count` and `.status-badge` stay monochrome,
  matching the design rule used across the app.

## Relevant Files
- `src/components/WorkspaceClient.tsx`: the sidebar markup, `createFolder` / `createProblem`, the
  `problemCounts` and `selectedFolder` derivations, and the panel `hidden` gating.
- `src/hooks/useMediaQuery.ts`: `useSyncExternalStore` media-query hook and `NARROW_LAYOUT_QUERY`,
  the TypeScript mirror of the CSS breakpoint.
- `src/app/globals.css`: `.workspace` grid, `.panel*` rules, `.tree-list` / `.problem-list` /
  `.row-button` / `.row-count`, and the `max-width: 900px` tab layout.

Dependencies (not owned by this feature): `POST/GET /api/folders` and `POST/GET /api/problems`,
`src/lib/validation.ts` (name and title limits), and `src/lib/db/transactions/core.ts`
(`createProblem`).

## Dev Mode
PRODUCTION-READY

## State Log
- 2026-09-16: Initialized the feature file. Made the sidebar reachable on desktop by gating panel
  `hidden` on the tab layout, added the `useMediaQuery` hook, and expanded the add flows with
  labelled buttons, placeholders, per-project problem counts, project-scoped new-problem labelling,
  and distinct empty states.
- 2026-09-16: Hardened the add flows — both submit buttons now report progress and are locked while
  a create request is in flight, and the per-project count exposes its unit to screen readers via
  `.visually-hidden` text instead of an `aria-label` on a roleless `<span>`. Typecheck, lint, and
  the 19 unit tests pass.
- 2026-09-16: Added an accessible desktop collapse control and matching compact grid state so the project sidebar can be hidden without affecting the narrow-screen panel tabs.
