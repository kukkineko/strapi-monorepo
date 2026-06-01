import { type NextRequest, NextResponse } from "next/server";
import { getEntryById, updateEntry } from "@/app/lib/entries";
import type { Entry, EntryPayload } from "@/app/lib/entries";
import {
  getSessionJwt,
  loadUserContext,
  saveUserSchemaData,
} from "@/app/lib/auth-server";
import {
  appendAuditLog,
  buildAuditDetails,
  type AuditAction,
  type AuditLogEntry,
} from "@/app/lib/audit-log";

/** Fields that are only allowed to reach employee browsers. */
const EMPLOYEE_ONLY_FIELDS: ReadonlyArray<keyof Entry> = [
  "igs",
  "issues",
  "tickets",
];

/** Strip employee-only fields so the data never reaches a non-employee browser. */
function stripEmployeeFields(entry: Entry): Entry {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([key]) => !EMPLOYEE_ONLY_FIELDS.includes(key as keyof Entry),
    ),
  ) as Entry;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/entries/:id
   ═══════════════════════════════════════════════════════════════════════════ */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id?.trim()) {
    return NextResponse.json(null, { status: 400 });
  }

  const entry = await getEntryById(id);

  if (!entry) {
    return NextResponse.json(null, { status: 404 });
  }

  let isEmployee = false;
  try {
    const jwt = await getSessionJwt();
    if (jwt) {
      const ctx = await loadUserContext(jwt);
      isEmployee = ctx?.user?.employee === true;
    }
  } catch {
    isEmployee = false;
  }

  const safeEntry = isEmployee ? entry : stripEmployeeFields(entry);

  return NextResponse.json(safeEntry, {
    headers: {
      "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PUT /api/entries/:id
   Only trusted users may update entries.  The action is audit-logged.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id?.trim()) {
    return NextResponse.json(
      { error: "Entry ID is required." },
      { status: 400 },
    );
  }

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
      {
        error:
          "Permission denied. Only trusted users can modify entries.",
      },
      { status: 403 },
    );
  }

  /* ── Parse body ─────────────────────────────────────────────────────────── */
  const body = (await request.json().catch(() => null)) as
    | (EntryPayload & { _auditSection?: string; _auditAction?: AuditAction })
    | null;

  if (!body) {
    return NextResponse.json(
      { error: "Request body is required." },
      { status: 400 },
    );
  }

  /* ── Update ─────────────────────────────────────────────────────────────── */
  try {
    // Strip metadata fields before forwarding to Strapi.
    const { _auditSection, _auditAction, ...payload } = body;

    const updated = await updateEntry(id, payload);

    /* ── Audit log ────────────────────────────────────────────────────────── */
    if (context.schema) {
      const section = _auditSection || "entry";
      const action: AuditAction = _auditAction || "update";

      const logEntry: AuditLogEntry = {
        action,
        timestamp: new Date().toISOString(),
        entryId: updated.documentId,
        entryTitle: updated.title,
        section,
        details: buildAuditDetails(action, section, updated.title),
      };

      const nextData = appendAuditLog(context.schema.data, logEntry);
      await saveUserSchemaData(context.schema.path, { data: nextData });
    }

    /* Strip employee-only fields for non-employees. */
    const isEmployee = context.user.employee === true;
    const safeEntry = isEmployee ? updated : stripEmployeeFields(updated);

    return NextResponse.json(safeEntry);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update entry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DELETE /api/entries/:id
   Only trusted users may delete entries.  The action is audit-logged.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id?.trim()) {
    return NextResponse.json(
      { error: "Entry ID is required." },
      { status: 400 },
    );
  }

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
      {
        error:
          "Permission denied. Only trusted users can delete entries.",
      },
      { status: 403 },
    );
  }

  /* ── Get entry before deleting (for audit log) ──────────────────────────── */
  const entry = await getEntryById(id);
  if (!entry) {
    return NextResponse.json(
      { error: "Entry not found." },
      { status: 404 },
    );
  }

  /* ── Delete from Strapi ─────────────────────────────────────────────────── */
  try {
    const STRAPI_URL = (
      process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337"
    ).replace(/\/$/, "");
    const token =
      process.env.STRAPI_TOKEN ??
      process.env.NEXT_PUBLIC_STRAPI_TOKEN ??
      "";

    const res = await fetch(
      `${STRAPI_URL}/api/entries/${entry.documentId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const message =
        json?.error?.message ?? "Failed to delete entry from Strapi.";
      return NextResponse.json({ error: message }, { status: res.status });
    }

    /* ── Audit log ────────────────────────────────────────────────────────── */
    if (context.schema) {
      const logEntry: AuditLogEntry = {
        action: "delete",
        timestamp: new Date().toISOString(),
        entryId: entry.documentId,
        entryTitle: entry.title,
        section: "entry",
        details: buildAuditDetails("delete", "entry", entry.title),
      };

      const nextData = appendAuditLog(context.schema.data, logEntry);
      await saveUserSchemaData(context.schema.path, { data: nextData });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete entry.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
