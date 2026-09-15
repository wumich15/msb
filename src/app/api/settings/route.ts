import { requireSession } from "@/lib/auth/session";
import { assertRpcOk, assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { settingsSchema } from "@/lib/validation";
import type { ProfileRow } from "@/lib/db/types";

export const GET = route(async () => {
  const { supabase, userId } = await requireSession();
  const { data, error } = await supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle();
  assertRpcOk(error);

  const profile = data as ProfileRow | null;
  return ok({
    profile: {
      displayName: profile?.display_name ?? null,
      automaticRecommendations: profile?.automatic_recommendations ?? true,
      aiDisclosureVersion: profile?.ai_disclosure_version ?? 0,
      onboardingCompletedAt: profile?.onboarding_completed_at ?? null,
    },
  });
});

/**
 * The automatic-recommendation preference is independent of per-problem tutoring:
 * switching the assistant off for a problem leaves this setting visible and
 * respected.
 */
export const PATCH = route(async (request: Request) => {
  await assertSameOrigin();
  const { supabase, userId } = await requireSession();
  const body = await parseBody(request, settingsSchema);

  const patch: Record<string, unknown> = {};
  if (body.automaticRecommendations !== undefined) patch.automatic_recommendations = body.automaticRecommendations;
  if (body.displayName !== undefined) patch.display_name = body.displayName;
  if (body.acceptAiDisclosureVersion !== undefined) {
    patch.ai_disclosure_version = body.acceptAiDisclosureVersion;
    patch.ai_disclosure_accepted_at = new Date().toISOString();
    patch.onboarding_completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("user_id", userId)
    .select("*")
    .single();
  assertRpcOk(error);

  const profile = data as ProfileRow;
  return ok({
    profile: {
      displayName: profile.display_name,
      automaticRecommendations: profile.automatic_recommendations,
      aiDisclosureVersion: profile.ai_disclosure_version,
      onboardingCompletedAt: profile.onboarding_completed_at,
    },
  });
});
