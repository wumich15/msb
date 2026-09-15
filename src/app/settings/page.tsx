import { redirect } from "next/navigation";
import SettingsClient from "@/components/SettingsClient";
import { getSession } from "@/lib/auth/session";

export const metadata = { title: "Settings — Math Study Buddy" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/signin?next=/settings");
  return <SettingsClient userId={session.userId} email={session.email} />;
}
