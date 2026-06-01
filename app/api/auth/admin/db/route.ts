import { type NextRequest, NextResponse } from "next/server";
import { cacheLife, cacheTag } from "next/cache";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";

type StrapiListResponse<T> = {
  data?: T[];
  meta?: {
    pagination?: {
      page?: number;
      pageSize?: number;
      pageCount?: number;
      total?: number;
    };
  };
};

const STRAPI_BASE_URL = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_API_TOKEN = process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";
const PAGE_SIZE = 100;

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function buildCategoryList(): string[] {
  const rubriks = Array.from({ length: 15 }, (_, i) => `r${String(i + 1).padStart(2, "0")}`);
  return ["all", ...rubriks, "replacements", "extra", "unassigned"];
}

function parseText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function extractRubrikString(value: unknown, depth = 0): string {
  if (depth > 5) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = extractRubrikString(item, depth + 1);
      if (s) return s;
    }
    return "";
  }
  const obj = value as Record<string, unknown>;
  for (const key of ["value", "code", "label", "name", "rubrik", "text"]) {
    const s = extractRubrikString(obj[key], depth + 1);
    if (s) return s;
  }
  for (const v of Object.values(obj)) {
    const s = extractRubrikString(v, depth + 1);
    if (s) return s;
  }
  return "";
}

function normalizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const attributes = raw.attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    return { ...raw, ...(attributes as Record<string, unknown>) };
  }
  return raw;
}

function parseRubrikCategory(value: unknown): string {
  const key = extractRubrikString(value).toLowerCase();
  if (key === "replacement" || key === "replacements") return "replacements";
  if (key === "extra" || key === "extras") return "extra";
  const match = key.match(/^(?:rubrik[-_\s]*)?(?:r)?0*(\d{1,2})$/i);
  if (match) {
    const numeric = Number.parseInt(match[1]!, 10);
    if (numeric >= 1 && numeric <= 15) return `r${String(numeric).padStart(2, "0")}`;
  }
  return "unassigned";
}

/**
 * Coerce whatever Strapi gave us for the `links` field into an array of
 * documentId strings.
 *
 * Strapi has surfaced this field in three different shapes across the
 * codebase's history:
 *
 *   1. A native JSON array — when the field is declared as `json` Strapi
 *      parses the column server-side and returns `["docId1","docId2"]`.
 *   2. A double-stringified JSON string — what `save-links/route.ts`
 *      writes (`data: { links: JSON.stringify(array) }`). Strapi treats
 *      this as opaque text and echoes the same string back.
 *   3. A newline-delimited blob — pre-import legacy format.
 *
 * The previous implementation ran `parseText(rawLinks)` first which
 * collapsed any non-string value (including the JSON array case) to `""`,
 * silently returning zero links. That made the stats page report 0
 * cross-links for databases that actually have links. This rewrite
 * handles all three shapes plus the occasional object-wrapped target
 * (`{ documentId: "…" }`) that some Strapi populate payloads emit.
 */
function parseLinkIds(rawLinks: unknown): string[] {
  if (rawLinks == null) return [];

  const fromArray = (arr: unknown[]): string[] =>
    arr
      .flatMap((v): string[] => {
        if (typeof v === "string" || typeof v === "number") {
          return [String(v).trim()];
        }
        if (v && typeof v === "object") {
          const obj = v as Record<string, unknown>;
          const id = obj.documentId ?? obj.id ?? obj.value;
          if (typeof id === "string" || typeof id === "number") {
            return [String(id).trim()];
          }
        }
        return [];
      })
      .filter(Boolean);

  /* Case 1 — Strapi returned a parsed JSON array. */
  if (Array.isArray(rawLinks)) return fromArray(rawLinks);

  /* Case 2 + 3 — Strapi returned a string (either JSON.stringify'd array
     or newline-delimited legacy text). */
  if (typeof rawLinks === "string") {
    const text = rawLinks.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return fromArray(parsed);
    } catch {
      /* not JSON — fall through to newline-delimited handling */
    }
    return text.split(/\n+/).map((v) => v.trim()).filter(Boolean);
  }

  /* Defensive — a single object reference (e.g. populate=links emitted a
     relation rather than the json column). */
  if (typeof rawLinks === "object") {
    return fromArray([rawLinks]);
  }

  return [];
}

