import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRequestClient } from "@/lib/db/server";
import { AppError } from "@/lib/errors";

export interface Session {
  userId: string;
  email: string | null;
  supabase: SupabaseClient;
}

/**
 * Identity comes from `getUser()`, which validates the token with the auth server.
 * An unverified client session object is never enough to authorize a request.
 */
export async function getSession(): Promise<Session | null> {
  const supabase = await createRequestClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null, supabase };
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new AppError("UNAUTHENTICATED");
  return session;
}
