import { requireSession } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { folderCreateSchema } from "@/lib/validation";
import { nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col, newId } from "@/lib/db/collections";
import { readMany } from "@/lib/db/transactions/shared";
import type { FolderRow } from "@/lib/db/types";

const projectFolder = (row: FolderRow) => ({ id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at });

export const GET = route(async () => {
  const { userId } = await requireSession();
  const rows = await readMany<FolderRow>(col(COLLECTIONS.folders).where("user_id", "==", userId).orderBy("created_at", "asc"));
  return ok({ folders: rows.map(projectFolder) });
});

export const POST = route(async (request: Request) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const body = await parseBody(request, folderCreateSchema);

  const now = nowIso();
  const row: FolderRow = { id: newId(), user_id: userId, name: body.name, created_at: now, updated_at: now };
  await col(COLLECTIONS.folders).doc(row.id).set(row);

  return ok({ folder: projectFolder(row) });
});
