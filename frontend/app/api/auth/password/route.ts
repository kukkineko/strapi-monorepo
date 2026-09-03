import { NextResponse } from "next/server";
import { getSessionJwt, changeMyPassword } from "@/app/lib/auth-server";
import { clientIpFromHeaders, isRateLimited } from "@/app/lib/rate-limit";

const PASSWORD_LIMIT = 6;
const PASSWORD_WINDOW_MS = 60 * 60 * 1000;

/** PUT — change the signed-in user's own password (requires currentPassword). */
export async function PUT(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const ip = clientIpFromHeaders(request.headers);
  if (isRateLimited(`password:${ip}`, PASSWORD_LIMIT, PASSWORD_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a while and try again." },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;

  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Current and new password are required." }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return NextResponse.json({ error: "New password must be at least 6 characters." }, { status: 400 });
  }

  const result = await changeMyPassword(jwt, currentPassword, newPassword);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
