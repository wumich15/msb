import "server-only";
import { z } from "zod";
import { aiConfig, limits } from "@/lib/config";
import { callModelForJson, untrustedBlock } from "@/lib/ai/openai";
import { tutorResponseSchema, type TutorResponseSchema } from "@/lib/ai/schemas";
import { reviewerPrompt, tutorPrompt } from "@/prompts";
import { plainTextExcerpt } from "@/lib/markdown";
import type { ChatMessageRow, ReferenceArtifact, TutorResponseMode } from "@/lib/db/types";

/**
 * Notes-aware tutoring.
 *
 * The context is assembled from the exact notes revision the question was asked
 * against, the current immutable statement version, and the checked reference —
 * each in a clearly separated block, and each labelled as data rather than as
 * instructions.
 */

export interface TutorContextInput {
  statement: string;
  statementVersion: number;
  reference: ReferenceArtifact;
  notesSnapshot: string;
  notesRevision: number;
  selectedExcerpt: string | null;
  question: string;
  responseMode: Exclude<TutorResponseMode, "operational">;
  /** Already filtered to the current statement version by the caller. */
  history: Pick<ChatMessageRow, "role" | "content" | "statement_version">[];
}

export interface TutorUsage {
  inputTokens: number;
  outputTokens: number;
  requestIds: string[];
  needsBillingReconciliation: boolean;
}

export type TutorOutcome =
  | { status: "published"; response: TutorResponseSchema; usage: TutorUsage }
  | { status: "needs_selection"; message: string; usage: TutorUsage }
  | { status: "abstained"; message: string; usage: TutorUsage };

const MODE_ALLOWED_SPOILER: Record<string, TutorResponseSchema["spoiler_level"][]> = {
  default: ["none", "low"],
  discuss_note_question: ["none", "low"],
  stronger_hint: ["none", "low", "medium"],
  full_solution: ["none", "low", "medium", "full"],
};

/** Rough character budget; a request that does not fit asks for a passage instead. */
const CONTEXT_CHAR_BUDGET = 90_000;

function historyBlock(history: TutorContextInput["history"], statementVersion: number): string {
  // Messages about previous statement versions stay visible as study history but
  // never re-enter tutoring context, directly or through a summary.
  const current = history.filter((message) => message.statement_version === statementVersion);
  const recent = current.slice(-8);
  if (recent.length === 0) return "";
  const text = recent
    .map((message) => `${message.role === "user" ? "Learner" : "Tutor"}: ${message.content}`)
    .join("\n\n");
  return untrustedBlock("recent_conversation", text, 12_000);
}

export function buildTutorUserMessage(input: TutorContextInput): string {
  const blocks = [
    untrustedBlock("problem_statement", input.statement, limits.statementChars),
    // The reference is clearly separated from the learner's own work.
    untrustedBlock("checked_reference_solution", JSON.stringify(input.reference, null, 2), 40_000),
    untrustedBlock("learner_notes", input.notesSnapshot, limits.notesChars),
  ];

  if (input.selectedExcerpt) {
    blocks.push(untrustedBlock("selected_passage", input.selectedExcerpt, limits.selectionChars));
  }

  const history = historyBlock(input.history, input.statementVersion);
  if (history) blocks.push(history);

  blocks.push(untrustedBlock("learner_question", input.question, limits.questionChars));
  blocks.push(`<requested_mode>${input.responseMode}</requested_mode>`);

  return blocks.join("\n\n");
}

/**
 * Deterministic checks that do not need a model. These run before and after the
 * reviewer call, because an automated spoiler detector is imperfect and the cheap
 * invariants should not depend on one.
 */
export function violatesResponsePolicy(
  response: TutorResponseSchema,
  requestedMode: TutorContextInput["responseMode"],
  reference: ReferenceArtifact,
): string | null {
  const allowed = MODE_ALLOWED_SPOILER[requestedMode] ?? ["none"];
  if (!allowed.includes(response.spoiler_level)) {
    return `spoiler level ${response.spoiler_level} is not allowed in ${requestedMode} mode`;
  }

  // The tutor may not escalate on its own.
  if (response.mode === "full_solution" && requestedMode !== "full_solution") {
    return "produced a full solution without an explicit request";
  }
  if (response.mode === "stronger_hint" && requestedMode === "default") {
    return "produced a stronger hint without an explicit request";
  }

  if (requestedMode === "default" || requestedMode === "discuss_note_question") {
    // At most one focused question.
    const questionMarks = (response.text.match(/\?/g) ?? []).length;
    if (questionMarks > 1) return "asked more than one question";
    if (response.text.length > 1_200) return "response is longer than a short paragraph";

    // A verbatim run from the reference's conclusion or a step is a giveaway even
    // when the model labelled it as a hint.
    const guarded = [reference.conclusion, ...reference.steps.map((step) => step.claim)];
    for (const fragment of guarded) {
      if (containsLongOverlap(response.text, fragment)) return "repeats the reference verbatim";
    }
  }

  return null;
}

