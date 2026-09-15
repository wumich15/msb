import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors";
import type { FolderRow, ProblemRow } from "@/lib/db/types";

/**
 * Ownership helpers. Workers hold a privileged client that bypasses row-level
 * security, so they call these with an explicit userId rather than trusting the
 * job payload.
 */

export async function requireOwnedProblem(
  supabase: SupabaseClient,
  problemId: string,
  userId: string,
): Promise<ProblemRow> {
  const { data, error } = await supabase
    .from("problems")
    .select("*")
    .eq("id", problemId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new AppError("INTERNAL_ERROR", error.message);
  // A record belonging to another account is reported as absent.
  if (!data) throw new AppError("NOT_FOUND");
  return data as ProblemRow;
}

export async function requireOwnedFolder(
  supabase: SupabaseClient,
  folderId: string,
  userId: string,
): Promise<FolderRow> {
  const { data, error } = await supabase
    .from("folders")
    .select("*")
    .eq("id", folderId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new AppError("INTERNAL_ERROR", error.message);
  if (!data) throw new AppError("NOT_FOUND");
  return data as FolderRow;
}

/** True when the account still exists; workers recheck before storing results. */
export async function accountStillExists(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await supabase.from("profiles").select("user_id").eq("user_id", userId).maybeSingle();
  return Boolean(data);
}
