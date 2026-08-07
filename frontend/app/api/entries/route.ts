import { NextResponse } from "next/server";
import {
  getSessionJwt,
  loadUserContext,
  updateMe,
} from "@/app/lib/auth-server";
import { createEntry, listEntries } from "@/app/lib/entries";
import type { Entry, EntryPayload } from "@/app/lib/entries";
import {
  appendAuditLog,
  buildAuditDetails,
  type AuditLogEntry,
  type AuditSnapshot,
} from "@/app/lib/audit-log";

/** Fields that must never reach a non-staff browser. */
const EMPLOYEE_ONLY_FIELDS: ReadonlyArray<keyof Entry> = ["igs", "issues", "tickets"];

function stripEmployeeFields(entry: Entry): Entry {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([key]) => !EMPLOYEE_ONLY_FIELDS.includes(key as keyof Entry),
    ),
  ) as Entry;
}

/**
 * GET /api/entries
 *
 * Full entry list for the browser (e.g. the link picker). The Strapi token
 * stays on the server, and employee-only fields are stripped for non-staff
 * before any data leaves the server.
 */
export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const context = await loadUserContext(jwt);
  if (!context?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (context.user.blocked) return NextResponse.json({ error: "Your account has been suspended." }, { status: 403 });

  const entries = await listEntries();
  const isEmployee = context.user.employee === true;
  const safe = isEmployee ? entries : entries.map(stripEmployeeFields);
  return NextResponse.json(safe, {
    headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" },
  });
}

/**
 * POST /api/entries
 *
 * Create a new entry.  Only trusted users may call this endpoint.
 * The action is recorded in the user's audit log.
 */
export async function POST(request: Request) {
  /* ── Auth ───────────────────────────────────────────────────────────────── */
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json(
      { error: "Not authenticated." },
      { status: 401 },
    );
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json(
      { error: "Not authenticated." },
      { status: 401 },
    );
  }

  /* ── Trusted + not-blocked check ───────────────────────────────────────── */
  if (context.user.blocked) {
    return NextResponse.json(
      { error: "Your account has been suspended." },
      { status: 403 },
    );
  }
  if (!context.user.trusted) {
    return NextResponse.json(
      { error: "Permission denied. Only trusted users can create entries." },
      { status: 403 },
    );
  }

  /* ── Parse body ─────────────────────────────────────────────────────────── */
  const body = (await request.json().catch(() => null)) as
    | (EntryPayload & { _auditSection?: string })
    | null;

  if (!body?.title?.trim()) {
    return NextResponse.json(
      { error: "Title is required." },
      { status: 400 },
    );
  }

  /* ── Create ─────────────────────────────────────────────────────────────── */
  try {
    // Strip the metadata field before forwarding to Strapi.
    const { _auditSection, ...payload } = body;

    const entry = await createEntry(payload);

    /* ── Audit log ────────────────────────────────────────────────────────── */
    {
      const snapshot: AuditSnapshot = { createdId: entry.documentId };
      const logEntry: AuditLogEntry = {
        action: "create",
        timestamp: new Date().toISOString(),
        entryId: entry.documentId,
        entryTitle: entry.title,
        section: _auditSection || "entry",
        details: buildAuditDetails("create", "entry", entry.title),
        snapshot,
      };

      const nextLog = appendAuditLog(context.user.auditLog, logEntry);
      await updateMe(jwt, { auditLog: nextLog });
    }

    return NextResponse.json(entry);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create entry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
