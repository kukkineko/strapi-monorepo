import { type NextRequest, NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";

const STRAPI_BASE = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";

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

/** Return up to 5 entries whose artNr exactly equals `value`. */
async function findByArtNr(artNr: string): Promise<StrapiEntry[]> {
  const enc = encodeURIComponent;
  const url =
    `${STRAPI_BASE}/api/entries` +
    `?filters[artNr][$eq]=${enc(artNr)}` +
    `&fields[0]=documentId&fields[1]=title&fields[2]=artNr&fields[3]=docs` +
    `&pagination[pageSize]=5`;

  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) return [];

  const body = (await res.json()) as { data?: unknown[] };
  const raw  = Array.isArray(body.data) ? body.data : [];

  return raw.map((item) => {
    const obj = item as Record<string, unknown>;
    const src = (obj.attributes as Record<string, unknown> | undefined) ?? obj;
    return {
      documentId: String(src.documentId ?? obj.documentId ?? ""),
      title:      String(src.title      ?? obj.title      ?? ""),
      artNr:      (src.artNr ?? obj.artNr) as string | undefined,
      docs:       (src.docs  ?? obj.docs)  as string | undefined,
    };
  }).filter((e) => e.documentId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  GET /api/auth/admin/assign-docs?artNrs[0]=03135&artNrs[1]=03136…        */
/*                                                                            */
/*  Returns Strapi entry matches for each supplied article number.            */
/*  Used by the client to resolve filenames → entries without exposing the    */
/*  Strapi API token to the browser.                                          */
/* ══════════════════════════════════════════════════════════════════════════ */

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard !== true) return guard;

  const { searchParams } = new URL(req.url);

  // Collect artNrs from repeated artNrs[] params or comma-separated artNrs.
  const artNrs: string[] = [];
  searchParams.forEach((value, key) => {
    if (key === "artNrs" || key.startsWith("artNrs[")) {
      value.split(",").forEach((v) => {
        const trimmed = v.trim();
        if (trimmed) artNrs.push(trimmed);
      });
    }
  });

  if (artNrs.length === 0)
    return NextResponse.json({ error: "Provide at least one artNr." }, { status: 400 });

  // Batch Strapi queries (cap concurrency to avoid hammering the server).
  const CONCURRENCY = 10;
  const result: Record<string, StrapiEntry[]> = {};

  for (let i = 0; i < artNrs.length; i += CONCURRENCY) {
    const chunk = artNrs.slice(i, i + CONCURRENCY);
    const entries = await Promise.all(chunk.map((nr) => findByArtNr(nr)));
    chunk.forEach((nr, j) => { result[nr] = entries[j]!; });
  }

  return NextResponse.json({ matches: result });
}
