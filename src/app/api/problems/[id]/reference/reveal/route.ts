import { requireSession } from "@/lib/auth/session";
import { requireOwnedProblem } from "@/lib/auth/ownership";
import { assertSameOrigin, ok, route } from "@/lib/http";
import { createServiceClient } from "@/lib/db/service";
import { revealReference } from "@/lib/ai/reference-store";
import { AppError } from "@/lib/errors";

type Params = { params: Promise<{ id: string }> };

/**
 * The explicit spoiler action. The readiness gate runs first: an unprepared or
 * superseded reference produces an operational code and no mathematical content.
 */
export const POST = route(async (_request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedProblem(supabase, id, userId);

  const service = createServiceClient();
  const { data: gate } = await service.rpc("tutor_gate", { p_problem_id: id, p_user_id: userId });
  const verdict = gate as { ok: boolean; code?: string; reason?: string };
  if (!verdict?.ok) {
    throw new AppError(verdict?.code === "STALE_REQUEST" ? "STALE_REQUEST" : "SOLUTION_NOT_READY", verdict?.reason);
  }

  const revealed = await revealReference(userId, id);
  const { data: problem } = await service
    .from("problems")
    .select("current_statement_version")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  await service.from("study_events").insert({
    user_id: userId,
    problem_id: id,
    kind: "reference_revealed",
    statement_version: problem?.current_statement_version ?? null,
    detail: { explicit_spoiler_action: true },
  });
  return ok({ reference: revealed });
});
