import "server-only";
import { createHash } from "node:crypto";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { aiConfig, limits, mathnetConfig, versions } from "@/lib/config";
import { embed } from "@/lib/ai/voyage";
import { callModelForJson, untrustedBlock } from "@/lib/ai/openai";
import { rerankResultSchema } from "@/lib/ai/schemas";
import { rerankerPrompt } from "@/prompts";
import { ideaLabel, ideasToText } from "@/lib/mathnet/taxonomy";
import { lexicalScore, queryTerms } from "@/lib/mathnet/lexical";
import { sharesMathnetCategory } from "@/lib/mathnet/categories";
import { mathnetExclusionsForUser, readActiveRelease } from "@/lib/db/transactions/mathnet";
import type { MathnetProblemRow, MathnetSolutionDataPrivateRow } from "@/lib/db/types";

/**
 * The retrieval pipeline shared by both recommendation entry points.
 *
 * Nothing here activates solution preparation: a request for related problems is
 * a request for related problems. When no checked reference exists, the source
 * profile comes from the statement and whatever approach the learner expressed,
 * and results are labelled tentative.
 */

export interface RetrievalSource {
  problemId: string;
  userId: string;
  statement: string;
  statementVersion: number;
  /** MathNet topic roots inferred from the statement, not from a solution. */
  problemCategories: string[];
  ideaIds: string[];
  mechanism: string | null;
  /** False when the profile rests on the statement alone. */
  hasSolutionEvidence: boolean;
}

export interface RetrievalCandidate {
  mathnetProblemId: string;
  fusionScore: number;
  sources: string[];
}

export interface RetrievalResult {
  state: "READY" | "NO_MATCH";
  items: Array<{
    mathnetProblemId: string;
    rank: number;
    fusionScore: number;
    relationship: string;
    isTentative: boolean;
  }>;
  releaseId: string | null;
  indexVersion: number;
  profileHash: string;
  usage: { inputTokens: number; outputTokens: number; requestIds: string[] };
}

export function profileHashFor(source: RetrievalSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        statement: source.statement,
        categories: [...source.problemCategories].sort(),
        ideas: [...source.ideaIds].sort(),
        mechanism: source.mechanism ?? "",
        retrieval: versions.retrieval,
        embedding: aiConfig().voyageModel,
      }),
    )
    .digest("hex");
}

/** The complete cache identity of one recommendation run. */
export function recommendationCacheKey(input: {
  userId: string;
  problemId: string;
  statementVersion: number;
  notesRevision: number | null;
  profileHash: string;
  releaseId: string | null;
  indexVersion: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...input, retrieval: versions.retrieval }))
    .digest("hex");
}

/**
 * Reciprocal rank fusion. Idea retrieval is weighted above statement retrieval
 * so that wording similarity alone cannot carry a candidate; the weights are
 * starting points to tune on labelled examples, not probabilities.
 */
const FUSION_WEIGHTS = { idea: 1.6, statement: 1.0, lexical: 0.9 } as const;

export function fuseRankedLists(lists: Array<{ source: keyof typeof FUSION_WEIGHTS; ids: string[] }>): RetrievalCandidate[] {
  const scores = new Map<string, { score: number; sources: Set<string> }>();

  for (const list of lists) {
    const weight = FUSION_WEIGHTS[list.source];
    list.ids.forEach((id, index) => {
      const entry = scores.get(id) ?? { score: 0, sources: new Set<string>() };
      entry.score += weight / (limits.rrfK + index + 1);
      entry.sources.add(list.source);
      scores.set(id, entry);
    });
  }

  return [...scores.entries()]
    .map(([mathnetProblemId, entry]) => ({
      mathnetProblemId,
      fusionScore: entry.score,
      sources: [...entry.sources],
    }))
    .sort((a, b) => b.fusionScore - a.fusionScore);
}

export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

type SolutionRow = MathnetSolutionDataPrivateRow & { id: string };

function eligibleQuery(releaseId: string): Query {
  return col(COLLECTIONS.mathnetSolutionData).where("release_id", "==", releaseId).where("is_eligible", "==", true);
}

/**
 * Nearest neighbours by one vector field. Firestore cannot exclude an arbitrary
 * id list in the query, so the window is widened and exclusions are removed
 * afterwards; if too few survive, the window is enlarged once.
 */
