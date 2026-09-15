import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/db/service";
import { aiConfig, limits, versions } from "@/lib/config";
import { embed, toVectorLiteral } from "@/lib/ai/voyage";
import { callModelForJson, untrustedBlock } from "@/lib/ai/anthropic";
import { rerankResultSchema } from "@/lib/ai/schemas";
import { rerankerPrompt } from "@/prompts";
import { ideaLabel, ideasToText } from "@/lib/mathnet/taxonomy";
import type { MathnetProblemRow } from "@/lib/db/types";

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
        ideas: [...source.ideaIds].sort(),
        mechanism: source.mechanism ?? "",
        retrieval: versions.retrieval,
        embedding: aiConfig().voyageModel,
      }),
    )
    .digest("hex");
}

async function activeRelease(): Promise<{ id: string; index_version: number } | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("mathnet_releases")
    .select("id, index_version")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`active MathNET release lookup failed: ${error.message}`);
  return (data as { id: string; index_version: number } | null) ?? null;
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

export async function retrieveRelatedProblems(source: RetrievalSource): Promise<RetrievalResult> {
  const supabase = createServiceClient();
  const usage = { inputTokens: 0, outputTokens: 0, requestIds: [] as string[] };
  const profileHash = profileHashFor(source);

  const release = await activeRelease();
  if (!release) {
    return { state: "NO_MATCH", items: [], releaseId: null, indexVersion: 0, profileHash, usage };
  }

  // Everything the learner has already seen, refiltered on every run.
  const { data: exclusionData, error: exclusionError } = await supabase.rpc("mathnet_exclusions_for_user", {
    p_user_id: source.userId,
    p_problem_id: source.problemId,
  });
  if (exclusionError) throw new Error(`MathNET exclusions failed: ${exclusionError.message}`);
  const exclusions = (exclusionData as string[] | null) ?? [];

  const ideaText = ideasToText(source.ideaIds, source.mechanism);
  const embeddings = await embed([source.statement, ideaText || source.statement], "query");
  const [statementVector, ideaVector] = embeddings.vectors;

  const perSource = limits.recommendationCandidatesPerSource;

  // The three candidate queries run in parallel against one database.
  const [byStatement, byIdea, byText] = await Promise.all([
    supabase.rpc("match_mathnet_by_statement", {
      p_release_id: release.id,
      p_embedding: toVectorLiteral(statementVector ?? []),
      p_limit: perSource,
      p_exclude_ids: exclusions,
    }),
    supabase.rpc("match_mathnet_by_idea", {
      p_release_id: release.id,
      p_embedding: toVectorLiteral(ideaVector ?? statementVector ?? []),
      p_limit: perSource,
      p_exclude_ids: exclusions,
    }),
    supabase.rpc("match_mathnet_by_text", {
      p_release_id: release.id,
      p_query: `${source.statement.slice(0, 600)} ${source.ideaIds.map(ideaLabel).join(" ")}`,
      p_idea_ids: source.ideaIds,
      p_limit: perSource,
      p_exclude_ids: exclusions,
    }),
  ]);
  for (const result of [byStatement, byIdea, byText]) {
    if (result.error) throw new Error(`MathNET candidate retrieval failed: ${result.error.message}`);
  }

  const fused = fuseRankedLists([
    { source: "statement", ids: rowIds(byStatement.data) },
    { source: "idea", ids: rowIds(byIdea.data) },
    { source: "lexical", ids: rowIds(byText.data) },
  ]);

  if (fused.length === 0) {
    return { state: "NO_MATCH", items: [], releaseId: release.id, indexVersion: release.index_version, profileHash, usage };
  }

  const shortlist = fused.slice(0, limits.rerankCandidates);
  const { data: problemRows, error: problemError } = await supabase
    .from("mathnet_problems")
    .select("id, source_id, title, statement_markdown, topics, competition, country")
    .in("id", shortlist.map((candidate) => candidate.mathnetProblemId));
  if (problemError) throw new Error(`MathNET candidate load failed: ${problemError.message}`);

  const problems = new Map(
    ((problemRows ?? []) as MathnetProblemRow[]).map((row) => [row.id, row]),
  );

  // Compact candidate profiles: solution text never enters this prompt.
  const { data: profileRows, error: profileError } = await supabase
    .from("mathnet_solution_data")
    .select("mathnet_problem_id, idea_ids, mechanism, confidence")
    .in("mathnet_problem_id", shortlist.map((candidate) => candidate.mathnetProblemId));
  if (profileError) throw new Error(`MathNET profile load failed: ${profileError.message}`);

  const profiles = new Map(
    ((profileRows ?? []) as Array<{ mathnet_problem_id: string; idea_ids: string[]; mechanism: string | null; confidence: number }>)
      .map((row) => [row.mathnet_problem_id, row]),
  );

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
    const allowed = new Set(shortlist.map((candidate) => candidate.mathnetProblemId));
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

function rowIds(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (row as { mathnet_problem_id?: string }).mathnet_problem_id)
    .filter((id): id is string => typeof id === "string");
}
