import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session-cookie";

/**
 * Keeps private pages behind a session cookie. This is only a fast presence
 * check: the pages and every API route verify the cookie with the Admin SDK
 * (signature, expiry, revocation) before reading or writing anything.
 */
export function proxy(request: NextRequest) {
  const isPrivate = request.nextUrl.pathname.startsWith("/workspace") || request.nextUrl.pathname.startsWith("/settings");
  if (isPrivate && !request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
