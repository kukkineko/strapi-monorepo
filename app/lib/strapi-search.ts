/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Strapi search helpers — shared between the import pipeline and the matcher
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Both `/api/auth/admin/import-data` (which now pre-resolves candidates
 * before asking the AI for a final verdict) and
 * `/api/auth/admin/import-data/match` (the per-row matcher) need to query
 * Strapi for entries by article number, EAN or title. The logic used to
 * live inline in the matcher; extracting it lets the import route reuse it
 * without duplicating the filter builders and confidence-priority pyramid.
 *
 * Nothing in this file talks to the AI — it is purely Strapi I/O.
 */
const STRAPI_BASE_URL = (
  process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337"
).replace(/\/$/, "");
const STRAPI_API_TOKEN =
  process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";

/**
 * How sure are we that this Strapi entry corresponds to the source ID?
 * Ordered roughly from most to least trustworthy.
 */
export type MatchConfidence =
  | "exact-artNr"
  | "exact-EAN"
  | "starts-artNr"
  | "starts-EAN"
  | "contains-artNr"
  | "contains-EAN"
  | "exact-name"
  | "contains-name";

export type MatchEntry = {
  documentId: string;
  title: string;
  artNr?: string;
  EAN?: string;
  desc?: string;
  pictureUrl?: string;
};

/* ── normalisers ────────────────────────────────────────────────────────── */

function pictureUrlFrom(source: Record<string, unknown>): string | undefined {
  const relation = source.pictures as
    | { data?: unknown }
    | Array<Record<string, unknown>>
    | undefined;
  const items: Array<Record<string, unknown>> = Array.isArray(
    (relation as { data?: unknown })?.data,
  )
    ? ((relation as { data: Array<Record<string, unknown>> }).data ?? [])
    : Array.isArray(relation)
      ? (relation as Array<Record<string, unknown>>)
      : [];
  if (items.length === 0) return undefined;

  const first = (items[0]?.attributes ?? items[0]) as Record<string, unknown>;
  const formats = first.formats as
    | Record<string, { url?: string }>
    | undefined;
  const url =
    formats?.thumbnail?.url ??
    formats?.small?.url ??
    formats?.medium?.url ??
    (first.url as string | undefined);

  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return `${STRAPI_BASE_URL}/${url.replace(/^\//, "")}`;
}

export function normalizeStrapiEntry(item: Record<string, unknown>): MatchEntry {
  const source = (item.attributes ?? item) as Record<string, unknown>;
  return {
    documentId:
      (source.documentId as string | undefined) ??
      (item.documentId as string | undefined) ??
      String(source.id ?? item.id ?? ""),
    title: (source.title as string | undefined) ?? "Untitled",
    artNr: (source.artNr as string | undefined) ?? undefined,
    EAN: (source.EAN as string | undefined) ?? undefined,
    desc: (source.desc as string | undefined) ?? undefined,
    pictureUrl: pictureUrlFrom(source),
  };
}

/* ── low-level search ───────────────────────────────────────────────────── */

