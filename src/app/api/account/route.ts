import { requireSession } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { accountDeletionSchema } from "@/lib/validation";
import { createServiceClient } from "@/lib/db/service";
import { AppError } from "@/lib/errors";

/**
 * Account deletion.
 *
 * Owned records cascade from auth.users, so this removes folders, problems, notes,
 * events, conversations, references, idea profiles, jobs, and recommendation runs.
 * Export objects and in-flight jobs are cleared explicitly, and any late worker
 * write finds no account and stops.
 */
export const DELETE = route(async (request: Request) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const body = await parseBody(request, accountDeletionSchema);
  if (body.confirmation !== "DELETE MY ACCOUNT") throw new AppError("INVALID_REQUEST", "confirmation required");

  const service = createServiceClient();

  // Stop in-flight work first so nothing writes back after the records are gone.
  await service
    .from("jobs")
    .update({ run_state: "CANCELLED", error_code: "ACCOUNT_DELETED" })
    .eq("user_id", userId)
    .in("run_state", ["QUEUED", "RUNNING"]);

  const { data: exports } = await service
    .from("exports")
    .select("object_path")
    .eq("user_id", userId)
    .not("object_path", "is", null);

  const paths = ((exports ?? []) as Array<{ object_path: string | null }>)
    .map((row) => row.object_path)
    .filter((path): path is string => Boolean(path));
  if (paths.length > 0) await service.storage.from("exports").remove(paths);

  const { error } = await service.auth.admin.deleteUser(userId);
  if (error) throw new AppError("INTERNAL_ERROR", error.message);

  // Browser recovery drafts are cleared by the client when it sees the signed-out state.
  return ok({ deleted: true });
});
