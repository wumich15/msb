import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicConfig } from "@/lib/config";

/**
 * Refreshes the Supabase session cookies on every navigation and keeps private
 * pages behind a verified identity. Authorization itself is re-derived on the
 * server in each route; this only avoids rendering a workspace for a stale token.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  if (!publicConfig.supabaseUrl || !publicConfig.supabasePublishableKey) {
    return response;
  }

  const supabase = createServerClient(publicConfig.supabaseUrl, publicConfig.supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const isPrivatePage = request.nextUrl.pathname.startsWith("/workspace")
    || request.nextUrl.pathname.startsWith("/settings");

  if (!data.user && isPrivatePage) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
