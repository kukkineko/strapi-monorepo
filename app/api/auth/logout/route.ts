import { NextResponse } from "next/server";
import { clearSessionJwt } from "@/app/lib/auth-server";

export async function POST() {
  await clearSessionJwt();
  return NextResponse.json({ ok: true });
}
