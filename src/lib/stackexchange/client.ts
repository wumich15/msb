import "server-only";
import { createHash } from "node:crypto";
import { COLLECTIONS, col } from "@/lib/db/collections";
import type { MseLookupCacheRow } from "@/lib/db/types";
import { limits, stackExchangeConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { licenseForPost } from "./license";
import { postBodyToText } from "./html";

/**
 * MathOverflow / Math Stack Exchange lookup.
 *
 * Only problem-statement search terms leave this application: no notes, no
 * conversation, no folder names, no account identity. Responses are cached by
 * normalized query and API parameters, and the documented backoff is honored.
 */

const API_ROOT = "https://api.stackexchange.com/2.3";
const SITES = ["mathoverflow.net", "math"] as const;
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
  site: (typeof SITES)[number];
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
  site: (typeof SITES)[number];
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

async function readCache(key: string): Promise<MseLookupCacheRow | null> {
  const snapshot = await col(COLLECTIONS.mseLookupCache).doc(key).get();
  if (!snapshot.exists) return null;
  const row = snapshot.data() as MseLookupCacheRow;
  return row.expires_at > new Date().toISOString() ? row : null;
}

async function writeCache(
  key: string,
  normalizedQuery: string,
  params: Record<string, string>,
  outcome: "found" | "no_result" | "unavailable",
  response: unknown,
): Promise<void> {
  if (outcome === "unavailable") return; // Never cache an outage as an answer.
  const ttl = stackExchangeConfig().cacheTtlSeconds;
  const row: MseLookupCacheRow = {
    cache_key: key,
    normalized_query: normalizedQuery,
    api_params: params,
    response,
    outcome,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  };
  await col(COLLECTIONS.mseLookupCache).doc(key).set(row);
}

/** Cached third-party lookups age out on the export-cleanup schedule. */
export async function deleteExpiredLookups(): Promise<number> {
  const snapshot = await col(COLLECTIONS.mseLookupCache).where("expires_at", "<", new Date().toISOString()).limit(200).get();
  await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  return snapshot.size;
}

interface ApiWrapper<T> {
  items?: T[];
  backoff?: number;
  quota_remaining?: number;
  error_message?: string;
}

async function apiGet<T>(path: string, params: Record<string, string>, site: (typeof SITES)[number], signal?: AbortSignal): Promise<ApiWrapper<T>> {
  if (Date.now() < backoffUntil) {
    throw new AppError("RATE_LIMITED", "search backoff in effect");
  }

  const config = stackExchangeConfig();
  const url = new URL(`${API_ROOT}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("site", site);
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
  const key = cacheKey(bounded, { ...params, sites: SITES.join(",") });

  const cached = await readCache(key);
  if (cached) {
    const payload = cached.response as { questions: MseQuestion[]; answers: MseAnswer[] };
    return cached.outcome === "found"
      ? { kind: "found", questions: payload.questions, answers: payload.answers, fromCache: true }
      : { kind: "no_result", fromCache: true };
  }

  const questions: MseQuestion[] = [];
  try {
    for (const site of SITES) {
      let siteQuestions = 0;
      for (const query of bounded) {
        const result = await apiGet<RawQuestion>("/search/advanced", { ...params, q: query }, site, signal);
        for (const item of result.items ?? []) {
          if (questions.some((existing) => existing.questionId === item.question_id && existing.site === site)) continue;
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
            site,
          });
          siteQuestions += 1;
          if (siteQuestions >= limits.maxMseQuestions) break;
        }
        if (siteQuestions >= limits.maxMseQuestions) break;
      }
    }
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof AppError ? error.detail ?? error.code : "search failed" };
  }

  const inspected = questions;
  if (inspected.length === 0) {
    await writeCache(key, bounded.join(" | "), params, "no_result", { questions: [], answers: [] });
    return { kind: "no_result", fromCache: false };
  }

  let answers: MseAnswer[] = [];
  try {
    const perQuestion = new Map<string, number>();
    for (const site of SITES) {
      const ids = inspected.filter((question) => question.site === site).map((question) => question.questionId).join(";");
      if (!ids) continue;
      const result = await apiGet<RawAnswer>(
        `/questions/${ids}/answers`,
        { sort: "votes", order: "desc", pagesize: String(limits.maxMseQuestions * limits.maxMseAnswersPerQuestion), filter: BODY_FILTER },
        site,
        signal,
      );
      const origin = site === "mathoverflow.net" ? "https://mathoverflow.net" : "https://math.stackexchange.com";
      for (const item of result.items ?? []) {
        const questionKey = `${site}:${item.question_id}`;
        const seen = perQuestion.get(questionKey) ?? 0;
        if (seen >= limits.maxMseAnswersPerQuestion) continue;
        perQuestion.set(questionKey, seen + 1);
        answers.push({
          answerId: item.answer_id,
          questionId: item.question_id,
          score: item.score,
          isAccepted: item.is_accepted,
          bodyText: postBodyToText(item.body ?? ""),
          author: item.owner?.display_name ?? null,
          license: licenseForPost(item),
          url: `${origin}/a/${item.answer_id}`,
          revisionLink: `${origin}/posts/${item.answer_id}/revisions`,
          site,
        });
      }
    }
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof AppError ? error.detail ?? error.code : "answer fetch failed" };
  }

  // An accepted or highly scored answer is a starting point, not evidence.
  answers = answers.sort((a, b) =>
    SITES.indexOf(a.site) - SITES.indexOf(b.site) ||
    Number(b.isAccepted) - Number(a.isAccepted) ||
    b.score - a.score,
  );

  if (answers.length === 0) {
    await writeCache(key, bounded.join(" | "), params, "no_result", { questions: inspected, answers: [] });
    return { kind: "no_result", fromCache: false };
  }

  await writeCache(key, bounded.join(" | "), params, "found", { questions: inspected, answers });
  return { kind: "found", questions: inspected, answers, fromCache: false };
}
