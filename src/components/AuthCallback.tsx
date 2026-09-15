"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isSignInWithEmailLink, signInWithEmailLink, signOut } from "firebase/auth";
import { getFirebaseAuth, SIGN_IN_EMAIL_KEY } from "@/lib/firebase/client";
import { api, ApiError } from "@/lib/api-client";
import { clearAllRecoveryDrafts } from "@/lib/drafts";

/**
 * Magic-link landing.
 *
 * The link is completed in the browser, the resulting ID token is exchanged once
 * for an HTTP-only session cookie, and the browser-side Firebase session is then
 * discarded so the cookie is the only credential the application relies on. An
 * expired or reused link fails into a readable message rather than a stack trace.
 */
export default function AuthCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const [phase, setPhase] = useState<"checking" | "need_email" | "signing_in" | "failed">("checking");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const requestedNext = params.get("next") ?? "/workspace";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") ? requestedNext : "/workspace";

  async function complete(address: string) {
    setPhase("signing_in");
    const auth = getFirebaseAuth();
    try {
      const credential = await signInWithEmailLink(auth, address, window.location.href);
      const idToken = await credential.user.getIdToken(true);
      const result = await api<{ userId: string }>("/auth/session", { method: "POST", json: { idToken } });
      // A different account than the one whose drafts are on this device.
      clearAllRecoveryDrafts(result.userId);
      try {
        window.localStorage.removeItem(SIGN_IN_EMAIL_KEY);
      } catch {
        /* ignore */
      }
      await signOut(auth).catch(() => undefined);
      router.replace(next);
      router.refresh();
    } catch (error) {
      setPhase("failed");
      if (error instanceof ApiError) {
        setMessage("The sign-in could not be completed. Request a new link.");
      } else {
        const code = (error as { code?: string }).code ?? "";
        setMessage(
          code.includes("invalid-action-code") || code.includes("expired-action-code")
            ? "That sign-in link has expired or was already used. Request a new one."
            : "That sign-in link did not work. Request a new one.",
        );
      }
    }
  }

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!isSignInWithEmailLink(auth, window.location.href)) {
      router.replace("/signin?error=missing_code");
      return;
    }
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(SIGN_IN_EMAIL_KEY);
    } catch {
      stored = null;
    }
    if (stored) void complete(stored);
    else setPhase("need_email");
    // The link is processed exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "need_email") {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void complete(email.trim());
        }}
      >
        <p>Confirm the email address this link was sent to, so the sign-in can finish on this device.</p>
        <div className="form-row">
          <label htmlFor="confirm-email">Email address</label>
          <input id="confirm-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} style={{ minWidth: "18rem" }} />
        </div>
        <button type="submit">Finish signing in</button>
      </form>
    );
  }

  if (phase === "failed") {
    return (
      <>
        <p className="notice" data-tone="error" role="alert">{message}</p>
        <p><a href="/signin">Request a new sign-in link</a></p>
      </>
    );
  }

  return <p role="status">Signing you in…</p>;
}
