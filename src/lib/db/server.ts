import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverConfig } from "@/lib/config";

/**
 * Request-scoped client carrying the signed-in user's session. Row-level security
 * applies to everything it touches, so it can never reach another account's rows
 * or the server-only solution tables.
 */
export async function createRequestClient(): Promise<SupabaseClient> {
  const config = serverConfig();
  const cookieStore = await cookies();

  return createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component; middleware refreshes the session instead.
        }
      },
    },
  });
}
