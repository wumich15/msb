import { requireSession } from "@/lib/auth/session";
import { assertRpcOk, ok, route } from "@/lib/http";
import { projectJob } from "@/lib/db/projections";
import { AppError } from "@/lib/errors";
import type { JobRow } from "@/lib/db/types";

type Params = { params: Promise<{ id: string }> };

/**
 * Safe job status for polling. It carries state, stage, and an operational error
 * code — never a worker payload, a prompt, or reference text.
 */
export const GET = route(async (_request: Request, { params }: Params) => {
  const { supabase, userId } = await requireSession();
  const { id } = await params;

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  assertRpcOk(error);
  if (!data) throw new AppError("NOT_FOUND");

  const job = projectJob(data as JobRow);
  return ok({
    job,
    // Poll every two seconds while visible, then back off, then stop.
    resultRef: job.state === "SUCCEEDED" ? ((data as JobRow).result ?? null) : null,
  });
});