async function fetchCollectionPage<T>(
  path: string,
  page: number,
  pageSize = PAGE_SIZE,
): Promise<{ data: T[]; total: number; pageSize: number }> {
  const join = path.includes("?") ? "&" : "?";
  const url =
    `${STRAPI_BASE_URL}${path}${join}` +
    `sort=id:asc&pagination[page]=${page}&pagination[pageSize]=${pageSize}&pagination[withCount]=true`;

  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });

  if (!response.ok) throw new Error(`Failed to fetch ${path} (status ${response.status}).`);

  const payload = (await response.json()) as StrapiListResponse<T>;
  const data = Array.isArray(payload.data) ? payload.data : [];
  const effectivePageSize = payload.meta?.pagination?.pageSize ?? pageSize;
  const total = payload.meta?.pagination?.total ?? data.length;

  return { data, total, pageSize: effectivePageSize };
}

async function fetchAllCollection<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  const first = await fetchCollectionPage<T>(path, 1);
  all.push(...first.data);

  const pageCount = Math.ceil(first.total / first.pageSize);
  if (pageCount > 1) {
    const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
    const chunkSize = 6;
    for (let i = 0; i < remaining.length; i += chunkSize) {
      const chunk = remaining.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map((page) => fetchCollectionPage<T>(path, page, first.pageSize)),
      );
      for (const r of results) all.push(...r.data);
    }
  }

  return all;
}

function parseLinkObjects(rawLinks: unknown): Array<{ id: string; confidence?: number }> {
  if (rawLinks == null) return [];

  const fromItem = (v: unknown): { id: string; confidence?: number } | null => {
    if (typeof v === "string") {
      const s = v.trim();
      return s ? { id: s } : null;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const rawId = obj.documentId ?? obj.id ?? obj.value;
      if (typeof rawId === "string" && rawId.trim()) {
        const result: { id: string; confidence?: number } = { id: rawId.trim() };
        if (typeof obj.confidence === "number") result.confidence = obj.confidence;
        return result;
      }
    }
    return null;
  };

  const fromArray = (arr: unknown[]) =>
    arr.flatMap((v) => { const r = fromItem(v); return r ? [r] : []; });

  if (Array.isArray(rawLinks)) return fromArray(rawLinks);

  if (typeof rawLinks === "string") {
    const text = rawLinks.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return fromArray(parsed);
    } catch { /* not JSON */ }
    return text.split(/\n+/).map((v) => v.trim()).filter(Boolean).map((id) => ({ id }));
  }

  if (typeof rawLinks === "object") {
    const r = fromItem(rawLinks);
    return r ? [r] : [];
  }

  return [];
}

