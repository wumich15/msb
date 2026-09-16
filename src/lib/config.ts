/**
 * Environment configuration.
 *
 * Public variables may contain only genuinely public configuration (the Firebase
 * web API key and project identifiers are public by design; they identify the
 * project and are not credentials). Everything else is read lazily on the server
 * so that a missing provider key breaks AI work without breaking note-taking,
 * status changes, sign-out, or export.
 */

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optionalNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Safe to reach the browser. */
export const publicConfig = {
  appOrigin: process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000",
  firebase: {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
    /** e.g. http://127.0.0.1:10009 during local development; empty in production. */
    authEmulatorUrl: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL ?? "",
  },
};

/** Server-side Firebase Admin settings. Credentials never reach the browser. */
export function firebaseAdminConfig() {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  return {
    projectId: required("FIREBASE_PROJECT_ID", projectId),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? "",
    // Secret Manager and .env files store the key with literal "\n" sequences.
    privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? "",
    sessionCookieDays: optionalNumber(process.env.SESSION_COOKIE_DAYS, 14),
  };
}

/** Model identifiers are pinned in Phase 0; never a moving alias. */
export function aiConfig() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    // Defaults are placeholders; pin the measured model IDs in Phase 0.
    solverModel: process.env.SOLVER_MODEL_ID ?? "gpt-5",
    checkerModel: process.env.CHECKER_MODEL_ID ?? "gpt-5",
    tutorModel: process.env.TUTOR_MODEL_ID ?? "gpt-5-mini",
    classifierModel: process.env.CLASSIFIER_MODEL_ID ?? "gpt-5-mini",
    rerankerModel: process.env.RERANKER_MODEL_ID ?? "gpt-5-mini",
    voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
    voyageModel: process.env.VOYAGE_MODEL_ID ?? "voyage-3",
    voyageDimension: optionalNumber(process.env.VOYAGE_DIMENSION, 1024),
  };
}

export function stackExchangeConfig() {
  return {
    key: process.env.STACK_EXCHANGE_KEY ?? "",
    cacheTtlSeconds: optionalNumber(process.env.MSE_CACHE_TTL_SECONDS, 24 * 60 * 60),
  };
}

export function mathnetConfig() {
  return {
    datasetId: process.env.MATHNET_DATASET_ID ?? "ShadenA/MathNet",
    revision: process.env.MATHNET_RELEASE_REVISION ?? "",
    /**
     * "index" uses Firestore vector search (requires the deployed vector indexes);
     * "exact" scans the eligible release in memory, for the emulator and for
     * checking index recall on small catalogs.
     */
    vectorMode: process.env.MATHNET_VECTOR_MODE === "exact" ? "exact" : "index",
  } as const;
}

/** Initial product limits from the spec; measured and tuned, not guessed again. */
export const limits = {
  statementChars: 20_000,
  notesChars: 50_000,
  questionChars: 4_000,
  selectionChars: 4_000,
  preparationWallClockMs: 5 * 60 * 1000,
  preparationTransientRetries: 2,
  providerCallTimeoutMs: 60_000,
  maxMseQueries: 3,
  maxMseQuestions: 5,
  maxMseAnswersPerQuestion: 3,
  autosaveDebounceMs: 750,
  jobPollIntervalMs: 2_000,
  jobPollMaxIntervalMs: 15_000,
  recommendationCandidatesPerSource: 40,
  rerankCandidates: 15,
  recommendationResultsMin: 3,
  recommendationResultsMax: 5,
  rrfK: 60,
  dailyTokenLimit: optionalNumber(process.env.DAILY_TOKEN_LIMIT, 400_000),
  maxConcurrentAiJobs: optionalNumber(process.env.MAX_CONCURRENT_AI_JOBS, 2),
  exportTtlHours: 24,
} as const;

export const versions = {
  retrieval: "retrieval-2-firestore",
  classifier: "classifier-1",
  exportSchema: "msb-export-1",
} as const;
