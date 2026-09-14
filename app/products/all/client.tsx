"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TopBar } from "@/app/components/top-bar";
import { useLanguage } from "@/app/components/language-provider";
import type { Entry } from "@/app/lib/entries";
import { parseRubrikNumbers, displayValue, searchEntries } from "@/app/lib/entries";
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
  const nums   = parseRubrikNumbers(entry.rubrik);
  const keys   = Array.isArray(entry.rubrik)
    ? (entry.rubrik as unknown[]).map((v) => String(v).trim().toLowerCase())
    : [String(entry.rubrik ?? "").trim().toLowerCase()];

  if (section === "all") return true;
  if (section === "replacements") return keys.some((k) => k === "replacement" || k === "replacements");
  if (section === "extra") {
    if (keys.some((k) => k === "extra" || k === "extras")) return true;
    return nums.length === 0;
  }
  const match = section.match(/^rubrik-(?:r)?0*(\d{1,2})$/);
  if (!match) return true;
  const target = Number.parseInt(match[1]!, 10);
  return nums.includes(target);
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
 *    35  all tokens found individually in the tags (tokenized tag match)
 *    20  all tokens found individually in the title
 *    10  baseline (all tokens matched somewhere – already guaranteed by filter)
 *     8  space-insensitive match only ("spatime" ≈ "spa time") — lowest weight
 */
const collapse = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

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
  // All query tokens found individually in the tags
  if (tokens.length > 0 && tokens.every((tok) => tags.includes(tok))) return 35;
  // All tokens found individually in the title
  if (tokens.every((tok) => title.includes(tok))) return 20;
  // Space-insensitive fallback: "spatime" matches "spa time" in title/tags.
  // Ranked below every direct match so exact hits always win.
  const qc = collapse(q);
  if (qc.length >= 3 && (collapse(title).includes(qc) || collapse(tags).includes(qc))) {
    return 8;
  }
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

/* ─── rubrik options (shared by bulk picker) ─────────────────────────────── */

const BULK_RUBRIK_OPTIONS = [
  { value: "", label: "— (keine / löschen)" },
  ...Array.from({ length: 15 }, (_, i) => {
    const n = i + 1;
    const code = `R${String(n).padStart(2, "0")}`;
    return { value: code, label: code };
  }),
  { value: "replacements", label: "Ersatzteile" },
  { value: "extra", label: "Extra" },
];

/* ─── main client component ──────────────────────────────────────────────── */

