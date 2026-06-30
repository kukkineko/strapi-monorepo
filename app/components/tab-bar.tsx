"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useCompare } from "@/app/components/compare-context";
import { searchEntries, type Entry } from "@/app/lib/entries";

export function TabBar() {
  const { tabs, addTab, removeTab } = useCompare();
  const pathname = usePathname();

  const [searchOpen, setSearchOpen]     = useState(false);
  const [query, setQuery]               = useState("");
  const [results, setResults]           = useState<Entry[]>([]);
  const [searching, setSearching]       = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /* focus search input when opened */
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setResults([]);
    }
  }, [searchOpen]);

  /* live search */
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    let cancelled = false;
    const id = window.setTimeout(() => {
      setSearching(true);
      void searchEntries(q, 8)
        .then((r)  => { if (!cancelled) setResults(r);  })
        .catch(()  => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 280);
    return () => { cancelled = true; clearTimeout(id); };
  }, [query]);

  function pickEntry(entry: Entry) {
    addTab(entry.documentId, entry.title ?? undefined);
    setSearchOpen(false);
  }

  /* derive active tab from current path */
  const activeId = pathname.match(/^\/products\/([^/]+)$/)?.[1] ?? null;

  if (tabs.length === 0 && !searchOpen) {
    /* show a minimal "+" hint when nothing is pinned */
    return (
      <div className="wiki-tab-bar wiki-tab-bar--empty">
        <button
          type="button"
          className="wiki-tab-new-btn"
          onClick={() => setSearchOpen(true)}
          title="Open product in new tab"
        >
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M10 4v12M4 10h12" />
          </svg>
          New tab
        </button>
        {searchOpen && <SearchPopover query={query} setQuery={setQuery} results={results} searching={searching} inputRef={inputRef} onPick={pickEntry} onClose={() => setSearchOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="wiki-tab-bar" role="navigation" aria-label="Open tabs">
      <div className="wiki-tab-bar-tabs">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <div key={tab.id} className={`wiki-tab-pill${isActive ? " active" : ""}`}>
              <Link
                href={`/products/${tab.id}`}
                className="wiki-tab-pill-label"
                title={tab.title ?? tab.id}
              >
                {tab.title ?? tab.id}
              </Link>
              <button
                type="button"
                className="wiki-tab-pill-close"
                onClick={() => removeTab(tab.id)}
                aria-label={`Close ${tab.title ?? tab.id}`}
                title="Close tab"
              >
                ×
              </button>
            </div>
          );
        })}

        <button
          type="button"
          className="wiki-tab-new-btn"
          onClick={() => setSearchOpen((o) => !o)}
          title="Open product in new tab"
          aria-label="New tab"
          aria-expanded={searchOpen}
        >
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
      </div>

      {searchOpen && (
        <SearchPopover
          query={query}
          setQuery={setQuery}
          results={results}
          searching={searching}
          inputRef={inputRef}
          onPick={pickEntry}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Inline search popover ─────────────────────────────────────────────── */

function SearchPopover({
  query,
  setQuery,
  results,
  searching,
  inputRef,
  onPick,
  onClose,
}: {
  query: string;
  setQuery: (q: string) => void;
  results: Entry[];
  searching: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (entry: Entry) => void;
  onClose: () => void;
}) {
  /* close on Escape */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* backdrop */}
      <div className="wiki-tab-search-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="wiki-tab-search-popover" role="dialog" aria-label="Search for product">
        <input
          ref={inputRef}
          type="search"
          className="wiki-tab-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, art.nr or EAN…"
          autoComplete="off"
        />
        <div className="wiki-tab-search-results">
          {searching && <p className="wiki-tab-search-status">Searching…</p>}
          {!searching && query.trim() && results.length === 0 && (
            <p className="wiki-tab-search-status">No results</p>
          )}
          {!searching && results.map((entry) => {
            const thumb = entry.pictureUrls?.[0];
            return (
              <Link
                key={entry.documentId}
                href={`/products/${entry.documentId}`}
                className="wiki-tab-search-item"
                onClick={() => onPick(entry)}
              >
                <span className="wiki-tab-search-thumb">
                  {thumb
                    ? <img src={thumb} alt="" width={36} height={36} loading="lazy" />
                    : <span>no img</span>}
                </span>
                <span className="wiki-tab-search-text">
                  <strong>{entry.title}</strong>
                  <span>{entry.artNr ?? entry.documentId}</span>
                </span>
              </Link>
            );
          })}
          {!query.trim() && (
            <p className="wiki-tab-search-status">Start typing to search…</p>
          )}
        </div>
      </div>
    </>
  );
}
