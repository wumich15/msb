import "server-only";
import { aiConfig, limits } from "@/lib/config";
import { callModelForJson, untrustedBlock } from "@/lib/ai/openai";
import {
  checkPasses,
  checkResultSchema,
  mseMatchSchema,
  referenceArtifactSchema,
  searchQueriesSchema,
  type CheckResultSchema,
  type ReferenceArtifactSchema,
} from "@/lib/ai/schemas";
import { checkerPrompt, extractorPrompt, mseMatchPrompt, searchQueryPrompt, solverPrompt } from "@/prompts";
import { lookupSolutions, type LookupOutcome } from "@/lib/stackexchange/client";
import { attributionLine } from "@/lib/stackexchange/license";
import type { RunBudget } from "@/jobs/runtime";
import type { SourceCredit } from "@/lib/db/types";

/**
 * Producing a complete reference solution and checking it.
 *
 * Nothing here decides that the learner refused anything or lowers a validation
 * requirement because someone is waiting. The only outcomes are: a candidate that
 * passed a separate check, or a blocked state with an operational explanation.
 */

export interface PreparationUsage {
  inputTokens: number;
  outputTokens: number;
  requestIds: string[];
  needsBillingReconciliation: boolean;
}

export interface PreparationCandidate {
  artifact: ReferenceArtifactSchema;
  provenance: "user_supplied" | "math_stack_exchange" | "ai_generated";
  sources: SourceCredit[];
  attribution: Record<string, unknown>;
}

export interface PreparationOutcome {
  status: "ready" | "blocked";
  candidate?: PreparationCandidate;
  check?: CheckResultSchema;
  /** Operational text only; never mathematical guidance. */
  message: string;
  stage: string;
  usage: PreparationUsage;
  modelVersions: Record<string, string>;
  promptVersions: Record<string, string>;
}

function emptyUsage(): PreparationUsage {
  return { inputTokens: 0, outputTokens: 0, requestIds: [], needsBillingReconciliation: false };
}

function accumulate(
  usage: PreparationUsage,
  result: { usage: { inputTokens: number; outputTokens: number }; requestId: string | null; needsBillingReconciliation: boolean },
): void {
  usage.inputTokens += result.usage.inputTokens;
  usage.outputTokens += result.usage.outputTokens;
  if (result.requestId) usage.requestIds.push(result.requestId);
  usage.needsBillingReconciliation ||= result.needsBillingReconciliation;
}

function statementBlock(statement: string): string {
  return untrustedBlock("problem_statement", statement, limits.statementChars);
}

// ---------------------------------------------------------------- extraction

/** Turns a pasted worked solution into the structured artifact, verbatim. */
export async function extractSubmittedSolution(
  statement: string,
  submitted: string,
  budget: RunBudget,
  usage: PreparationUsage,
): Promise<ReferenceArtifactSchema> {
  budget.assertTimeLeft("extracting the submitted solution");
  const config = aiConfig();
  const result = await callModelForJson(
    {
      model: config.solverModel,
      system: extractorPrompt.system,
      user: `${statementBlock(statement)}\n\n${untrustedBlock("submitted_solution", submitted, 60_000)}`,
      maxTokens: 8_000,
      retries: limits.preparationTransientRetries,
      signal: budget.controller.signal,
    },
    referenceArtifactSchema,
  );
  accumulate(usage, result);
  return result.value;
}

// -------------------------------------------------------------- self-solving

export async function solveFromScratch(
  statement: string,
  budget: RunBudget,
  usage: PreparationUsage,
  repairNote?: string,
): Promise<ReferenceArtifactSchema> {
  budget.assertTimeLeft("constructing a solution");
  const config = aiConfig();
  const repair = repairNote
    ? `\n\nA previous attempt was rejected by the checker for these reasons. Address them directly.\n${untrustedBlock("checker_findings", repairNote, 6_000)}`
    : "";

  const result = await callModelForJson(
    {
      model: config.solverModel,
      system: solverPrompt.system,
      user: `${statementBlock(statement)}${repair}`,
      maxTokens: 12_000,
      retries: limits.preparationTransientRetries,
      signal: budget.controller.signal,
    },
    referenceArtifactSchema,
  );
  accumulate(usage, result);
  return result.value;
}

// ------------------------------------------------------------------ checking

/**
 * A separate call with the original problem and the candidate. Using the same
 * model is acceptable for the MVP, but this is a check, not an independent proof
 * of correctness, and the state it produces is labelled accordingly.
 */
