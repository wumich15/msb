import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { problemCreateSchema } from "@/lib/validation";
import { projectProblemSummary } from "@/lib/db/projections";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { readMany } from "@/lib/db/transactions/shared";
import { createProblem } from "@/lib/db/transactions/core";
import type { ProblemRow } from "@/lib/db/types";

export const GET = route(async (request: Request) => {
  const { userId } = await requireSession();
  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");
  const status = url.searchParams.get("status");

  let query = col(COLLECTIONS.problems).where("user_id", "==", userId);
  if (folderId) query = query.where("folder_id", "==", folderId);
  if (status === "not_started" || status === "in_progress" || status === "complete") {
    query = query.where("status", "==", status);
  }
  const rows = await readMany<ProblemRow>(query.orderBy("updated_at", "desc"));

  return ok({ problems: rows.map(projectProblemSummary) });
});

export const POST = route(async (request: Request) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const body = await parseBody(request, problemCreateSchema);

  // One transaction creates the problem, its first immutable statement version,
  // the notes row, the assistant session, and the created event.
  const problemId = await createProblem({
    userId,
    folderId: body.folderId,
    title: body.title,
    statement: body.statement ?? "",
  });

  const problem = await requireOwnedProblem(problemId, userId);
  return ok({ problem: projectProblemSummary(problem) });
});
