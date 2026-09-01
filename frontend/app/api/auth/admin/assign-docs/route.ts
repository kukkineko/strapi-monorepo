import { type NextRequest, NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";

const STRAPI_BASE = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? "";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${STRAPI_TOKEN}` };
}

/* ── Auth guard ───────────────────────────────────────────────────────────── */

async function requireAdmin(): Promise<true | NextResponse> {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const ctx = await loadUserContext(jwt);
  if (!ctx?.user?.administrator)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  if (!STRAPI_TOKEN)
    return NextResponse.json({ error: "Missing Strapi API token." }, { status: 500 });
  return true;
}

/* ── Strapi entry lookup ──────────────────────────────────────────────────── */

type StrapiEntry = {
  documentId: string;
  title:      string;
  artNr?:     string;
  docs?:      string;
};

/** Map a raw Strapi row (v4 `attributes` or flat) to a StrapiEntry. */
function normalizeEntry(item: unknown): StrapiEntry {
  const obj = item as Record<string, unknown>;
  const src = (obj.attributes as Record<string, unknown> | undefined) ?? obj;
  return {
    documentId: String(src.documentId ?? obj.documentId ?? ""),
    title:      String(src.title      ?? obj.title      ?? ""),
    artNr:      (src.artNr ?? obj.artNr) as string | undefined,
    docs:       (src.docs  ?? obj.docs)  as string | undefined,
  };
}

/** Run a Strapi /api/entries query with the given filter query-string. */
async function queryEntries(filterQs: string): Promise<StrapiEntry[]> {
  const url =
    `${STRAPI_BASE}/api/entries?${filterQs}` +
    `&fields[0]=documentId&fields[1]=title&fields[2]=artNr&fields[3]=docs` +
    `&pagination[pageSize]=5`;

  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) return [];

  const body = (await res.json()) as { data?: unknown[] };
  const raw  = Array.isArray(body.data) ? body.data : [];
  return raw.map(normalizeEntry).filter((e) => e.documentId);
}

/** Return up to 5 entries whose artNr exactly equals `value`. */
function findByArtNr(artNr: string): Promise<StrapiEntry[]> {
  return queryEntries(`filters[artNr][$eq]=${encodeURIComponent(artNr)}`);
}

/** Return up to 5 entries whose title contains `name` (case-insensitive).
 *  Used as a fallback when a filename carries no article number — the admin
 *  can still find the product by (part of) the document's name. */
function findByName(name: string): Promise<StrapiEntry[]> {
  return queryEntries(`filters[title][$containsi]=${encodeURIComponent(name)}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  GET /api/auth/admin/assign-docs?artNrs[0]=03135&names[0]=Gartenschlauch    */
/*                                                                            */
/*  Returns Strapi entry matches for each supplied article number (exact      */
/*  artNr) under `matches`, and for each supplied name fragment (title        */
/*  contains, case-insensitive) under `nameMatches`. The name lookup lets     */
/*  filenames without an article number still resolve to products.           */
/*  Used by the client to resolve filenames → entries without exposing the    */
/*  Strapi API token to the browser.                                          */
/* ══════════════════════════════════════════════════════════════════════════ */

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard !== true) return guard;

  const { searchParams } = new URL(req.url);

  // Collect a repeated / comma-separated list param (e.g. artNrs[], names[]).
  const collect = (name: string): string[] => {
    const out: string[] = [];
    searchParams.forEach((value, key) => {
      if (key === name || key.startsWith(`${name}[`)) {
        value.split(",").forEach((v) => {
          const trimmed = v.trim();
          if (trimmed) out.push(trimmed);
        });
      }
    });
    return out;
  };

  const artNrs = collect("artNrs");
  // Filenames (or name fragments) to resolve by title when no artNr is present.
  const names  = collect("names");

  if (artNrs.length === 0 && names.length === 0)
    return NextResponse.json(
      { error: "Provide at least one artNr or name." },
      { status: 400 },
    );

  // Cap concurrency so a large folder doesn't hammer Strapi.
  const CONCURRENCY = 10;
  const resolve = async (
    keys: string[],
    lookup: (k: string) => Promise<StrapiEntry[]>,
  ): Promise<Record<string, StrapiEntry[]>> => {
    const out: Record<string, StrapiEntry[]> = {};
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      const chunk = keys.slice(i, i + CONCURRENCY);
      const entries = await Promise.all(chunk.map(lookup));
      chunk.forEach((k, j) => { out[k] = entries[j]!; });
    }
    return out;
  };

  const [matches, nameMatches] = await Promise.all([
    resolve(artNrs, findByArtNr),
    resolve(names, findByName),
  ]);

  return NextResponse.json({ matches, nameMatches });
}
