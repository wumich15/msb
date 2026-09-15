import "server-only";
import { createHash } from "node:crypto";
import { aiConfig, limits, versions } from "@/lib/config";
import { callModelForJson, untrustedBlock } from "@/lib/ai/anthropic";
import { ideaProfileSchema, type IdeaProfileSchema } from "@/lib/ai/schemas";
import { classifierPrompt } from "@/prompts";
import { keepKnownIdeas, vocabularyForPrompt } from "@/lib/mathnet/taxonomy";

/**
 * Idea classification.
 *
 * A statement-only profile is provisional and low-confidence: the solution idea is
 * usually not visible from the statement. A checked reference or the learner's own
 * completed work produces a stronger profile, and the evidence kind is recorded so
 * a weak label can never masquerade as a strong one.
 */

export type EvidenceKind = "statement_only" | "user_supplied_work" | "checked_reference";

export interface ClassificationInput {
  statement: string;
  /** The approach the learner actually used, when it is available. */
  work?: string | null;
  referenceSolution?: string | null;
  evidenceKind: EvidenceKind;
}

export interface ClassificationResult {
  profile: IdeaProfileSchema;
  evidenceKind: EvidenceKind;
  inputHash: string;
  classifierVersion: string;
  usage: { inputTokens: number; outputTokens: number; requestIds: string[] };
}

/** Cache key: identical inputs and classifier version never re-run the model. */
export function classificationInputHash(input: ClassificationInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        statement: input.statement,
        work: input.work ?? "",
        reference: input.referenceSolution ?? "",
        evidenceKind: input.evidenceKind,
        version: `${versions.classifier}:${classifierPrompt.version}`,
      }),
    )
    .digest("hex");
}

const CONFIDENCE_CEILING: Record<EvidenceKind, number> = {
  // Missing evidence must lower confidence, whatever the model reports.
  statement_only: 0.4,
  user_supplied_work: 0.75,
  checked_reference: 1,
};

export async function classifyProblem(input: ClassificationInput): Promise<ClassificationResult> {
  const config = aiConfig();

  const blocks = [
    untrustedBlock("problem_statement", input.statement, limits.statementChars),
    `<idea_vocabulary>\n${vocabularyForPrompt()}\n</idea_vocabulary>`,
  ];
  if (input.referenceSolution) {
    blocks.push(untrustedBlock("checked_solution", input.referenceSolution, 30_000));
  }
  if (input.work) {
    blocks.push(untrustedBlock("learner_work", input.work, 30_000));
  }
  blocks.push(`<evidence_kind>${input.evidenceKind}</evidence_kind>`);

  const result = await callModelForJson(
    {
      model: config.classifierModel,
      system: classifierPrompt.system,
      user: blocks.join("\n\n"),
      maxTokens: 1_500,
      retries: 1,
    },
    ideaProfileSchema,
  );

  const profile = normalizeProfile(result.value, input.evidenceKind);

  return {
    profile,
    evidenceKind: input.evidenceKind,
    inputHash: classificationInputHash(input),
    classifierVersion: `${versions.classifier}:${classifierPrompt.version}`,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      requestIds: result.requestId ? [result.requestId] : [],
    },
  };
}

export function normalizeProfile(profile: IdeaProfileSchema, evidenceKind: EvidenceKind): IdeaProfileSchema {
  const idea_ids = keepKnownIdeas(profile.idea_ids);
  const secondary_idea_ids = keepKnownIdeas(profile.secondary_idea_ids).filter((id) => !idea_ids.includes(id));

  // An empty or unrecognized label set means the evidence did not support one.
  const resolved = idea_ids.length > 0 ? idea_ids : ["unknown"];
  const ceiling = CONFIDENCE_CEILING[evidenceKind];
  const confidence = resolved.includes("unknown")
    ? Math.min(profile.confidence, 0.25)
    : Math.min(profile.confidence, ceiling);

  return { ...profile, idea_ids: resolved, secondary_idea_ids, confidence };
}

/**
 * Tags safe to show while a problem is unfinished: drawn from the learner's own
 * notes rather than from a solution they have not seen.
 */
export function safeTagsFrom(profile: IdeaProfileSchema, evidenceKind: EvidenceKind): string[] {
  if (evidenceKind !== "user_supplied_work") return [];
  return profile.idea_ids.filter((id) => id !== "unknown");
}
