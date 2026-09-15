import { requireSession } from "@/lib/auth/session";
import { requireOwnedFolder } from "@/lib/auth/ownership";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { folderUpdateSchema } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import { createServiceClient } from "@/lib/db/service";

type Params = { params: Promise<{ id: string }> };

export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedFolder(supabase, id, userId);

  const body = await parseBody(request, folderUpdateSchema);
  const service = createServiceClient();
  const { data, error } = await service
    .from("folders")
    .update({ name: body.name })
    .eq("id", id)
    .eq("user_id", userId)
    .select("id, name, created_at, updated_at")
    .single();
  assertRpcOk(error);

  return ok({ folder: data });
});

export const DELETE = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const { id } = await params;
  await requireOwnedFolder(supabase, id, userId);

  const url = new URL(request.url);
  const confirmed = url.searchParams.get("confirm") === "delete-contents";

  const { count, error: countError } = await supabase
    .from("problems")
    .select("id", { count: "exact", head: true })
    .eq("folder_id", id)
    .eq("user_id", userId);
  assertRpcOk(countError);

  // Deleting a folder with problems in it needs an explicit destructive action.
  if ((count ?? 0) > 0 && !confirmed) {
    throw new AppError("INVALID_REQUEST", "folder_not_empty", { problemCount: count });
  }

  const service = createServiceClient();
  const { error } = await service.from("folders").delete().eq("id", id).eq("user_id", userId);
  assertRpcOk(error);

  return ok({ deleted: true, problemsDeleted: count ?? 0 });
});
