# Continue — Math Study Buddy

This file records the state after implementing the local MVP described in
[`Claude.MD`](./Claude.MD). The application code is complete and passes local
static/unit/build verification. The unchecked items below require external
credentials, a pinned real dataset, a disposable Supabase stack, or deployment;
they cannot be truthfully completed from source code alone.

## Completed implementation

- [x] Added the authenticated `/workspace` and `/settings` routes.
- [x] Built the responsive three-panel workspace and mobile Projects/Notes/Assistant tabs.
- [x] Added folder and problem creation, rename, move, filtering, status changes, and confirmed deletion.
- [x] Added separate statement and notes editors, sanitized Markdown/KaTeX previews, visible parse errors, autosave state, conflict recovery, and reload-safe local drafts.
- [x] Flushes notes and statements before navigation, chat, completion, and export.
- [x] Persists the selected problem in the URL and reconnects to active preparation, tutoring, recommendation, and export jobs after reload.
- [x] Added the exact assistant choice flow: provide work, find a solution, reuse a saved reference, replace, retry, report, and explicit spoiler reveal.
- [x] Added note-selection attachments, exact note-revision display, default help, stronger hints, and note-question discussion as separate actions.
- [x] Added recommendation no-match/failure states, save, dismiss, and relevance feedback.
- [x] Added problem/folder/account export controls with an explicit reference/spoiler option and short-lived download links.
- [x] Added onboarding disclosure, independent automatic-recommendation settings, account deletion, and draft cleanup on sign-out/account changes.
- [x] Preserved the monochrome Times New Roman design, text/symbol status meanings, visible labels/focus, live status announcements, and mounted mobile panel state.

## Completed backend hardening

- [x] Removed raw job results from browser polling responses and wired safe idea projections into problem payloads.
- [x] Replaced the deprecated middleware convention with the Next.js proxy convention.
- [x] Split request-safe Supabase configuration from the server-only service key.
- [x] Rejects cross-site browser mutations using Origin and Fetch Metadata checks.
- [x] Revoked default execution of security-definer functions from browser roles and explicitly granted only ownership-deriving user RPCs.
- [x] Removed direct browser writes for folders, problems, versions, notes, and study events where they bypassed API/RPC invariants.
- [x] Fixed the concurrent-job limit off-by-one and added an atomic reservation path for jobs committed with automatic state changes.
- [x] Runs the tutoring readiness gate before quota reservation and rechecks it in the atomic chat transaction.
- [x] Releases rejected reservations, records reservations per durable job, reconciles actual usage once, and cleans abandoned/timed-out reservations.
- [x] Added provider call timeouts, abort-aware retry delays, terminal job handling, and visible preparation timeout/failure states.
- [x] Made preparation state writes conditional on owner, statement version, activation generation, and preparation generation.
- [x] Rechecks statement/notes inputs after classification and retrieval before publishing results.
- [x] Enqueues classification after a checked reference becomes ready and after substantive debounced statement saves.
- [x] Makes completion retrieval wait for classification of the learner's final saved work.
- [x] Uses the complete recommendation cache identity: statement version, notes revision, profile hash, release, index version, and retrieval version.
- [x] Treats catalog/exclusion/vector/text query errors as failures rather than empty matches.
- [x] Made problem/folder export scope IDs mandatory.
- [x] Replaced independent export reads with one service-only MVCC snapshot RPC scoped to the requested problem IDs.
- [x] Persists explicit reference reveals so default exports can apply the same spoiler decision; hidden references remain excluded unless requested.

## Completed repository setup and tooling

- [x] Added `.env.example` covering Supabase, Inngest, Anthropic, Voyage, Stack Exchange, MathNET, and usage limits.
- [x] Added local Supabase configuration, empty seed, and ordered hardening migrations.
- [x] Implemented MathNET inspection, normalized import/quarantine/fixture generation, classification/embedding/index construction, validation, and atomic release activation scripts.
- [x] Implemented an evaluation inventory/launch-fixture gate that records model, prompt, taxonomy, and retrieval versions and will not label missing fixtures as passing.
- [x] Added a local/deployment README and documented the migration, worker, provider, catalog, test, and launch workflows.
- [x] Replaced the broken ESLint compatibility config with the native Next.js flat config.
- [x] Added deterministic unit coverage for validation/error mapping, Markdown/KaTeX behavior, safe projections, retrieval fusion/taxonomy filtering, Stack Exchange sanitization/licensing, and export filenames.
- [x] Verified `npm run typecheck`, `npm run lint`, `npm test` (16 tests), `npm run evals:run`, and `npm run build`.

## External launch gates still required

- [ ] Install/start the Supabase CLI and run `supabase db reset`; generate and commit `src/lib/db/database.types.ts` from that live local schema.
- [ ] Run two-account integration/RLS tests against the disposable database, including every table, storage policy, and callable RPC.
- [ ] Supply an immutable real MathNET export and reviewed rights decision, then run inspect/import/index. Confirm that 100–300 eligible fixtures, checksums, quarantines, deduplication, attribution, and indexes match the real source schema.
- [ ] Supply provider credentials and run one live Math Stack Exchange search/answer retrieval. Record backoff, quota, author, revision, license, and attribution behavior.
- [ ] Run the configured Anthropic/Voyage models on the reviewed development set; record measured latency, token usage, cost, context behavior, and final model choices before production.
- [ ] Add independently reviewed evaluation data: at least 20 invalid/incomplete references, 30 tutoring turns, and 30 retrieval queries, split into development and held-out sets. Run `npm run evals:run -- --enforce` and retain scored artifacts.
- [ ] Add provider-backed integration tests and Playwright journeys against the disposable stack (magic link, CRUD/autosave/reload, conflicts, preparation races, tutoring gate, recommendations, exports, sign-out, deletion, and account isolation).
- [ ] Inspect generated ZIP files to confirm default/spoiler contents and attribution, then verify private-bucket expiry and cleanup in the real storage service.
- [ ] Deploy separate staging infrastructure and verify real mail, callback URLs, Inngest signatures/retries/reconciliation, provider outages, quotas, storage, and migration/RLS behavior.
- [ ] Meet the launch quality thresholds from `Claude.MD`, run the learner pilot, measure latency/cost/cache rates, and rehearse backup restore, release rollback, account deletion, and worker incidents.

## Current verification

```text
npm run typecheck  PASS
npm run lint       PASS
npm test           PASS (6 files, 16 tests)
npm run build      PASS
npm run evals:run  PASS (inventory works; launchFixtureReady=false until reviewed fixtures are supplied)
```

The source-level MVP is ready for a configured local stack. Production launch is
intentionally blocked on the external gates above; none should be checked off
without the real dataset, credentials, database policies, and reviewed results.