/** True when the reply contains a long contiguous run of the reference text. */
function containsLongOverlap(text: string, fragment: string, window = 60): boolean {
  const haystack = normalize(text);
  const needleSource = normalize(fragment);
  if (needleSource.length < window) return false;
  for (let start = 0; start + window <= needleSource.length; start += 10) {
    if (haystack.includes(needleSource.slice(start, start + window))) return true;
  }
  return false;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const reviewSchema = z.object({ accept: z.boolean(), reason: z.string().default("") });

export async function generateTutorResponse(input: TutorContextInput): Promise<TutorOutcome> {
  const config = aiConfig();
  const usage: TutorUsage = { inputTokens: 0, outputTokens: 0, requestIds: [], needsBillingReconciliation: false };

  const userMessage = buildTutorUserMessage(input);
  if (userMessage.length > CONTEXT_CHAR_BUDGET) {
    // Ask for a passage rather than silently dropping the statement, the question,
    // or critical reference steps.
    return {
      status: "needs_selection",
      message:
        "These notes are longer than one request can carry. Select the passage you want to ask about and send the question again.",
      usage,
    };
  }

  const draft = await callModelForJson(
    {
      model: config.tutorModel,
      system: tutorPrompt.system,
      user: userMessage,
      maxTokens: 1_500,
      temperature: 0.2,
      retries: 1,
    },
    tutorResponseSchema,
  );
  usage.inputTokens += draft.usage.inputTokens;
  usage.outputTokens += draft.usage.outputTokens;
  if (draft.requestId) usage.requestIds.push(draft.requestId);
  usage.needsBillingReconciliation ||= draft.needsBillingReconciliation;

  let candidate = draft.value;
  let rejection = violatesResponsePolicy(candidate, input.responseMode, input.reference);

  if (!rejection && input.responseMode !== "full_solution") {
    const review = await reviewResponse(input, candidate, usage);
    if (!review.accept) rejection = review.reason || "the reviewer rejected the draft";
  }

  if (rejection) {
    // Exactly one rewrite; otherwise abstain rather than publish a spoiler.
    const rewrite = await callModelForJson(
      {
        model: config.tutorModel,
        system: tutorPrompt.system,
        user: `${userMessage}\n\n<rewrite_required note="Your previous draft was rejected before the learner saw it.">\n${rejection}\nWrite a reply that stays strictly within the requested mode.\n</rewrite_required>`,
        maxTokens: 1_200,
        temperature: 0,
        retries: 0,
      },
      tutorResponseSchema,
    );
    usage.inputTokens += rewrite.usage.inputTokens;
    usage.outputTokens += rewrite.usage.outputTokens;
    if (rewrite.requestId) usage.requestIds.push(rewrite.requestId);

    candidate = rewrite.value;
    const secondFailure = violatesResponsePolicy(candidate, input.responseMode, input.reference);
    if (secondFailure) {
      return {
        status: "abstained",
        message:
          "I could not put that answer in a form that leaves the problem to you. Try asking about one specific step in your notes.",
        usage,
      };
    }
  }

  return { status: "published", response: candidate, usage };
}

async function reviewResponse(
  input: TutorContextInput,
  candidate: TutorResponseSchema,
  usage: TutorUsage,
): Promise<{ accept: boolean; reason: string }> {
  const config = aiConfig();
  try {
    const result = await callModelForJson(
      {
        model: config.tutorModel,
        system: reviewerPrompt.system,
        user: [
          untrustedBlock("problem_statement", input.statement, 8_000),
          untrustedBlock("reference_conclusion", input.reference.conclusion, 4_000),
          untrustedBlock("learner_question", input.question, limits.questionChars),
          untrustedBlock("draft_reply", candidate.text, 4_000),
          `<requested_mode>${input.responseMode}</requested_mode>`,
        ].join("\n\n"),
        maxTokens: 500,
        retries: 0,
      },
      reviewSchema,
    );
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    if (result.requestId) usage.requestIds.push(result.requestId);
    return result.value;
  } catch {
    // A failed review is not an acceptance.
    return { accept: false, reason: "the response review could not be completed" };
  }
}

/** Short excerpt shown above the composer so the learner sees what is attached. */
export function notesExcerptForComposer(markdown: string): string {
  return plainTextExcerpt(markdown, 320);
}
