import "server-only";
import { createServiceClient } from "@/lib/db/service";
import { accountStillExists } from "@/lib/auth/ownership";
import type {
  AssistantSessionRow,
  JobRow,
  JobRunState,
  NotesRow,
  ProblemRow,
  ProblemVersionRow,
} from "@/lib/db/types";

/**
 * Shared worker plumbing.
 *
 * Workers hold a privileged database client, so every one of them re-verifies
 * ownership and re-reads the live state instead of trusting the event payload.
 */

export interface ProblemContext {
  problem: ProblemRow;
  statement: ProblemVersionRow | null;
  notes: NotesRow | null;
  session: AssistantSessionRow | null;
}

export async function claimJob(jobId: string): Promise<JobRow | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("claim_job", { p_job_id: jobId });
  if (error) throw new Error(error.message);

  const result = data as { ok: boolean; job?: JobRow; code?: string };
  if (!result?.ok) return null; // Already terminal, expired, or out of attempts.
  return result.job ?? null;
}

export async function finishJob(
  jobId: string,
  runState: JobRunState,
  options: {
    errorCode?: string;
    errorDetail?: string;
    result?: Record<string, unknown>;
    providerRequestIds?: string[];
    needsBillingReconciliation?: boolean;
  } = {},
): Promise<void> {
  const supabase = createServiceClient();
  await supabase.rpc("finish_job", {
    p_job_id: jobId,
    p_run_state: runState,
    p_error_code: options.errorCode ?? null,
    p_error_detail: options.errorDetail?.slice(0, 500) ?? null,
    p_result: options.result ?? null,
    p_provider_request_ids: options.providerRequestIds ?? null,
    p_needs_billing_reconciliation: options.needsBillingReconciliation ?? false,
  });
}

export async function setJobStage(jobId: string, stage: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from("jobs").update({ stage }).eq("id", jobId);
}

export async function loadProblemContext(userId: string, problemId: string): Promise<ProblemContext | null> {
  const supabase = createServiceClient();

  // The account may have been deleted between dispatch and execution.
  if (!(await accountStillExists(supabase, userId))) return null;

  const { data: problem } = await supabase
    .from("problems")
    .select("*")
    .eq("id", problemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!problem) return null;

  const typedProblem = problem as ProblemRow;

  const [statement, notes, session] = await Promise.all([
    supabase
      .from("problem_versions")
      .select("*")
      .eq("problem_id", problemId)
      .eq("version", typedProblem.current_statement_version)
      .maybeSingle(),
    supabase.from("notes").select("*").eq("problem_id", problemId).maybeSingle(),
    supabase.from("assistant_sessions").select("*").eq("problem_id", problemId).maybeSingle(),
  ]);

  return {
    problem: typedProblem,
    statement: (statement.data as ProblemVersionRow | null) ?? null,
    notes: (notes.data as NotesRow | null) ?? null,
    session: (session.data as AssistantSessionRow | null) ?? null,
  };
}

/**
 * True when the live session no longer matches the generations this job was
 * bound to. A late worker must not publish anything in that case.
 */
export function isSuperseded(job: JobRow, context: ProblemContext): boolean {
  const session = context.session;
  if (!session) return true;
  if (job.statement_version !== null && job.statement_version !== context.problem.current_statement_version) return true;
  if (job.activation_generation !== null && job.activation_generation !== session.activation_generation) return true;
  if (job.preparation_generation !== null && job.preparation_generation !== session.preparation_generation) return true;
  return false;
}

export async function setPreparationState(
  problemId: string,
  state: AssistantSessionRow["preparation_state"],
  message: string | null = null,
): Promise<void> {
  const supabase = createServiceClient();
  await supabase
    .from("assistant_sessions")
    .update({ preparation_state: state, preparation_message: message })
    .eq("problem_id", problemId);
}

/** A wall-clock budget the preparation run shares across all of its steps. */
export class RunBudget {
  private readonly deadline: number;
  readonly controller = new AbortController();

  constructor(milliseconds: number) {
    this.deadline = Date.now() + milliseconds;
  }

  get remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  get expired(): boolean {
    return this.remaining === 0;
  }

  /** Throws rather than letting a spinner run indefinitely. */
  assertTimeLeft(stage: string): void {
    if (this.expired) {
      this.controller.abort();
      throw new BudgetExhaustedError(stage);
    }
  }
}

export class BudgetExhaustedError extends Error {
  constructor(readonly stage: string) {
    super(`preparation budget exhausted during ${stage}`);
    this.name = "BudgetExhaustedError";
  }
}
