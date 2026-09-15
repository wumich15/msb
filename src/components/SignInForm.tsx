"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { sendSignInLinkToEmail } from "firebase/auth";
import { getFirebaseAuth, SIGN_IN_EMAIL_KEY } from "@/lib/firebase/client";
import { publicConfig } from "@/lib/config";
import { clearAllRecoveryDrafts } from "@/lib/drafts";

const ERROR_MESSAGES: Record<string, string> = {
  link_expired: "That sign-in link has expired or was already used. Request a new one below.",
  missing_code: "That link was incomplete. Request a new one below.",
  session_failed: "The sign-in could not be completed. Request a new link below.",
};

export default function SignInForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const linkError = params.get("error");
  const signedOut = params.get("signed_out") === "1";
  const accountDeleted = params.get("account_deleted") === "1";
  const next = params.get("next") ?? "/workspace";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");
    setMessage(null);
    try {
      const auth = getFirebaseAuth();
      const url = `${publicConfig.appOrigin}/auth/callback?next=${encodeURIComponent(next)}`;
      await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
      try {
        window.localStorage.setItem(SIGN_IN_EMAIL_KEY, email);
      } catch {
        // Blocked storage: the callback page asks for the address again.
      }
      setState("sent");
    } catch (error) {
      setState("failed");
      setMessage(error instanceof Error ? error.message : "Could not send the link.");
    }
  }

  if (signedOut && state === "idle") {
    // Signing out clears local recovery drafts for this browser.
    clearAllRecoveryDrafts();
  }

  return (
    <>
      {linkError ? (
        <p className="notice" data-tone="error" role="alert">
          {ERROR_MESSAGES[linkError] ?? "That sign-in link did not work. Request a new one below."}
        </p>
      ) : null}
      {signedOut ? <p className="notice">You are signed out. Local drafts on this device were cleared.</p> : null}
      {accountDeleted ? <p className="notice">Your account and its saved data were deleted.</p> : null}

      {state === "sent" ? (
        <p className="notice" role="status">
          Check <strong>{email}</strong> for a sign-in link. It works once and expires shortly.
        </p>
      ) : (
        <form onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={{ minWidth: "18rem" }}
            />
          </div>
          <button type="submit" disabled={state === "sending"}>
            {state === "sending" ? "Sending…" : "Send sign-in link"}
          </button>
        </form>
      )}

      {message ? (
        <p className="notice" data-tone="error" role="alert">
          {message}
        </p>
      ) : null}
    </>
  );
}
