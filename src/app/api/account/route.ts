import { NextResponse } from "next/server";
import { requireSession, revokeSessions, sessionCookieOptions } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { accountDeletionSchema } from "@/lib/validation";
import { adminAuth } from "@/lib/db/admin";
import { deleteAccountData } from "@/lib/db/transactions/cascade";
import { AppError } from "@/lib/errors";

/**
 * Account deletion.
 *
 * In-flight jobs are cancelled first, export objects are removed, the profile is
 * deleted (so any late worker finds no account and stops), every owned collection
 * is cleared, and finally the Firebase Auth user is deleted and the session
 * cookie cleared.
 */
export const DELETE = route(async (request: Request) => {
  await assertSameOrigin();
  const { userId } = await requireSession();
  const body = await parseBody(request, accountDeletionSchema);
  if (body.confirmation !== "DELETE MY ACCOUNT") throw new AppError("INVALID_REQUEST", "confirmation required");

  await deleteAccountData(userId);
  await revokeSessions(userId).catch(() => undefined);
  try {
    await adminAuth().deleteUser(userId);
  } catch (error) {
    throw new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : "could not delete the auth user");
  }

  // Browser recovery drafts are cleared by the client when it sees the signed-out state.
  const response: NextResponse = ok({ deleted: true });
  response.cookies.set({ ...sessionCookieOptions(0), value: "" });
  return response;
});
