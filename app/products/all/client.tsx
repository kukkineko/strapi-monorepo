"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/app/components/top-bar";
import { useLanguage } from "@/app/components/language-provider";
import type { Entry } from "@/app/lib/entries";
import { parseRubrikNumber, displayValue } from "@/app/lib/entries";
import { HoverPreview, useHoverPreview } from "@/app/components/hover-preview";

const PAGE_SIZE = 250;

/* ─── types ──────────────────────────────────────────────────────────────── */

type SortKey = "artnr" | "ean" | "name" | "tags";
type SortDir = "asc" | "desc";

/* ─── section helpers ────────────────────────────────────────────────────── */

function normalizeSection(value: string | null) {
  return (value ?? "all").toLowerCase();
}

function rubrikSectionValue(n: number) {
  return `rubrik-r${String(n).padStart(2, "0")}`;
}

function inSection(entry: Entry, section: string): boolean {
  const key    = String(entry.rubrik ?? "").trim().toLowerCase();
  const parsed = parseRubrikNumber(entry.rubrik);

  if (section === "all") return true;
  if (section === "replacements") return key === "replacement" || key === "replacements";
  if (section === "extra") {
    if (key === "extra" || key === "extras") return true;
    return parsed === null || parsed < 1 || parsed > 15;
  }
  const match = section.match(/^rubrik-(?:r)?0*(\d{1,2})$/);
  if (!match) return true;
  return parsed !== null && parsed === Number.parseInt(match[1]!, 10);
}

/* ─── search helpers ─────────────────────────────────────────────────────── */

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

function collectStrings(value: unknown, out: string[]): void {
  if (value == null) return;
  if (typeof value === "string") { if (value.trim()) out.push(value.trim()); return; }
  if (typeof value === "number" || typeof value === "boolean") { out.push(String(value)); return; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return; }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.trim()) out.push(k.trim());
      collectStrings(v, out);
    }
  }
}

function igsText(raw?: string): string {
  const t = raw?.trim();
  if (!t) return "";
  const parts: string[] = [];
  try { collectStrings(JSON.parse(t) as unknown, parts); } catch { parts.push(t); }
  return parts.join(" ").toLowerCase();
}

function parseTags(raw?: string): string[] {
  const t = raw?.trim();
  if (!t) return [];
  try {
    const p = JSON.parse(t) as unknown;
    if (Array.isArray(p)) return p.map((x) => String(x).trim()).filter(Boolean);
    if (p && typeof p === "object") {
      const s = p as { tags?: unknown };
      if (Array.isArray(s.tags)) return s.tags.map((x) => String(x).trim()).filter(Boolean);
    }
  } catch { /**/ }
  return t.split(/[\n,;|]+/).map((x) => x.trim()).filter(Boolean);
}

function shortDesc(entry: Entry): string {
  const src = (entry.desc ?? "").trim();
  if (!src) return "";
  return src.length <= 120 ? src : `${src.slice(0, 117).trimEnd()}…`;
}

/* ─── relevance scoring ─────────────────────────────────────────────────── */

/**
 * Compute a relevance score (higher = better match) for an entry against a
 * search query.  The score is used to sort the most relevant results to the
 * top when a search term is active.
 *
 * Scoring tiers:
 *   100  exact title match
 *    90  title starts with query
 *    80  artNr or EAN exact match
 *    70  artNr or EAN starts with query
 *    60  full query found as substring in title
 *    50  full query found in artNr / EAN
 *    40  full query found in tags
 *    20  all tokens found individually in the title
 *    10  baseline (all tokens matched somewhere – already guaranteed by filter)
 */
function scoreRelevance(entry: Entry, query: string, tokens: string[]): number {
  if (!query) return 0;

  const q     = query.toLowerCase();
  const title = entry.title.toLowerCase();
  const artNr = (entry.artNr ?? "").toLowerCase();
  const ean   = (entry.EAN   ?? "").toLowerCase();
  const tags  = (entry.tags  ?? "").toLowerCase();

  // Exact match on title
  if (title === q) return 100;
  // Title starts with query
  if (title.startsWith(q)) return 90;
  // Exact match on artNr or EAN
  if (artNr === q || ean === q) return 80;
  // artNr or EAN starts with query
  if (artNr.startsWith(q) || ean.startsWith(q)) return 70;
  // Full query found as substring in title
  if (title.includes(q)) return 60;
  // Full query found in artNr / EAN
  if (artNr.includes(q) || ean.includes(q)) return 50;
  // Full query found in tags
  if (tags.includes(q)) return 40;
  // All tokens found individually in the title
  if (tokens.every((tok) => title.includes(tok))) return 20;
  // Baseline – tokens matched somewhere in the haystack
  return 10;
}