async function vectorCandidates(
  releaseId: string,
  field: "statement_embedding" | "idea_embedding",
  vector: number[],
  excluded: Set<string>,
  limitCount: number,
): Promise<string[]> {
  const mode = mathnetConfig().vectorMode;
  const run = async (window: number): Promise<string[]> => {
    if (mode === "exact") {
      const rows = await eligibleQuery(releaseId).select(field).get();
      return rows.docs
        .map((doc) => ({ id: doc.id, distance: cosineDistance(vector, vectorArray(doc.get(field))) }))
        .filter((row) => !excluded.has(row.id))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limitCount)
        .map((row) => row.id);
    }
    const snapshot = await eligibleQuery(releaseId)
      .findNearest({
        vectorField: field,
        queryVector: FieldValue.vector(vector),
        limit: Math.min(window, 1000),
        distanceMeasure: "COSINE",
        distanceResultField: "vector_distance",
      })
      .get();
    return snapshot.docs.map((doc) => doc.id).filter((id) => !excluded.has(id)).slice(0, limitCount);
  };
  const first = await run(limitCount + excluded.size);
  if (first.length >= limitCount || mode === "exact") return first;
  return run((limitCount + excluded.size) * 3);
}

function vectorArray(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  const maybe = value as { toArray?: () => number[] } | null;
  if (maybe && typeof maybe.toArray === "function") return maybe.toArray();
  return [];
}

/** Lexical + idea-tag candidates, scored in memory over a bounded window. */
async function lexicalCandidates(
  releaseId: string,
  statement: string,
  ideaIds: string[],
  excluded: Set<string>,
  limitCount: number,
): Promise<string[]> {
  const terms = queryTerms(`${statement.slice(0, 1_500)} ${ideaIds.map(ideaLabel).join(" ")}`);
  const window = Math.min(300, (limitCount + excluded.size) * 4);
  const scored = new Map<string, number>();
  const ideaSet = new Set(ideaIds);

  const consider = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
    if (excluded.has(doc.id)) return;
    const data = doc.data() as MathnetSolutionDataPrivateRow;
    const shared = (data.idea_ids ?? []).filter((id) => ideaSet.has(id)).length;
    const score = lexicalScore(data.search_terms ?? [], terms, shared);
    if (score > 0) scored.set(doc.id, Math.max(scored.get(doc.id) ?? 0, score));
  };

  if (terms.length > 0) {
    const snapshot = await eligibleQuery(releaseId).where("search_terms", "array-contains-any", terms).limit(window).get();
    snapshot.docs.forEach(consider);
  }
  if (ideaIds.length > 0) {
    const snapshot = await eligibleQuery(releaseId).where("idea_ids", "array-contains-any", ideaIds.slice(0, 30)).limit(window).get();
    snapshot.docs.forEach(consider);
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limitCount)
    .map(([id]) => id);
}

