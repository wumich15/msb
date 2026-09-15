import { requireSession } from "@/lib/auth/session";
import { requireOwnedFolder } from "@/lib/auth/ownership";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { folderUpdateSchema } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import { nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { deleteFolderCascade } from "@/lib/db/transactions/cascade";

type Params = { params: Promise<{ id: string }> };

export const PATCH = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  const folder = await requireOwnedFolder(id, userId);

  const body = await parseBody(request, folderUpdateSchema);
  const updated_at = nowIso();
  await col(COLLECTIONS.folders).doc(id).update({ name: body.name, updated_at });

  return ok({ folder: { id, name: body.name, created_at: folder.created_at, updated_at } });
});

export const DELETE = route(async (request: Request, { params }: Params) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const { id } = await params;
  await requireOwnedFolder(id, userId);

  const url = new URL(request.url);
  const confirmed = url.searchParams.get("confirm") === "delete-contents";

  const count = (
    await col(COLLECTIONS.problems).where("user_id", "==", userId).where("folder_id", "==", id).count().get()
  ).data().count;

  // Deleting a folder with problems in it needs an explicit destructive action.
  if (count > 0 && !confirmed) {
    throw new AppError("INVALID_REQUEST", "folder_not_empty", { problemCount: count });
  }

  const problemsDeleted = await deleteFolderCascade(userId, id);
  return ok({ deleted: true, problemsDeleted });
});
