import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import {
  readAuditLog,
  type UserAuditRecord,
} from "@/app/lib/audit-log";
import {
  displayName as formatDisplayName,
  displayUsername,
  toJsonField,
  toObjectRecord,
} from "@/app/lib/auth-types";

const STRAPI_BASE_URL = (
  process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337"
).replace(/\/$/, "");
const STRAPI_API_TOKEN =
  process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";

/**
 * GET /api/audit-log
 *
 * Aggregates audit logs from all customuser records and returns them
 * sorted newest-first.  Admin only.
 */
export async function GET() {
  /* ── Auth ───────────────────────────────────────────────────────────────── */
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json(
      { error: "Not authenticated." },
      { status: 401 },
    );
  }

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json(
      { error: "Forbidden. Administrator access required." },
      { status: 403 },
    );
  }

  /* ── Fetch all customusers ──────────────────────────────────────────────── */
  try {
    const response = await fetch(
      `${STRAPI_BASE_URL}/api/customusers?pagination[pageSize]=200&populate=*`,
      {
        headers: {
          Authorization: `Bearer ${STRAPI_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch users." },
        { status: 500 },
      );
    }

    const payload = (await response.json()) as { data?: unknown[] };
    const rawList = Array.isArray(payload.data) ? payload.data : [];

    const allLogs: UserAuditRecord[] = [];

    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;

      const record = raw as Record<string, unknown>;
      const email =
        typeof record.email === "string" ? record.email : "unknown";
      const nameField = toJsonField(record.name);
      const usernameField = toJsonField(record.username);
      const displayNameValue =
        formatDisplayName(nameField) ||
        displayUsername(usernameField) ||
        email.split("@")[0] ||
        "Unknown";

      const data = toObjectRecord(record.data);
      const logs = readAuditLog(data);

      for (const log of logs) {
        allLogs.push({
          ...log,
          userEmail: email,
          userDisplayName: displayNameValue,
        });
      }
    }

    // Sort newest first.
    allLogs.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return NextResponse.json({ logs: allLogs });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load audit logs.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
