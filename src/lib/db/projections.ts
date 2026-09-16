/**
 * Explicit safe projections.
 *
 * Browser responses are built only from these functions. Nothing here reads
 * `reference_solutions.artifact`, a solution-derived idea tag, or a raw worker
 * payload, so a hidden solution cannot leak through a routine page or API call.
 */

import type {
  AssistantSessionRow,
  ChatMessageRow,
  ExportRow,
  IdeaProfilePrivateRow,
  JobRow,
  MathnetProblemRow,
  PreparationState,
  ProblemRow,
  RecommendationItemRow,
} from "@/lib/db/types";

export interface SafeAssistantState {
  enabled: boolean;
  activationGeneration: number;
  preparationGeneration: number;
  preparationChoice: AssistantSessionRow["preparation_choice"];
  preparationState: PreparationState;
  preparationLabel: string;
  preparationMessage: string | null;
  /** Whether a reference is currently selected — not what it says. */
  hasSelectedReference: boolean;
  referenceRevision: number | null;
  statementVersion: number;
  /** True when a still-valid checked reference exists for this statement version. */
  canReuseSavedReference: boolean;
}

/** Plain-language labels; the enum names never reach the interface. */
export const PREPARATION_LABELS: Record<PreparationState, string> = {
  OFF: "Off",
  AWAITING_SOLUTION: "Waiting for your choice",
  SEARCHING_MSE: "Searching",
  SELF_SOLVING: "Preparing",
  VALIDATING: "Checking",
  READY: "Ready",
  BLOCKED: "Could not prepare a solution",
  STALE: "The statement changed",
};

export function projectAssistantState(
  row: AssistantSessionRow,
  options: { reusableReferenceExists: boolean },
): SafeAssistantState {
  return {
    enabled: row.enabled,
    activationGeneration: row.activation_generation,
    preparationGeneration: row.preparation_generation,
    preparationChoice: row.preparation_choice,
    preparationState: row.preparation_state,
    preparationLabel: PREPARATION_LABELS[row.preparation_state],
    preparationMessage: row.preparation_message,
    hasSelectedReference: row.selected_reference_id !== null,
    referenceRevision: row.selected_reference_revision,
    statementVersion: row.statement_version,
    canReuseSavedReference: options.reusableReferenceExists,
  };
}

export interface SafeChatMessage {
  id: string;
  threadId: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  /** The exact saved revision the question was asked against. */
  notesRevision: number | null;
  selectedExcerpt: string | null;
  statementVersion: number;
  responseMode: ChatMessageRow["response_mode"];
  citedNoteExcerpt: string | null;
  isOperational: boolean;
  createdAt: string;
  /** Turns about an older statement stay visible as study history. */
  isHistorical: boolean;
}

export function projectChatMessage(row: ChatMessageRow, currentStatementVersion: number): SafeChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    notesRevision: row.notes_revision,
    selectedExcerpt: row.selected_excerpt,
    statementVersion: row.statement_version,
    responseMode: row.response_mode,
    citedNoteExcerpt: row.cited_note_excerpt,
    isOperational: row.is_operational,
    createdAt: row.created_at,
    isHistorical: row.statement_version !== currentStatementVersion,
  };
}

export interface SafeJobStatus {
  id: string;
  type: JobRow["job_type"];
  state: JobRow["run_state"];
  stage: string | null;
  attempts: number;
  errorCode: string | null;
  isTerminal: boolean;
  createdAt: string;
  updatedAt: string;
}

export function projectJob(row: JobRow): SafeJobStatus {
  return {
    id: row.id,
    type: row.job_type,
    state: row.run_state,
    stage: row.stage,
    attempts: row.attempts,
    // Error codes are operational; never a raw worker payload or reference text.
    errorCode: row.error_code,
    isTerminal: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(row.run_state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SafeProblemSummary {
  id: string;
  folderId: string;
  title: string;
  status: ProblemRow["status"];
  statementVersion: number;
  importedSourceId: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export function projectProblemSummary(row: ProblemRow): SafeProblemSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    status: row.status,
    statementVersion: row.current_statement_version,
    importedSourceId: row.imported_source_id,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface SafeRecommendation {
  itemId: string;
  runId: string;
  rank: number;
  title: string;
  sourceId: string;
  statementPreview: string;
  competition: string | null;
  country: string | null;
  sourceUrl: string | null;
  /** How the two problems are related — never how to solve either. */
  relationship: string | null;
  isTentative: boolean;
  savedProblemId: string | null;
  dismissed: boolean;
}

const STATEMENT_PREVIEW_CHARS = 420;

export function projectRecommendation(
  item: RecommendationItemRow,
  problem: MathnetProblemRow,
): SafeRecommendation {
  return {
    itemId: item.id,
    runId: item.run_id,
    rank: item.rank,
    title: problem.title ?? `MathNET ${problem.source_id}`,
    sourceId: problem.source_id,
    // A recommendation card never shows a solution.
    statementPreview:
      problem.statement_markdown.length > STATEMENT_PREVIEW_CHARS
        ? `${problem.statement_markdown.slice(0, STATEMENT_PREVIEW_CHARS)}…`
        : problem.statement_markdown,
    competition: problem.competition,
    country: problem.country,
    sourceUrl: problem.source_locator?.explorer_url ?? problem.source_locator?.url ?? null,
    // Results without solution evidence are labeled tentative and carry neutral
    // relationship text rather than method-level detail.
    relationship: item.is_tentative
      ? (item.relationship ?? "Related problem — the shared approach has not been confirmed.")
      : item.relationship,
    isTentative: item.is_tentative,
    savedProblemId: item.saved_problem_id,
    dismissed: item.dismissed_at !== null,
  };
}

export interface SafeIdeaTags {
  /** Statement-level MathNet categories; not a solution hint. */
  problemCategories: string[];
  /** Drawn from the learner's own notes; safe before completion. */
  safeTags: string[];
  /** Full summary, shown only once the problem is complete. */
  ideaIds: string[];
  mechanism: string | null;
  confidence: number;
  evidenceKind: IdeaProfilePrivateRow["evidence_kind"];
  isProvisional: boolean;
}

/**
 * Solution-derived tags stay hidden while the problem is unfinished. Reopening a
 * completed problem restores that protection.
 */
export function projectIdeaTags(
  row: IdeaProfilePrivateRow | null,
  options: { problemComplete: boolean; explicitlyRevealed: boolean },
): SafeIdeaTags | null {
  if (!row) return null;
  const reveal = options.problemComplete || options.explicitlyRevealed;
  if (!reveal) {
    return {
      problemCategories: row.problem_categories ?? [],
      safeTags: row.safe_tags,
      ideaIds: [],
      mechanism: null,
      confidence: row.confidence,
      evidenceKind: row.evidence_kind,
      isProvisional: row.is_provisional,
    };
  }
  return {
    problemCategories: row.problem_categories ?? [],
    safeTags: row.safe_tags,
    ideaIds: row.idea_ids,
    mechanism: row.mechanism,
    confidence: row.confidence,
    evidenceKind: row.evidence_kind,
    isProvisional: row.is_provisional,
  };
}

export interface SafeExport {
  id: string;
  scope: ExportRow["scope"];
  scopeId: string | null;
  state: ExportRow["state"];
  includeReferences: boolean;
  byteSize: number | null;
  errorCode: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export function projectExport(row: ExportRow): SafeExport {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    state: row.state,
    includeReferences: row.include_references,
    byteSize: row.byte_size,
    errorCode: row.error_code,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
