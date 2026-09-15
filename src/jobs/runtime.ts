import "server-only";
import { accountStillExists } from "@/lib/auth/ownership";
import { COLLECTIONS, col, ids } from "@/lib/db/collections";
import { readOne } from "@/lib/db/transactions/shared";
import { claimJob as claimJobTx, finishJob as finishJobTx, setJobStage as setJobStageTx, type FinishOptions } from "@/lib/db/transactions/jobs";
import { setPreparationStateForJob } from "@/lib/db/transactions/assistant";
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
 * Workers hold the privileged Admin SDK, so every one of them re-verifies
 * ownership and re-reads the live state instead of trusting the event payload.
 */

export interface ProblemContext {
  problem: ProblemRow;
  statement: ProblemVersionRow | null;
  notes: NotesRow | null;
  session: AssistantSessionRow | null;
}

export async function claimJob(jobId: string): Promise<JobRow | null> {
  const result = await claimJobTx(jobId);
  if (!result.ok) return null; // Already terminal, expired, or out of attempts.
  return result.job ?? null;
}

export async function finishJob(jobId: string, runState: JobRunState, options: FinishOptions = {}): Promise<void> {
  await finishJobTx(jobId, runState, options);
}

export async function setJobStage(jobId: string, stage: string): Promise<void> {
  await setJobStageTx(jobId, stage);
}

export async function loadProblemContext(userId: string, problemId: string): Promise<ProblemContext | null> {
  // The account may have been deleted between dispatch and execution.
  if (!(await accountStillExists(userId))) return null;

  const problem = await readOne<ProblemRow>(col(COLLECTIONS.problems).doc(problemId));
  if (!problem || problem.user_id !== userId) return null;

  const [statement, notes, session] = await Promise.all([
    problem.current_statement_version > 0
      ? readOne<ProblemVersionRow>(col(COLLECTIONS.problemVersions).doc(ids.versionDoc(problemId, problem.current_statement_version)))
      : Promise.resolve(null),
    readOne<NotesRow>(col(COLLECTIONS.notes).doc(problemId)),
    readOne<AssistantSessionRow>(col(COLLECTIONS.assistantSessions).doc(problemId)),
  ]);

  return {
    problem,
    statement,
    notes: notes && notes.user_id === userId ? notes : null,
    session: session && session.user_id === userId ? session : null,
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
  job: Pick<JobRow, "user_id" | "problem_id" | "activation_generation" | "preparation_generation" | "statement_version">,
  state: AssistantSessionRow["preparation_state"],
  message: string | null = null,
): Promise<void> {
  await setPreparationStateForJob(job, state, message);
}

/** A wall-clock budget the preparation run shares across all of its steps. */
export class RunBudget {
  private readonly deadline: number;
  readonly controller = new AbortController();

  constructor(milliseconds: number) {
    this.deadline = Date.now() + milliseconds;
    const timer = setTimeout(() => this.controller.abort(), milliseconds);
    timer.unref?.();
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