/* ─── sort helpers ───────────────────────────────────────────────────────── */

const SORT_OPTIONS: { value: `${SortKey}:${SortDir}`; label: string }[] = [
  { value: "artnr:asc",  label: "ArtNr ↑" },
  { value: "artnr:desc", label: "ArtNr ↓" },
  { value: "name:asc",   label: "Name A→Z" },
  { value: "name:desc",  label: "Name Z→A" },
  { value: "ean:asc",    label: "EAN ↑" },
  { value: "ean:desc",   label: "EAN ↓" },
  { value: "tags:asc",   label: "Tags A→Z" },
  { value: "tags:desc",  label: "Tags Z→A" },
];

function sortEntries(list: Entry[], key: SortKey, dir: SortDir): Entry[] {
  const factor = dir === "desc" ? -1 : 1;
  const cmp    = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }) * factor;

  return [...list].sort((a, b) => {
    if (key === "ean")  return cmp(a.EAN   ?? "", b.EAN   ?? "");
    if (key === "tags") return cmp(a.tags  ?? "", b.tags  ?? "");
    if (key === "name") return cmp(a.title,        b.title);
    return cmp(a.artNr ?? "", b.artNr ?? "");
  });
}

/* ─── main client component ──────────────────────────────────────────────── */

export function AllProductsClient({ initialEntries }: { initialEntries: Entry[] }) {
  const { t }      = useLanguage();
  const router     = useRouter();
  const pathname   = usePathname();
  const params     = useSearchParams();

  /* ── URL-derived state ── */
  const section   = normalizeSection(params.get("section"));
  const sortParam = params.get("sort") ?? "artnr";
  const sortKey   = (["artnr", "ean", "name", "tags"].includes(sortParam)
    ? sortParam : "artnr") as SortKey;
  const sortDir   = params.get("dir") === "desc" ? "desc" : ("asc" as SortDir);
  const urlQ      = params.get("q") ?? "";

  /* ── local search — drives filtering instantly without any URL round-trip ── */
  const [searchInput, setSearchInput] = useState(urlQ);
  const lastUrlQ = useRef(urlQ);

  /* ── pagination ── */
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  /* Sync from URL when user navigates (back/forward) */
  useEffect(() => {
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setSearchInput(urlQ);
    }
  }, [urlQ]);

  /* Write back to URL with debounce (for shareable/bookmarkable links only) */
  const searchInputRef = useRef(searchInput);
  searchInputRef.current = searchInput;

  const pushSearchToUrl = useCallback(() => {
    const next = new URLSearchParams(params.toString());
    next.set("section", section);
    next.set("sort",    sortKey);
    next.set("dir",     sortDir);
    const q = searchInputRef.current.trim();
    if (q) next.set("q", q); else next.delete("q");
    lastUrlQ.current = q;
    router.replace(`${pathname}?${next.toString()}`);
  }, [params, pathname, router, section, sortDir, sortKey]);

  useEffect(() => {
    if (searchInput === urlQ) return;
    const handle = window.setTimeout(pushSearchToUrl, 380);
    return () => window.clearTimeout(handle);
  }, [searchInput, urlQ, pushSearchToUrl]);

  /* ── hover preview ── */
  const { target: hoverTarget, showPreview, hidePreview } = useHoverPreview();

  /* ── scroll-position restore ── */
  const scrollKey         = `wiki-list-scroll:${pathname}?${params.toString()}`;
  const restoredScrollRef = useRef(false);

  useEffect(() => {
    if (restoredScrollRef.current) return;
    const stored = window.sessionStorage.getItem(scrollKey);
    if (!stored) return;
    restoredScrollRef.current = true;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Number(stored), behavior: "auto" });
      window.sessionStorage.removeItem(scrollKey);
    });
  }, [scrollKey]);

  /* ── entries come pre-loaded from the server — no fetch needed ── */
  const entries = initialEntries;

  /* ── pre-compute searchable text once per data-load, not per keystroke ──
     igsText() calls JSON.parse — doing it inside the filter loop on every
     keystroke is expensive with thousands of entries.  Instead we build a
     Map<documentId → blob> once here.

     Each blob contains:
       • raw text  — preserves the original spacing/punctuation so a query
                     like "7624020" still matches "(7624020)" via substring
       • clean text — all punctuation replaced with spaces, so a value like
                     "kw-7624020" or "[7624020]" is also found when searching
                     the bare number
  ── */
  const searchBlobs = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      const raw   = `${e.title} ${e.artNr ?? ""} ${e.EAN ?? ""} ${e.tags ?? ""} ${igsText(e.igs)}`;
      const clean = raw.replace(/[^a-z0-9 ]/gi, " ");
      map.set(e.documentId, `${raw} ${clean}`.toLowerCase());
    }
    return map;
  }, [entries]);

  /* ── reset page on filter/sort/search change ── */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [section, sortKey, sortDir, searchInput]);

  /* ── filter + sort ── */
  const displayedEntries = useMemo(() => {
    const q      = searchInput.trim().toLowerCase();
    const tokens = tokenize(q);

    const filtered = entries.filter((e) => {
      if (!inSection(e, section)) return false;
      if (!q) return true;
      const haystack = searchBlobs.get(e.documentId) ?? "";
      return tokens.every((tok) => haystack.includes(tok));
    });

    /* When a search query is active, sort by relevance first (best match at
       the top) and fall back to the user-chosen sort order for entries with
       the same relevance tier. Without a query, use pure column sort. */
    if (!q) return sortEntries(filtered, sortKey, sortDir);

    const scored = filtered.map((e) => ({
      entry: e,
      score: scoreRelevance(e, q, tokens),
    }));

    const columnSorted = sortEntries(
      scored.map((s) => s.entry),
      sortKey,
      sortDir,
    );

    const scoreMap = new Map(scored.map((s) => [s.entry.documentId, s.score]));

    return columnSorted.sort(
      (a, b) => (scoreMap.get(b.documentId) ?? 0) - (scoreMap.get(a.documentId) ?? 0),
    );
  }, [entries, section, sortKey, sortDir, searchInput, searchBlobs]);

  /* hide preview whenever the visible item set changes (filter / sort / search /
     load-more) — the hovered element may no longer be in the DOM so onMouseLeave
     will never fire for it */
  useEffect(() => {
    hidePreview();
  }, [displayedEntries, visibleCount, hidePreview]);

  /* ── section options ── */
  const sectionOptions = useMemo(() => [
    { value: "all",          label: t.listing.allSections },
    ...Array.from({ length: 15 }, (_, i) => ({
      value: rubrikSectionValue(i + 1),
      label: `R${String(i + 1).padStart(2, "0")}`,
    })),
    { value: "replacements", label: t.home.replacements },
    { value: "extra",        label: t.home.extra },
  ], [t]);

  /* ── URL helpers ── */
  function goSection(nextSection: string) {
    const next = new URLSearchParams(params.toString());
    next.set("section", nextSection);
    next.set("sort",    sortKey);
    next.set("dir",     sortDir);
    router.replace(`${pathname}?${next.toString()}`);
  }

  function goSort(value: string) {
    const [key, dir] = value.split(":") as [SortKey, SortDir];
    const next = new URLSearchParams(params.toString());
    next.set("section", section);
    next.set("sort",    key);
    next.set("dir",     dir);
    if (searchInput.trim()) next.set("q", searchInput.trim());
    else next.delete("q");
    router.replace(`${pathname}?${next.toString()}`);
  }

  function navigateTo(entry: Entry) {
    window.sessionStorage.setItem(scrollKey, String(window.scrollY));
    const from = encodeURIComponent(`${pathname}?${params.toString()}`);
    router.push(`/products/${entry.documentId}?from=${from}`);
  }

  /* ─────────────────────────────────────────────────────────────────────── */
  return (
    <main className="wiki-shell">
      <TopBar
        actions={[
          { href: "/",             label: t.nav.home },
          { href: "/products/new", label: t.nav.createNewPage, primary: true },
        ]}
      />

      <section className="wiki-card">
        {/* ── Page heading ── */}
        <div className="wiki-title-row" style={{ marginBottom: "1rem" }}>
          <h1 style={{ margin: 0, fontSize: "clamp(1.4rem,2.2vw,1.9rem)", letterSpacing: "-0.02em" }}>
            {t.listing.title}
          </h1>
          <p className="wiki-muted" style={{ margin: "0.35rem 0 0" }}>
            {t.listing.subtitle}
          </p>
        </div>

        {/* ── Toolbar ── */}
        <div className="wiki-list-toolbar">
          {/* Section filter */}
          <select
            className="wiki-list-select"
            value={section}
            onChange={(e) => goSection(e.target.value)}
            aria-label={t.listing.sectionLabel}
            title={t.listing.sectionLabel}
          >
            {sectionOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Search */}
          <div className="wiki-list-search-wrap">
            <svg className="wiki-list-search-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16.65 16.65L21 21" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
            <input
              type="search"
              className="wiki-list-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t.listing.sectionSearchPlaceholder}
              aria-label={t.listing.sectionSearchLabel}
            />
          </div>

          {/* Sort */}
          <select
            className="wiki-list-select"
            value={`${sortKey}:${sortDir}`}
            onChange={(e) => goSort(e.target.value)}
            aria-label="Sort order"
            title="Sort order"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Count */}
          <span className="wiki-list-count">
            {Math.min(visibleCount, displayedEntries.length).toLocaleString()}
            {" / "}
            {displayedEntries.length.toLocaleString()}
            {entries.length !== displayedEntries.length && ` (${entries.length.toLocaleString()} total)`}
            {" items"}
          </span>
        </div>

        {/* ── Empty state ── */}
        {displayedEntries.length === 0 && (
          <p className="wiki-muted" style={{ textAlign: "center", padding: "2rem 0" }}>
            {searchInput.trim()
              ? `No results for "${searchInput.trim()}" in this section.`
              : t.listing.noEntries}
          </p>
        )}

        {/* ── Product card list ── */}
        {displayedEntries.length > 0 && (
          <>
            <div className="wiki-product-list">
              {displayedEntries.slice(0, visibleCount).map((entry) => {
                const tags  = parseTags(entry.tags).slice(0, 5);
                const desc  = shortDesc(entry);
                const thumb = entry.pictureUrls?.[0];

                return (
                  <button
                    key={entry.documentId}
                    type="button"
                    className="wiki-product-card"
                    onClick={() => navigateTo(entry)}
                    onMouseEnter={(e) => showPreview(entry, e.currentTarget)}
                    onMouseLeave={hidePreview}
                  >
                    {/* Thumbnail */}
                    <div className="wiki-product-thumb">
                      {thumb
                        ? <img src={thumb} alt="" loading="lazy" />
                        : <span className="wiki-product-thumb-ph">no image</span>}
                    </div>

                    {/* Info */}
                    <div className="wiki-product-info">
                      <div className="wiki-product-title">{entry.title}</div>

                      <div className="wiki-product-meta">
                        {entry.artNr && <>ArtNr:&nbsp;<strong>{displayValue(entry.artNr)}</strong></>}
                        {entry.artNr && entry.EAN && <>&ensp;·&ensp;</>}
                        {entry.EAN   && <>EAN:&nbsp;<strong>{displayValue(entry.EAN)}</strong></>}
                        {!entry.artNr && !entry.EAN && <span className="wiki-muted">—</span>}
                      </div>

                      {desc && (
                        <div className="wiki-product-desc">{desc}</div>
                      )}

                      {tags.length > 0 && (
                        <div className="wiki-product-tags">
                          {tags.map((tag) => (
                            <span key={tag} className="wiki-tag-pill">{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {visibleCount < displayedEntries.length && (
              <div style={{ display: "flex", justifyContent: "center", padding: "1.5rem 0 0.5rem" }}>
                <button
                  type="button"
                  className="wiki-button"
                  onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                >
                  Load more ({(displayedEntries.length - visibleCount).toLocaleString()} remaining)
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <HoverPreview target={hoverTarget} />
    </main>
  );
}