async function computeDbStatsRaw() {
  const [entriesRaw, usersRaw] = await Promise.all([
    fetchAllCollection<Record<string, unknown>>(
      "/api/entries?fields[0]=title&fields[1]=rubrik&fields[2]=links" +
      "&fields[3]=documentId&fields[4]=docs&populate[0]=pictures",
    ),
    fetchAllCollection<Record<string, unknown>>(
      "/api/customusers?fields[0]=email&fields[1]=confirmed&fields[2]=trusted&fields[3]=blocked&fields[4]=employee&fields[5]=administrator",
    ),
  ]);

  const entries = entriesRaw.map(normalizeRecord);
  const users   = usersRaw.map(normalizeRecord);

  const categories     = buildCategoryList();
  const categoryCounts: Record<string, number> = {};
  for (const cat of categories) categoryCounts[cat] = 0;

  const idToDoc         = new Map<string, string>();
  const documentIdSet   = new Set<string>();

  for (const entry of entries) {
    const id         = Number(entry.id);
    const documentId = parseText(entry.documentId) || String(id);
    const category   = parseRubrikCategory(entry.rubrik);

    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    idToDoc.set(String(id), documentId);
    documentIdSet.add(documentId);
  }

  const edgeKey     = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);
  const directedKey = (a: string, b: string) => `${a}->${b}`;
  const undirectedSet = new Set<string>();
  const directedSet   = new Set<string>();

  let totalLinkReferences  = 0;
  let entriesWithLinks     = 0;
  let danglingReferences   = 0;
  let selfReferences       = 0;
  let entriesWithDocs      = 0;
  let entriesWithImages    = 0;
  let linksWithConfidence  = 0;
  let linksWithoutConfidence = 0;
  let confidenceSum        = 0;
  let confidenceLow        = 0;   // < 34 %
  let confidenceMedium     = 0;   // 34–66 %
  let confidenceHigh       = 0;   // > 66 %

  for (const entry of entries) {
    const sourceDocId = parseText(entry.documentId);
    if (!sourceDocId) continue;

    /* ── Docs ─────────────────────────────────────────────────────────── */
    const docsRaw = entry.docs;
    if (docsRaw) {
      const docsText = parseText(docsRaw).trim();
      if (docsText && docsText !== "[]") {
        try {
          const parsed = JSON.parse(docsText) as unknown;
          if (Array.isArray(parsed) ? parsed.length > 0 : !!parsed) entriesWithDocs++;
        } catch {
          if (docsText.length > 0) entriesWithDocs++;
        }
      }
    }

    /* ── Images ───────────────────────────────────────────────────────── */
    const pics = entry.pictures;
    if (Array.isArray(pics) && pics.length > 0) {
      entriesWithImages++;
    } else if (pics && typeof pics === "object" && "data" in (pics as object)) {
      const data = (pics as { data: unknown }).data;
      if (Array.isArray(data) && data.length > 0) entriesWithImages++;
    }

    /* ── Links + confidence ───────────────────────────────────────────── */
    const linkIds = parseLinkIds(entry.links);
    if (linkIds.length > 0) entriesWithLinks++;

    const linkObjects = parseLinkObjects(entry.links);
    for (const obj of linkObjects) {
      if (typeof obj.confidence === "number") {
        linksWithConfidence++;
        confidenceSum += obj.confidence;
        const pct = obj.confidence * 100;
        if (pct < 34) confidenceLow++;
        else if (pct <= 66) confidenceMedium++;
        else confidenceHigh++;
      } else {
        linksWithoutConfidence++;
      }
    }

    for (const linkedId of linkIds) {
      totalLinkReferences++;

      const targetDoc = documentIdSet.has(linkedId)
        ? linkedId
        : idToDoc.get(linkedId);

      if (!targetDoc || !documentIdSet.has(targetDoc)) {
        danglingReferences++;
        continue;
      }
      if (targetDoc === sourceDocId) {
        selfReferences++;
        continue;
      }

      directedSet.add(directedKey(sourceDocId, targetDoc));
      undirectedSet.add(edgeKey(sourceDocId, targetDoc));
    }
  }

  let oneSidedPairs = 0;
  for (const key of undirectedSet) {
    const [a, b] = key.split("::") as [string, string];
    if (!(directedSet.has(directedKey(a, b)) && directedSet.has(directedKey(b, a)))) {
      oneSidedPairs++;
    }
  }

  const avgConfidence =
    linksWithConfidence > 0
      ? Math.round((confidenceSum / linksWithConfidence) * 100)
      : null;

  return {
    stats: {
      totalEntries:          entries.length,
      totalUsers:            users.length,
      totalLinkPairs:        undirectedSet.size,
      totalLinkReferences,
      entriesWithLinks,
      danglingReferences,
      selfReferences,
      oneSidedPairs,
      entriesWithDocs,
      entriesWithImages,
      linksWithConfidence,
      linksWithoutConfidence,
      avgConfidence,
      confidenceLow,
      confidenceMedium,
      confidenceHigh,
      categories:            categoryCounts,
      generatedAt:           new Date().toISOString(),
    },
  };
}

/**
 * Stale-while-revalidate wrapper around `computeDbStatsRaw`.
 *
 * Tuning:
 *   - `stale`      30 min — client router can keep showing the cached payload
 *                  for that long after the panel is reopened, so re-opening
 *                  the stats page from anywhere on the site is instant.
 *   - `revalidate` 10 min — background re-compute window. Live edits won't
 *                  appear until then unless save-links calls
 *                  `revalidateTag("entries")` (which it does).
 *   - `expire`     1 day  — hard upper bound; after this the next request
 *                  blocks on a fresh compute.
 *
 * Tagged with "entries" so any future call to `revalidateTag("entries")`
 * blows the cache away — handy for write paths that want their effects to
 * be visible on the next stats refresh.
 */
async function computeDbStatsCached() {
  "use cache";
  cacheLife({ stale: 1800, revalidate: 600, expire: 86400 });
  cacheTag("entries");
  return computeDbStatsRaw();
}

export async function GET(req: NextRequest) {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  if (!STRAPI_API_TOKEN) return NextResponse.json({ error: "Missing STRAPI API token." }, { status: 500 });

  /* `?nocache=1` forces a fresh compute. The admin "Refresh" button in
     DBStatsContent passes this when the user explicitly wants up-to-date
     numbers after a recent write (e.g. just saved cross-links). Without it
     the answer can be up to 5 minutes stale. */
  const noCache = new URL(req.url).searchParams.get("nocache") === "1";

  try {
    const result = noCache
      ? await computeDbStatsRaw()
      : await computeDbStatsCached();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to compute DB stats.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