export function AllProductsClient({
  initialEntries,
  canEdit = false,
}: {
  initialEntries: Entry[];
  canEdit?: boolean;
}) {
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

  /* ── working set ──
     The server sends only the most-recently-updated entries (initialEntries).
     That covers the default view instantly. As soon as the user types a query
     we fetch matches from the server search endpoint (which searches the WHOLE
     catalogue, not just the recent set), so nothing is unreachable. When the
     box is cleared we fall straight back to the recent set. */
  const [serverResults, setServerResults] = useState<Entry[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = searchInput.trim();
    if (!q) {
      setServerResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(() => {
      void searchEntries(q, 100)
        .then((r) => { if (!cancelled) setServerResults(r); })
        .catch(() => { if (!cancelled) setServerResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [searchInput]);

  /* Candidate pool = whole-catalogue server results (when a query is active)
     UNION the locally-loaded set. Keeping the loaded set in the pool means the
     richer client-side matching below — tokenized tags and the space-insensitive
     "spatime" ≈ "spa time" fallback — still runs even for a query the server's
     literal $containsi could not match. */
  const pool = useMemo(() => {
    if (!serverResults) return initialEntries;
    const seen = new Set<string>();
    const merged: Entry[] = [];
    for (const e of [...serverResults, ...initialEntries]) {
      if (seen.has(e.documentId)) continue;
      seen.add(e.documentId);
      merged.push(e);
    }
    return merged;
  }, [serverResults, initialEntries]);

  /* ── pre-compute searchable text once per data-load, not per keystroke ──
     igsText() calls JSON.parse — doing it inside the filter loop on every
     keystroke is expensive with thousands of entries.  Instead we build a
     Map<documentId → blob> once here.

     Each blob contains:
       • text      — raw + punctuation-as-spaces, lower-cased. Preserves word
                     boundaries so multi-token queries and bare numbers match.
       • collapsed — text with ALL non-alphanumerics removed, so a spaceless
                     query ("spatime") still matches a spaced value ("spa time").
  ── */
  const searchBlobs = useMemo(() => {
    const map = new Map<string, { text: string; collapsed: string }>();
    for (const e of pool) {
      const raw   = `${e.title} ${e.artNr ?? ""} ${e.EAN ?? ""} ${e.documentId} ${e.tags ?? ""} ${e.desc ?? ""} ${igsText(e.igs)}`;
      const clean = raw.replace(/[^a-z0-9 ]/gi, " ");
      const text  = `${raw} ${clean}`.toLowerCase();
      map.set(e.documentId, { text, collapsed: text.replace(/[^a-z0-9]/g, "") });
    }
    return map;
  }, [pool]);

  /* ── reset page on filter/sort/search change ── */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [section, sortKey, sortDir, searchInput]);

  /* ── filter + sort ── */
  const displayedEntries = useMemo(() => {
    const q      = searchInput.trim().toLowerCase();
    const tokens = tokenize(q);

    const qc = q.replace(/[^a-z0-9]/g, "");

    const filtered = pool.filter((e) => {
      if (!inSection(e, section)) return false;
      if (!q) return true;
      const blob = searchBlobs.get(e.documentId);
      if (!blob) return false;
      // Direct: every token appears somewhere in the searchable text.
      if (tokens.every((tok) => blob.text.includes(tok))) return true;
      // Space-insensitive fallback: "spatime" matches "spa time".
      return qc.length >= 3 && blob.collapsed.includes(qc);
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
  }, [pool, section, sortKey, sortDir, searchInput, searchBlobs]);

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

  /* ── bulk multi-select (editors only) ── */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [bulkTag, setBulkTag] = useState("");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [unlinkDialogOpen, setUnlinkDialogOpen] = useState(false);
  const [bulkLinkSource, setBulkLinkSource] = useState("");
  const [bulkLinkConfidence, setBulkLinkConfidence] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [targetSelected, setTargetSelected] = useState<Set<string>>(new Set());
  const [rubrikDialogOpen, setRubrikDialogOpen] = useState(false);
  const [bulkRubriks, setBulkRubriks] = useState<Set<string>>(new Set());

  const toggleSelected = useCallback((docId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }, []);

  const toggleTarget = useCallback((docId: string) => {
    setTargetSelected((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }, []);

  function clearSelection() {
    setSelected(new Set());
    setBulkMsg(null);
  }

  function closeLinkDialog() {
    setLinkDialogOpen(false);
    setTargetQuery("");
    setTargetSelected(new Set());
    setBulkLinkSource("");
    setBulkLinkConfidence("");
  }

  function closeUnlinkDialog() {
    setUnlinkDialogOpen(false);
    setTargetQuery("");
    setTargetSelected(new Set());
  }

  /* Target candidates for the link/unlink dialogs. An empty query shows the
     recent set; a typed query hits the server search so editors can link to
     ANY item in the catalogue, not just the recently-updated ones. */
  const [targetResults, setTargetResults] = useState<Entry[]>([]);
  useEffect(() => {
    if (!linkDialogOpen && !unlinkDialogOpen) {
      setTargetResults([]);
      return;
    }
    const q = targetQuery.trim();
    if (!q) {
      setTargetResults(initialEntries.slice(0, 100));
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void searchEntries(q, 100)
        .then((r) => { if (!cancelled) setTargetResults(r); })
        .catch(() => { if (!cancelled) setTargetResults([]); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [linkDialogOpen, unlinkDialogOpen, targetQuery, initialEntries]);

  async function handleBulkTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tag = bulkTag.trim();
    if (!tag || selected.size === 0 || bulkBusy) return;
    try {
      setBulkBusy(true);
      const res = await fetch("/api/entries/bulk-tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], tag }),
      });
      const data = (await res.json().catch(() => ({}))) as { updated?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to add tag.");
      setBulkMsg(`Added tag “${tag}” to ${data.updated ?? 0} item(s).`);
      setTagDialogOpen(false);
      setBulkTag("");
      clearSelection();
      router.refresh();
    } catch (err) {
      setBulkMsg(err instanceof Error ? err.message : "Failed to add tag.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkLink() {
    if (selected.size === 0 || targetSelected.size === 0 || bulkBusy) return;
    try {
      setBulkBusy(true);
      const confidenceNum = bulkLinkConfidence.trim()
        ? Math.min(1, Math.max(0, Number(bulkLinkConfidence) / 100))
        : undefined;
      const res = await fetch("/api/entries/bulk-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceIds: [...selected],
          targetIds: [...targetSelected],
          ...(confidenceNum !== undefined && !Number.isNaN(confidenceNum) && { confidence: confidenceNum }),
          ...(bulkLinkSource.trim() && { source: bulkLinkSource.trim() }),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { updated?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to link items.");
      setBulkMsg(`Linked ${selected.size} item(s) to ${targetSelected.size} target(s) — ${data.updated ?? 0} entries updated.`);
      closeLinkDialog();
      clearSelection();
      router.refresh();
    } catch (err) {
      setBulkMsg(err instanceof Error ? err.message : "Failed to link items.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkUnlink() {
    if (selected.size === 0 || targetSelected.size === 0 || bulkBusy) return;
    try {
      setBulkBusy(true);
      const res = await fetch("/api/entries/bulk-unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceIds: [...selected], targetIds: [...targetSelected] }),
      });
      const data = (await res.json().catch(() => ({}))) as { updated?: number; linksRemoved?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to unlink items.");
      setBulkMsg(`Removed ${data.linksRemoved ?? 0} link(s) across ${data.updated ?? 0} entries.`);
      closeUnlinkDialog();
      clearSelection();
      router.refresh();
    } catch (err) {
      setBulkMsg(err instanceof Error ? err.message : "Failed to unlink items.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkRubrik() {
    if (selected.size === 0 || bulkBusy) return;
    try {
      setBulkBusy(true);
      const rubriks = [...bulkRubriks];
      const res = await fetch("/api/entries/bulk-rubrik", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], rubriks }),
      });
      const data = (await res.json().catch(() => ({}))) as { updated?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to set rubrik.");
      const label = rubriks.length > 0 ? rubriks.join(", ") : "(keine)";
      setBulkMsg(`Rubrik "${label}" gesetzt für ${data.updated ?? 0} Artikel.`);
      setRubrikDialogOpen(false);
      clearSelection();
      router.refresh();
    } catch (err) {
      setBulkMsg(err instanceof Error ? err.message : "Failed to set rubrik.");
    } finally {
      setBulkBusy(false);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────── */
  return (
    <main className="wiki-shell">
      <TopBar
        actions={[
          { href: "/",             label: t.nav.home },
          { href: "/products/new", label: t.nav.createNewPage, primary: true, adminOnly: true },
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
            {pool.length !== displayedEntries.length && ` (${pool.length.toLocaleString()} total)`}
            {" items"}
          </span>
        </div>

        {/* ── Empty state ── */}
        {displayedEntries.length === 0 && (
          <p className="wiki-muted" style={{ textAlign: "center", padding: "2rem 0" }}>
            {searching
              ? "Searching…"
              : searchInput.trim()
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
                const isSelected = selected.has(entry.documentId);

                return (
                  <div
                    key={entry.documentId}
                    className={`wiki-product-card-wrap${isSelected ? " selected" : ""}`}
                    onMouseEnter={(e) => showPreview(entry, e.currentTarget)}
                    onMouseLeave={hidePreview}
                  >
                    {/* Navigation button — thumb + info + tags columns */}
                    <button
                      type="button"
                      className="wiki-product-card"
                      onClick={() => navigateTo(entry)}
                    >
                      {/* Thumbnail */}
                      <div className="wiki-product-thumb">
                        {thumb
                          ? <img src={thumb} alt="" loading="lazy" />
                          : <span className="wiki-product-thumb-ph">no image</span>}
                      </div>

                      {/* Info: title / artNr+EAN / desc */}
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
                      </div>

                      {/* Tags — right column */}
                      {tags.length > 0 && (
                        <div className="wiki-product-tags-col">
                          {tags.map((tag) => (
                            <span key={tag} className="wiki-tag-pill">{tag}</span>
                          ))}
                        </div>
                      )}
                    </button>

                    {/* Selector — far right, outside the nav button */}
                    {canEdit && (
                      <label
                        className="wiki-product-select-col"
                        title="Select"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelected(entry.documentId)}
                        />
                      </label>
                    )}
                  </div>
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

      {/* ── Bulk action bar (editors, when something is selected) ── */}
      {canEdit && selected.size > 0 && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            flexWrap: "wrap",
            padding: "0.75rem 1rem",
            background: "#0f172a",
            color: "#fff",
            boxShadow: "0 -4px 20px rgba(15,23,42,0.35)",
          }}
        >
          <strong>{selected.size.toLocaleString()} selected</strong>
          <button
            type="button"
            className="wiki-button"
            onClick={() => setSelected(new Set(displayedEntries.map((e) => e.documentId)))}
          >
            Select all ({displayedEntries.length.toLocaleString()})
          </button>
          <button type="button" className="wiki-button" onClick={clearSelection}>
            Clear
          </button>
          <span style={{ flex: 1, minWidth: "1rem" }} />
          {bulkMsg && <span style={{ fontSize: "0.85rem", opacity: 0.92 }}>{bulkMsg}</span>}
          <button
            type="button"
            className="wiki-button"
            onClick={() => { setBulkTag(""); setBulkMsg(null); setTagDialogOpen(true); }}
          >
            Add tag…
          </button>
          <button
            type="button"
            className="wiki-button"
            onClick={() => { setBulkRubriks(new Set()); setBulkMsg(null); setRubrikDialogOpen(true); }}
          >
            Set rubrik…
          </button>
          <button
            type="button"
            className="wiki-button"
            style={{ background: "#2563eb", color: "#fff", borderColor: "#2563eb" }}
            onClick={() => { setBulkMsg(null); setLinkDialogOpen(true); }}
          >
            Link…
          </button>
          <button
            type="button"
            className="wiki-button"
            style={{ background: "#dc2626", color: "#fff", borderColor: "#dc2626" }}
            onClick={() => { setBulkMsg(null); setUnlinkDialogOpen(true); }}
          >
            Unlink…
          </button>
        </div>
      )}

      {/* ── Add-tag dialog ── */}
      {canEdit && tagDialogOpen && (
        <div className="wiki-modal" onClick={() => !bulkBusy && setTagDialogOpen(false)}>
          <div
            className="wiki-modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "440px" }}
          >
            <div className="wiki-modal-header">
              <div>
                <h2>Add tag to {selected.size} item(s)</h2>
                <p>The tag is added to each selected item (duplicates skipped).</p>
              </div>
            </div>
            <form
              onSubmit={handleBulkTag}
              style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}
            >
              <input
                type="text"
                className="wiki-list-search"
                value={bulkTag}
                onChange={(e) => setBulkTag(e.target.value)}
                placeholder="Tag"
                autoFocus
                disabled={bulkBusy}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button type="button" className="wiki-button" onClick={() => setTagDialogOpen(false)} disabled={bulkBusy}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="wiki-button"
                  style={{ background: "#2563eb", color: "#fff", borderColor: "#2563eb" }}
                  disabled={bulkBusy || !bulkTag.trim()}
                >
                  {bulkBusy ? "Adding…" : "Add tag"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Set-rubrik dialog ── */}
      {canEdit && rubrikDialogOpen && (
        <div className="wiki-modal" onClick={() => !bulkBusy && setRubrikDialogOpen(false)}>
          <div
            className="wiki-modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "360px" }}
          >
            <div className="wiki-modal-header">
              <div>
                <h2>Rubrik setzen für {selected.size} Artikel</h2>
                <p>Setzt die Kategorie für alle gewählten Artikel.</p>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
              <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--wiki-muted, #6b7280)" }}>
                Mehrere Kategorien möglich. Leer lassen = Zuweisung entfernen.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem 1rem" }}>
                {BULK_RUBRIK_OPTIONS.filter((o) => o.value !== "").map((opt) => (
                  <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.9rem" }}>
                    <input
                      type="checkbox"
                      checked={bulkRubriks.has(opt.value)}
                      disabled={bulkBusy}
                      onChange={() => {
                        setBulkRubriks((prev) => {
                          const next = new Set(prev);
                          if (next.has(opt.value)) next.delete(opt.value); else next.add(opt.value);
                          return next;
                        });
                      }}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button type="button" className="wiki-button" onClick={() => setRubrikDialogOpen(false)} disabled={bulkBusy}>
                  Abbrechen
                </button>
                <button
                  type="button"
                  className="wiki-button"
                  style={{ background: "#2563eb", color: "#fff", borderColor: "#2563eb" }}
                  onClick={() => void handleBulkRubrik()}
                  disabled={bulkBusy}
                >
                  {bulkBusy ? "Speichern…" : `Setzen für ${selected.size} Artikel`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Unlink target picker dialog ── */}
      {canEdit && unlinkDialogOpen && (
        <div className="wiki-modal" onClick={() => !bulkBusy && closeUnlinkDialog()}>
          <div
            className="wiki-modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(720px, 96vw)", maxHeight: "86vh", display: "flex", flexDirection: "column" }}
          >
            <div className="wiki-modal-header">
              <div>
                <h2>Unlink {selected.size} item(s) from…</h2>
                <p>Pick items to remove links to. Links are removed both ways.</p>
              </div>
            </div>
            <div style={{ padding: "0 1rem" }}>
              <input
                type="text"
                className="wiki-list-search"
                value={targetQuery}
                onChange={(e) => setTargetQuery(e.target.value)}
                placeholder="Search items to unlink from…"
                autoFocus
              />
            </div>
            <div
              style={{
                overflowY: "auto",
                flex: 1,
                padding: "0.5rem 1rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.2rem",
              }}
            >
              {targetResults.length === 0 ? (
                <p className="wiki-muted">No matching items.</p>
              ) : (
                targetResults.map((e) => {
                  const checked  = targetSelected.has(e.documentId);
                  const isSource = selected.has(e.documentId);
                  const tgtTags  = parseTags(e.tags).slice(0, 5);
                  return (
                    <label
                      key={e.documentId}
                      style={{
                        display: "flex",
                        gap: "0.6rem",
                        alignItems: "flex-start",
                        padding: "0.4rem 0.5rem",
                        borderRadius: "8px",
                        background: checked ? "#fff1f2" : "transparent",
                        cursor: isSource ? "not-allowed" : "pointer",
                        opacity: isSource ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSource}
                        onChange={() => toggleTarget(e.documentId)}
                        style={{ marginTop: "3px", width: "16px", height: "16px" }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {e.title}
                          {isSource && <span className="wiki-muted"> (selected source)</span>}
                        </div>
                        <div className="wiki-muted" style={{ fontSize: "0.8rem" }}>
                          ArtNr {displayValue(e.artNr)} · EAN {displayValue(e.EAN)}
                        </div>
                        {tgtTags.length > 0 && (
                          <div className="wiki-product-tags">
                            {tgtTags.map((tg) => (
                              <span key={tg} className="wiki-tag-pill">{tg}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.75rem 1rem",
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <span className="wiki-muted">{targetSelected.size} selected</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="wiki-button" onClick={closeUnlinkDialog} disabled={bulkBusy}>
                Cancel
              </button>
              <button
                type="button"
                className="wiki-button"
                style={{ background: "#dc2626", color: "#fff", borderColor: "#dc2626" }}
                onClick={() => void handleBulkUnlink()}
                disabled={bulkBusy || targetSelected.size === 0}
              >
                {bulkBusy ? "Unlinking…" : `Unlink ${selected.size}×${targetSelected.size}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Link target picker dialog ── */}
      {canEdit && linkDialogOpen && (
        <div className="wiki-modal" onClick={() => !bulkBusy && closeLinkDialog()}>
          <div
            className="wiki-modal-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(720px, 96vw)", maxHeight: "86vh", display: "flex", flexDirection: "column" }}
          >
            <div className="wiki-modal-header">
              <div>
                <h2>Link {selected.size} item(s) to…</h2>
                <p>Pick the target items. Links are created both ways.</p>
              </div>
            </div>
            <div style={{ padding: "0 1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  type="text"
                  className="wiki-list-search"
                  style={{ flex: 1, marginBottom: 0 }}
                  value={bulkLinkSource}
                  onChange={(e) => setBulkLinkSource(e.target.value)}
                  placeholder="Source (optional)"
                />
                <input
                  type="number"
                  className="wiki-list-search"
                  style={{ width: "110px", marginBottom: 0 }}
                  value={bulkLinkConfidence}
                  onChange={(e) => setBulkLinkConfidence(e.target.value)}
                  placeholder="Confidence %"
                  min={0}
                  max={100}
                />
              </div>
              <input
                type="text"
                className="wiki-list-search"
                style={{ marginBottom: 0 }}
                value={targetQuery}
                onChange={(e) => setTargetQuery(e.target.value)}
                placeholder="Search items to link to…"
                autoFocus
              />
            </div>
            <div
              style={{
                overflowY: "auto",
                flex: 1,
                padding: "0.5rem 1rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.2rem",
              }}
            >
              {targetResults.length === 0 ? (
                <p className="wiki-muted">No matching items.</p>
              ) : (
                targetResults.map((e) => {
                  const checked = targetSelected.has(e.documentId);
                  const isSource = selected.has(e.documentId);
                  const tgtTags = parseTags(e.tags).slice(0, 5);
                  return (
                    <label
                      key={e.documentId}
                      style={{
                        display: "flex",
                        gap: "0.6rem",
                        alignItems: "flex-start",
                        padding: "0.4rem 0.5rem",
                        borderRadius: "8px",
                        background: checked ? "#eff6ff" : "transparent",
                        cursor: isSource ? "not-allowed" : "pointer",
                        opacity: isSource ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSource}
                        onChange={() => toggleTarget(e.documentId)}
                        style={{ marginTop: "3px", width: "16px", height: "16px" }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {e.title}
                          {isSource && <span className="wiki-muted"> (selected source)</span>}
                        </div>
                        <div className="wiki-muted" style={{ fontSize: "0.8rem" }}>
                          ArtNr {displayValue(e.artNr)} · EAN {displayValue(e.EAN)}
                        </div>
                        {tgtTags.length > 0 && (
                          <div className="wiki-product-tags">
                            {tgtTags.map((tg) => (
                              <span key={tg} className="wiki-tag-pill">{tg}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.75rem 1rem",
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <span className="wiki-muted">{targetSelected.size} target(s)</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="wiki-button" onClick={closeLinkDialog} disabled={bulkBusy}>
                Cancel
              </button>
              <button
                type="button"
                className="wiki-button"
                style={{ background: "#2563eb", color: "#fff", borderColor: "#2563eb" }}
                onClick={handleBulkLink}
                disabled={bulkBusy || targetSelected.size === 0}
              >
                {bulkBusy ? "Linking…" : `Link ${selected.size}×${targetSelected.size}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
