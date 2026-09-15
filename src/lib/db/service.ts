import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverConfig } from "@/lib/config";

let cached: SupabaseClient | null = null;

/**
 * Privileged client for workers and for the narrow server paths that must read
 * private reference/solution tables.
 *
 * It bypasses row-level security, so every caller re-verifies ownership itself.
 * Never hand this client to code that renders a browser response directly.
 */
export function createServiceClient(): SupabaseClient {
  if (cached) return cached;
  const config = serverConfig();
  cached = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application": "math-study-buddy-worker" } },
  });
  return cached;
}
