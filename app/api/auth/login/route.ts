import { NextResponse } from "next/server";
import { loginUser, setSessionJwt } from "@/app/lib/auth-server";
import { clientIpFromHeaders, isRateLimited } from "@/app/lib/rate-limit";

const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

export async function POST(request: Request) {
  const ip = clientIpFromHeaders(request.headers);
  if (isRateLimited(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many login attempts. Please wait a few minutes and try again." },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as { identifier?: unknown; password?: unknown } | null;
  const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!identifier || !password) {
    return NextResponse.json({ error: "Identifier and password are required." }, { status: 400 });
  }

  const result = await loginUser(identifier, password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await setSessionJwt(result.jwt);
  return NextResponse.json({ user: result.user });
}
