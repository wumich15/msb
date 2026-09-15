import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { problemUpdateSchema } from "@/lib/validation";
import { projectAssistantState, projectIdeaTags, projectJob, projectProblemSummary } from "@/lib/db/projections";
import { reusableReferenceExists } from "@/lib/ai/reference-store";
import { COLLECTIONS, col, ids } from "@/lib/db/collections";
import { readMany, readOne } from "@/lib/db/transactions/shared";
import { activeJobsForProblem } from "@/lib/db/transactions/jobs";
import { updateProblem } from "@/lib/db/transactions/core";
import { deleteProblemCascade } from "@/lib/db/transactions/cascade";
import type { AssistantSessionRow, IdeaProfilePrivateRow, NotesRow, ProblemVersionRow } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/** Full editor payload: statement, notes, status, and safe assistant state. */
export const GET = route(async (_request: Request, { params }: Params) => {
  const { userId } = await requireSession();
  const { id } = await params;
  const problem = await requireOwnedProblem(id, userId);

  const [version, notes, session, profiles, jobs, reusable] = await Promise.all([
    problem.current_statement_version > 0
      ? readOne<ProblemVersionRow>(col(COLLECTIONS.problemVersions).doc(ids.versionDoc(id, problem.current_statement_version)))
      : Promise.resolve(null),
    readOne<NotesRow>(col(COLLECTIONS.notes).doc(id)),
    readOne<AssistantSessionRow>(col(COLLECTIONS.assistantSessions).doc(id)),
    readMany<IdeaProfilePrivateRow>(
      col(COLLECTIONS.ideaProfiles)
        .where("user_id", "==", userId)
        .where("problem_id", "==", id)
        .where("statement_version", "==", problem.current_statement_version)
        .orderBy("created_at", "desc")
        .limit(1),
    ),
    activeJobsForProblem(userId, id),
    reusableReferenceExists(userId, id, problem.current_statement_version),
  ]);

  const profile = profiles[0] ?? null;

  return ok({
    problem: projectProblemSummary(problem),
    statement: {
      version: problem.current_statement_version,
      markdown: version?.statement_markdown ?? "",
      sourceKind: version?.source_kind ?? "user",
      sourceMetadata: version?.source_metadata ?? {},
    },
    notes: { revision: notes?.revision ?? 0, markdown: notes?.markdown ?? "", savedAt: notes?.saved_at ?? null },
    assistant: session && session.user_id === userId ? projectAssistantState(session, { reusableReferenceExists: reusable }) : null,
    ideas: projectIdeaTags(profile, { problemComplete: problem.status === "complete", explicitlyRevealed: false }),
    activeJobs: jobs.map(projectJob),
  });
});

export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const body = await parseBody(request, problemUpdateSchema);

  const problem = await updateProblem(userId, id, { title: body.title, folderId: body.folderId });
  return ok({ problem: projectProblemSummary(problem) });
});

export const DELETE = route(async (_request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;

  await deleteProblemCascade(userId, id);
  return ok({ deleted: true });
});
