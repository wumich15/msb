import "server-only";
import { nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col, newId } from "@/lib/db/collections";
import { AppError } from "@/lib/errors";
import { readMany, readOne } from "@/lib/db/transactions/shared";
import type {
  AssistantSessionRow,
  CheckResult,
  ReferenceArtifact,
  ReferenceProvenance,
  ReferenceSolutionPrivateRow,
  ReferenceState,
  SourceCredit,
} from "@/lib/db/types";

/**
 * The only module (besides the transactions that select and supersede them) that
 * reads or writes `reference_solutions`.
 *
 * Nothing here returns a worked solution except `revealReference`, which is
 * reached solely through the explicit spoiler route after the readiness gate.
 */

export async function findReusableReference(
  userId: string,
  problemId: string,
  statementVersion: number,
): Promise<ReferenceSolutionPrivateRow | null> {
  const rows = await readMany<ReferenceSolutionPrivateRow>(
    col(COLLECTIONS.referenceSolutions)
      .where("user_id", "==", userId)
      .where("problem_id", "==", problemId)
      .where("statement_version", "==", statementVersion)
      .where("state", "==", "READY")
      .orderBy("created_at", "desc")
      .limit(5),
  );
  return rows.find((row) => !row.reported_at) ?? null;
}

export async function reusableReferenceExists(userId: string, problemId: string, statementVersion: number): Promise<boolean> {
  return (await findReusableReference(userId, problemId, statementVersion)) !== null;
}

export interface CreateReferenceInput {
  userId: string;
  problemId: string;
  statementVersion: number;
  activationGeneration: number;
  preparationGeneration: number;
  provenance: ReferenceProvenance;
  artifact?: ReferenceArtifact | null;
  checkResult?: CheckResult | null;
  sourceUrls?: SourceCredit[];
  attribution?: Record<string, unknown>;
  modelVersions?: Record<string, string>;
  promptVersions?: Record<string, string>;
}

export async function createReference(input: CreateReferenceInput): Promise<ReferenceSolutionPrivateRow> {
  const now = nowIso();
  const row: ReferenceSolutionPrivateRow = {
    id: newId(),
    user_id: input.userId,
    problem_id: input.problemId,
    statement_version: input.statementVersion,
    revision: 1,
    activation_generation: input.activationGeneration,
    preparation_generation: input.preparationGeneration,
    state: "PENDING",
    provenance: input.provenance,
    submitted_text: null,
    artifact: input.artifact ?? null,
    check_result: input.checkResult ?? null,
    source_urls: input.sourceUrls ?? [],
    attribution: input.attribution ?? {},
    model_versions: input.modelVersions ?? {},
    prompt_versions: input.promptVersions ?? {},
    reported_at: null,
    report_reason: null,
    created_at: now,
    updated_at: now,
  };
  await col(COLLECTIONS.referenceSolutions).doc(row.id).set(row);
  return row;
}

export async function updateReference(
  referenceId: string,
  patch: {
    state?: ReferenceState;
    artifact?: ReferenceArtifact | null;
    checkResult?: CheckResult | null;
    provenance?: ReferenceProvenance;
    attribution?: Record<string, unknown>;
    sourceUrls?: SourceCredit[];
    modelVersions?: Record<string, string>;
    promptVersions?: Record<string, string>;
  },
): Promise<ReferenceSolutionPrivateRow> {
  const ref = col(COLLECTIONS.referenceSolutions).doc(referenceId);
  const update: Partial<ReferenceSolutionPrivateRow> = { updated_at: nowIso() };
  if (patch.state) update.state = patch.state;
  if (patch.artifact !== undefined) update.artifact = patch.artifact;
  if (patch.checkResult !== undefined) update.check_result = patch.checkResult;
  if (patch.provenance) update.provenance = patch.provenance;
  if (patch.attribution) update.attribution = patch.attribution;
  if (patch.sourceUrls) update.source_urls = patch.sourceUrls;
  if (patch.modelVersions) update.model_versions = patch.modelVersions;
  if (patch.promptVersions) update.prompt_versions = patch.promptVersions;
  await ref.update(update);
  const stored = await readOne<ReferenceSolutionPrivateRow>(ref);
  if (!stored) throw new AppError("NOT_FOUND");
  return stored;
}

/** Loads the reference a worker is allowed to use, after the gate has passed. */
export async function loadReferenceForWorker(referenceId: string, userId: string): Promise<ReferenceSolutionPrivateRow> {
  const row = await readOne<ReferenceSolutionPrivateRow>(col(COLLECTIONS.referenceSolutions).doc(referenceId));
  if (!row || row.user_id !== userId) throw new AppError("NOT_FOUND");
  return row;
}

/** Latest READY reference for a statement version, for classification evidence. */
export async function latestReadyReference(userId: string, problemId: string, statementVersion: number): Promise<ReferenceSolutionPrivateRow | null> {
  const rows = await readMany<ReferenceSolutionPrivateRow>(
    col(COLLECTIONS.referenceSolutions)
      .where("user_id", "==", userId)
      .where("problem_id", "==", problemId)
      .where("statement_version", "==", statementVersion)
      .where("state", "==", "READY")
      .orderBy("created_at", "desc")
      .limit(1),
  );
  return rows[0] ?? null;
}

export interface RevealedReference {
  provenance: ReferenceProvenance;
  artifact: ReferenceArtifact;
  checkSummary: string;
  unresolvedGaps: string[];
  sources: SourceCredit[];
  statementVersion: number;
}

/**
 * The explicit spoiler action. Callers must have run the readiness gate first;
 * this re-reads the selected reference rather than trusting an id from the client.
 */
export async function revealReference(userId: string, problemId: string): Promise<RevealedReference> {
  const session = await readOne<AssistantSessionRow>(col(COLLECTIONS.assistantSessions).doc(problemId));
  if (!session || session.user_id !== userId) throw new AppError("NOT_FOUND");
  if (!session.selected_reference_id) throw new AppError("SOLUTION_NOT_READY", "no_reference");

  const reference = await loadReferenceForWorker(session.selected_reference_id, userId);
  if (reference.state !== "READY" || !reference.artifact || !reference.check_result?.passed) {
    throw new AppError("SOLUTION_NOT_READY", "check_not_passed");
  }

  return {
    provenance: reference.provenance,
    artifact: reference.artifact,
    // A concise check summary travels with the solution; hidden model reasoning
    // traces are never persisted or shown.
    checkSummary: reference.check_result.summary,
    unresolvedGaps: reference.check_result.unresolved_gaps,
    sources: reference.source_urls ?? [],
    statementVersion: reference.statement_version,
  };
}
