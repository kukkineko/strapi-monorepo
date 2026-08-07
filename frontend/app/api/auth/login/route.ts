import { NextResponse } from "next/server";
import { loginUser, setSessionJwt } from "@/app/lib/auth-server";

export async function POST(request: Request) {
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
