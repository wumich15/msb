import { z } from "zod";

/**
 * Structured output contracts for every model call.
 *
 * Each response is validated against its schema before anything is stored or
 * shown. A response that does not parse is a failure, not a partial result.
 */

export const referenceArtifactSchema = z.object({
  /** The exact problem being solved, restated so a mismatch is detectable. */
  restated_problem: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  domain_restrictions: z.array(z.string()).default([]),
  notation: z.array(z.string()).default([]),
  /** A full worked proof or derivation: every substantial step, with its reason. */
  steps: z
    .array(z.object({ claim: z.string().min(1), justification: z.string().min(1) }))
    .min(1, "A reference must contain worked steps."),
  boundary_cases: z.array(z.string()).default([]),
  subparts: z.array(z.object({ label: z.string(), conclusion: z.string() })).default([]),
  /** A conclusion that answers the original question. */
  conclusion: z.string().min(1),
  provenance_note: z.string().default(""),
});

export type ReferenceArtifactSchema = z.infer<typeof referenceArtifactSchema>;

export const checkResultSchema = z.object({
  statement_match: z.boolean(),
  logical_step_coverage: z.boolean(),
  assumptions_and_cases: z.boolean(),
  conclusion_answers_question: z.boolean(),
  unresolved_gaps: z.array(z.string()).default([]),
  /** What the checker actively tried to break, so a bare "looks fine" is visible. */
  counterexample_attempts: z.array(z.string()).default([]),
  summary: z.string().min(1),
  passed: z.boolean(),
});

export type CheckResultSchema = z.infer<typeof checkResultSchema>;

/**
 * A check only passes when every required component passed and nothing is
 * unresolved. The model's own `passed` flag is necessary but never sufficient.
 */
export function checkPasses(result: CheckResultSchema): boolean {
  return (
    result.passed &&
    result.statement_match &&
    result.logical_step_coverage &&
    result.assumptions_and_cases &&
    result.conclusion_answers_question &&
    result.unresolved_gaps.length === 0
  );
}

export const tutorResponseSchema = z.object({
  mode: z.enum(["default", "stronger_hint", "full_solution", "clarification", "abstain"]),
  text: z.string().min(1),
  /** The line in the learner's notes the response points at, quoted verbatim. */
  cited_note_excerpt: z.string().nullable().default(null),
  spoiler_level: z.enum(["none", "low", "medium", "full"]),
});

export type TutorResponseSchema = z.infer<typeof tutorResponseSchema>;

export const ideaProfileSchema = z.object({
  /** Statement-level MathNet topic roots; deliberately separate from solution ideas. */
  problem_categories: z.array(z.enum(["algebra", "combinatorics", "geometry", "number theory"])).max(2).default([]),
  /** Roughly one to three main ideas, drawn from the controlled vocabulary. */
  idea_ids: z.array(z.string()).max(3).default([]),
  secondary_idea_ids: z.array(z.string()).max(3).default([]),
  /** The particular mechanism, in one or two sentences. */
  mechanism: z.string().default(""),
  object_roles: z.array(z.object({ object: z.string(), role: z.string() })).default([]),
  prerequisites: z.array(z.string()).default([]),
  evidence: z.array(z.object({ snippet: z.string(), source: z.string() })).default([]),
  estimated_difficulty: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
});

export type IdeaProfileSchema = z.infer<typeof ideaProfileSchema>;

export const rerankResultSchema = z.object({
  results: z
    .array(
      z.object({
        /** Must be one of the candidate ids that were supplied. */
        candidate_id: z.string(),
        /** Specific shared mechanism, not a topic label. */
        shared_mechanism: z.string().min(1),
        relationship: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  no_confident_match: z.boolean().default(false),
});

export type RerankResultSchema = z.infer<typeof rerankResultSchema>;

export const mseMatchSchema = z.object({
  /** Whether this answer actually solves the stated problem, not a relative of it. */
  matches: z.boolean(),
  mismatch_reasons: z.array(z.string()).default([]),
  extracted_solution: referenceArtifactSchema.nullable().default(null),
});

export type MseMatchSchema = z.infer<typeof mseMatchSchema>;

export const searchQueriesSchema = z.object({
  queries: z.array(z.string().min(3)).min(1).max(3),
});
