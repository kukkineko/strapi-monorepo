import { NextResponse } from "next/server";
import { loadUserContext, setSessionJwt } from "@/app/lib/auth-server";
import { toJsonField, toObjectRecord, type AuthUser } from "@/app/lib/auth-types";

const STRAPI_BASE_URL = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");

function sanitizeUser(payload: unknown): AuthUser | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const source = payload as Record<string, unknown>;
  const id = Number(source.id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  const data = toObjectRecord(source.data);

  return {
    id,
    userID: typeof source.userID === "string" ? source.userID : "",
    name: toJsonField(source.name ?? source.name_Surname),
    username: toJsonField(source.username),
    email: typeof source.email === "string" ? source.email : "",
    company: toJsonField(source.company ?? data.company),
    confirmed: Boolean(source.confirmed),
    trusted: Boolean(source.trusted),
    blocked: Boolean(source.blocked),
    employee: Boolean(source.employee),
    administrator: Boolean(source.administrator ?? source.admin),
    data,
  };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { identifier?: unknown; password?: unknown } | null;
  const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!identifier || !password) {
    return NextResponse.json({ error: "Identifier and password are required." }, { status: 400 });
  }

  const response = await fetch(`${STRAPI_BASE_URL}/api/auth/local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as { jwt?: unknown; user?: unknown; error?: { message?: string } } | null;
  const jwt = typeof payload?.jwt === "string" ? payload.jwt.trim() : "";

  if (!response.ok || !jwt) {
    const error = payload?.error?.message || "Invalid identifier or password.";
    return NextResponse.json({ error }, { status: response.status || 401 });
  }

  await setSessionJwt(jwt);

  const context = await loadUserContext(jwt);
  const user = context?.user ?? sanitizeUser(payload?.user);
  return NextResponse.json({ user });
}
