import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, updateMe } from "@/app/lib/auth-server";
import { listEntries, updateEntry } from "@/app/lib/entries";
import type { Entry } from "@/app/lib/entries";
import { appendAuditLog, MAX_SNAPSHOT_ENTRIES, type AuditLogEntry } from "@/app/lib/audit-log";

/** Parse the entry.tags string (JSON array or delimiter-separated) into a list. */
function parseTags(raw?: string): string[] {
  const value = raw?.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    if (parsed && typeof parsed === "object") {
      const s = parsed as { tags?: unknown };
      if (Array.isArray(s.tags)) return s.tags.map((x) => String(x).trim()).filter(Boolean);
    }
  } catch {
    /* fall through to delimiter split */
  }
  return value.split(/[\n,;|]+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * POST /api/entries/bulk-tag  { ids: string[], tag: string }
 *
 * Adds a single tag to every selected item (skipping those that already have
 * it). Editor-only. One summary audit entry is recorded.
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
      { error: "Permission denied. Only editors can tag items." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { ids?: unknown; tag?: unknown }
    | null;
  const ids = Array.isArray(body?.ids)
    ? Array.from(new Set(body!.ids.map((v) => String(v).trim()).filter(Boolean)))
    : [];
  const tag = typeof body?.tag === "string" ? body.tag.trim() : "";

  if (ids.length === 0 || !tag) {
    return NextResponse.json({ error: "ids and tag are required." }, { status: 400 });
  }

  const all = await listEntries();
  const byId = new Map<string, Entry>(all.map((e) => [e.documentId, e]));

  const snapshotEntries: Array<{ id: string; before: { title?: string; tags?: string } }> = [];
  let updated = 0;
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) continue;
    const current = parseTags(entry.tags);
    if (current.some((x) => x.toLowerCase() === tag.toLowerCase())) continue;
    if (snapshotEntries.length < MAX_SNAPSHOT_ENTRIES) {
      snapshotEntries.push({ id, before: { title: entry.title, tags: entry.tags } });
    }
    const next = [...current, tag];
    await updateEntry(id, { title: entry.title, tags: JSON.stringify(next) });
    updated += 1;
  }
  const snapshotTruncated = snapshotEntries.length < updated;

  try {
    const log: AuditLogEntry = {
      action: "update",
      timestamp: new Date().toISOString(),
      entryId: ids[0] ?? "",
      entryTitle: `${updated} item(s)`,
      section: "tags",
      details: `Added tag "${tag}" to ${updated} item(s)`,
      snapshot: { entries: snapshotEntries, truncated: snapshotTruncated || undefined },
    };
    await updateMe(jwt, { auditLog: appendAuditLog(context.user.auditLog, log) });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ updated });
}
