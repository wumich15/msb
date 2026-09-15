/**
 * Document shapes for the Firestore collections this application reads.
 *
 * Firestore has no schema, so these interfaces are the schema: every write in
 * src/lib/db/transactions constructs a complete row of one of these shapes, and
 * timestamps are ISO-8601 UTC strings so ordering and range queries stay simple.
 * The safe/unsafe distinction is visible in the names: anything ending in
 * `Private` must never be projected to a browser response.
 */

export type ProblemStatus = "not_started" | "in_progress" | "complete";

export type PreparationState =
  | "OFF"
  | "AWAITING_SOLUTION"
  | "SEARCHING_MSE"
  | "SELF_SOLVING"
  | "VALIDATING"
  | "READY"
  | "BLOCKED"
  | "STALE";

export type PreparationChoice = "provide" | "find" | "reuse";

export type ReferenceState =
  | "PENDING"
  | "CHECKING"
  | "READY"
  | "REJECTED"
  | "REPORTED"
  | "SUPERSEDED"
  | "CANCELLED";

export type ReferenceProvenance = "user_supplied" | "math_stack_exchange" | "ai_generated";

export type TutorResponseMode =
  | "default"
  | "stronger_hint"
  | "full_solution"
  | "discuss_note_question"
  | "operational";

export type JobType =
  | "prepare-reference"
  | "respond-to-question"
  | "classify-problem"
  | "recommend-problems"
  | "export-workspace";

export type JobRunState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
export type JobDispatchState = "PENDING" | "DISPATCHED" | "FAILED_DISPATCH";
export type ExportScope = "problem" | "folder" | "account";
export type ExportState = "QUEUED" | "RUNNING" | "READY" | "FAILED" | "EXPIRED";
export type RecommendationState = "QUEUED" | "RUNNING" | "READY" | "NO_MATCH" | "FAILED";

