import { type NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import {
  getSessionJwt,
  loadUserContext,
  updateMe,
} from "@/app/lib/auth-server";
import {
  appendAuditLog,
  buildAuditDetails,
  type AuditLogEntry,
} from "@/app/lib/audit-log";
import type { LinkEntry } from "@/app/lib/entries";

/* ── config ─────────────────────────────────────────────────────────────── */

const STRAPI_BASE_URL = (
  process.env.STRAPI_URL ?? "http://localhost:1337"
).replace(/\/$/, "");
const STRAPI_API_TOKEN =
  process.env.STRAPI_TOKEN ?? "";

/* ── types ──────────────────────────────────────────────────────────────── */

type LinkEdge = {
  a: { documentId: string; title?: string };
  b: { documentId: string; title?: string };
  confidence?: number;
  source?: string;
};

type SaveLinksRequest = {
  edges: LinkEdge[];
};

type PerDocResult = {
  documentId: string;
  title: string;
  saved: boolean;
  error?: string;
};

/* ── helpers ────────────────────────────────────────────────────────────── */

function parseLinks(raw: unknown): LinkEntry[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return (parsed as unknown[])
        .map((v): LinkEntry | null => {
          if (typeof v === "string" && v.trim()) return { id: v.trim() };
          if (typeof v === "object" && v !== null) {
            const e = v as { id?: unknown; confidence?: unknown; source?: unknown; link?: unknown; desc?: unknown };
            if (typeof e.id === "string" && e.id.trim()) {
              return {
                id: e.id.trim(),
                ...(typeof e.confidence === "number" && { confidence: e.confidence }),
                ...(typeof e.source === "string" && e.source && { source: e.source }),
                ...(typeof e.link === "string" && e.link && { link: e.link }),
                ...(typeof e.desc === "string" && e.desc && { desc: e.desc }),
              };
            }
          }
          return null;
        })
        .filter((e): e is LinkEntry => e !== null);
    }
  } catch {
    /* ignore */
  }
  return [];
}

const strapiHeaders = (includeJson = false): HeadersInit => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
  };
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
};

async function fetchEntry(documentId: string): Promise<
  | {
      documentId: string;
      title: string;
      links: LinkEntry[];
    }
  | null
