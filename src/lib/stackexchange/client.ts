import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/db/service";
import { limits, stackExchangeConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { licenseForPost } from "./license";
import { postBodyToText } from "./html";

/**
 * Math Stack Exchange lookup.
 *
 * Only problem-statement search terms leave this application: no notes, no
 * conversation, no folder names, no account identity. Responses are cached by
 * normalized query and API parameters, and the documented backoff is honored.
 */

const API_ROOT = "https://api.stackexchange.com/2.3";
const SITE = "math";
/** The built-in filter that includes question and answer bodies. */
const BODY_FILTER = "withbody";

export interface MseAnswer {
  answerId: number;
  questionId: number;
  score: number;
  isAccepted: boolean;
  bodyText: string;
  author: string | null;
  license: string;
  url: string;
  revisionLink: string;
}

export interface MseQuestion {
  questionId: number;
  title: string;
  bodyText: string;
  url: string;
  license: string;
  author: string | null;
  isAnswered: boolean;
  score: number;
}

export type LookupOutcome =
  | { kind: "found"; questions: MseQuestion[]; answers: MseAnswer[]; fromCache: boolean }
  | { kind: "no_result"; fromCache: boolean }
  /** Distinct from "no result": an unavailable search never "found nothing". */
  | { kind: "unavailable"; reason: string };

/** Honors the API's own backoff instruction across calls in this process. */
let backoffUntil = 0;

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function cacheKey(queries: string[], params: Record<string, string>): string {
  const payload = JSON.stringify({ queries: queries.map(normalizeQuery).sort(), params });
  return createHash("sha256").update(payload).digest("hex");
}

async function readCache(key: string) {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("mse_lookup_cache")
    .select("*")
    .eq("cache_key", key)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data;
}

async function writeCache(
  key: string,
  normalizedQuery: string,
  params: Record<string, string>,
  outcome: "found" | "no_result" | "unavailable",
  response: unknown,
): Promise<void> {
  if (outcome === "unavailable") return; // Never cache an outage as an answer.
  const supabase = createServiceClient();
  const ttl = stackExchangeConfig().cacheTtlSeconds;
  await supabase.from("mse_lookup_cache").upsert({
    cache_key: key,
    normalized_query: normalizedQuery,
    api_params: params,
    response: response as Record<string, unknown>,
    outcome,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
}

interface ApiWrapper<T> {
  items?: T[];
  backoff?: number;
  quota_remaining?: number;
  error_message?: string;
}

async function apiGet<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<ApiWrapper<T>> {
  if (Date.now() < backoffUntil) {
    throw new AppError("RATE_LIMITED", "search backoff in effect");
  }

  const config = stackExchangeConfig();
  const url = new URL(`${API_ROOT}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("site", SITE);
  if (config.key) url.searchParams.set("key", config.key);

  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new AppError("UPSTREAM_UNAVAILABLE", `Stack Exchange returned ${response.status}`);
  }

  const payload = (await response.json()) as ApiWrapper<T>;
  if (payload.backoff) {
    // The API requires honoring this before the next request of the same kind.
    backoffUntil = Date.now() + payload.backoff * 1000;
  }
  if (payload.error_message) {
    throw new AppError("UPSTREAM_UNAVAILABLE", payload.error_message.slice(0, 200));
  }
  return payload;
}

interface RawQuestion {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  is_answered: boolean;
  score: number;
  answer_count: number;
  content_license?: string;
  creation_date?: number;
  last_edit_date?: number;
  owner?: { display_name?: string };
}

interface RawAnswer {
  answer_id: number;
  question_id: number;
  body?: string;
  score: number;
  is_accepted: boolean;
  content_license?: string;
  creation_date?: number;
  last_edit_date?: number;
  owner?: { display_name?: string };
}

/**
 * Runs at most three queries, inspects a bounded number of questions, and
 * retrieves a bounded number of answers per question.
 */
export async function lookupSolutions(queries: string[], signal?: AbortSignal): Promise<LookupOutcome> {
  const bounded = queries.slice(0, limits.maxMseQueries).filter((query) => query.trim().length > 2);
  if (bounded.length === 0) return { kind: "no_result", fromCache: false };

  const params = { sort: "relevance", order: "desc", pagesize: String(limits.maxMseQuestions), filter: BODY_FILTER };
  const key = cacheKey(bounded, params);

  const cached = await readCache(key);
  if (cached) {
    const payload = cached.response as { questions: MseQuestion[]; answers: MseAnswer[] };
    return cached.outcome === "found"
      ? { kind: "found", questions: payload.questions, answers: payload.answers, fromCache: true }
      : { kind: "no_result", fromCache: true };
  }

  const questions: MseQuestion[] = [];
  try {
    for (const query of bounded) {
      const result = await apiGet<RawQuestion>("/search/advanced", { ...params, q: query }, signal);
      for (const item of result.items ?? []) {
        if (questions.some((existing) => existing.questionId === item.question_id)) continue;
        if (item.answer_count === 0) continue;
        questions.push({
          questionId: item.question_id,
          title: item.title,
          bodyText: postBodyToText(item.body ?? ""),
          url: item.link,
          license: licenseForPost(item),
          author: item.owner?.display_name ?? null,
          isAnswered: item.is_answered,
          score: item.score,
        });
      }
      if (questions.length >= limits.maxMseQuestions) break;
    }
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof AppError ? error.detail ?? error.code : "search failed" };
  }

  const inspected = questions.slice(0, limits.maxMseQuestions);
  if (inspected.length === 0) {
    await writeCache(key, bounded.join(" | "), params, "no_result", { questions: [], answers: [] });
    return { kind: "no_result", fromCache: false };
  }

  let answers: MseAnswer[] = [];
  try {
    const ids = inspected.map((question) => question.questionId).join(";");
    const result = await apiGet<RawAnswer>(
      `/questions/${ids}/answers`,
      { sort: "votes", order: "desc", pagesize: String(limits.maxMseQuestions * limits.maxMseAnswersPerQuestion), filter: BODY_FILTER },
      signal,
    );

    const perQuestion = new Map<number, number>();
    for (const item of result.items ?? []) {
      const seen = perQuestion.get(item.question_id) ?? 0;
      if (seen >= limits.maxMseAnswersPerQuestion) continue;
      perQuestion.set(item.question_id, seen + 1);
      answers.push({
        answerId: item.answer_id,
        questionId: item.question_id,
        score: item.score,
        isAccepted: item.is_accepted,
        bodyText: postBodyToText(item.body ?? ""),
        author: item.owner?.display_name ?? null,
        license: licenseForPost(item),
        url: `https://math.stackexchange.com/a/${item.answer_id}`,
        revisionLink: `https://math.stackexchange.com/posts/${item.answer_id}/revisions`,
      });
    }
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof AppError ? error.detail ?? error.code : "answer fetch failed" };
  }

  // An accepted or highly scored answer is a starting point, not evidence.
  answers = answers.sort((a, b) => Number(b.isAccepted) - Number(a.isAccepted) || b.score - a.score);

  if (answers.length === 0) {
    await writeCache(key, bounded.join(" | "), params, "no_result", { questions: inspected, answers: [] });
    return { kind: "no_result", fromCache: false };
  }

  await writeCache(key, bounded.join(" | "), params, "found", { questions: inspected, answers });
  return { kind: "found", questions: inspected, answers, fromCache: false };
}