export async function checkCandidate(
  statement: string,
  artifact: ReferenceArtifactSchema,
  budget: RunBudget,
  usage: PreparationUsage,
): Promise<CheckResultSchema> {
  budget.assertTimeLeft("checking the solution");
  const config = aiConfig();
  const result = await callModelForJson(
    {
      model: config.checkerModel,
      system: checkerPrompt.system,
      user: `${statementBlock(statement)}\n\n${untrustedBlock("candidate_solution", JSON.stringify(artifact, null, 2), 60_000)}`,
      maxTokens: 6_000,
      retries: limits.preparationTransientRetries,
      signal: budget.controller.signal,
    },
    checkResultSchema,
  );
  accumulate(usage, result);
  return result.value;
}

// ---------------------------------------------------- Math Stack Exchange path

export async function buildSearchQueries(
  statement: string,
  budget: RunBudget,
  usage: PreparationUsage,
): Promise<string[]> {
  budget.assertTimeLeft("preparing search terms");
  const config = aiConfig();
  const result = await callModelForJson(
    {
      model: config.classifierModel,
      system: searchQueryPrompt.system,
      // Only statement content is sent onward to the search API.
      user: statementBlock(statement),
      maxTokens: 700,
      retries: 1,
      signal: budget.controller.signal,
    },
    searchQueriesSchema,
  );
  accumulate(usage, result);
  return result.value.queries.slice(0, limits.maxMseQueries);
}

export interface MseCandidateResult {
  kind: "candidate" | "no_result" | "unavailable";
  candidate?: PreparationCandidate;
  reason?: string;
  mismatchReasons?: string[];
}

/**
 * Searches, then compares each retrieved answer against the actual problem. A
 * related question is not automatically a solution to this one.
 */
export async function findCandidateOnStackExchange(
  statement: string,
  budget: RunBudget,
  usage: PreparationUsage,
): Promise<MseCandidateResult> {
  const queries = await buildSearchQueries(statement, budget, usage);

  let lookup: LookupOutcome;
  try {
    lookup = await lookupSolutions(queries, budget.controller.signal);
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : "search failed" };
  }

  if (lookup.kind === "unavailable") return { kind: "unavailable", reason: lookup.reason };
  if (lookup.kind === "no_result") return { kind: "no_result" };

  const config = aiConfig();
  const mismatches: string[] = [];

  for (const answer of lookup.answers) {
    budget.assertTimeLeft("comparing a retrieved answer");
    const question = lookup.questions.find((item) => item.questionId === answer.questionId);

    const result = await callModelForJson(
      {
        model: config.checkerModel,
        system: mseMatchPrompt.system,
        user: [
          statementBlock(statement),
          untrustedBlock("retrieved_question", `${question?.title ?? ""}\n\n${question?.bodyText ?? ""}`, 12_000),
          untrustedBlock("retrieved_answer", answer.bodyText, 20_000),
        ].join("\n\n"),
        maxTokens: 10_000,
        retries: 1,
        signal: budget.controller.signal,
      },
      mseMatchSchema,
    );
    accumulate(usage, result);

    if (!result.value.matches || !result.value.extracted_solution) {
      mismatches.push(...result.value.mismatch_reasons.slice(0, 2));
      continue;
    }

    const credit: SourceCredit = {
      url: answer.url,
      title: question?.title,
      author: answer.author ?? undefined,
      license: answer.license,
      post_id: String(answer.answerId),
      revision_link: answer.revisionLink,
      modification_note: "Reformatted into a structured worked solution for checking.",
      retrieved_at: new Date().toISOString(),
    };

    // Author, post link, revision link and the applicable licence travel with the
    // reused material and are kept in displayed and exported adaptations.
    const sources: SourceCredit[] = [credit];
    if (question) {
      sources.push({
        url: question.url,
        title: question.title,
        author: question.author ?? undefined,
        license: question.license,
        post_id: String(question.questionId),
      });
    }

    return {
      kind: "candidate",
      candidate: {
        artifact: result.value.extracted_solution,
        provenance: "math_stack_exchange",
        sources,
        attribution: {
          line: attributionLine({
            author: answer.author ?? undefined,
            url: answer.url,
            license: answer.license,
            modificationNote: credit.modification_note,
          }),
        },
      },
    };
  }

  return { kind: "no_result", mismatchReasons: mismatches.slice(0, 3) };
}

// --------------------------------------------------------- the whole pipeline

export interface PreparationInput {
  choice: "provide" | "find";
  statement: string;
  submittedText?: string | null;
  budget: RunBudget;
}

/**
 * Runs the preparation path the learner chose and returns a checked candidate or
 * a blocked outcome. Budget: one complete candidate, one separate check, and at
 * most one substantive repair and recheck.
 */