> {
  const res = await fetch(
    `${STRAPI_BASE_URL}/api/entries/${encodeURIComponent(documentId)}` +
      `?fields[0]=documentId&fields[1]=title&fields[2]=links`,
    {
      headers: strapiHeaders(),
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    data?: {
      documentId?: string;
      attributes?: Record<string, unknown>;
      title?: string;
      links?: string;
    } | null;
  } | null;
  const data = json?.data;
  if (!data) return null;
  const source = (data.attributes ?? data) as Record<string, unknown>;
  return {
    documentId:
      (source.documentId as string | undefined) ??
      (data.documentId as string | undefined) ??
      documentId,
    title: (source.title as string | undefined) ?? "(untitled)",
    links: parseLinks(source.links),
  };
}

async function putLinks(documentId: string, links: LinkEntry[]): Promise<void> {
  const res = await fetch(
    `${STRAPI_BASE_URL}/api/entries/${encodeURIComponent(documentId)}`,
    {
      method: "PUT",
      headers: strapiHeaders(true),
      body: JSON.stringify({
        data: { links: JSON.stringify(links) },
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `Strapi ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      if (text) message = text.slice(0, 200);
    }
    throw new Error(message);
  }
}

/* ── POST handler ───────────────────────────────────────────────────────── */

/**
 * POST /api/auth/admin/import-data/save-links
 *
 * Bidirectionally cross-links pairs of Strapi entries by editing the `links`
 * JSON field on each side. Only administrators may call this — it is the
 * server-side complement to the parts-list import flow and exists so that
 * imports do not require the importer to also have the `trusted` flag that
 * the general `/api/entries/[id]` PUT route demands.
 */
export async function POST(req: NextRequest) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json(
      { error: "Not authenticated." },
      { status: 401 },
    );
  }
  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (!STRAPI_API_TOKEN) {
    return NextResponse.json(
      { error: "Missing STRAPI API token." },
      { status: 500 },
    );
  }

  let body: SaveLinksRequest;
  try {
    body = (await req.json()) as SaveLinksRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const edges = Array.isArray(body.edges) ? body.edges : [];
  if (edges.length === 0) {
    return NextResponse.json({
      ok: true,
      saved: 0,
      failed: 0,
      results: [],
    });
  }

  /* Aggregate additions bidirectionally so each entry is touched at most
     once regardless of how many edges it participates in. */
  const additions = new Map<string, Map<string, LinkEntry>>();
  const titleByDocId = new Map<string, string>();

  for (const edge of edges) {
    const a = edge?.a;
    const b = edge?.b;
    if (
      !a?.documentId ||
      !b?.documentId ||
      a.documentId === b.documentId
    ) {
      continue;
    }
    if (a.title) titleByDocId.set(a.documentId, a.title);
    if (b.title) titleByDocId.set(b.documentId, b.title);
    if (!additions.has(a.documentId)) additions.set(a.documentId, new Map());
    if (!additions.has(b.documentId)) additions.set(b.documentId, new Map());
    additions.get(a.documentId)!.set(b.documentId, {
      id: b.documentId,
      confidence: edge.confidence ?? 0.5,
      source: edge.source ?? "Partslist AI parse",
    });
    additions.get(b.documentId)!.set(a.documentId, {
      id: a.documentId,
      confidence: edge.confidence ?? 0.5,
      source: edge.source ?? "Partslist AI parse",
    });
  }

  const results: PerDocResult[] = [];
  const auditEntries: AuditLogEntry[] = [];

  for (const [docId, additionsForDoc] of additions.entries()) {
    const fallbackTitle = titleByDocId.get(docId) ?? docId;
    try {
      const existing = await fetchEntry(docId);
      const existingLinks = existing?.links ?? [];
      const title = existing?.title ?? fallbackTitle;

      const merged: LinkEntry[] = [...existingLinks];
      for (const [addId, addEntry] of additionsForDoc.entries()) {
        if (addId !== docId && !merged.some((e) => e.id === addId)) {
          merged.push(addEntry);
        }
      }

      const unchanged =
        merged.length === existingLinks.length &&
        merged.every((m) => existingLinks.some((e) => e.id === m.id));

      if (!unchanged) {
        await putLinks(docId, merged);
        auditEntries.push({
          action: "update",
          timestamp: new Date().toISOString(),
          entryId: docId,
          entryTitle: title,
          section: "links",
          details: buildAuditDetails("update", "links", title),
        });
      }

      results.push({ documentId: docId, title, saved: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      results.push({
        documentId: docId,
        title: fallbackTitle,
        saved: false,
        error: message,
      });
    }
  }

  /* Persist audit entries (best-effort — never fail the request on a log
     write error). All entries are appended in a single save so we don't
     hammer the schema file. */
  if (auditEntries.length > 0) {
    try {
      let nextLog = context.user.auditLog;
      for (const entry of auditEntries) {
        nextLog = appendAuditLog(nextLog, entry);
      }
      await updateMe(jwt, { auditLog: nextLog });
    } catch (err) {
      console.error("[save-links] audit log persist failed:", err);
    }
  }

  const saved = results.filter((r) => r.saved).length;
  const failed = results.filter((r) => !r.saved).length;

  /* Bust the "entries" cache tag so the admin stats page and the cached
     listEntries() helper pick up the new links on their next request.
     Without this, freshly-saved cross-links can appear missing for up to
     five minutes (the cacheLife revalidate window).
     Next.js 16 requires the two-argument form — "max" gives the standard
     stale-while-revalidate semantics. */
  if (saved > 0) {
    try {
      revalidateTag("entries", "max");
    } catch (err) {
      console.error("[save-links] revalidateTag failed:", err);
    }
  }

  return NextResponse.json({ ok: true, saved, failed, results });
}
