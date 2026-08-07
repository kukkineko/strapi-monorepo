import { NextResponse } from "next/server";
import {
  getSessionJwt,
  loadUserContext,
  adminListUsers,
  adminUpdateUser,
} from "@/app/lib/auth-server";
import { normalizeRoles } from "@/app/lib/auth-types";
import type { AuditLogEntry } from "@/app/lib/audit-log";

/** GET — list all appusers (administrator only). */
export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const users = await adminListUsers(jwt);
  return NextResponse.json({ users });
}

/** PUT — update roles / account status on an appuser (administrator only). */
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
    documentId?: unknown;
    fields?: unknown;
  } | null;

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const documentId = typeof body?.documentId === "string" ? body.documentId.trim() : "";
  const rawFields =
    body?.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
      ? (body.fields as Record<string, unknown>)
      : null;

  if ((!email && !documentId) || !rawFields) {
    return NextResponse.json(
      { error: "A user identifier (email or documentId) and fields are required." },
      { status: 400 },
    );
  }

  const fields: { roles?: string[]; blocked?: boolean; confirmed?: boolean } = {};
  if (Array.isArray(rawFields.roles)) fields.roles = normalizeRoles(rawFields.roles);
  if (typeof rawFields.blocked === "boolean") fields.blocked = rawFields.blocked;
  if (typeof rawFields.confirmed === "boolean") fields.confirmed = rawFields.confirmed;

  if (Object.keys(fields).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update (roles, blocked, confirmed)." },
      { status: 400 },
    );
  }

  const ok = await adminUpdateUser(jwt, { documentId: documentId || undefined, email: email || undefined }, fields);
  if (!ok) {
    return NextResponse.json({ error: "Failed to update user." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/** PATCH — remove specific audit-log entries from a user (administrator only). */
export async function PATCH(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    removeAuditTimestamps?: unknown;
  } | null;

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const toRemove: string[] = Array.isArray(body?.removeAuditTimestamps)
    ? (body!.removeAuditTimestamps as unknown[])
        .filter((t): t is string => typeof t === "string")
    : [];

  if (!email || toRemove.length === 0) {
    return NextResponse.json(
      { error: "email and removeAuditTimestamps (non-empty array) are required." },
      { status: 400 },
    );
  }

  const users = await adminListUsers(jwt);
  const target = users.find((u) => u.email === email);
  if (!target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const removeSet = new Set(toRemove);
  const nextLog: AuditLogEntry[] = target.auditLog.filter(
    (e) => !removeSet.has(e.timestamp),
  );

  const ok = await adminUpdateUser(jwt, { email }, { auditLog: nextLog });
  if (!ok) {
    return NextResponse.json({ error: "Failed to update audit log." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, remaining: nextLog.length });
}
