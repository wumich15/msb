import { NextResponse, type NextRequest } from "next/server";
import { createRequestClient } from "@/lib/db/server";

export async function POST(request: NextRequest) {
  const supabase = await createRequestClient();
  await supabase.auth.signOut();
  // Recovery drafts are cleared on the client when it observes the signed-out state.
  return NextResponse.redirect(new URL("/signin?signed_out=1", new URL(request.url).origin), { status: 303 });
}
