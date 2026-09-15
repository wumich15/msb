import "server-only";
import { cookies } from "next/headers";
import { adminAuth, nowIso } from "@/lib/db/admin";
import { COLLECTIONS, col } from "@/lib/db/collections";
import { firebaseAdminConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import type { ProfileRow } from "@/lib/db/types";

/**
 * Server-validated sessions.
 *
 * Sign-in produces a Firebase ID token in the browser, which is exchanged once
 * for an HTTP-only session cookie minted by the Admin SDK. Every private request
 * verifies that cookie with `verifySessionCookie(cookie, true)`, which checks the
 * signature, expiry, and revocation against Firebase Auth. An unverified client
 * session object is never enough to authorize a request.
 *
 * The cookie is named `__session` because Firebase Hosting / App Hosting only
 * forward that cookie to the application server.
 */

import { SESSION_COOKIE } from "@/lib/auth/session-cookie";
export { SESSION_COOKIE };

export interface Session {
  userId: string;
  email: string | null;
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE)?.value;
  if (!cookie) return null;
  try {
    const decoded = await adminAuth().verifySessionCookie(cookie, true);
    return { userId: decoded.uid, email: decoded.email ?? null };
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new AppError("UNAUTHENTICATED");
  return session;
}

/** Cookie attributes shared by creation and clearing. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function sessionCookieMaxAgeSeconds(): number {
  return firebaseAdminConfig().sessionCookieDays * 24 * 60 * 60;
}

/**
 * Exchanges a freshly minted ID token for a session cookie. The token must have
 * been issued by a sign-in within the last five minutes, so a stale token from a
 * long-lived client session cannot be replayed into a new cookie.
 */
export async function createSessionCookieFromIdToken(idToken: string): Promise<{ cookie: string; userId: string; email: string | null }> {
  const decoded = await adminAuth().verifyIdToken(idToken, true);
  const authAgeSeconds = Date.now() / 1000 - decoded.auth_time;
  if (authAgeSeconds > 5 * 60) throw new AppError("UNAUTHENTICATED", "sign in again");
  const expiresIn = sessionCookieMaxAgeSeconds() * 1000;
  const cookie = await adminAuth().createSessionCookie(idToken, { expiresIn });
  await ensureProfile(decoded.uid, decoded.email ?? null);
  return { cookie, userId: decoded.uid, email: decoded.email ?? null };
}

/** Creates the profile on first sign-in so the workspace never has to upsert one. */
export async function ensureProfile(userId: string, email: string | null): Promise<void> {
  const ref = col(COLLECTIONS.profiles).doc(userId);
  const now = nowIso();
  const row: ProfileRow = {
    user_id: userId,
    display_name: email ? email.split("@")[0] ?? null : null,
    ai_disclosure_version: 0,
    ai_disclosure_accepted_at: null,
    automatic_recommendations: true,
    onboarding_completed_at: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await ref.create(row);
  } catch (error) {
    // ALREADY_EXISTS is the expected outcome on every sign-in after the first.
    const code = (error as { code?: number | string }).code;
    if (code !== 6 && code !== "already-exists") throw error;
  }
}

/** Revokes the account's refresh tokens so every existing session cookie fails verification. */
export async function revokeSessions(userId: string): Promise<void> {
  await adminAuth().revokeRefreshTokens(userId);
}
