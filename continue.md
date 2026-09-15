# Continue — Math Study Buddy

This file records the state after implementing the local MVP described in
[`Claude.MD`](./Claude.MD) and moving the whole application from Supabase to
Firebase. The application code is complete and passes local static, unit,
emulator-backed integration, and build verification. The unchecked items below
require external credentials, a pinned real dataset, or a deployed Firebase
project; they cannot be truthfully completed from source code alone.

## Platform: Firebase

- [x] Replaced Supabase Auth with Firebase Authentication email-link sign-in. The browser completes the link, exchanges a fresh ID token once at `POST /auth/session` (same-origin, `auth_time` within five minutes) for an HTTP-only `__session` cookie minted by the Admin SDK, then discards its client session. Every private request verifies the cookie with revocation checking; sign-out revokes refresh tokens and clears the cookie.
- [x] Replaced Postgres tables, SQL functions, triggers, and row-level security with Firestore collections, TypeScript row types as the schema, and Firestore transactions in `src/lib/db/transactions/` (study records, readiness gate, chat, reference selection/publication, jobs, budget, MathNET, cascade deletes, read-only export snapshot).
- [x] Deny-all `firestore.rules` and `storage.rules`: the browser never uses the Firestore or Storage client SDKs, so ownership is derived on the server in every route and re-checked inside every transaction.
- [x] Deterministic document IDs replace unique constraints: one notes/session document per problem, `<problem>_v<n>` versions, `<problem>_s<version>` chat threads with an allocated `next_sequence`, job IDs derived from owner + idempotency key, chat turns derived from owner + problem + request ID, idea-profile cache IDs from problem + input hash + classifier version.
- [x] Declared composite, array-contains, and 1024-dimension vector indexes in `firestore.indexes.json`, with large text and vector fields excluded from single-field indexing.
- [x] Replaced pgvector and Postgres full-text search with Firestore `findNearest` (cosine, release/eligibility pre-filter, widened windows with post-filtered exclusions), stored stemmed `search_terms` and `idea_ids` arrays queried with `array-contains-any` and scored in memory, and an `exact` vector mode for the emulator and recall checks.
- [x] Moved export archives to a private Cloud Storage bucket under `exports/<user_id>/`, with signed URLs where signing is available and a session-authorized download route otherwise; expiry cleanup deletes the objects.
- [x] Reporting a reference now also retires every READY copy for that statement version, so a reported solution cannot return through "Use the saved reference".
- [x] Kept Inngest for durable jobs (an HTTP callback endpoint that works on App Hosting), with pending-job records committed in the same transaction as their triggering state change and a scheduled reconciler.
- [x] Added `firebase.json`, `.firebaserc` (demo project), `apphosting.yaml`, emulator scripts, and Firebase-oriented `.env.example`, README, and specification text.
- [x] Ported the MathNET import and index-build scripts to the Admin SDK with Firestore vector values.

## Text AI provider: OpenAI

- [x] Replaced the Anthropic Messages API adapter with an OpenAI Chat Completions adapter (`src/lib/ai/openai.ts`) with the same `callModelForJson` contract: JSON mode, schema validation, bounded transient retries, per-call timeouts, request IDs, and ambiguous-billing flags. Reasoning models are sent no sampling temperature. Model IDs default to placeholders and must be pinned in Phase 0.

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
- [x] Uses the Next.js proxy convention for a cookie-presence redirect; pages and routes verify the cookie with the Admin SDK.
- [x] Rejects cross-site browser mutations using Origin and Fetch Metadata checks, including session creation.
- [x] Runs the tutoring readiness gate before quota reservation and rechecks it inside the chat-request transaction and again at publication.
- [x] Releases rejected reservations, records reservations per durable job, reconciles actual usage once, and cleans abandoned/timed-out reservations.
- [x] Added provider call timeouts, abort-aware retry delays, terminal job handling, and visible preparation timeout/failure states.
- [x] Made preparation state writes conditional on owner, statement version, activation generation, and preparation generation.
- [x] Rechecks statement/notes inputs after classification and retrieval before publishing results.
- [x] Enqueues classification after a checked reference becomes ready and after substantive debounced statement saves.
- [x] Makes completion retrieval wait for classification of the learner's final saved work.
- [x] Uses the complete recommendation cache identity (statement version, notes revision, profile hash, release, index version, retrieval version) as a single `cache_key`.
- [x] Treats catalog/exclusion/vector/text query errors as failures rather than empty matches.
- [x] Reads exports through one read-only Firestore transaction (a consistent snapshot) scoped to the requested problem IDs; hidden references are read only when explicitly requested.
- [x] Persists explicit reference reveals so default exports can apply the same spoiler decision.

