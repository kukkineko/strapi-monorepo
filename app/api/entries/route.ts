import { NextResponse } from "next/server";
import {
  getSessionJwt,
  loadUserContext,
  saveUserSchemaData,
} from "@/app/lib/auth-server";
import { createEntry } from "@/app/lib/entries";
import type { EntryPayload } from "@/app/lib/entries";
import {
  appendAuditLog,
  buildAuditDetails,
  type AuditLogEntry,
} from "@/app/lib/audit-log";

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

  /* ── Trusted check ──────────────────────────────────────────────────────── */
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
    if (context.schema) {
      const logEntry: AuditLogEntry = {
        action: "create",
        timestamp: new Date().toISOString(),
        entryId: entry.documentId,
        entryTitle: entry.title,
        section: _auditSection || "entry",
        details: buildAuditDetails("create", "entry", entry.title),
      };

      const nextData = appendAuditLog(context.schema.data, logEntry);
      await saveUserSchemaData(context.schema.path, { data: nextData });
    }

    return NextResponse.json(entry);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create entry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
