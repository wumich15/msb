import { Suspense } from "react";
import AuthCallback from "@/components/AuthCallback";

export const metadata = { title: "Signing in — Math Study Buddy" };
export const dynamic = "force-dynamic";

export default function AuthCallbackPage() {
  return (
    <main className="panel" style={{ maxWidth: "34rem", margin: "0 auto" }}>
      <h1>Sign in</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <AuthCallback />
      </Suspense>
    </main>
  );
}
