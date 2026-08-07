import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";

export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  return NextResponse.json({ user: context.user });
}
