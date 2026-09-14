import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import { readViewStore } from "@/app/lib/page-views";

/**
 * GET /api/entries/views/stats
 *
 * Admin-only. Reads the page-view counter store and returns, for each viewed
 * entry, its rolling-window counts (day / week / month / year / all-time)
 * joined with the entry title / article number. The "Page Views" tab does the
 * range selection and sorting client-side from this single payload.
 */

type StrapiListResponse<T> = {
  data?: T[];
  meta?: { pagination?: { pageSize?: number; total?: number } };
};

const STRAPI_BASE_URL = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_API_TOKEN = process.env.STRAPI_TOKEN ?? "";
const PAGE_SIZE = 100;

const DAY = 24 * 60 * 60 * 1000;
const WINDOWS = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

type ViewCounts = { day: number; week: number; month: number; year: number; all: number };

type ViewItem = {
  documentId: string;
  title: string;
  artNr: string | null;
  last: string | null;
  counts: ViewCounts;
};

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Fetch a documentId → { title, artNr } map for the whole entries collection,
 * projecting only the two display fields so the payload stays small. Mirrors
 * the paginated fetch used by the DB-stats route.
 */
async function fetchEntryLabels(): Promise<Map<string, { title: string; artNr: string | null }>> {
  const labels = new Map<string, { title: string; artNr: string | null }>();
  const base =
    "/api/entries?fields[0]=documentId&fields[1]=title&fields[2]=artNr&sort=id:asc";

  const fetchPage = async (page: number) => {
    const url = `${STRAPI_BASE_URL}${base}&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}&pagination[withCount]=true`;
    const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch entries (status ${res.status}).`);
    return (await res.json()) as StrapiListResponse<Record<string, unknown>>;
  };

  const first = await fetchPage(1);
  const collect = (payload: StrapiListResponse<Record<string, unknown>>) => {
    for (const raw of payload.data ?? []) {
      const rec = (raw.attributes && typeof raw.attributes === "object"
        ? { ...raw, ...(raw.attributes as Record<string, unknown>) }
        : raw) as Record<string, unknown>;
      const documentId = typeof rec.documentId === "string" ? rec.documentId : "";
      if (!documentId) continue;
      labels.set(documentId, {
        title: typeof rec.title === "string" && rec.title.trim() ? rec.title : documentId,
        artNr: typeof rec.artNr === "string" && rec.artNr.trim() ? rec.artNr : null,
      });
    }
  };

  collect(first);

  const pageSize = first.meta?.pagination?.pageSize ?? PAGE_SIZE;
  const total = first.meta?.pagination?.total ?? (first.data?.length ?? 0);
  const pageCount = Math.ceil(total / pageSize);

  if (pageCount > 1) {
    const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
    const chunkSize = 6;
    for (let i = 0; i < remaining.length; i += chunkSize) {
      const chunk = remaining.slice(i, i + chunkSize);
      const results = await Promise.all(chunk.map((p) => fetchPage(p)));
      results.forEach(collect);
    }
  }

  return labels;
}

export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (!STRAPI_API_TOKEN) {
    return NextResponse.json({ error: "Missing STRAPI API token." }, { status: 500 });
  }

  try {
    const store = await readViewStore();
    const docIds = Object.keys(store.totals);

    // Only pay for the title join when there's something to show.
    const labels = docIds.length > 0 ? await fetchEntryLabels() : new Map();

    // Roll the event log up into per-item windowed counts in one pass.
    const now = Date.now();
    const windowed = new Map<string, { day: number; week: number; month: number; year: number }>();
    for (const ev of store.events) {
      const age = now - ev.t;
      if (age > WINDOWS.year) continue;
      const w = windowed.get(ev.d) ?? { day: 0, week: 0, month: 0, year: 0 };
      if (age < WINDOWS.day) w.day++;
      if (age < WINDOWS.week) w.week++;
      if (age < WINDOWS.month) w.month++;
      w.year++;
      windowed.set(ev.d, w);
    }

    const items: ViewItem[] = docIds
      .map((documentId) => {
        const label = labels.get(documentId);
        const w = windowed.get(documentId) ?? { day: 0, week: 0, month: 0, year: 0 };
        return {
          documentId,
          title: label?.title ?? documentId,
          artNr: label?.artNr ?? null,
          last: store.last[documentId] ?? null,
          counts: { ...w, all: store.totals[documentId] ?? 0 },
        };
      })
      .sort((a, b) => b.counts.all - a.counts.all || a.title.localeCompare(b.title));

    return NextResponse.json({ items, generatedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load view stats.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
