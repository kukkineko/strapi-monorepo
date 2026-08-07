import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, updateMe } from "@/app/lib/auth-server";
import {
  listEntries,
  updateEntry,
  parseLinkEntries,
  serializeLinkEntries,
} from "@/app/lib/entries";
import type { Entry, LinkEntry } from "@/app/lib/entries";
import { appendAuditLog, MAX_SNAPSHOT_ENTRIES, type AuditLogEntry } from "@/app/lib/audit-log";

/**
 * POST /api/entries/bulk-link  { sourceIds: string[], targetIds: string[] }
 *
 * Creates bidirectional links between every selected source and every selected
 * target (a cross-product). Editor-only. One summary audit entry is recorded.
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
      { error: "Permission denied. Only editors can link items." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { sourceIds?: unknown; targetIds?: unknown; confidence?: unknown; source?: unknown }
    | null;
  const sourceIds = Array.isArray(body?.sourceIds)
    ? Array.from(new Set(body!.sourceIds.map((v) => String(v).trim()).filter(Boolean)))
    : [];
  const targetIds = Array.isArray(body?.targetIds)
    ? Array.from(new Set(body!.targetIds.map((v) => String(v).trim()).filter(Boolean)))
    : [];
  const confidence =
    typeof body?.confidence === "number"
      ? Math.min(1, Math.max(0, body.confidence))
      : undefined;
  const source =
    typeof body?.source === "string" && body.source.trim()
      ? body.source.trim()
      : undefined;

  if (sourceIds.length === 0 || targetIds.length === 0) {
    return NextResponse.json(
      { error: "sourceIds and targetIds are required." },
      { status: 400 },
    );
  }

  const all = await listEntries();
  const byId = new Map<string, Entry>(all.map((e) => [e.documentId, e]));

  // docId -> (linkedId -> LinkEntry), seeded from the entry's current links.
  const linkSets = new Map<string, Map<string, LinkEntry>>();
  function ensure(docId: string): Map<string, LinkEntry> | null {
    const entry = byId.get(docId);
    if (!entry) return null;
    let m = linkSets.get(docId);
    if (!m) {
      m = new Map();
      for (const le of parseLinkEntries(entry.links)) m.set(le.id, le);
      linkSets.set(docId, m);
    }
    return m;
  }

  let linksCreated = 0;
  for (const s of sourceIds) {
    for (const tgt of targetIds) {
      if (s === tgt) continue;
      const sm = ensure(s);
      const tm = ensure(tgt);
      if (!sm || !tm) continue; // skip ids that aren't real entries
      if (!sm.has(tgt)) {
        sm.set(tgt, {
          id: tgt,
          ...(confidence !== undefined && { confidence }),
          ...(source && { source }),
        });
        linksCreated += 1;
      }
      if (!tm.has(s)) {
        tm.set(s, {
          id: s,
          ...(confidence !== undefined && { confidence }),
          ...(source && { source }),
        });
      }
    }
  }

  // Collect before-snapshots for entries whose link set will grow.
  const snapshotEntries: Array<{ id: string; before: { title?: string; links?: string } }> = [];
  for (const [docId, m] of linkSets) {
    const entry = byId.get(docId)!;
    if (m.size === parseLinkEntries(entry.links).length) continue;
    if (snapshotEntries.length < MAX_SNAPSHOT_ENTRIES) {
      snapshotEntries.push({ id: docId, before: { title: entry.title, links: entry.links } });
    }
  }
  const snapshotTruncated = snapshotEntries.length < linkSets.size;

  // Persist only entries whose link set actually grew.
  let updated = 0;
  for (const [docId, m] of linkSets) {
    const entry = byId.get(docId)!;
    const before = parseLinkEntries(entry.links).length;
    if (m.size === before) continue;
    await updateEntry(docId, {
      title: entry.title,
      links: serializeLinkEntries([...m.values()]),
    });
    updated += 1;
  }

  // Single summary audit entry (avoids flooding the per-user log).
  try {
    const log: AuditLogEntry = {
      action: "update",
      timestamp: new Date().toISOString(),
      entryId: sourceIds[0] ?? "",
      entryTitle: `${sourceIds.length} → ${targetIds.length} items`,
      section: "links",
      details: `Bulk-linked ${sourceIds.length} item(s) to ${targetIds.length} item(s)`,
      snapshot: { entries: snapshotEntries, truncated: snapshotTruncated || undefined },
    };
    await updateMe(jwt, { auditLog: appendAuditLog(context.user.auditLog, log) });
  } catch {
    /* audit is best-effort */
  }

  return NextResponse.json({ updated, linksCreated });
}
