import { redirect } from "next/navigation";
import WorkspaceClient from "@/components/WorkspaceClient";
import { getSession } from "@/lib/auth/session";

export const metadata = { title: "Workspace — Math Study Buddy" };
export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const session = await getSession();
  if (!session) redirect("/signin?next=/workspace");

  return <WorkspaceClient userId={session.userId} email={session.email} />;
}
