import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await getSession().catch(() => null);
  if (session) redirect("/workspace");

  return (
    <main className="panel" style={{ maxWidth: "42rem", margin: "0 auto" }}>
      <h1>Math Study Buddy</h1>
      <p>
        A quiet place to work through mathematics on your own: keep problems in project folders,
        write notes in Markdown and LaTeX, and ask for help that stops short of giving the problem away.
      </p>
      <h2>How the help works</h2>
      <p>
        The assistant will not say anything mathematical — not a hint, not a guiding question, not a
        judgement about your work — until a complete reference solution exists and has passed the
        application&rsquo;s checks. Each time you turn it on, it asks whether you want to supply a worked
        solution or have one found for you.
      </p>
      <p>
        <Link href="/signin">Sign in with an email link</Link>
      </p>
    </main>
  );
}
