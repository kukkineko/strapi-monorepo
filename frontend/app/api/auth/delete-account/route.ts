import { NextResponse } from "next/server";
import { getSessionJwt, deleteMyAccount, clearSessionJwt } from "@/app/lib/auth-server";
import { clientIpFromHeaders, isRateLimited } from "@/app/lib/rate-limit";

const DELETE_LIMIT = 6;
const DELETE_WINDOW_MS = 60 * 60 * 1000;

/** POST — permanently delete the signed-in user's own account (requires password). */
export async function POST(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const ip = clientIpFromHeaders(request.headers);
  if (isRateLimited(`delete-account:${ip}`, DELETE_LIMIT, DELETE_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a while and try again." },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";

  if (!password) {
    return NextResponse.json({ error: "Password is required to confirm account deletion." }, { status: 400 });
  }

  const result = await deleteMyAccount(jwt, password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await clearSessionJwt();
  return NextResponse.json({ ok: true });
}
