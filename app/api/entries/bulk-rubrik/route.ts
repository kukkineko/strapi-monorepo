import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, updateMe } from "@/app/lib/auth-server";
import { listEntries, updateEntry } from "@/app/lib/entries";
import type { Entry } from "@/app/lib/entries";
import { appendAuditLog, MAX_SNAPSHOT_ENTRIES, type AuditLogEntry } from "@/app/lib/audit-log";

/**
 * POST /api/entries/bulk-rubrik  { ids: string[], rubriks: string[] }
 *
 * Sets the rubrik (category) field on every selected item.
 * Pass rubriks=[] to clear. Editor-only. One summary audit entry is recorded.
 */
export async function POST(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!context.user.trusted) {
    return NextResponse.json(
      { error: "Permission denied. Only editors can set categories." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { ids?: unknown; rubriks?: unknown }
    | null;
  const ids = Array.isArray(body?.ids)
    ? Array.from(new Set(body!.ids.map((v) => String(v).trim()).filter(Boolean)))
    : [];
  const rubriks: string[] = Array.isArray(body?.rubriks)
    ? (body!.rubriks as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : [];

  if (ids.length === 0) {
    return NextResponse.json({ error: "ids is required." }, { status: 400 });
  }

  const all = await listEntries();
  const byId = new Map<string, Entry>(all.map((e) => [e.documentId, e]));

  const snapshotEntries: Array<{ id: string; before: { title?: string; rubrik?: string | string[] | Record<string, unknown> } }> = [];
  let updated = 0;
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) continue;
    if (snapshotEntries.length < MAX_SNAPSHOT_ENTRIES) {
      snapshotEntries.push({ id, before: { title: entry.title, rubrik: entry.rubrik as string | string[] | Record<string, unknown> | undefined } });
    }
    await updateEntry(id, { title: entry.title, rubrik: rubriks });
    updated += 1;
  }
  const snapshotTruncated = snapshotEntries.length < updated;

  const rubrikLabel = rubriks.length > 0 ? rubriks.join(", ") : "(none)";
  try {
    const log: AuditLogEntry = {
      action: "update",
      timestamp: new Date().toISOString(),
      entryId: ids[0] ?? "",
      entryTitle: `${updated} item(s)`,
      section: "rubrik",
      details: `Set rubrik to "${rubrikLabel}" on ${updated} item(s)`,
      snapshot: { entries: snapshotEntries, truncated: snapshotTruncated || undefined },
    };
    await updateMe(jwt, { auditLog: appendAuditLog(context.user.auditLog, log) });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ updated });
}
