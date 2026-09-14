export type StrapiMedia = {
  id: number;
  documentId?: string;
  url?: string;
  name?: string;
  alternativeText?: string;
  caption?: string;
  width?: number;
  height?: number;
  formats?: Record<string, { url: string; width?: number; height?: number }> | null;
};

export type EntryMedia = {
  id: number;
  name?: string;
  url: string;
};

export type Entry = {
  id: number;
  documentId: string;
  title: string;
  artNr?: string;
  EAN?: string;
  rubrik?: string | string[] | Record<string, unknown>;
  desc?: string;
  tags?: string;
  docs?: string;
  links?: string;
  issues?: string;
  tickets?: string;
  igs?: string;
  pictures?: StrapiMedia[] | number[];
  pictureUrls?: string[];
  miscFile?: StrapiMedia[] | number[];
  miscFiles?: EntryMedia[];
  updatedAt?: string;
};

export type EntryPayload = {
  title: string;
  artNr?: string;
  EAN?: string;
  desc?: string;
  tags?: string;
  docs?: string;
  links?: string;
  issues?: string;
  tickets?: string;
  igs?: string;
  pictures?: number[] | StrapiMedia[];
  miscFile?: number[] | StrapiMedia[];
  rubrik?: string | string[] | Record<string, unknown>;
};

/** The two artNr-ordered neighbourhoods around an entry (see getArtNrNeighbors). */
export type EntryNeighbors = { before: Entry[]; after: Entry[] };

export type LinkVote = { v: 1 | -1; r?: string };

export type LinkEntry = {
  id: string;
  confidence?: number;
  source?: string;
  link?: string;
  desc?: string;
  votes?: Record<string, LinkVote>;
};

export function parseLinkEntries(value?: string): LinkEntry[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item): LinkEntry | null => {
          if (typeof item === "string") return item.trim() ? { id: item.trim() } : null;
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as { id?: unknown }).id === "string" &&
            (item as { id: string }).id.trim()
          ) {
            const e = item as {
              id: string;
              confidence?: unknown;
              source?: unknown;
              link?: unknown;
              desc?: unknown;
              votes?: unknown;
            };
            return {
              id: e.id.trim(),
              ...(typeof e.confidence === "number" && { confidence: e.confidence }),
              ...(typeof e.source === "string" && e.source && { source: e.source }),
              ...(typeof e.link === "string" && e.link && { link: e.link }),
              ...(typeof e.desc === "string" && e.desc && { desc: e.desc }),
              ...(e.votes && typeof e.votes === "object" && !Array.isArray(e.votes) ? { votes: e.votes as Record<string, LinkVote> } : {}),
            };
          }
          return null;
        })
        .filter((e): e is LinkEntry => e !== null);
    }
  } catch {
    // fall through
  }
  return value
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id }));
}

export function serializeLinkEntries(values: LinkEntry[]): string {
  return JSON.stringify(
    values
      .map((e) => ({
        id: e.id.trim(),
        ...(e.confidence !== undefined && { confidence: e.confidence }),
        ...(e.source && { source: e.source }),
        ...(e.link && { link: e.link }),
        ...(e.desc && { desc: e.desc }),
        ...(e.votes && Object.keys(e.votes).length > 0 && { votes: e.votes }),
      }))
      .filter((e) => e.id)
  );
}

// Server-only. The browser must never hold the Strapi URL or token — all
// browser data access goes through the Next.js /api/* routes below.
const STRAPI_URL = process.env.STRAPI_URL ?? "http://localhost:1337";
const POPULATE_QUERY = "?populate[0]=pictures&populate[1]=miscFile";
// Lighter field projection for the listing page: drops docs/links/issues/
// tickets/miscFile so the RSC payload sent to 50 browsers is far smaller.
const LIST_FIELDS_QUERY =
  "?fields[0]=id&fields[1]=documentId&fields[2]=title" +
  "&fields[3]=artNr&fields[4]=EAN&fields[5]=rubrik" +
  "&fields[6]=tags&fields[7]=desc&fields[8]=IGS" +
  "&fields[9]=updatedAt&populate[0]=pictures";
// Light projection for the artNr-neighbours window on the product page: just
// enough to render a row (id/documentId/title/artNr/EAN) plus the first picture
// for a thumbnail.
const NEIGHBOR_FIELDS_QUERY =
  "?fields[0]=id&fields[1]=documentId&fields[2]=title" +
  "&fields[3]=artNr&fields[4]=EAN&populate[0]=pictures";
const LIST_PAGE_SIZE = 100;
// The listing page loads only this many of the most-recently-updated entries
// up front; everything else is reachable via the server search endpoint.
const RECENT_LIMIT = 300;
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheRecord<T> = {
  value: T;
  expiresAt: number;
};

let listEntriesCache: CacheRecord<Entry[]> | null = null;
let listEntriesInFlight: Promise<Entry[]> | null = null;
let listRecentEntriesCache: CacheRecord<Entry[]> | null = null;
let listRecentEntriesInFlight: Promise<Entry[]> | null = null;
// Numbered rubrik sections are small, so we load each one in full (cached per
// section). The big "all"/"extra" buckets never come through here.
const sectionEntriesCache = new Map<string, CacheRecord<Entry[]>>();
const sectionEntriesInFlight = new Map<string, Promise<Entry[]>>();

