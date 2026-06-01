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
  rubrik?: string | Record<string, unknown>;
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
  rubrik?: string | Record<string, unknown>;
};

export type LinkEntry = {
  id: string;
  confidence?: number;
  source?: string;
  link?: string;
  desc?: string;
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
            };
            return {
              id: e.id.trim(),
              ...(typeof e.confidence === "number" && { confidence: e.confidence }),
              ...(typeof e.source === "string" && e.source && { source: e.source }),
              ...(typeof e.link === "string" && e.link && { link: e.link }),
              ...(typeof e.desc === "string" && e.desc && { desc: e.desc }),
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
      }))
      .filter((e) => e.id)
  );
}

const STRAPI_URL = process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337";
const POPULATE_QUERY = "?populate[0]=pictures&populate[1]=miscFile";
// Lighter field projection for the listing page: drops docs/links/issues/
// tickets/miscFile so the RSC payload sent to 50 browsers is far smaller.
const LIST_FIELDS_QUERY =
  "?fields[0]=id&fields[1]=documentId&fields[2]=title" +
  "&fields[3]=artNr&fields[4]=EAN&fields[5]=rubrik" +
  "&fields[6]=tags&fields[7]=desc&fields[8]=IGS" +
  "&fields[9]=updatedAt&populate[0]=pictures";
const LIST_PAGE_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheRecord<T> = {
  value: T;
  expiresAt: number;
};

let listEntriesCache: CacheRecord<Entry[]> | null = null;
let listEntriesInFlight: Promise<Entry[]> | null = null;
let listEntriesForListCache: CacheRecord<Entry[]> | null = null;
let listEntriesForListInFlight: Promise<Entry[]> | null = null;
let listEntriesLightCache: CacheRecord<Entry[]> | null = null;
let listEntriesLightInFlight: Promise<Entry[]> | null = null;

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
  return Boolean(record);
}

function cacheEntry(entry: Entry) {
  const record: CacheRecord<Entry> = {
    value: entry,
    expiresAt: 0,
  };

  entryCacheByDocumentId.set(entry.documentId, record);
  numericIdToDocumentIdCache.set(String(entry.id), {
    value: entry.documentId,
    expiresAt: 0,
  });
}

function invalidateEntriesListCache() {
  listEntriesCache = null;
  listEntriesForListCache = null;
}

