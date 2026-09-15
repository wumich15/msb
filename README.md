# Math Study Buddy

Math Study Buddy is a private, typed-math study workspace. Learners organize
problems, keep Markdown/LaTeX notes, request restrained AI tutoring only after a
server-checked reference is ready, find method-related MathNET problems, and
export their study record.

## Local development

Requirements: Node 20.9+, Docker, the Supabase CLI, and provider credentials only
for the AI-backed features.

1. Copy `.env.example` to `.env.local` and fill the local Supabase keys printed by
   `supabase start`. Keep `SUPABASE_SECRET_KEY` server-only.
2. Run `supabase start`, then `supabase db reset` to apply every migration and the
   empty seed. Generate checked schema types with `npm run db:types`.
3. Run `npm install`, `npm run dev`, and `npm run inngest:dev` in a second terminal.
   Configure Inngest to serve the app endpoint at `/api/inngest`.
4. Open `http://localhost:3000`. Local magic-link mail appears in Inbucket at
   `http://localhost:54324`.

The note-taking, status, sign-out, settings, account deletion, and export paths do
not require Anthropic, Voyage, Stack Exchange, or Inngest to be available. AI
actions return an operational error and preserve drafts when a provider is down.

## MathNET catalog

Use an immutable, rights-reviewed MathNET export; never point production at a
moving dataset revision.

1. Set `MATHNET_SOURCE_FILE`, `MATHNET_DATASET_ID`, and
   `MATHNET_RELEASE_REVISION`.
2. Run `npm run mathnet:inspect` and review the emitted columns, license groups,
   samples, checksum, and exclusion counts.
3. Run `npm run mathnet:import`. It normalizes JSON/JSONL records, quarantines
   non-English, diagram-dependent, solution-less, or uncleared records, writes a
   manifest, and creates 100–300 eligible development fixtures when available.
4. Set pinned Anthropic/Voyage model IDs and run `npm run mathnet:index`. The index
   builder classifies and embeds every eligible record; the database activates the
   release atomically only if all eligible rows validate.

Changing the embedding model or dimension requires a migration and complete index
rebuild. MathNET solution rows and derived method profiles are server-only.

## Verification

- `npm run typecheck` — strict TypeScript
- `npm run lint` — Next.js, React, and accessibility linting
- `npm test` — deterministic unit/integration tests
- `npm run test:e2e` — browser journeys (requires a running disposable stack)
- `npm run evals:run -- --enforce` — reviewed launch-fixture gate
- `npm run build` — production compilation

Integration and browser tests should always use a disposable Supabase project and
two accounts. Provider fakes belong in tests; deterministic CI must not call live
Anthropic, Voyage, Stack Exchange, or Inngest services.

## Deployment

Use separate Supabase, storage, provider, and Inngest credentials for development,
staging, and production. Set the public origin and auth callback URLs exactly,
apply migrations before deploying the app, expose `/api/inngest` over HTTPS, and
verify Inngest signing. Keep the export bucket private and run the scheduled job
reconciler/24-hour export cleanup.

Before production, import a reviewed catalog, complete the held-out evaluation
set, run two-account RLS tests, verify real magic links and job callbacks, inspect
ZIP contents for hidden references, and rehearse account deletion and catalog
rollback. Current scope is typed English text-complete problems; handwriting,
OCR, diagram interpretation, uploads, collaboration, native mobile, billing,
spaced repetition, and PDF export are deliberately excluded.
