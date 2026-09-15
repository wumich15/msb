import { requireSession } from "@/lib/auth/session";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { folderCreateSchema } from "@/lib/validation";
import type { FolderRow } from "@/lib/db/types";
import { createServiceClient } from "@/lib/db/service";

export const GET = route(async () => {
  const { supabase, userId } = await requireSession();
  const { data, error } = await supabase
    .from("folders")
    .select("id, name, created_at, updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  assertRpcOk(error);

  return ok({ folders: (data ?? []) as Pick<FolderRow, "id" | "name" | "created_at" | "updated_at">[] });
});

export const POST = route(async (request: Request) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const body = await parseBody(request, folderCreateSchema);

  const service = createServiceClient();
  const { data, error } = await service
    .from("folders")
    .insert({ user_id: userId, name: body.name })
    .select("id, name, created_at, updated_at")
    .single();
  assertRpcOk(error);

  return ok({ folder: data });
});
