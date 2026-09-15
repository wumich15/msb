import { NextResponse, type NextRequest } from "next/server";
import { getSession, revokeSessions, sessionCookieOptions } from "@/lib/auth/session";

/** Explicit sign-out: revokes the account's sessions and clears the cookie. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (session) await revokeSessions(session.userId).catch(() => undefined);
  const response = NextResponse.redirect(new URL("/signin?signed_out=1", new URL(request.url).origin), { status: 303 });
  // Recovery drafts are cleared on the client when it observes the signed-out state.
  response.cookies.set({ ...sessionCookieOptions(0), value: "" });
  return response;
}
