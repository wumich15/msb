import { requireSession } from "@/lib/auth/session";
import { ok, route } from "@/lib/http";
import { projectJob } from "@/lib/db/projections";
import { readJob } from "@/lib/db/transactions/jobs";
import { AppError } from "@/lib/errors";

type Params = { params: Promise<{ id: string }> };

/**
 * Safe job status for polling. It carries state, stage, and an operational error
 * code — never a worker payload, a prompt, or reference text.
 */
export const GET = route(async (_request: Request, { params }: Params) => {
  const { userId } = await requireSession();
  const { id } = await params;

  const job = await readJob(id);
  if (!job || job.user_id !== userId) throw new AppError("NOT_FOUND");

  // Poll every two seconds while visible, then back off, then stop. Raw worker
  // results are deliberately excluded because they can contain private ids or
  // provider metadata the browser does not need.
  return ok({ job: projectJob(job) });
});
