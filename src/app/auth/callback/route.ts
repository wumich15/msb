import { NextResponse, type NextRequest } from "next/server";
import { createRequestClient } from "@/lib/db/server";

/**
 * Magic-link landing route. An expired or already-used link lands here too, so it
 * must fail into a readable message rather than a stack trace.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/workspace";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/workspace";

  if (!code) {
    return NextResponse.redirect(new URL("/signin?error=missing_code", url.origin));
  }

  const supabase = await createRequestClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/signin?error=link_expired", url.origin));
  }

  return NextResponse.redirect(new URL(safeNext, url.origin));
}