## Completed repository setup and tooling

- [x] Firebase-oriented `.env.example` covering web config, Admin credentials, emulator hosts, Inngest, OpenAI, Voyage, Stack Exchange, MathNET, and usage limits.
- [x] MathNET inspection, normalized import/quarantine/fixture generation, classification/embedding/lexical-term/index construction, validation, and atomic release activation scripts.
- [x] Evaluation inventory/launch-fixture gate that records model, prompt, taxonomy, and retrieval versions and will not label missing fixtures as passing.
- [x] Deterministic unit coverage for validation/error mapping, Markdown/KaTeX, safe projections, retrieval fusion/taxonomy, lexical tokenization, Stack Exchange sanitization/licensing, and export filenames (7 files, 19 tests).
- [x] Emulator-backed integration coverage (`npm run test:integration`, 3 files, 14 tests): two-account isolation for problems/folders/notes, optimistic concurrency, immutable statement versions, single status events with completion snapshots and jobs, job idempotency/claim/cancel, folder cascade; readiness gate rejection in every pre-ready state, refusal to select unchecked or stale references, chat snapshots and duplicate collapse, publication recheck, statement-change invalidation, off/on re-prompt, reuse, report; budget reservation and one-time reconciliation; and security-rules tests proving owners, other accounts, and anonymous clients are all denied direct access.
- [x] Verified `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, `npm run evals:run`, and `npm run build`.

## External launch gates still required

- [ ] Create the real Firebase projects (development, staging, production), enable email-link sign-in and authorized domains, and deploy `firestore.rules`, `storage.rules`, and `firestore.indexes.json` (`npm run firebase:deploy:rules`); confirm the two vector indexes finish building.
- [ ] Run one real email-link sign-in end to end against a deployed project: link delivery, same-device and cross-device completion, expired/reused links, session-cookie lifetime, revocation on sign-out and account deletion.
- [ ] Supply an immutable real MathNET export and reviewed rights decision, then run inspect/import/index against the emulator and staging. Confirm that 100–300 eligible fixtures, checksums, quarantines, deduplication, attribution, and vector/lexical indexes match the real source schema, and compare `findNearest` recall against `MATHNET_VECTOR_MODE=exact` on a sample.
- [ ] Supply provider credentials and run one live Math Stack Exchange search/answer retrieval. Record backoff, quota, author, revision, license, and attribution behavior.
- [ ] Run the configured OpenAI/Voyage models on the reviewed development set; record measured latency, token usage, cost, context behavior, and final model choices before production.
- [ ] Add independently reviewed evaluation data: at least 20 invalid/incomplete references, 30 tutoring turns, and 30 retrieval queries, split into development and held-out sets. Run `npm run evals:run -- --enforce` and retain scored artifacts.
- [ ] Add provider-backed integration tests and Playwright journeys against the emulator stack (email link, CRUD/autosave/reload, conflicts, preparation races, tutoring gate through the HTTP routes, recommendations, exports, sign-out, deletion, and account isolation through the routes).
- [ ] Inspect generated ZIP files to confirm default/spoiler contents and attribution, then verify signed-URL issuance (service-account signer permission), private-bucket expiry, and cleanup in the real storage bucket.
- [ ] Deploy staging on App Hosting with separate credentials and Secret Manager entries; verify real mail, `__session` cookie forwarding, Inngest signatures/retries/reconciliation, provider outages, quotas, storage, and Firestore index/rules behavior.
- [ ] Meet the launch quality thresholds from `Claude.MD`, run the learner pilot, measure latency/cost/cache rates, and rehearse Firestore export/restore, catalog release rollback, account deletion, and worker incidents.

## Current verification

```text
npm run typecheck          PASS
npm run lint               PASS
npm test                   PASS (7 files, 19 tests)
npm run test:integration   PASS (3 files, 14 tests, Firestore emulator)
npm run build              PASS
npm run evals:run          PASS (inventory works; launchFixtureReady=false until reviewed fixtures are supplied)
```

The source-level MVP is ready for a configured Firebase project and the local
emulator stack. Production launch is intentionally blocked on the external gates
above; none should be checked off without the real dataset, credentials, deployed
rules and indexes, and reviewed results.
