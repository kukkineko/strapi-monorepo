import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, updateMe } from "@/app/lib/auth-server";
import {
  listEntries,
  updateEntry,
  parseLinkEntries,
  serializeLinkEntries,
} from "@/app/lib/entries";
import type { Entry } from "@/app/lib/entries";
import { appendAuditLog, MAX_SNAPSHOT_ENTRIES, type AuditLogEntry } from "@/app/lib/audit-log";

/**
 * POST /api/entries/bulk-unlink  { sourceIds: string[], targetIds: string[] }
 *
 * Removes bidirectional links between every source and every target.
 * Editor-only. Snapshots before-state for undo.
 */
export async function POST(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const context = await loadUserContext(jwt);
  if (!context?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (!context.user.trusted) {
    return NextResponse.json({ error: "Permission denied. Only editors can unlink items." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | { sourceIds?: unknown; targetIds?: unknown }
    | null;

  const sourceIds = Array.isArray(body?.sourceIds)
    ? Array.from(new Set(body!.sourceIds.map((v) => String(v).trim()).filter(Boolean)))
    : [];
  const targetIds = Array.isArray(body?.targetIds)
    ? Array.from(new Set(body!.targetIds.map((v) => String(v).trim()).filter(Boolean)))
    : [];

  if (sourceIds.length === 0 || targetIds.length === 0) {
    return NextResponse.json({ error: "sourceIds and targetIds are required." }, { status: 400 });
  }

  const all = await listEntries();
  const byId = new Map<string, Entry>(all.map((e) => [e.documentId, e]));

  const targetSet = new Set(targetIds);
  const sourceSet = new Set(sourceIds);

  // Build mutable link maps for every entry that will be touched.
  const affected = new Set([...sourceIds, ...targetIds]);
  const linkMaps = new Map<string, Map<string, { id: string; confidence?: number; source?: string; link?: string; desc?: string }>>();

  for (const id of affected) {
    const entry = byId.get(id);
    if (!entry) continue;
    const m = new Map<string, { id: string; confidence?: number; source?: string; link?: string; desc?: string }>();
    for (const le of parseLinkEntries(entry.links)) m.set(le.id, le);
    linkMaps.set(id, m);
  }

  // Capture before-snapshot for entries whose links will actually shrink.
  const snapshotEntries: Array<{ id: string; before: { title?: string; links?: string } }> = [];
  let linksRemoved = 0;

  for (const s of sourceIds) {
    const sm = linkMaps.get(s);
    if (!sm) continue;
    for (const t of targetIds) {
      if (s === t) continue;
      if (sm.has(t)) {
        if (snapshotEntries.length < MAX_SNAPSHOT_ENTRIES && !snapshotEntries.find((e) => e.id === s)) {
          const entry = byId.get(s)!;
          snapshotEntries.push({ id: s, before: { title: entry.title, links: entry.links } });
        }
        sm.delete(t);
        linksRemoved += 1;
      }
      const tm = linkMaps.get(t);
      if (tm?.has(s)) {
        if (snapshotEntries.length < MAX_SNAPSHOT_ENTRIES && !snapshotEntries.find((e) => e.id === t)) {
          const entry = byId.get(t)!;
          snapshotEntries.push({ id: t, before: { title: entry.title, links: entry.links } });
        }
        tm.delete(s);
      }
    }
  }

  // Persist only entries whose link set actually shrank.
  let updated = 0;
  for (const [id, m] of linkMaps) {
    const entry = byId.get(id)!;
    const before = parseLinkEntries(entry.links).length;
    if (m.size === before) continue;
    await updateEntry(id, {
      title: entry.title,
      links: serializeLinkEntries([...m.values()]),
    });
    updated += 1;
  }

  const snapshotTruncated = snapshotEntries.length < updated;

  try {
    const log: AuditLogEntry = {
      action: "update",
      timestamp: new Date().toISOString(),
      entryId: sourceIds[0] ?? "",
      entryTitle: `${sourceIds.length} → ${targetIds.length} items`,
      section: "links",
      details: `Bulk-unlinked ${sourceIds.length} item(s) from ${targetIds.length} item(s) (${linksRemoved} link(s) removed)`,
      snapshot: { entries: snapshotEntries, truncated: snapshotTruncated || undefined },
    };
    await updateMe(jwt, { auditLog: appendAuditLog(context.user.auditLog, log) });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ updated, linksRemoved });
}