export async function strapiSearch(
  filterQuery: string,
  limit = 5,
): Promise<MatchEntry[]> {
  const url =
    `${STRAPI_BASE_URL}/api/entries` +
    `?fields[0]=documentId&fields[1]=title&fields[2]=artNr` +
    `&fields[3]=EAN&fields[4]=desc` +
    `&populate[pictures][fields][0]=url` +
    `&populate[pictures][fields][1]=formats` +
    `&pagination[pageSize]=${limit}` +
    `&${filterQuery}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) return [];

  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return (json.data ?? []).map(normalizeStrapiEntry);
}

/** Fetch a single entry directly by documentId. Used to honour AI verdicts
 *  that pin a specific Strapi documentId for a source ID. */
export async function strapiFetchByDocumentId(
  documentId: string,
): Promise<MatchEntry | null> {
  if (!documentId) return null;
  const url =
    `${STRAPI_BASE_URL}/api/entries/${encodeURIComponent(documentId)}` +
    `?fields[0]=documentId&fields[1]=title&fields[2]=artNr` +
    `&fields[3]=EAN&fields[4]=desc` +
    `&populate[pictures][fields][0]=url` +
    `&populate[pictures][fields][1]=formats`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;

  const json = (await res.json()) as { data?: Record<string, unknown> };
  if (!json.data) return null;
  return normalizeStrapiEntry(json.data);
}

/* ── filter builders ────────────────────────────────────────────────────── */

const enc = (v: string) => encodeURIComponent(v.trim());

export const eqIdFilter = (value: string) =>
  `filters[$or][0][artNr][$eq]=${enc(value)}` +
  `&filters[$or][1][EAN][$eq]=${enc(value)}`;

export const startsIdFilter = (value: string) =>
  `filters[$or][0][artNr][$startsWith]=${enc(value)}` +
  `&filters[$or][1][EAN][$startsWith]=${enc(value)}`;

export const containsIdFilter = (value: string) =>
  `filters[$or][0][artNr][$containsi]=${enc(value)}` +
  `&filters[$or][1][EAN][$containsi]=${enc(value)}`;

export const eqTitleFilter = (value: string) =>
  `filters[title][$eqi]=${enc(value)}`;

export const containsTitleFilter = (value: string) =>
  `filters[title][$containsi]=${enc(value)}`;

/* ── dedupe ─────────────────────────────────────────────────────────────── */

export function dedupeByDocId(list: MatchEntry[]): MatchEntry[] {
  const seen = new Set<string>();
  const out: MatchEntry[] = [];
  for (const e of list) {
    if (!e.documentId || seen.has(e.documentId)) continue;
    seen.add(e.documentId);
    out.push(e);
  }
  return out;
}

/* ── single-best-match (existing matcher behaviour) ─────────────────────── */

const NAME_CANDIDATE_LIMIT = 10;

export type BestMatchResult = {
  entry: MatchEntry | null;
  confidence: MatchConfidence | null;
  field: string;
  value: string;
  /** Additional likely matches; primary is included as candidates[0]. */
  candidates: MatchEntry[];
};

/**
 * Find the best Strapi entry for a list of source identifiers.
 * Priority: exact artNr → exact EAN → starts-with → contains → (main parts
 * only) title.
 */
export async function findBestMatch(
  ids: string[],
  fallbackName: string | null,
): Promise<BestMatchResult> {
  const cleaned = ids
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0);

  const lower = (s: string | undefined) => (s ?? "").toLowerCase();

  /* Pass 1 — exact artNr / EAN */
  for (const id of cleaned) {
    const results = await strapiSearch(eqIdFilter(id), 5);
    if (results.length === 0) continue;

    const ln = id.toLowerCase();
    const artNrHit = results.find((r) => lower(r.artNr) === ln);
    if (artNrHit) {
      return {
        entry: artNrHit,
        confidence: "exact-artNr",
        field: "artNr",
        value: id,
        candidates: [artNrHit],
      };
    }
    const eanHit = results.find((r) => lower(r.EAN) === ln);
    if (eanHit) {
      return {
        entry: eanHit,
        confidence: "exact-EAN",
        field: "EAN",
        value: id,
        candidates: [eanHit],
      };
    }
  }

  /* Pass 2 — starts-with artNr / EAN */
  for (const id of cleaned) {
    if (id.length < 3) continue;
    const results = await strapiSearch(startsIdFilter(id), 5);
    if (results.length === 0) continue;

    const ln = id.toLowerCase();
    const artNrHit = results.find((r) => lower(r.artNr).startsWith(ln));
    if (artNrHit) {
      return {
        entry: artNrHit,
        confidence: "starts-artNr",
        field: "artNr",
        value: id,
        candidates: [artNrHit],
      };
    }
    const eanHit = results.find((r) => lower(r.EAN).startsWith(ln));
    if (eanHit) {
      return {
        entry: eanHit,
        confidence: "starts-EAN",
        field: "EAN",
        value: id,
        candidates: [eanHit],
      };
    }
  }

  /* Pass 3 — contains artNr / EAN */
  for (const id of cleaned) {
    if (id.length < 4) continue;
    const results = await strapiSearch(containsIdFilter(id), 5);
    if (results.length === 0) continue;

    const ln = id.toLowerCase();
    const artNrHit = results.find((r) => lower(r.artNr).includes(ln));
    if (artNrHit) {
      return {
        entry: artNrHit,
        confidence: "contains-artNr",
        field: "artNr",
        value: id,
        candidates: [artNrHit],
      };
    }
    const eanHit = results.find((r) => lower(r.EAN).includes(ln));
    if (eanHit) {
      return {
        entry: eanHit,
        confidence: "contains-EAN",
        field: "EAN",
        value: id,
        candidates: [eanHit],
      };
    }
  }

  /* Pass 4 — name fallback (main parts only) */
  if (fallbackName && fallbackName.trim().length >= 3) {
    const name = fallbackName.trim();
    const exact = await strapiSearch(eqTitleFilter(name), NAME_CANDIDATE_LIMIT);
    const partial = await strapiSearch(
      containsTitleFilter(name),
      NAME_CANDIDATE_LIMIT,
    );

    if (exact.length > 0) {
      const candidates = dedupeByDocId([...exact, ...partial]).slice(
        0,
        NAME_CANDIDATE_LIMIT,
      );
      return {
        entry: exact[0]!,
        confidence: "exact-name",
        field: "title",
        value: name,
        candidates,
      };
    }

    if (partial.length > 0) {
      const candidates = dedupeByDocId(partial).slice(0, NAME_CANDIDATE_LIMIT);
      return {
        entry: partial[0]!,
        confidence: "contains-name",
        field: "title",
        value: name,
        candidates,
      };
    }
  }

  return {
    entry: null,
    confidence: null,
    field: "",
    value: cleaned.join(", "),
    candidates: [],
  };
}

/* ── candidate gathering (broader pool for the AI verdict stage) ────────── */

export type CandidateMatch = MatchEntry & {
  /** Why this candidate was surfaced — debug aid for the AI prompt. */
  matchedVia: MatchConfidence;
  /** The source ID/name that produced this hit. */
  sourceValue: string;
};

const CANDIDATE_LIMIT_PER_PASS = 6;
const MAX_CANDIDATES_PER_GROUP = 12;

/**
 * Gather a *broad* candidate pool for a single source row — used to feed
 * the AI verdict stage. Unlike {@link findBestMatch}, this does not stop
 * at the first hit: it runs every relevant pass and accumulates results
 * (deduplicated by documentId, capped at {@link MAX_CANDIDATES_PER_GROUP}).
 *
 * `allowNameFallback` should be `true` for main parts (which carry a
 * human-readable name) and `false` for replacements (where only the ID
 * stream is trustworthy).
 */
export async function gatherCandidates(
  ids: string[],
  name: string | null,
  allowNameFallback: boolean,
): Promise<CandidateMatch[]> {
  const cleaned = ids
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0);

  const lower = (s: string | undefined) => (s ?? "").toLowerCase();
  const out: CandidateMatch[] = [];
  const seen = new Set<string>();

  const push = (
    entry: MatchEntry,
    via: MatchConfidence,
    sourceValue: string,
  ) => {
    if (!entry.documentId || seen.has(entry.documentId)) return;
    if (out.length >= MAX_CANDIDATES_PER_GROUP) return;
    seen.add(entry.documentId);
    out.push({ ...entry, matchedVia: via, sourceValue });
  };

  /* Pass 1 — exact artNr / EAN (highest signal; run for every ID) */
  for (const id of cleaned) {
    const results = await strapiSearch(eqIdFilter(id), CANDIDATE_LIMIT_PER_PASS);
    const ln = id.toLowerCase();
    for (const r of results) {
      if (lower(r.artNr) === ln) push(r, "exact-artNr", id);
      else if (lower(r.EAN) === ln) push(r, "exact-EAN", id);
    }
  }

  /* Pass 2 — starts-with */
  for (const id of cleaned) {
    if (id.length < 3) continue;
    if (out.length >= MAX_CANDIDATES_PER_GROUP) break;
    const results = await strapiSearch(
      startsIdFilter(id),
      CANDIDATE_LIMIT_PER_PASS,
    );
    const ln = id.toLowerCase();
    for (const r of results) {
      if (lower(r.artNr).startsWith(ln)) push(r, "starts-artNr", id);
      else if (lower(r.EAN).startsWith(ln)) push(r, "starts-EAN", id);
    }
  }

  /* Pass 3 — contains (longer IDs only — noisy) */
  for (const id of cleaned) {
    if (id.length < 4) continue;
    if (out.length >= MAX_CANDIDATES_PER_GROUP) break;
    const results = await strapiSearch(
      containsIdFilter(id),
      CANDIDATE_LIMIT_PER_PASS,
    );
    const ln = id.toLowerCase();
    for (const r of results) {
      if (lower(r.artNr).includes(ln)) push(r, "contains-artNr", id);
      else if (lower(r.EAN).includes(ln)) push(r, "contains-EAN", id);
    }
  }

  /* Pass 4 — name fallback (main parts only) */
  if (
    allowNameFallback &&
    name &&
    name.trim().length >= 3 &&
    out.length < MAX_CANDIDATES_PER_GROUP
  ) {
    const trimmed = name.trim();
    const exact = await strapiSearch(
      eqTitleFilter(trimmed),
      CANDIDATE_LIMIT_PER_PASS,
    );
    for (const r of exact) push(r, "exact-name", trimmed);
    if (out.length < MAX_CANDIDATES_PER_GROUP) {
      const partial = await strapiSearch(
        containsTitleFilter(trimmed),
        CANDIDATE_LIMIT_PER_PASS,
      );
      for (const r of partial) push(r, "contains-name", trimmed);
    }
  }

  return out;
}
