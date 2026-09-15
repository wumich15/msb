import { Suspense } from "react";
import SignInForm from "@/components/SignInForm";

export const metadata = { title: "Sign in — Math Study Buddy" };

export default function SignInPage() {
  return (
    <main className="panel" style={{ maxWidth: "34rem", margin: "0 auto" }}>
      <h1>Sign in</h1>
      <p>We send a single-use link to your email address. There is no password to remember.</p>
      <Suspense fallback={<p>Loading…</p>}>
        <SignInForm />
      </Suspense>
    </main>
  );
}