const entryCacheByDocumentId = new Map<string, CacheRecord<Entry>>();
const numericIdToDocumentIdCache = new Map<string, CacheRecord<string>>();
const resolveDocumentIdInFlight = new Map<string, Promise<string | null>>();
const getEntryInFlightByDocumentId = new Map<string, Promise<Entry | null>>();

const mediaCacheById = new Map<number, CacheRecord<EntryMedia | null>>();
const mediaInFlightById = new Map<number, Promise<EntryMedia | null>>();
const searchEntriesCache = new Map<string, CacheRecord<Entry[]>>();
const searchEntriesInFlight = new Map<string, Promise<Entry[]>>();
const SEARCH_CACHE_MAX = 50;

function pruneSearchCache() {
  if (searchEntriesCache.size > SEARCH_CACHE_MAX) {
    // Map preserves insertion order — delete the oldest entry
    const firstKey = searchEntriesCache.keys().next().value;
    if (firstKey !== undefined) searchEntriesCache.delete(firstKey);
  }
}

function isCacheFresh<T>(record: CacheRecord<T> | null | undefined): record is CacheRecord<T> {
  return Boolean(record && Date.now() < record.expiresAt);
}

function cacheEntry(entry: Entry) {
  const record: CacheRecord<Entry> = {
    value: entry,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  entryCacheByDocumentId.set(entry.documentId, record);
  numericIdToDocumentIdCache.set(String(entry.id), {
    value: entry.documentId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function invalidateEntriesListCache() {
  listEntriesCache = null;
  listRecentEntriesCache = null;
  sectionEntriesCache.clear();
}

function toAbsoluteUrl(url: string): string {
  if (!url) {
    return "";
  }

  if (/^https?:\/\//i.test(url)) {
    // Strip the Strapi origin so the browser fetches via the proxied /uploads/ path,
    // making media accessible from any host (not just localhost).
    const strapiOrigin = STRAPI_URL.replace(/\/$/, "");
    if (url.startsWith(strapiOrigin)) {
      return url.slice(strapiOrigin.length);
    }
    return url;
  }

  return `/${url.replace(/^\//, "")}`;
}

function extractStringValue(value: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return "";
    }

    if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractStringValue(JSON.parse(trimmed), depth + 1, seen);
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value).trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (seen.has(value) || depth > 5) {
    return "";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractStringValue(item, depth + 1, seen);
      if (extracted) {
        return extracted;
      }
    }

    return "";
  }

  const source = value as Record<string, unknown>;
  const preferredKeys = ["value", "code", "label", "name", "rubrik", "text", "title"];

  for (const key of preferredKeys) {
    const candidate = source[key];
    const extracted = extractStringValue(candidate, depth + 1, seen);
    if (extracted) {
      return extracted;
    }
  }

  for (const candidate of Object.values(source)) {
    const extracted = extractStringValue(candidate, depth + 1, seen);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

export function normalizeRubrikValue(value: unknown): string {
  return extractStringValue(value).trim().toUpperCase();
}

function extractAllStringValues(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return extractAllStringValues(JSON.parse(trimmed), depth + 1, seen);
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  if (!value || typeof value !== "object" || seen.has(value) || depth > 5) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item) => extractAllStringValues(item, depth + 1, seen));
  }
  const s = extractStringValue(value, depth, seen);
  return s ? [s] : [];
}

export function normalizeRubrikValues(value: unknown): string[] {
  return extractAllStringValues(value).map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Returns the trimmed string value, or the placeholder when the value is
 * null/undefined/empty.
 */
export function displayValue(value: unknown, placeholder = "---"): string {
  if (value === null || value === undefined) {
    return placeholder;
  }

  const str = typeof value === "string" ? value.trim() : String(value).trim();
  return str.length > 0 ? str : placeholder;
}

export function parseRubrikNumber(value: unknown): number | null {
  const key = normalizeRubrikValue(value).toLowerCase();
  const match = key.match(/^(?:rubrik[-_\s]*)?(?:r)?0*(\d{1,2})$/i);

  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1]!, 10);
  return parsed >= 1 && parsed <= 15 ? parsed : null;
}

function parseSingleRubrikStr(key: string): number | null {
  const match = key.toLowerCase().match(/^(?:rubrik[-_\s]*)?(?:r)?0*(\d{1,2})$/i);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return n >= 1 && n <= 15 ? n : null;
}

export function parseRubrikNumbers(value: unknown): number[] {
  const strs = normalizeRubrikValues(value);
  return [...new Set(strs.map(parseSingleRubrikStr).filter((n): n is number => n !== null))];
}

