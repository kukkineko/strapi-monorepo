import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, adminListUsers } from "@/app/lib/auth-server";
import type { UserAuditRecord } from "@/app/lib/audit-log";
import {
  displayName as formatDisplayName,
  displayUsername,
} from "@/app/lib/auth-types";

/**
 * GET /api/audit-log
 *
 * Aggregates audit logs from all appuser records and returns them sorted
 * newest-first. Administrator only.
 */
export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json(
      { error: "Forbidden. Administrator access required." },
      { status: 403 },
    );
  }

  try {
    const users = await adminListUsers(jwt);
    const allLogs: UserAuditRecord[] = [];

    for (const user of users) {
      const userDisplayName =
        formatDisplayName(user.name) ||
        displayUsername(user.username) ||
        user.email.split("@")[0] ||
        "Unknown";

      for (const log of user.auditLog) {
        if (!log || typeof log.timestamp !== "string") continue;
        allLogs.push({ ...log, userEmail: user.email, userDisplayName });
      }
    }

    allLogs.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return NextResponse.json({ logs: allLogs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load audit logs.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