export async function prepareReference(input: PreparationInput): Promise<PreparationOutcome> {
  const config = aiConfig();
  const usage = emptyUsage();
  const modelVersions = {
    solver: config.solverModel,
    checker: config.checkerModel,
  };
  const promptVersions: Record<string, string> = {
    solver: solverPrompt.version,
    checker: checkerPrompt.version,
  };

  if (!input.statement.trim()) {
    return {
      status: "blocked",
      message: "Add the problem statement before preparing a reference solution.",
      stage: "missing_statement",
      usage,
      modelVersions,
      promptVersions,
    };
  }

  let candidate: PreparationCandidate | null = null;
  let stage = "preparing";
  let searchNote = "";

  try {
    if (input.choice === "provide") {
      stage = "validating";
      if (!input.submittedText?.trim()) {
        return {
          status: "blocked",
          message: "No worked solution was submitted. Paste one, or choose to have one found for you.",
          stage,
          usage,
          modelVersions,
          promptVersions,
        };
      }
      promptVersions.extractor = extractorPrompt.version;
      candidate = {
        artifact: await extractSubmittedSolution(input.statement, input.submittedText, input.budget, usage),
        provenance: "user_supplied",
        sources: [],
        attribution: { line: "Worked solution supplied by the learner." },
      };
    } else {
      // Math Stack Exchange first; self-solving only after that attempt fails.
      stage = "searching";
      promptVersions.search_queries = searchQueryPrompt.version;
      promptVersions.mse_match = mseMatchPrompt.version;

      const found = await findCandidateOnStackExchange(input.statement, input.budget, usage);
      if (found.kind === "candidate" && found.candidate) {
        candidate = found.candidate;
      } else {
        // "Search unavailable" and "search found nothing" are different facts, and
        // the learner is told which one happened.
        searchNote =
          found.kind === "unavailable"
            ? "Math Stack Exchange could not be reached, so a solution was constructed instead."
            : "No matching Math Stack Exchange answer was found, so a solution was constructed instead.";
        stage = "self_solving";
        candidate = {
          artifact: await solveFromScratch(input.statement, input.budget, usage),
          provenance: "ai_generated",
          sources: [],
          attribution: { line: "Solution constructed by the application after searching Math Stack Exchange." },
        };
      }
    }

    stage = "checking";
    let check = await checkCandidate(input.statement, candidate.artifact, input.budget, usage);

    if (!checkPasses(check)) {
      // One substantive repair and recheck, then stop. Requirements are never
      // lowered to produce a result.
      stage = "repairing";
      const repairNote = [check.summary, ...check.unresolved_gaps].join("\n");
      const repaired = await solveFromScratch(input.statement, input.budget, usage, repairNote);
      const recheck = await checkCandidate(input.statement, repaired, input.budget, usage);

      if (checkPasses(recheck)) {
        candidate = {
          artifact: repaired,
          provenance: input.choice === "provide" ? "ai_generated" : candidate.provenance,
          sources: candidate.sources,
          attribution: {
            ...candidate.attribution,
            repair_note: "The submitted or retrieved solution did not pass; this reference was reconstructed.",
          },
        };
        check = recheck;
      } else {
        return {
          status: "blocked",
          check: recheck,
          message: blockedMessage(input.choice, recheck),
          stage: "checker_rejected",
          usage,
          modelVersions,
          promptVersions,
        };
      }
    }

    return {
      status: "ready",
      candidate,
      check,
      message: searchNote,
      stage: "ready",
      usage,
      modelVersions,
      promptVersions,
    };
  } catch (error) {
    return {
      status: "blocked",
      message: operationalMessage(error, stage),
      stage,
      usage,
      modelVersions,
      promptVersions,
    };
  }
}

function blockedMessage(choice: "provide" | "find", check: CheckResultSchema): string {
  const gap = check.unresolved_gaps[0];
  const detail = gap ? ` The check reported: ${gap}` : "";
  return choice === "provide"
    ? `The submitted solution did not pass the checks, so the assistant stays off.${detail} You can replace the reference or have one found for you.`
    : `No solution passed the checks, so the assistant stays off.${detail} You can try again or paste a worked solution yourself.`;
}

function operationalMessage(error: unknown, stage: string): string {
  if (error instanceof Error && error.name === "BudgetExhaustedError") {
    return `Preparation ran out of time while ${stage}. You can try again.`;
  }
  if (error instanceof Error && /not configured/i.test(error.message)) {
    return "The AI provider is not configured, so no reference could be prepared. Your notes and status are unaffected.";
  }
  return `Preparation failed while ${stage}. You can try again.`;
}
