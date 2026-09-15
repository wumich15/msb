"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import { clearAllRecoveryDrafts } from "@/lib/drafts";

interface Profile {
  displayName: string | null;
  automaticRecommendations: boolean;
  aiDisclosureVersion: number;
  onboardingCompletedAt: string | null;
}

export default function SettingsClient({ userId, email }: { userId: string; email: string | null }) {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [automaticRecommendations, setAutomaticRecommendations] = useState(true);
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState("Loading settings…");

  useEffect(() => {
    clearAllRecoveryDrafts(userId);
    api<{ profile: Profile }>("/api/settings")
      .then(({ profile: loaded }) => {
        setProfile(loaded);
        setDisplayName(loaded.displayName ?? "");
        setAutomaticRecommendations(loaded.automaticRecommendations);
        setStatus("");
      })
      .catch((error: unknown) => setStatus(error instanceof ApiError ? error.detail || error.code : "Could not load settings."));
  }, [userId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus("Saving…");
    try {
      const result = await api<{ profile: Profile }>("/api/settings", {
        method: "PATCH",
        json: { displayName: displayName.trim() || undefined, automaticRecommendations },
      });
      setProfile(result.profile);
      setStatus("Settings saved.");
    } catch (error) {
      setStatus(error instanceof ApiError ? error.detail || error.code : "Could not save settings.");
    }
  }

  async function deleteAccount() {
    if (confirmation !== "DELETE MY ACCOUNT") return;
    setStatus("Deleting account…");
    try {
      await api("/api/account", { method: "DELETE", json: { confirmation } });
      clearAllRecoveryDrafts();
      router.push("/signin?account_deleted=1");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof ApiError ? error.detail || error.code : "Could not delete the account.");
    }
  }

  return (
    <>
      <header className="app-header">
        <h1>Math Study Buddy</h1>
        <nav aria-label="Account"><Link href="/workspace">Workspace</Link><span>{email}</span></nav>
      </header>
      <main className="settings-page">
        <h2>Settings</h2>
        {status ? <p className="notice" role="status">{status}</p> : null}
        {profile ? (
          <form onSubmit={save}>
            <fieldset>
              <legend>Profile</legend>
              <div className="stacked-field"><label htmlFor="display-name">Display name</label><input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} /></div>
              <label><input type="checkbox" checked={automaticRecommendations} onChange={(event) => setAutomaticRecommendations(event.target.checked)} /> Automatically classify completed work and suggest related problems</label>
              <p className="scope-note">This preference is independent of whether tutoring is enabled for a problem.</p>
              <button type="submit">Save settings</button>
            </fieldset>
          </form>
        ) : null}
        <section className="notice" aria-labelledby="privacy-title">
          <h2 id="privacy-title">AI and privacy</h2>
          <p>When you explicitly use AI help, the current problem and relevant notes may be sent to configured AI providers. Search providers receive statement-derived search terms. Ordinary notes, status changes, and exports do not require AI.</p>
          <p>Disclosure accepted: {profile?.onboardingCompletedAt ? new Date(profile.onboardingCompletedAt).toLocaleDateString() : "not yet"}.</p>
        </section>
        <section className="danger-zone" aria-labelledby="delete-title">
          <h2 id="delete-title">Delete account</h2>
          <p>This permanently removes your projects, problems, study history, assistant data, recommendations, exports, and account.</p>
          <label htmlFor="delete-confirmation">Type <strong>DELETE MY ACCOUNT</strong> to confirm</label>
          <input id="delete-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
          <button type="button" disabled={confirmation !== "DELETE MY ACCOUNT"} onClick={() => void deleteAccount()}>Delete my account</button>
        </section>
      </main>
    </>
  );
}