function toAbsoluteUrl(url: string): string {
  if (!url) {
    return "";
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `${STRAPI_URL.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
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

function getHeaders(includeJson = false): HeadersInit {
  const headers: HeadersInit = {};
  const token = process.env.NEXT_PUBLIC_STRAPI_TOKEN;

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
    rubrik: source.rubrik as string | Record<string, unknown> | undefined,
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
    rubrik: payload.rubrik,
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
      expiresAt: 0,
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
 * Lightweight variant of listEntries() for the home page.
 * Fetches minimal fields (no pictures/miscFiles) for fast category counts.
 */
export async function listEntriesLight(): Promise<Entry[]> {
  if (isCacheFresh(listEntriesLightCache)) {
    return listEntriesLightCache.value;
  }

  if (listEntriesLightInFlight) {
    return listEntriesLightInFlight;
  }

  listEntriesLightInFlight = (async () => {
    const allEntries: unknown[] = [];

    const SORT_PARAM = "sort=id:asc";
    const LIGHT_FIELDS = "fields[0]=id&fields[1]=documentId&fields[2]=title&fields[3]=rubrik&fields[4]=artNr&fields[5]=EAN";

    const firstResponse = await fetch(
      `${STRAPI_URL}/api/entries?${LIGHT_FIELDS}&${SORT_PARAM}&pagination[pageSize]=500&pagination[page]=1&pagination[withCount]=true`,
      { headers: getHeaders(), next: { revalidate: 3600 } }
    );

    type LightResponse = {
      data?: unknown[];
      meta?: { pagination?: { pageCount?: number; pageSize?: number; total?: number } };
      error?: { message?: string };
    };

    const firstJson = (await firstResponse.json()) as LightResponse;
    if (!firstResponse.ok) {
      throw new Error(firstJson.error?.message ?? "Failed to fetch entries");
    }

    allEntries.push(...(firstJson.data ?? []));
    const pageCount = firstJson.meta?.pagination?.total
      ? Math.ceil((firstJson.meta.pagination.total) / 500)
      : (firstJson.meta?.pagination?.pageCount ?? 1);

    if (pageCount > 1) {
      const remainingPages = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
      const chunkSize = 10;

      for (let i = 0; i < remainingPages.length; i += chunkSize) {
        const chunk = remainingPages.slice(i, i + chunkSize);
        const chunkData = await Promise.all(
          chunk.map(async (page) => {
            const res = await fetch(
              `${STRAPI_URL}/api/entries?${LIGHT_FIELDS}&${SORT_PARAM}&pagination[pageSize]=500&pagination[page]=${page}`,
              { headers: getHeaders(), next: { revalidate: 3600 } }
            );
            const json = (await res.json()) as LightResponse;
            return json.data ?? [];
          })
        );
        for (const pageData of chunkData) {
          allEntries.push(...pageData);
        }
      }
    }

    const normalized = allEntries.map(normalizeEntry);

    const seenDocumentIds = new Set<string>();
    const deduplicated = normalized.filter((entry) => {
      if (seenDocumentIds.has(entry.documentId)) return false;
      seenDocumentIds.add(entry.documentId);
      return true;
    });

    listEntriesLightCache = {
      value: deduplicated,
      expiresAt: 0,
    };

    return deduplicated;
  })();

  try {
    return await listEntriesLightInFlight;
  } finally {
    listEntriesLightInFlight = null;
  }
}

/**
 * Optimised list for the /products/all listing page.
 * Fetches the same entries as listEntries() but drops heavy text fields
 * (docs, links, issues, tickets) and the miscFile relation.
 * This reduces the RSC payload sent to each browser by ~40–70 % depending
 * on how much content entries have, while keeping everything the client
 * needs for display, filtering, and search.
 */
export async function listEntriesForList(): Promise<Entry[]> {
  if (isCacheFresh(listEntriesForListCache)) {
    return listEntriesForListCache.value;
  }

  if (listEntriesForListInFlight) {
    return listEntriesForListInFlight;
  }

  type ListResponse<T> = {
    data?: T;
    meta?: { pagination?: { pageCount?: number; pageSize?: number; total?: number } };
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
      throw new Error(message);
    }
    if (json.data === undefined) throw new Error("Unexpected Strapi response shape.");
    return {
      data: json.data,
      pageCount: json.meta?.pagination?.pageCount,
      pageSize: json.meta?.pagination?.pageSize,
      total: json.meta?.pagination?.total,
    };
  }

  const SORT_PARAM = "&sort=id:asc";

  listEntriesForListInFlight = (async () => {
    const allEntries: unknown[] = [];

    const firstResponse = await fetch(
      `${STRAPI_URL}/api/entries${LIST_FIELDS_QUERY}${SORT_PARAM}&pagination[pageSize]=${LIST_PAGE_SIZE}&pagination[page]=1&pagination[withCount]=true`,
      { headers: getHeaders(), next: { revalidate: 3600 } },
    );

    const firstPage = await parseListResponse<unknown[]>(firstResponse);
    allEntries.push(...firstPage.data);

    const effectivePageSize = firstPage.pageSize ?? LIST_PAGE_SIZE;
    const pageCount =
      firstPage.total != null
        ? Math.ceil(firstPage.total / effectivePageSize)
        : (firstPage.pageCount ?? 1);

    if (pageCount > 1) {
      const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
      const chunkSize = 6;
      for (let i = 0; i < remaining.length; i += chunkSize) {
        const chunk = remaining.slice(i, i + chunkSize);
        const chunkData = await Promise.all(
          chunk.map(async (page) => {
            const res = await fetch(
              `${STRAPI_URL}/api/entries${LIST_FIELDS_QUERY}${SORT_PARAM}&pagination[pageSize]=${effectivePageSize}&pagination[page]=${page}&pagination[withCount]=true`,
              { headers: getHeaders(), next: { revalidate: 3600 } },
            );
            return (await parseListResponse<unknown[]>(res)).data;
          }),
        );
        for (const pageData of chunkData) allEntries.push(...pageData);
      }
    }

    const normalized = allEntries.map(normalizeEntry);
    const seenDocumentIds = new Set<string>();
    const deduplicated = normalized.filter((entry) => {
      if (seenDocumentIds.has(entry.documentId)) return false;
      seenDocumentIds.add(entry.documentId);
      return true;
    });

    listEntriesForListCache = { value: deduplicated, expiresAt: 0 };

    for (const entry of deduplicated) {
      cacheEntry(entry);
    }

    return deduplicated;
  })();

  try {
    return await listEntriesForListInFlight;
  } finally {
    listEntriesForListInFlight = null;
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

  const encoded = encodeURIComponent(trimmed);
  const request = (async () => {
    const res = await fetch(
      `${STRAPI_URL}/api/entries${POPULATE_QUERY}` +
        `&pagination[pageSize]=${safeLimit}` +
        `&filters[$or][0][title][$containsi]=${encoded}` +
        `&filters[$or][1][artNr][$containsi]=${encoded}` +
        `&filters[$or][2][EAN][$containsi]=${encoded}` +
        `&filters[$or][3][documentId][$containsi]=${encoded}`,
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
      expiresAt: 0,
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

  const res = await fetch(`${STRAPI_URL}/api/entries/${documentId}`, {
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

export async function uploadMedia(files: File[]): Promise<number[]> {
  const formData = new FormData();
  files.forEach((file) => {
    formData.append("files", file);
  });

  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_STRAPI_TOKEN}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json();
    console.error("Media upload error:", error);
    throw new Error("Failed to upload media.");
  }

  const data = (await res.json()) as Array<{ id: number }>;
  return data.map((item) => item.id);
}

export async function getMediaById(id: number): Promise<EntryMedia | null> {
  if (!Number.isFinite(id) || id <= 0) {
    return null;
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
        expiresAt: 0,
      });
      return null;
    }

    const raw = (await res.json()) as Partial<StrapiMedia>;
    const url = raw.url ? toAbsoluteUrl(raw.url) : "";

    if (!url) {
      mediaCacheById.set(id, {
        value: null,
        expiresAt: 0,
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
      expiresAt: 0,
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
