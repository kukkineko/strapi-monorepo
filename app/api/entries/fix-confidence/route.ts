import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getSessionJwt, loadUserContext, updateMe } from "@/app/lib/auth-server";
import {
  listEntries,
  updateEntry,
  parseLinkEntries,
  serializeLinkEntries,
} from "@/app/lib/entries";
import { appendAuditLog, MAX_SNAPSHOT_ENTRIES, type AuditLogEntry } from "@/app/lib/audit-log";

/** Confidence assigned to links that have no score yet (as a 0–1 fraction). */
const DEFAULT_CONFIDENCE = 0.5;

/**
 * POST /api/entries/fix-confidence
 *
 * Scans every entry and assigns a default 50% confidence to each link that
 * carries no confidence score yet — both bare-string links and link objects
 * missing the field. Existing confidences are left untouched. Admin-only.
 * Returns the number of entries persisted and links fixed.
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

  let fixed = 0; // individual links given a default confidence
  let updated = 0; // entries persisted
  let affectedCount = 0;
  const snapshotEntries: Array<{ id: string; before: { title?: string; links?: string } }> = [];

  for (const entry of all) {
    const links = parseLinkEntries(entry.links);
    if (links.length === 0) continue;

    let changed = 0;
    const nextLinks = links.map((le) => {
      if (typeof le.confidence !== "number") {
        changed += 1;
        return { ...le, confidence: DEFAULT_CONFIDENCE };
      }
      return le;
    });
    if (changed === 0) continue;

    affectedCount += 1;
    if (snapshotEntries.length < MAX_SNAPSHOT_ENTRIES) {
      snapshotEntries.push({
        id: entry.documentId,
        before: { title: entry.title, links: entry.links },
      });
    }

    await updateEntry(entry.documentId, {
      title: entry.title,
      links: serializeLinkEntries(nextLinks),
    });
    fixed += changed;
    updated += 1;
  }

  const snapshotTruncated = snapshotEntries.length < affectedCount;

  try {
    const log: AuditLogEntry = {
      action: "update",
      timestamp: new Date().toISOString(),
      entryId: "",
      entryTitle: "All entries",
      section: "links",
      details:
        `Fix link confidence: set ${fixed} link(s) to ` +
        `${Math.round(DEFAULT_CONFIDENCE * 100)}% across ${updated} ` +
        `entr${updated === 1 ? "y" : "ies"}`,
      snapshot: { entries: snapshotEntries, truncated: snapshotTruncated || undefined },
    };
    await updateMe(jwt, { auditLog: appendAuditLog(context.user.auditLog, log) });
  } catch {
    /* audit is best-effort */
  }

  /* Bust the "entries" cache tag so the DB stats page reflects the new
     confidence scores on its next (non-forced) load. */
  if (updated > 0) {
    try {
      revalidateTag("entries", "max");
    } catch {
      /* best-effort cache bust */
    }
  }

  return NextResponse.json({ updated, fixed });
}