export async function retrieveRelatedProblems(source: RetrievalSource): Promise<RetrievalResult> {
  const usage = { inputTokens: 0, outputTokens: 0, requestIds: [] as string[] };
  const profileHash = profileHashFor(source);

  const release = await readActiveRelease();
  if (!release) {
    return { state: "NO_MATCH", items: [], releaseId: null, indexVersion: 0, profileHash, usage };
  }

  // Everything the learner has already seen, refiltered on every run.
  const excluded = new Set(await mathnetExclusionsForUser(source.userId, source.problemId, release.id));

  const ideaText = ideasToText(source.ideaIds, source.mechanism);
  const embeddings = await embed([source.statement, ideaText || source.statement], "query");
  const [statementVector, ideaVector] = embeddings.vectors;

  const perSource = limits.recommendationCandidatesPerSource;

  // The three candidate queries run in parallel against one database.
  const [byStatement, byIdea, byText] = await Promise.all([
    vectorCandidates(release.id, "statement_embedding", statementVector ?? [], excluded, perSource),
    vectorCandidates(release.id, "idea_embedding", ideaVector ?? statementVector ?? [], excluded, perSource),
    lexicalCandidates(release.id, source.statement, source.ideaIds, excluded, perSource),
  ]);

  const fused = fuseRankedLists([
    { source: "statement", ids: byStatement },
    { source: "idea", ids: byIdea },
    { source: "lexical", ids: byText },
  ]);

  if (fused.length === 0) {
    return { state: "NO_MATCH", items: [], releaseId: release.id, indexVersion: release.index_version, profileHash, usage };
  }

  // Category is a boundary, not evidence of a shared trick. Restrict the pool by
  // statement topic before the idea-level reranker sees any candidates.
  const candidateDocs = await col(COLLECTIONS.mathnetProblems).firestore.getAll(
    ...fused.map((candidate) => col(COLLECTIONS.mathnetProblems).doc(candidate.mathnetProblemId)),
  );
  const candidateProblems = new Map<string, MathnetProblemRow>();
  for (const doc of candidateDocs) {
    if (doc.exists) candidateProblems.set(doc.id, { ...(doc.data() as MathnetProblemRow), id: doc.id });
  }
  const shortlist = fused
    .filter((candidate) => {
      const problem = candidateProblems.get(candidate.mathnetProblemId);
      return problem ? sharesMathnetCategory(problem.topics ?? [], source.problemCategories) : false;
    })
    .slice(0, limits.rerankCandidates);
  if (shortlist.length === 0) {
    return { state: "NO_MATCH", items: [], releaseId: release.id, indexVersion: release.index_version, profileHash, usage };
  }
  const shortlistIds = shortlist.map((candidate) => candidate.mathnetProblemId);
  const profileDocs = await col(COLLECTIONS.mathnetSolutionData).firestore.getAll(
      ...shortlistIds.map((id) => col(COLLECTIONS.mathnetSolutionData).doc(id)),
      { fieldMask: ["idea_ids", "mechanism", "confidence"] },
    );
  const problems = candidateProblems;
  // Compact candidate profiles: solution text never enters this prompt.
  const profiles = new Map<string, Pick<SolutionRow, "idea_ids" | "mechanism" | "confidence">>();
  for (const doc of profileDocs) if (doc.exists) profiles.set(doc.id, doc.data() as SolutionRow);

  const candidateBlock = shortlist
    .map((candidate) => {
      const problem = problems.get(candidate.mathnetProblemId);
      const profile = profiles.get(candidate.mathnetProblemId);
      if (!problem) return null;
      return [
        `id: ${candidate.mathnetProblemId}`,
        `ideas: ${(profile?.idea_ids ?? []).map(ideaLabel).join("; ") || "unknown"}`,
        `mechanism: ${profile?.mechanism ?? "unknown"}`,
        `statement: ${problem.statement_markdown.slice(0, 700)}`,
      ].join("\n");
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n\n---\n\n");

  let ranked: Array<{ candidate_id: string; relationship: string; confidence: number }> = [];
  let noConfidentMatch = false;

  try {
    // Exactly one bounded reranking call per uncached run.
    const result = await callModelForJson(
      {
        model: aiConfig().rerankerModel,
        system: rerankerPrompt.system,
        user: [
          untrustedBlock("source_problem", source.statement, 8_000),
          `<source_ideas>${ideaText || "unknown"}</source_ideas>`,
          untrustedBlock("candidates", candidateBlock, 30_000),
        ].join("\n\n"),
        maxTokens: 2_000,
        retries: 1,
      },
      rerankResultSchema,
    );
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    if (result.requestId) usage.requestIds.push(result.requestId);

    noConfidentMatch = result.value.no_confident_match;
    // Candidate ids must come from the retrieved set; anything else is discarded.
    const allowed = new Set(shortlistIds);
    ranked = result.value.results.filter((entry) => allowed.has(entry.candidate_id));
  } catch {
    // Without a reranker, fall back to fusion order but keep the results tentative.
    ranked = shortlist.slice(0, limits.recommendationResultsMax).map((candidate) => ({
      candidate_id: candidate.mathnetProblemId,
      relationship: "Retrieved by shared idea tags and statement similarity.",
      confidence: 0.3,
    }));
  }

  if (noConfidentMatch || ranked.length === 0) {
    return { state: "NO_MATCH", items: [], releaseId: release.id, indexVersion: release.index_version, profileHash, usage };
  }

  const fusionById = new Map(fused.map((candidate) => [candidate.mathnetProblemId, candidate.fusionScore]));

  // Three to five where available; never weak matches merely to fill five slots.
  const items = ranked.slice(0, limits.recommendationResultsMax).map((entry, index) => ({
    mathnetProblemId: entry.candidate_id,
    rank: index + 1,
    fusionScore: fusionById.get(entry.candidate_id) ?? 0,
    relationship: entry.relationship,
    isTentative: !source.hasSolutionEvidence || (profiles.get(entry.candidate_id)?.confidence ?? 0) < 0.4,
  }));

  return { state: "READY", items, releaseId: release.id, indexVersion: release.index_version, profileHash, usage };
}