export interface ProfileRow {
  user_id: string;
  display_name: string | null;
  ai_disclosure_version: number;
  ai_disclosure_accepted_at: string | null;
  automatic_recommendations: boolean;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatThreadRow {
  id: string;
  user_id: string;
  problem_id: string;
  statement_version: number;
  /** Sequence numbers are allocated in the transaction that appends a turn. */
  next_sequence: number;
  created_at: string;
  updated_at: string;
}

export interface AiUsageRow {
  user_id: string;
  usage_date: string;
  reserved_tokens: number;
  actual_tokens: number;
  reserved_micro_usd: number;
  actual_micro_usd: number;
  job_count: number;
}

export interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ProblemRow {
  id: string;
  user_id: string;
  folder_id: string;
  title: string;
  status: ProblemStatus;
  current_statement_version: number;
  imported_mathnet_id: string | null;
  imported_source_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ProblemVersionRow {
  id: string;
  user_id: string;
  problem_id: string;
  version: number;
  statement_markdown: string;
  statement_hash: string;
  source_kind: string;
  source_metadata: Record<string, unknown>;
  created_at: string;
}

export interface NotesRow {
  problem_id: string;
  user_id: string;
  markdown: string;
  revision: number;
  saved_at: string;
}

export interface StudyEventRow {
  id: string;
  user_id: string;
  problem_id: string;
  kind: string;
  from_status: ProblemStatus | null;
  to_status: ProblemStatus | null;
  statement_version: number | null;
  notes_revision: number | null;
  notes_snapshot: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AssistantSessionRow {
  problem_id: string;
  user_id: string;
  enabled: boolean;
  activation_generation: number;
  preparation_generation: number;
  preparation_choice: PreparationChoice | null;
  preparation_state: PreparationState;
  preparation_message: string | null;
  selected_reference_id: string | null;
  selected_reference_revision: number | null;
  statement_version: number;
  updated_at: string;
}

/** PRIVATE: never projected to a browser response without an explicit reveal. */
export interface ReferenceSolutionPrivateRow {
  id: string;
  user_id: string;
  problem_id: string;
  statement_version: number;
  revision: number;
  activation_generation: number;
  preparation_generation: number;
  state: ReferenceState;
  provenance: ReferenceProvenance;
  /** Exactly as the learner pasted it, before extraction. */
  submitted_text: string | null;
  artifact: ReferenceArtifact | null;
  check_result: CheckResult | null;
  source_urls: SourceCredit[];
  attribution: Record<string, unknown>;
  model_versions: Record<string, string>;
  prompt_versions: Record<string, string>;
  reported_at: string | null;
  report_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReferenceArtifact {
  restated_problem: string;
  assumptions: string[];
  domain_restrictions: string[];
  notation: string[];
  steps: Array<{ claim: string; justification: string }>;
  boundary_cases: string[];
  subparts: Array<{ label: string; conclusion: string }>;
  conclusion: string;
  provenance_note: string;
}

export interface CheckResult {
  passed: boolean;
  statement_match: boolean;
  logical_step_coverage: boolean;
  assumptions_and_cases: boolean;
  conclusion_answers_question: boolean;
  unresolved_gaps: string[];
  counterexample_attempts: string[];
  summary: string;
}

export interface SourceCredit {
  url: string;
  title?: string;
  author?: string;
  license?: string;
  post_id?: string;
  revision_link?: string;
  modification_note?: string;
  retrieved_at?: string;
}

export interface ChatMessageRow {
  id: string;
  user_id: string;
  problem_id: string;
  thread_id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  request_id: string | null;
  notes_revision: number | null;
  notes_snapshot: string | null;
  selected_excerpt: string | null;
  statement_version: number;
  activation_generation: number;
  preparation_generation: number;
  reference_id: string | null;
  reference_revision: number | null;
  response_mode: TutorResponseMode;
  cited_note_excerpt: string | null;
  spoiler_level: string | null;
  is_operational: boolean;
  created_at: string;
}

/** PRIVATE: solution-derived idea tags can reveal the trick. */
export interface IdeaProfilePrivateRow {
  id: string;
  user_id: string;
  problem_id: string;
  statement_version: number;
  notes_revision: number | null;
  idea_ids: string[];
  secondary_idea_ids: string[];
  mechanism: string | null;
  object_roles: Array<{ object: string; role: string }>;
  prerequisites: string[];
  evidence: Array<{ snippet: string; source: string }>;
  evidence_kind: "statement_only" | "user_supplied_work" | "checked_reference";
  estimated_difficulty: string | null;
  confidence: number;
  is_provisional: boolean;
  safe_tags: string[];
  input_hash: string;
  classifier_version: string;
  created_at: string;
}

export interface JobRow {
  id: string;
  user_id: string;
  job_type: JobType;
  problem_id: string | null;
  input: Record<string, unknown>;
  idempotency_key: string;
  dispatch_state: JobDispatchState;
  dispatched_at: string | null;
  run_state: JobRunState;
  attempts: number;
  max_attempts: number;
  stage: string | null;
  error_code: string | null;
  error_detail: string | null;
  result: Record<string, unknown> | null;
  activation_generation: number | null;
  preparation_generation: number | null;
  statement_version: number | null;
  notes_revision: number | null;
  provider_request_ids: string[];
  needs_billing_reconciliation: boolean;
  reserved_tokens: number;
  usage_reconciled: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface MathnetReleaseRow {
  id: string;
  dataset_id: string;
  revision: string;
  schema_version: string;
  import_manifest: Record<string, unknown>;
  imported_count: number;
  eligible_count: number;
  exclusion_counts: Record<string, number>;
  license: string | null;
  source_url: string | null;
  checksums: Record<string, string>;
  index_version: number;
  is_active: boolean;
  validated_at: string | null;
  activated_at: string | null;
  created_at: string;
}

/** PRIVATE: source solutions and solution-derived profiles can reveal the trick. */
export interface MathnetSolutionDataPrivateRow {
  id: string;
  mathnet_problem_id: string;
  release_id: string;
  is_eligible: boolean;
  solutions_markdown: string | null;
  final_answer: string | null;
  idea_ids: string[];
  secondary_idea_ids: string[];
  mechanism: string | null;
  evidence: Array<{ snippet: string; source: string }>;
  evidence_kind: string;
  confidence: number;
  /** Stemmed lexical tokens from statement, topics, idea labels and mechanism. */
  search_terms: string[];
  statement_embedding: unknown | null;
  idea_embedding: unknown | null;
  embedding_model: string | null;
  embedding_dimension: number | null;
  profile_version: string | null;
  created_at: string;
}

export interface MseLookupCacheRow {
  cache_key: string;
  normalized_query: string;
  api_params: Record<string, string>;
  response: unknown;
  outcome: "found" | "no_result" | "unavailable";
  fetched_at: string;
  expires_at: string;
}

export interface MathnetProblemRow {
  id: string;
  release_id: string;
  source_id: string;
  title: string | null;
  statement_markdown: string;
  language: string | null;
  country: string | null;
  competition: string | null;
  topics: string[];
  problem_type: string | null;
  source_locator: { url?: string; explorer_url?: string; dataset?: string; revision?: string };
  content_hash: string;
  is_english: boolean;
  is_text_complete: boolean;
  has_images: boolean;
  has_solution: boolean;
  rights_cleared: boolean;
  exclusion_reason: string | null;
  is_eligible: boolean;
  attribution: Record<string, unknown>;
  created_at: string;
}

export interface RecommendationRunRow {
  id: string;
  user_id: string;
  problem_id: string;
  statement_version: number;
  notes_revision: number | null;
  profile_hash: string;
  /** Hash of every cache input: statement version, notes revision, profile, release, index, retrieval version. */
  cache_key: string;
  trigger: "completion" | "manual";
  release_id: string | null;
  index_version: number;
  retrieval_version: string;
  state: RecommendationState;
  candidates: unknown[];
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RecommendationItemRow {
  id: string;
  run_id: string;
  user_id: string;
  mathnet_problem_id: string;
  rank: number;
  fusion_score: number | null;
  relationship: string | null;
  is_tentative: boolean;
  saved_problem_id: string | null;
  dismissed_at: string | null;
  relevance_feedback: string | null;
  /** True once saved or dismissed; refiltered out of every later run. */
  excluded: boolean;
  created_at: string;
}

export interface ExportRow {
  id: string;
  user_id: string;
  scope: ExportScope;
  scope_id: string | null;
  schema_version: string;
  include_references: boolean;
  snapshot_at: string;
  state: ExportState;
  object_path: string | null;
  byte_size: number | null;
  error_code: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}
