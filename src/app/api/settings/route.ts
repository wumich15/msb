import { requireSession, ensureProfile } from "@/lib/auth/session";
import { assertSameOrigin, ok, parseBody, route } from "@/lib/http";
import { settingsSchema } from "@/lib/validation";
import { nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { readOne } from "@/lib/db/transactions/shared";
import type { ProfileRow } from "@/lib/db/types";

const project = (profile: ProfileRow | null) => ({
  displayName: profile?.display_name ?? null,
  automaticRecommendations: profile?.automatic_recommendations ?? true,
  aiDisclosureVersion: profile?.ai_disclosure_version ?? 0,
  onboardingCompletedAt: profile?.onboarding_completed_at ?? null,
});

export const GET = route(async () => {
  const { userId } = await requireSession();
  const profile = await readOne<ProfileRow>(col(COLLECTIONS.profiles).doc(userId));
  return ok({ profile: project(profile) });
});

/**
 * The automatic-recommendation preference is independent of per-problem tutoring:
 * switching the assistant off for a problem leaves this setting visible and
 * respected.
 */
export const PATCH = route(async (request: Request) => {
  await assertSameOrigin();
  const { userId, email } = await requireSession();
  const body = await parseBody(request, settingsSchema);

  const patch: Partial<ProfileRow> = { updated_at: nowIso() };
  if (body.automaticRecommendations !== undefined) patch.automatic_recommendations = body.automaticRecommendations;
  if (body.displayName !== undefined) patch.display_name = body.displayName;
  if (body.acceptAiDisclosureVersion !== undefined) {
    patch.ai_disclosure_version = body.acceptAiDisclosureVersion;
    patch.ai_disclosure_accepted_at = nowIso();
    patch.onboarding_completed_at = nowIso();
  }

  await ensureProfile(userId, email);
  await col(COLLECTIONS.profiles).doc(userId).update(patch);
  const profile = await readOne<ProfileRow>(col(COLLECTIONS.profiles).doc(userId));
  return ok({ profile: project(profile) });
});
