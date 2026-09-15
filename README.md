# Math Study Buddy

Math Study Buddy is a private, typed-math study workspace. Learners organize
problems, keep Markdown/LaTeX notes, request restrained AI tutoring only after a
server-checked reference is ready, find method-related MathNET problems, and
export their study record.

The application runs on Firebase: Firebase Authentication (email link, exchanged
for a server-minted session cookie), Cloud Firestore (all study records, jobs,
catalog, and vector search), Cloud Storage for Firebase (private export
archives), and Firebase App Hosting for the Next.js app. Durable background jobs
run through Inngest functions served from `/api/inngest`.

## Local development

Requirements: Node 20.9+, the Firebase CLI (`npm i -g firebase-tools`), a Java
runtime for the emulators (`brew install openjdk@21`, then put
`/opt/homebrew/opt/openjdk@21/bin` on your `PATH`), and provider credentials only
for the AI-backed features.

1. Copy `.env.example` to `.env.local`. The defaults point at the emulators with
   the demo project `demo-math-study-buddy`; no Firebase credentials are needed.
2. Run `npm install`, then `npm run emulators` (Auth, Firestore, Storage, and the
   Emulator UI at `http://localhost:4000`).
3. Run `npm run dev`, and `npm run inngest:dev` in a second terminal. Configure
   Inngest to serve the app endpoint at `/api/inngest`.
4. Open `http://localhost:3000`. Sign-in links sent by the Auth emulator are
   printed in the emulator terminal and shown in the Emulator UI.

The note-taking, status, sign-out, settings, account deletion, and export paths do
not require OpenAI, Voyage, Stack Exchange, or Inngest to be available. AI
actions return an operational error and preserve drafts when a provider is down.

### How access control works

The browser never talks to Firestore or Storage. `firestore.rules` and
`storage.rules` deny all client-SDK access; every read and write goes through the
API routes, which verify the `__session` cookie with the Admin SDK and derive the
owner on the server. Compound writes (problem creation, note saves, statement
versions, status changes, the tutoring readiness gate, chat requests, reference
selection and publication, budget reservations) are Firestore transactions in
`src/lib/db/transactions/`, each of which re-checks `user_id` before writing.

## Firebase project setup

1. Create separate Firebase projects for development, staging, and production and
   enable Authentication (Email/Password provider with **Email link** sign-in),
   Firestore (Native mode), and Storage.
2. Add each deployed origin to Authentication → Settings → Authorized domains.
3. Put the web app config in the `NEXT_PUBLIC_FIREBASE_*` variables and the
   Admin credentials in `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and
   `FIREBASE_PRIVATE_KEY` (or rely on application-default credentials on App
   Hosting, granting the runtime service account `roles/iam.serviceAccountTokenCreator`
   if signed download URLs are wanted; otherwise the authorized download route is used).
4. Deploy rules and indexes before the first request:
   `npm run firebase:deploy:rules`. Vector indexes take a few minutes to build;
   recommendations return "no match" until they are ready.
5. Deploy the app with `firebase deploy --only apphosting` after filling in
   `apphosting.yaml` and creating the referenced secrets in Secret Manager.

## MathNET catalog

Use an immutable, rights-reviewed MathNET export; never point production at a
moving dataset revision.

1. Set `MATHNET_SOURCE_FILE`, `MATHNET_DATASET_ID`, and
   `MATHNET_RELEASE_REVISION`.
2. Run `npm run mathnet:inspect` and review the emitted columns, license groups,
   samples, checksum, and exclusion counts.
3. Run `npm run mathnet:import`. It normalizes JSON/JSONL records, quarantines
   non-English, diagram-dependent, solution-less, or uncleared records, writes a
   manifest, stores statements in `mathnet_problems` and solutions in the
   server-only `mathnet_solution_data` collection, and creates 100–300 eligible
   development fixtures when available.
4. Set pinned OpenAI/Voyage model IDs and run `npm run mathnet:index`. The index
   builder classifies and embeds every eligible record, writes lexical terms and
   Firestore vector values, and activates the release atomically only if all
   eligible rows validate.

Changing the embedding model or dimension requires a new `firestore.indexes.json`
vector dimension and a complete index rebuild. Against the emulator, set
`MATHNET_VECTOR_MODE=exact` so retrieval scans the eligible release in memory
instead of using a deployed vector index.

## Verification

- `npm run typecheck` — strict TypeScript
- `npm run lint` — Next.js, React, and accessibility linting
- `npm test` — deterministic unit tests (no emulator, no providers)
- `npm run test:integration` — two-account transaction, readiness-gate, and
  security-rules tests, run inside `firebase emulators:exec`
- `npm run test:e2e` — browser journeys (requires a running stack)
- `npm run evals:run -- --enforce` — reviewed launch-fixture gate
- `npm run build` — production compilation

Integration tests always use the emulator with the demo project and two
accounts. Provider fakes belong in tests; deterministic CI must not call live
OpenAI, Voyage, Stack Exchange, or Inngest services.

## Deployment

Use separate Firebase projects, provider keys, and Inngest credentials for
development, staging, and production. Set `NEXT_PUBLIC_APP_ORIGIN` and the Auth
authorized domains exactly, deploy rules and indexes before the app, expose
`/api/inngest` over HTTPS, and verify Inngest signing. Keep the export bucket
private (the rules deny all client access) and let the scheduled reconciler and
24-hour export cleanup run.

Before production, import a reviewed catalog, complete the held-out evaluation
set, run the two-account integration tests, verify real email links and session
cookies, verify deployed vector indexes with a recall check against
`MATHNET_VECTOR_MODE=exact`, inspect ZIP contents for hidden references, and
rehearse account deletion and catalog rollback. Current scope is typed English
text-complete problems; handwriting, OCR, diagram interpretation, uploads,
collaboration, native mobile, billing, spaced repetition, and PDF export are
deliberately excluded.
