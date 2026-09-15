import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { createSessionCookieFromIdToken, sessionCookieMaxAgeSeconds, sessionCookieOptions } from "@/lib/auth/session";

const schema = z.object({ idToken: z.string().min(20).max(8_000) });

/**
 * Exchanges a fresh Firebase ID token for the HTTP-only session cookie. This is
 * the only place a browser credential becomes a server session, and it requires a
 * same-origin request like every other cookie-authenticated mutation.
 */
export const POST = route(async (request: Request) => {
  await assertSameOrigin();
  const body = await parseBody(request, schema);
  const { cookie, userId } = await createSessionCookieFromIdToken(body.idToken);
  const response: NextResponse = ok({ userId });
  response.cookies.set({ ...sessionCookieOptions(sessionCookieMaxAgeSeconds()), value: cookie });
  return response;
});