function getHeaders(includeJson = false): HeadersInit {
  const headers: HeadersInit = {};
  const token = process.env.STRAPI_TOKEN;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (includeJson) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

function extractPictureUrls(pictures?: StrapiMedia[] | unknown): string[] {
  if (!pictures) {
    return [];
  }

  const relation = pictures as { data?: unknown };
  const rawItems = Array.isArray(relation?.data)
    ? relation.data
    : Array.isArray(pictures)
      ? pictures
      : [];

  if (rawItems.length === 0) {
    return [];
  }

  return rawItems
    .map((pic, idx) => {
      try {
        const item = pic as { attributes?: Record<string, unknown> } & StrapiMedia;
        const source = (item.attributes ?? item) as Record<string, unknown>;
        
        // Try multiple sources for URL.
        // For TIFF files, prefer Strapi's generated JPEG format versions (large/medium/small/thumbnail)
        // since browsers cannot natively render TIFF in <img> tags.
        const formats = source.formats as Record<string, { url?: string }> | undefined;
        const originalUrl = source.url as string | undefined;
        const isTiff = /\.tiff?(\?|#|$)/i.test(originalUrl ?? "");
        const candidates = isTiff
          ? [
              formats?.large?.url,
              formats?.medium?.url,
              formats?.small?.url,
              formats?.thumbnail?.url,
              originalUrl,
            ]
          : [
              originalUrl,
              formats?.large?.url,
              formats?.medium?.url,
              formats?.small?.url,
              formats?.thumbnail?.url,
            ];
        
        const bestUrl = candidates.find((url) => url && url.trim());

        if (!bestUrl) {
          return "";
        }

        return toAbsoluteUrl(bestUrl);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function extractMediaItems(media?: StrapiMedia[] | unknown): EntryMedia[] {
  if (!media) {
    return [];
  }

  const relation = media as { data?: unknown };
  const rawItems = Array.isArray(relation?.data)
    ? relation.data
    : Array.isArray(media)
      ? media
      : [];

  const mapped = rawItems
    .map((item) => {
      const mediaItem = item as { attributes?: Record<string, unknown> } & StrapiMedia;
      const source = (mediaItem.attributes ?? mediaItem) as Record<string, unknown>;
      const formats = source.formats as Record<string, { url?: string }> | undefined;
      const bestUrl =
        (source.url as string | undefined) ??
        formats?.large?.url ??
        formats?.medium?.url ??
        formats?.small?.url ??
        formats?.thumbnail?.url ??
        "";
      const absoluteUrl = toAbsoluteUrl(bestUrl);
      const id = Number(source.id ?? mediaItem.id);

      if (!absoluteUrl || Number.isNaN(id)) {
        return undefined;
      }

      return {
        id,
        name: source.name as string | undefined,
        url: absoluteUrl,
      } as EntryMedia;
    });

  return mapped.filter((item): item is EntryMedia => item !== undefined);
}

function normalizeEntry(raw: unknown): Entry {
  const item = raw as {
    id: number;
    documentId?: string;
    attributes?: Record<string, unknown>;
  };
  const source = (item.attributes ?? item) as Record<string, unknown>;
  const documentId =
    (source.documentId as string | undefined) ??
    item.documentId ??
    String(item.id);

  const pictures = source.pictures as StrapiMedia[] | undefined;
  const pictureUrls = extractPictureUrls(pictures);
  const miscFile = source.miscFile as StrapiMedia[] | undefined;
  const miscFiles = extractMediaItems(miscFile);

  // Helper to normalize JSON fields: if already string, keep it; if array/object, stringify it
  const normalizeJsonField = (value: unknown): string | undefined => {
    if (!value) return undefined;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  };

  return {
    id: item.id,
    documentId,
    title: (source.title as string) ?? "Untitled",
    artNr: source.artNr as string | undefined,
    EAN: source.EAN as string | undefined,
    rubrik: source.rubrik as string | string[] | Record<string, unknown> | undefined,
    desc: source.desc as string | undefined,
    tags: normalizeJsonField(source.tags),
    docs: normalizeJsonField(source.docs),
    links: normalizeJsonField(source.links),
    issues: normalizeJsonField(source.issues),
    tickets: normalizeJsonField(source.tickets),
    igs: normalizeJsonField(source.igs ?? source.IGS),
    pictures,
    pictureUrls,
    miscFile,
    miscFiles,
    updatedAt: source.updatedAt as string | undefined,
  };
}

function toStrapiPayload(payload: EntryPayload) {
  return {
    title: payload.title,
    artNr: payload.artNr,
    EAN: payload.EAN,
    desc: payload.desc,
    tags: payload.tags,
    docs: payload.docs,
    links: payload.links,
    issues: payload.issues,
    tickets: payload.tickets,
    IGS: payload.igs,
    pictures: payload.pictures,
    miscFile: payload.miscFile,
    rubrik: (() => {
      const r = payload.rubrik;
      if (r == null) return null;
      if (Array.isArray(r)) return r.length > 0 ? r : null;
      if (typeof r === "string") return r.trim() ? [r.trim()] : null;
      return r;
    })(),
  };
}

async function parseResponse<T>(res: Response): Promise<T> {
  const json = (await res.json()) as { data?: T; error?: { message?: string; details?: unknown } };

  if (!res.ok) {
    const message = json.error?.message ?? "Strapi request failed.";
    const details = json.error?.details ? ` (${JSON.stringify(json.error.details)})` : "";
    console.error("=== STRAPI ERROR ===");
    console.error("Status:", res.status);
    console.error("URL:", res.url);
    console.error("Message:", message);
    console.error("Details:", details);
    console.error("Full JSON:", JSON.stringify(json, null, 2));
    console.error("==================");
    throw new Error(message + details);
  }

  if (json.data === undefined) {
    throw new Error("Unexpected Strapi response shape.");
  }

  return json.data;
}

export async function listEntries(): Promise<Entry[]> {
  // ── Client-side: route through the Next.js API so the token stays on the
  // server and employee-only fields are stripped before reaching the browser.
  if (typeof window !== "undefined") {
    const res = await fetch("/api/entries");
    if (!res.ok) return [];
    return (await res.json()) as Entry[];
  }

  if (isCacheFresh(listEntriesCache)) {
    return listEntriesCache.value;
  }

  if (listEntriesInFlight) {
    return listEntriesInFlight;
  }

  type ListResponse<T> = {
    data?: T;
    meta?: {
      pagination?: {
        page?: number;
        pageSize?: number;
        pageCount?: number;
        total?: number;
      };
    };
    error?: { message?: string; details?: unknown };
  };

  async function parseListResponse<T>(res: Response): Promise<{
    data: T;
    pageCount?: number;
    pageSize?: number;
    total?: number;
  }> {
    const json = (await res.json()) as ListResponse<T>;

    if (!res.ok) {
      const message = json.error?.message ?? "Strapi request failed.";
      const details = json.error?.details ? ` (${JSON.stringify(json.error.details)})` : "";
      console.error("=== STRAPI ERROR ===");
      console.error("Status:", res.status);
      console.error("URL:", res.url);
      console.error("Message:", message);
      console.error("Details:", details);
      console.error("Full JSON:", JSON.stringify(json, null, 2));
      console.error("==================");
      throw new Error(message + details);
    }

    if (json.data === undefined) {
      throw new Error("Unexpected Strapi response shape.");
    }

    return {
      data: json.data,
      pageCount: json.meta?.pagination?.pageCount,
      pageSize: json.meta?.pagination?.pageSize,
      total: json.meta?.pagination?.total,
    };
  }

  listEntriesInFlight = (async () => {
    const allEntries: unknown[] = [];

    // Sort by id:asc so every page has a stable, non-overlapping window.
    // Without an explicit sort Strapi uses updatedAt (ties are common after
    // bulk imports), causing pages to overlap and entries to be missed.
    const SORT_PARAM = "&sort=id:asc";

    const firstResponse = await fetch(
      `${STRAPI_URL}/api/entries${POPULATE_QUERY}${SORT_PARAM}&pagination[pageSize]=${LIST_PAGE_SIZE}&pagination[page]=1&pagination[withCount]=true`,
      { headers: getHeaders(), next: { revalidate: 3600 } }
    );

    const firstPage = await parseListResponse<unknown[]>(firstResponse);
    allEntries.push(...firstPage.data);

    const effectivePageSize = firstPage.pageSize ?? LIST_PAGE_SIZE;
    // Compute real page count from `total` rather than trusting `pageCount`,
    // which Strapi can cap via its maxLimit setting.
    const pageCount =
      firstPage.total != null
        ? Math.ceil(firstPage.total / effectivePageSize)
        : (firstPage.pageCount ?? 1);

    if (pageCount > 1) {
      const remainingPages = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
      const chunkSize = 6;

      for (let i = 0; i < remainingPages.length; i += chunkSize) {
        const chunk = remainingPages.slice(i, i + chunkSize);
        const chunkData = await Promise.all(
          chunk.map(async (page) => {
            const res = await fetch(
              `${STRAPI_URL}/api/entries${POPULATE_QUERY}${SORT_PARAM}&pagination[pageSize]=${effectivePageSize}&pagination[page]=${page}&pagination[withCount]=true`,
              { headers: getHeaders(), next: { revalidate: 3600 } }
            );
            return (await parseListResponse<unknown[]>(res)).data;
          })
        );
        for (const pageData of chunkData) {
          allEntries.push(...pageData);
        }
      }
    }

    const normalized = allEntries.map(normalizeEntry);

    // Strapi v5 can return multiple variants of the same document
    // (draft + published, or locale versions) all sharing one documentId.
    // Keep only the first occurrence to avoid duplicate React keys.
    const seenDocumentIds = new Set<string>();
    const deduplicated = normalized.filter((entry) => {
      if (seenDocumentIds.has(entry.documentId)) return false;
      seenDocumentIds.add(entry.documentId);
      return true;
    });

    listEntriesCache = {
      value: deduplicated,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };

    for (const entry of deduplicated) {
      cacheEntry(entry);
    }

    return deduplicated;
  })();

  try {
    return await listEntriesInFlight;
  } finally {
    listEntriesInFlight = null;
  }
}

/**
 * Loads only the most-recently-updated entries — the working set most users
 * actually look at — in a single Strapi request.
 *
 * This deliberately does NOT paginate the whole catalogue. The listing page
 * (/products/all) renders these by default and routes full-text search
 * through the server search endpoint (searchEntries), which covers every
 * entry, so nothing becomes unreachable.
 *
 * Uses the lighter LIST_FIELDS projection (drops docs/links/issues/tickets/
 * miscFile) so the RSC payload shipped to each browser stays small.
 */
export async function listRecentEntries(limit = RECENT_LIMIT): Promise<Entry[]> {
  if (isCacheFresh(listRecentEntriesCache)) {
    return listRecentEntriesCache.value;
  }

  if (listRecentEntriesInFlight) {
    return listRecentEntriesInFlight;
  }

  listRecentEntriesInFlight = (async () => {
    // Single request, newest first. sort by updatedAt (most recently touched)
    // with id as a stable tiebreak.
    const res = await fetch(
      `${STRAPI_URL}/api/entries${LIST_FIELDS_QUERY}` +
        `&sort[0]=updatedAt:desc&sort[1]=id:desc` +
        `&pagination[pageSize]=${limit}&pagination[page]=1`,
      { headers: getHeaders(), next: { revalidate: 300 } },
    );

    const json = (await res.json()) as {
      data?: unknown[];
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(json.error?.message ?? "Failed to fetch entries");
    }

    const normalized = (json.data ?? []).map(normalizeEntry);
    const seenDocumentIds = new Set<string>();
    const deduplicated = normalized.filter((entry) => {
      if (seenDocumentIds.has(entry.documentId)) return false;
      seenDocumentIds.add(entry.documentId);
      return true;
    });

    listRecentEntriesCache = {
      value: deduplicated,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };

    for (const entry of deduplicated) {
      cacheEntry(entry);
    }

    return deduplicated;
  })();

  try {
    return await listRecentEntriesInFlight;
  } finally {
    listRecentEntriesInFlight = null;
  }
}

/**
 * Strapi rubrik filter for a browseable section, or `null` for sections that
 * should fall back to the recent set. Numbered rubriks (R01–R15) and
 * `replacements` are small enough to load in full; `all` and `extra` (the
 * ~13k uncategorised bucket) are not, so they return `null` here.
 */
function sectionRubrikFilter(section: string): string | null {
  const m = section.match(/^rubrik-(?:r)?0*(\d{1,2})$/i);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    if (n >= 1 && n <= 15) {
      return `filters[rubrik][$containsi]=R${String(n).padStart(2, "0")}`;
    }
  }
  if (section === "replacements" || section === "replacement") {
    return `filters[rubrik][$containsi]=replacement`;
  }
  return null;
}

/**
 * Loads every entry in a single browseable section (numbered rubrik or
 * replacements) so the listing page shows the whole category, sortable and
 * fully client-searchable. Sections are small (≤~1100), and Strapi caps
 * pageSize at 100, so we page through in parallel chunks and cache per section.
 *
 * `all` and `extra` are far too large to bulk-load, so they fall back to
 * listRecentEntries() (newest N) — matching the site-wide "most recent" model.
 */
export async function listEntriesBySection(section: string): Promise<Entry[]> {
  const filter = sectionRubrikFilter(section);
  if (!filter) {
    return listRecentEntries();
  }

  const cached = sectionEntriesCache.get(section);
  if (isCacheFresh(cached)) {
    return cached.value;
  }
  const inFlight = sectionEntriesInFlight.get(section);
  if (inFlight) {
    return inFlight;
  }

  const fetchPage = async (page: number) => {
    const res = await fetch(
      `${STRAPI_URL}/api/entries${LIST_FIELDS_QUERY}` +
        `&${filter}&sort=id:asc` +
        `&pagination[pageSize]=100&pagination[page]=${page}&pagination[withCount]=true`,
      { headers: getHeaders(), next: { revalidate: 300 } },
    );
    const json = (await res.json()) as {
      data?: unknown[];
      meta?: { pagination?: { pageCount?: number } };
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(json.error?.message ?? "Failed to fetch entries");
    }
    return { data: json.data ?? [], pageCount: json.meta?.pagination?.pageCount ?? 1 };
  };

  const request = (async () => {
    const all: unknown[] = [];
    const first = await fetchPage(1);
    all.push(...first.data);

    if (first.pageCount > 1) {
      const rest = Array.from({ length: first.pageCount - 1 }, (_, i) => i + 2);
      const chunkSize = 6;
      for (let i = 0; i < rest.length; i += chunkSize) {
        const results = await Promise.all(
          rest.slice(i, i + chunkSize).map((p) => fetchPage(p)),
        );
        for (const r of results) all.push(...r.data);
      }
    }

    const normalized = all.map(normalizeEntry);
    const seenDocumentIds = new Set<string>();
    const deduplicated = normalized.filter((entry) => {
      if (seenDocumentIds.has(entry.documentId)) return false;
      seenDocumentIds.add(entry.documentId);
      return true;
    });

    sectionEntriesCache.set(section, {
      value: deduplicated,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    for (const entry of deduplicated) {
      cacheEntry(entry);
    }

    return deduplicated;
  })();

  sectionEntriesInFlight.set(section, request);
  try {
    return await request;
  } finally {
    sectionEntriesInFlight.delete(section);
  }
}

export async function searchEntries(query: string, limit = 24): Promise<Entry[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, 100));

  // ── Client-side fast path ──────────────────────────────────────────────
  // Route through the Next.js API so that (a) the Strapi token stays on the
  // server and (b) employee-only fields are stripped before reaching the
  // browser.  This mirrors the same pattern used by getEntryById.
  if (typeof window !== "undefined") {
    const params = new URLSearchParams({ q: trimmed, limit: String(safeLimit) });
    const res = await fetch(`/api/entries/search?${params.toString()}`);
    if (!res.ok) return [];
    return (await res.json()) as Entry[];
  }

  // ── Server-side path: fetch directly from Strapi ───────────────────────
  const cacheKey = `${trimmed.toLowerCase()}::${safeLimit}`;
  const cached = searchEntriesCache.get(cacheKey);
  if (isCacheFresh(cached)) {
    return cached.value;
  }

  const inFlight = searchEntriesInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  // Token-based AND-of-ORs: every whitespace-separated token must match at
  // least one field (title / artNr / EAN / documentId / tags / desc). This lets
  // multi-word queries match across fields (e.g. "pump 230v" → title contains
  // "pump" AND artNr contains "230v"), searches tokenized tags, and pushes all
  // the matching work into Strapi so the entire catalogue is searched without
  // loading it into memory. A single-token query collapses to the old behaviour.
  // `desc` is included so numbers embedded in the description — e.g. the
  // "7753050" in `2"AG (7753050)` — are findable, even though $containsi is a
  // substring match rather than a whole-word one.
  const SEARCH_FIELDS = ["title", "artNr", "EAN", "documentId", "tags", "desc"] as const;
  const tokens = trimmed.split(/\s+/).filter(Boolean).slice(0, 8);
  const filterQuery = tokens
    .flatMap((token, ti) => {
      const enc = encodeURIComponent(token);
      return SEARCH_FIELDS.map(
        (field, fi) =>
          `filters[$and][${ti}][$or][${fi}][${field}][$containsi]=${enc}`,
      );
    })
    .join("&");

  const request = (async () => {
    const res = await fetch(
      `${STRAPI_URL}/api/entries${POPULATE_QUERY}` +
        `&pagination[pageSize]=${safeLimit}` +
        `&${filterQuery}`,
      {
        headers: getHeaders(),
        cache: "no-store",
      }
    );

    const data = await parseResponse<unknown[]>(res);
    const normalized = data.map(normalizeEntry);

    // Deduplicate by documentId for the same reason as listEntries.
    const seenDocumentIds = new Set<string>();
    const deduplicated = normalized.filter((entry) => {
      if (seenDocumentIds.has(entry.documentId)) return false;
      seenDocumentIds.add(entry.documentId);
      return true;
    });

    searchEntriesCache.set(cacheKey, {
      value: deduplicated,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    pruneSearchCache();

    for (const entry of deduplicated) {
      cacheEntry(entry);
    }

    return deduplicated;
  })();

  searchEntriesInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    searchEntriesInFlight.delete(cacheKey);
  }
}

async function resolveDocumentId(identifier: string): Promise<string | null> {
  if (!/^\d+$/.test(identifier)) {
    return identifier;
  }

  const cachedDocumentId = numericIdToDocumentIdCache.get(identifier);
  if (isCacheFresh(cachedDocumentId)) {
    return cachedDocumentId.value;
  }

  const inFlight = resolveDocumentIdInFlight.get(identifier);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    const res = await fetch(
      `${STRAPI_URL}/api/entries?filters[id][$eq]=${identifier}&pagination[pageSize]=1`,
      {
        headers: getHeaders(),
        cache: "no-store",
      }
    );

    const data = await parseResponse<unknown[]>(res);
    const first = data[0];

    if (!first) {
      return null;
    }

    const normalized = normalizeEntry(first);
    cacheEntry(normalized);
    return normalized.documentId;
  })();

  resolveDocumentIdInFlight.set(identifier, request);
  try {
    return await request;
  } finally {
    resolveDocumentIdInFlight.delete(identifier);
  }
}

export async function getEntryById(id: string): Promise<Entry | null> {
  // ── Client-side fast path ──────────────────────────────────────────────
  // When running in the browser, route through the Next.js API route instead
  // of calling Strapi directly.  This means all 50 users share the server's
  // module-level cache: the first user's request hits Strapi, every
  // subsequent request for the same entry is served from memory.
  if (typeof window !== "undefined") {
    // Check local browser cache first (populated by previous calls this
    // session) to skip even the Next.js API round-trip.
    const docIdCached = /^\d+$/.test(id)
      ? (numericIdToDocumentIdCache.get(id)?.value ?? null)
      : id;
    if (docIdCached) {
      const browserCached = entryCacheByDocumentId.get(docIdCached);
      if (isCacheFresh(browserCached)) return browserCached.value;
    }

    const res = await fetch(`/api/entries/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as Entry | null;
    if (!data) return null;
    cacheEntry(data);
    return data;
  }

  // ── Server-side path: fetch directly from Strapi ───────────────────────
  const documentId = await resolveDocumentId(id);

  if (!documentId) {
    return null;
  }

  const cachedEntry = entryCacheByDocumentId.get(documentId);
  if (isCacheFresh(cachedEntry)) {
    return cachedEntry.value;
  }

  const inFlight = getEntryInFlightByDocumentId.get(documentId);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    const res = await fetch(`${STRAPI_URL}/api/entries/${documentId}${POPULATE_QUERY}`, {
      headers: getHeaders(),
      cache: "no-store",
    });

    if (res.status === 404) {
      return null;
    }

    const data = await parseResponse<unknown>(res);
    const normalized = normalizeEntry(data);
    cacheEntry(normalized);
    return normalized;
  })();

  getEntryInFlightByDocumentId.set(documentId, request);
  try {
    return await request;
  } finally {
    getEntryInFlightByDocumentId.delete(documentId);
  }
}

/**
 * Loads the entries whose artNr sits immediately before and after the given
 * artNr in lexicographic (dictionary) order. Because a base article's variants
 * are formed by appending digits — "04305" → "043051", "043052" — the base
 * sorts right before its variants, so this window naturally shows an item
 * together with its replacement parts / versions.
 *
 * `count` items are returned on each side. The `before` list is ordered so it
 * reads top-to-bottom toward the current entry (i.e. closest-last).
 */
export async function getArtNrNeighbors(artNr: string, count: number): Promise<EntryNeighbors> {
  const trimmed = artNr.trim();
  if (!trimmed) {
    return { before: [], after: [] };
  }

  const safeCount = Math.max(1, Math.min(count, 50));

  // ── Client-side: route through the Next.js API so the Strapi token stays on
  // the server (mirrors searchEntries / getEntryById).
  if (typeof window !== "undefined") {
    const params = new URLSearchParams({ artNr: trimmed, count: String(safeCount) });
    const res = await fetch(`/api/entries/neighbors?${params.toString()}`);
    if (!res.ok) return { before: [], after: [] };
    return (await res.json()) as EntryNeighbors;
  }

  // ── Server-side: one Strapi request per direction. `$gt`/`$lt` on the artNr
  // string column give the dictionary-order neighbours.
  const fetchDirection = async (direction: "before" | "after"): Promise<Entry[]> => {
    const op = direction === "after" ? "$gt" : "$lt";
    const order = direction === "after" ? "asc" : "desc";
    const res = await fetch(
      `${STRAPI_URL}/api/entries${NEIGHBOR_FIELDS_QUERY}` +
        `&filters[artNr][${op}]=${encodeURIComponent(trimmed)}` +
        `&sort=artNr:${order}` +
        `&pagination[pageSize]=${safeCount}&pagination[page]=1`,
      { headers: getHeaders(), cache: "no-store" },
    );

    const json = (await res.json()) as {
      data?: unknown[];
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(json.error?.message ?? "Failed to fetch neighbours");
    }

    const normalized = (json.data ?? []).map(normalizeEntry);
    const seen = new Set<string>();
    return normalized.filter((entry) => {
      if (seen.has(entry.documentId)) return false;
      seen.add(entry.documentId);
      return true;
    });
  };

  const [before, after] = await Promise.all([
    fetchDirection("before"),
    fetchDirection("after"),
  ]);

  // `before` came back descending (closest artNr first); reverse it so the list
  // ascends toward the current entry.
  before.reverse();

  return { before, after };
}

export async function createEntry(payload: EntryPayload): Promise<Entry> {
  const strapiPayload = toStrapiPayload(payload);
  const requestBody = { data: strapiPayload };

  const res = await fetch(`${STRAPI_URL}/api/entries`, {
    method: "POST",
    headers: getHeaders(true),
    body: JSON.stringify(requestBody),
  });

  const data = await parseResponse<unknown>(res);
  const normalized = normalizeEntry(data);
  cacheEntry(normalized);
  invalidateEntriesListCache();
  return normalized;
}

export async function updateEntry(id: string, payload: EntryPayload): Promise<Entry> {
  const documentId = await resolveDocumentId(id);

  if (!documentId) {
    throw new Error("Entry not found.");
  }

  const strapiPayload = toStrapiPayload(payload);
  const requestBody = { data: strapiPayload };

  // Populate media on the response so callers get the full entry back (with
  // pictures/miscFiles) instead of an unpopulated shell that looks like the
  // images were removed.
  const res = await fetch(`${STRAPI_URL}/api/entries/${documentId}${POPULATE_QUERY}`, {
    method: "PUT",
    headers: getHeaders(true),
    body: JSON.stringify(requestBody),
  });

  const data = await parseResponse<unknown>(res);
  const normalized = normalizeEntry(data);
  cacheEntry(normalized);
  invalidateEntriesListCache();
  return normalized;
}

/**
 * Server-side content dedup: return the id of an existing media file whose
 * bytes are identical to `file`, or null. Prefilters by original name + size
 * (cheap) then verifies with a sha256 of the actual content, so we never reuse
 * a coincidental name/size match. Identical assets used to be re-uploaded once
 * per entry, bloating the library ~3x — this collapses them to one record.
 */
async function findExistingMedia(file: File): Promise<number | null> {
  try {
    const sizeKb = Math.round((file.size / 1000) * 100) / 100;
    const url =
      `${STRAPI_URL}/api/upload/files` +
      `?filters[name][$eq]=${encodeURIComponent(file.name)}` +
      `&sort=id:asc&pagination[pageSize]=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.STRAPI_TOKEN}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ id: number; name: string; size: number; url: string }>;
    const candidates = (Array.isArray(list) ? list : []).filter(
      (f) => f.name === file.name && Math.abs((f.size ?? 0) - sizeKb) < 0.02,
    );
    if (candidates.length === 0) return null;

    const { createHash } = await import("node:crypto");
    const wantHash = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
    for (const f of candidates) {
      try {
        const fres = await fetch(`${STRAPI_URL}${f.url}`, {
          headers: { Authorization: `Bearer ${process.env.STRAPI_TOKEN}` },
          cache: "no-store",
        });
        if (!fres.ok) continue;
        const gotHash = createHash("sha256").update(Buffer.from(await fres.arrayBuffer())).digest("hex");
        if (gotHash === wantHash) return f.id;
      } catch {
        /* ignore and try the next candidate */
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function uploadMedia(files: File[]): Promise<number[]> {
  const formData = new FormData();
  files.forEach((file) => {
    formData.append("files", file);
  });

  // ── Client-side: route through the editor-gated /api/media route so the
  // token stays on the server and only authorised users can upload.
  if (typeof window !== "undefined") {
    const res = await fetch("/api/media", { method: "POST", body: formData });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? "Failed to upload media.");
    }
    const data = (await res.json()) as { ids: number[] };
    return Array.isArray(data.ids) ? data.ids : [];
  }

  // ── Server-side: upload straight to Strapi with the server-only token.
  // Reuse existing records for byte-identical content instead of creating
  // duplicates; only genuinely new files are uploaded. Order is preserved.
  const results: number[] = new Array(files.length);
  const pending: { index: number; file: File }[] = [];

  await Promise.all(
    files.map(async (file, i) => {
      const existing = await findExistingMedia(file);
      if (existing != null) results[i] = existing;
      else pending.push({ index: i, file });
    }),
  );

  if (pending.length > 0) {
    const uploadForm = new FormData();
    pending.forEach(({ file }) => uploadForm.append("files", file));

    const res = await fetch(`${STRAPI_URL}/api/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRAPI_TOKEN}`,
      },
      body: uploadForm,
    });

    if (!res.ok) {
      const error = await res.json();
      console.error("Media upload error:", error);
      throw new Error("Failed to upload media.");
    }

    const data = (await res.json()) as Array<{ id: number }>;
    if (!Array.isArray(data) || data.length !== pending.length) {
      throw new Error("Unexpected upload response from Strapi.");
    }
    pending.forEach(({ index }, k) => {
      results[index] = data[k].id;
    });
  }

  return results;
}

export async function getMediaById(id: number): Promise<EntryMedia | null> {
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  // ── Client-side: route through the Next.js API (token stays on the server).
  if (typeof window !== "undefined") {
    const res = await fetch(`/api/media/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as EntryMedia | null;
  }

  const cached = mediaCacheById.get(id);
  if (isCacheFresh(cached)) {
    return cached.value;
  }

  const inFlight = mediaInFlightById.get(id);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    const res = await fetch(`${STRAPI_URL}/api/upload/files/${id}`, {
      headers: getHeaders(),
      cache: "no-store",
    });

    if (!res.ok) {
      mediaCacheById.set(id, {
        value: null,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return null;
    }

    const raw = (await res.json()) as Partial<StrapiMedia>;
    const url = raw.url ? toAbsoluteUrl(raw.url) : "";

    if (!url) {
      mediaCacheById.set(id, {
        value: null,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return null;
    }

    const media: EntryMedia = {
      id: Number(raw.id ?? id),
      name: raw.name,
      url,
    };

    mediaCacheById.set(id, {
      value: media,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return media;
  })();

  mediaInFlightById.set(id, request);
  try {
    return await request;
  } finally {
    mediaInFlightById.delete(id);
  }
}

export async function attachMediaToEntry(entryId: string, mediaIds: number[]): Promise<Entry> {
  const documentId = await resolveDocumentId(entryId);

  if (!documentId) {
    throw new Error("Entry not found.");
  }

  const res = await fetch(`${STRAPI_URL}/api/entries/${documentId}`, {
    method: "PUT",
    headers: getHeaders(true),
    body: JSON.stringify({
      data: {
        pictures: mediaIds,
      },
    }),
  });

  const data = await parseResponse<unknown>(res);
  const normalized = normalizeEntry(data);
  cacheEntry(normalized);
  invalidateEntriesListCache();
  return normalized;
}
