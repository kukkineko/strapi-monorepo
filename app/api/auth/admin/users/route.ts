import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, saveUserSchemaData } from "@/app/lib/auth-server";
import {
  toJsonField,
  toObjectRecord,
  type AuthUser,
} from "@/app/lib/auth-types";

const STRAPI_BASE_URL = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_API_TOKEN = process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";

function parseCustomUser(record: Record<string, unknown>): AuthUser {
  return {
    id: Number(record.id) || 0,
    userID: typeof record.userID === "string" ? record.userID : "",
    name: toJsonField(record.name),
    username: toJsonField(record.username),
    email: typeof record.email === "string" ? record.email : "",
    company: toJsonField(record.company),
    data: toObjectRecord(record.data),
    confirmed: Boolean(record.confirmed),
    trusted: Boolean(record.trusted),
    blocked: Boolean(record.blocked),
    employee: Boolean(record.employee),
    administrator: Boolean(record.administrator),
  };
}

/** GET — list all customuser records (admin only). */
export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const response = await fetch(
    `${STRAPI_BASE_URL}/api/customusers?pagination[pageSize]=100&populate=*`,
    {
      headers: {
        Authorization: `Bearer ${STRAPI_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return NextResponse.json({ users: [] });
  }

  const payload = (await response.json()) as { data?: unknown[] };
  const rawList = Array.isArray(payload.data) ? payload.data : [];

  const users: AuthUser[] = rawList
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => parseCustomUser(item as Record<string, unknown>));

  return NextResponse.json({ users });
}

/** PUT — update boolean flags on a customuser record (admin only). */
export async function PUT(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    fields?: unknown;
  } | null;

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const fields = body?.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
    ? (body.fields as Record<string, unknown>)
    : null;

  if (!email || !fields) {
    return NextResponse.json({ error: "email and fields are required." }, { status: 400 });
  }

  // Only allow updating boolean flag fields.
  const allowedKeys = new Set(["confirmed", "trusted", "blocked", "employee", "administrator"]);
  const sanitized: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowedKeys.has(key)) {
      sanitized[key] = Boolean(value);
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
  }

  // Find the customuser by email to get its documentId.
  const lookupResponse = await fetch(
    `${STRAPI_BASE_URL}/api/customusers?filters[email][$eq]=${encodeURIComponent(email)}&pagination[pageSize]=1`,
    {
      headers: {
        Authorization: `Bearer ${STRAPI_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );

  if (!lookupResponse.ok) {
    return NextResponse.json({ error: "Failed to look up user." }, { status: 500 });
  }

  const lookupPayload = (await lookupResponse.json()) as { data?: Array<{ documentId?: string }> };
  const docId = lookupPayload.data?.[0]?.documentId;
  if (!docId) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const saved = await saveUserSchemaData(`/api/customusers/${docId}`, sanitized);
  if (!saved) {
    return NextResponse.json({ error: "Failed to update user." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
