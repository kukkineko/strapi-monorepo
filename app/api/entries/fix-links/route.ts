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
 * POST /api/entries/fix-links
 *
 * Scans all entries and adds missing back-links so every link pair is
 * bidirectional.  Admin-only.  Returns the count of entries updated and
 * back-links added.
 */
export async function POST(request: Request) {
  void request;
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!context.user.administrator) {
    return NextResponse.json(
      { error: "Permission denied. Only administrators can run this operation." },
      { status: 403 },
    );
  }

  const all = await listEntries();
  const byId = new Map<string, Entry>(all.map((e) => [e.documentId, e]));

  // Parse every entry's link set into a mutable Map so we can add back-links.
  const linkMaps = new Map<string, Map<string, { id: string; confidence?: number; source?: string; link?: string; desc?: string }>>();
  for (const entry of all) {
    const m = new Map<string, { id: string; confidence?: number; source?: string; link?: string; desc?: string }>();
    for (const le of parseLinkEntries(entry.links)) m.set(le.id, le);
    linkMaps.set(entry.documentId, m);
  }

  let backLinksAdded = 0;

  // For each entry A that links to B, ensure B also links back to A.
  for (const entry of all) {
    const aId = entry.documentId;
    const aLinks = linkMaps.get(aId)!;
    for (const [bId] of aLinks) {
      if (aId === bId) continue;
      const bLinks = linkMaps.get(bId);
      if (!bLinks) continue; // B doesn't exist — leave it (dangling reference)
      if (!bLinks.has(aId)) {
        bLinks.set(aId, { id: aId });
        backLinksAdded += 1;
      }
    }
  }

  // Collect before-snapshots for entries that will gain back-links.
  let affectedCount = 0;
  const snapshotEntries: Array<{ id: string; before: { title?: string; links?: string } }> = [];
  for (const [docId, m] of linkMaps) {
    const entry = byId.get(docId)!;
    if (m.size === parseLinkEntries(entry.links).length) continue;
    affectedCount += 1;
    if (snapshotEntries.length < MAX_SNAPSHOT_ENTRIES) {
      snapshotEntries.push({ id: docId, before: { title: entry.title, links: entry.links } });
    }
  }
  const snapshotTruncated = snapshotEntries.length < affectedCount;

  // Persist only entries whose link count actually grew.
  let updated = 0;
  for (const [docId, m] of linkMaps) {
    const entry = byId.get(docId)!;
    const before = parseLinkEntries(entry.links).length;
    if (m.size === before) continue;
    await updateEntry(docId, {
      title: entry.title,
      links: serializeLinkEntries([...m.values()]),
    });
    updated += 1;
  }

  try {
    const log: AuditLogEntry = {
      action: "update",
      timestamp: new Date().toISOString(),
      entryId: "",
      entryTitle: "All entries",
      section: "links",
      details: `Fix one-sided links: added ${backLinksAdded} back-link(s) across ${updated} entr${updated === 1 ? "y" : "ies"}`,
      snapshot: { entries: snapshotEntries, truncated: snapshotTruncated || undefined },
    };
    await updateMe(jwt, { auditLog: appendAuditLog(context.user.auditLog, log) });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ updated, backLinksAdded });
}
