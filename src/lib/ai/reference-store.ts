import "server-only";
import { createServiceClient } from "@/lib/db/service";
import { AppError } from "@/lib/errors";
import type {
  CheckResult,
  ReferenceArtifact,
  ReferenceProvenance,
  ReferenceSolutionPrivateRow,
  ReferenceState,
  SourceCredit,
} from "@/lib/db/types";

/**
 * The only module that reads or writes `reference_solutions`.
 *
 * Nothing here returns a worked solution except `revealReference`, which is
 * reached solely through the explicit spoiler route after the readiness gate.
 */

export async function reusableReferenceExists(
  userId: string,
  problemId: string,
  statementVersion: number,
): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("reference_solutions")
    .select("id")
    .eq("user_id", userId)
    .eq("problem_id", problemId)
    .eq("statement_version", statementVersion)
    .eq("state", "READY")
    .limit(1);
  return (data?.length ?? 0) > 0;
}

export async function findReusableReference(
  userId: string,
  problemId: string,
  statementVersion: number,
): Promise<ReferenceSolutionPrivateRow | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("reference_solutions")
    .select("*")
    .eq("user_id", userId)
    .eq("problem_id", problemId)
    .eq("statement_version", statementVersion)
    .eq("state", "READY")
    .is("reported_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ReferenceSolutionPrivateRow | null) ?? null;
}

export interface CreateReferenceInput {
  userId: string;
  problemId: string;
  statementVersion: number;
  activationGeneration: number;
  preparationGeneration: number;
  provenance: ReferenceProvenance;
  artifact?: ReferenceArtifact | null;
  sourceUrls?: SourceCredit[];
  attribution?: Record<string, unknown>;
  modelVersions?: Record<string, string>;
  promptVersions?: Record<string, string>;
}

export async function createReference(input: CreateReferenceInput): Promise<ReferenceSolutionPrivateRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("reference_solutions")
    .insert({
      user_id: input.userId,
      problem_id: input.problemId,
      statement_version: input.statementVersion,
      activation_generation: input.activationGeneration,
      preparation_generation: input.preparationGeneration,
      state: "PENDING",
      provenance: input.provenance,
      artifact: input.artifact ?? null,
      source_urls: input.sourceUrls ?? [],
      attribution: input.attribution ?? {},
      model_versions: input.modelVersions ?? {},
      prompt_versions: input.promptVersions ?? {},
    })
    .select("*")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", error.message);
  return data as ReferenceSolutionPrivateRow;
}

export async function updateReference(
  referenceId: string,
  patch: {
    state?: ReferenceState;
    artifact?: ReferenceArtifact | null;
    checkResult?: CheckResult | null;
    revisionIncrement?: boolean;
    sourceUrls?: SourceCredit[];
    modelVersions?: Record<string, string>;
  },
): Promise<ReferenceSolutionPrivateRow> {
  const supabase = createServiceClient();
  const update: Record<string, unknown> = {};
  if (patch.state) update.state = patch.state;
  if (patch.artifact !== undefined) update.artifact = patch.artifact;
  if (patch.checkResult !== undefined) update.check_result = patch.checkResult;
  if (patch.sourceUrls) update.source_urls = patch.sourceUrls;
  if (patch.modelVersions) update.model_versions = patch.modelVersions;

  if (patch.revisionIncrement) {
    const { data: current } = await supabase
      .from("reference_solutions")
      .select("revision")
      .eq("id", referenceId)
      .single();
    update.revision = ((current?.revision as number | undefined) ?? 1) + 1;
  }

  const { data, error } = await supabase
    .from("reference_solutions")
    .update(update)
    .eq("id", referenceId)
    .select("*")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", error.message);
  return data as ReferenceSolutionPrivateRow;
}

/** Loads the reference a worker is allowed to use, after the gate has passed. */
export async function loadReferenceForWorker(
  referenceId: string,
  userId: string,
): Promise<ReferenceSolutionPrivateRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("reference_solutions")
    .select("*")
    .eq("id", referenceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new AppError("INTERNAL_ERROR", error.message);
  if (!data) throw new AppError("NOT_FOUND");
  return data as ReferenceSolutionPrivateRow;
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
  const supabase = createServiceClient();
  const { data: session } = await supabase
    .from("assistant_sessions")
    .select("selected_reference_id")
    .eq("problem_id", problemId)
    .eq("user_id", userId)
    .maybeSingle();

  const referenceId = session?.selected_reference_id as string | undefined;
  if (!referenceId) throw new AppError("SOLUTION_NOT_READY", "no_reference");

  const reference = await loadReferenceForWorker(referenceId, userId);
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
