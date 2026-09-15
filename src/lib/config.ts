/**
 * Environment configuration.
 *
 * Public variables may contain only genuinely public configuration. Everything
 * else is read lazily on the server so that a missing provider key breaks AI
 * work without breaking note-taking, status changes, sign-out, or export.
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
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  appOrigin: process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000",
};

export function serverConfig() {
  return {
    supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabasePublishableKey: required(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    supabaseSecretKey: required("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY),
    appOrigin: publicConfig.appOrigin,
  };
}

/** Model identifiers are pinned in Phase 0; never a moving alias. */
export function aiConfig() {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    solverModel: process.env.SOLVER_MODEL_ID ?? "claude-opus-5",
    checkerModel: process.env.CHECKER_MODEL_ID ?? "claude-opus-5",
    tutorModel: process.env.TUTOR_MODEL_ID ?? "claude-sonnet-5",
    classifierModel: process.env.CLASSIFIER_MODEL_ID ?? "claude-sonnet-5",
    rerankerModel: process.env.RERANKER_MODEL_ID ?? "claude-sonnet-5",
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
  };
}

/** Initial product limits from the spec; measured and tuned, not guessed again. */
export const limits = {
  statementChars: 20_000,
  notesChars: 50_000,
  questionChars: 4_000,
  selectionChars: 4_000,
  preparationWallClockMs: 5 * 60 * 1000,
  preparationTransientRetries: 2,
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
  retrieval: "retrieval-1",
  classifier: "classifier-1",
  exportSchema: "msb-export-1",
} as const;
