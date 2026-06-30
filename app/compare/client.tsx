"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TopBar } from "@/app/components/top-bar";
import { useCompare } from "@/app/components/compare-context";
import { getEntryById, type Entry } from "@/app/lib/entries";

/* ── Compact product pane for side-by-side comparison ─────────────────────── */

function ProductPane({ id }: { id: string }) {
  const [entry,   setEntry]   = useState<Entry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [imgIdx,  setImgIdx]  = useState(0);

  const { removeTab } = useCompare();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getEntryById(id)
      .then((data) => { if (!cancelled) { setEntry(data); setLoading(false); } })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [id]);

  const images = entry?.pictureUrls ?? [];
  const safeIdx = Math.min(imgIdx, Math.max(images.length - 1, 0));

  let tags: string[] = [];
  if (entry?.tags) {
    try {
      const parsed = JSON.parse(entry.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = entry.tags.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    }
  }

  return (
    <div className="compare-pane">
      {/* Pane header */}
      <div className="compare-pane-header">
        <Link href={`/products/${id}`} className="compare-pane-title-link" title="Open full page">
          {entry?.title ?? id}
        </Link>
        <button
          type="button"
          className="compare-pane-remove"
          onClick={() => removeTab(id)}
          title="Remove from compare"
          aria-label="Remove"
        >
          ×
        </button>
      </div>

      {loading && <p className="wiki-muted compare-pane-status">Loading…</p>}
      {error   && <p className="wiki-error compare-pane-status">{error}</p>}

      {!loading && !error && entry && (
        <>
          {/* Image carousel */}
          <div className="compare-pane-image-wrap">
            {images.length > 0 ? (
              <>
                <img
                  src={images[safeIdx]}
                  alt={entry.title}
                  className="compare-pane-image"
                />
                {images.length > 1 && (
                  <div className="compare-pane-image-nav">
                    <button
                      type="button"
                      onClick={() => setImgIdx((i) => Math.max(i - 1, 0))}
                      disabled={safeIdx === 0}
                      aria-label="Previous image"
                    >‹</button>
                    <span>{safeIdx + 1}/{images.length}</span>
                    <button
                      type="button"
                      onClick={() => setImgIdx((i) => Math.min(i + 1, images.length - 1))}
                      disabled={safeIdx === images.length - 1}
                      aria-label="Next image"
                    >›</button>
                  </div>
                )}
              </>
            ) : (
              <div className="compare-pane-no-image">No image</div>
            )}
          </div>

          {/* Key fields */}
          <dl className="compare-pane-fields">
            <div className="compare-field-row">
              <dt>Art.Nr.</dt>
              <dd title={entry.artNr ?? "—"}>{entry.artNr ?? "—"}</dd>
            </div>
            <div className="compare-field-row">
              <dt>EAN</dt>
              <dd title={entry.EAN ?? "—"}>{entry.EAN ?? "—"}</dd>
            </div>
            <div className="compare-field-row">
              <dt>Rubrik</dt>
              <dd>{typeof entry.rubrik === "string" ? entry.rubrik : "—"}</dd>
            </div>
          </dl>

          {/* Description */}
          {entry.desc?.trim() && (
            <p className="compare-pane-desc">{entry.desc.trim()}</p>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <div className="compare-pane-tags">
              {tags.map((tag) => (
                <span key={tag} className="wiki-tag-pill">{tag}</span>
              ))}
            </div>
          )}

          <Link href={`/products/${id}`} className="compare-pane-open-link">
            Open full page →
          </Link>
        </>
      )}
    </div>
  );
}

/* ── Compare page ─────────────────────────────────────────────────────────── */

export function CompareClient() {
  const searchParams = useSearchParams();
  const { layout, setLayout, tabs, addTab } = useCompare();

  const idsParam = searchParams.get("ids") ?? "";
  const ids = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  // Sync URL ids into context tabs on mount
  useEffect(() => {
    for (const id of ids) {
      addTab(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsParam]);

  // Use context tabs when available, fall back to URL ids
  const displayIds = tabs.length > 0 ? tabs.map((t) => t.id) : ids;
  const show1x1 = layout === "1x1";
  const [focused, setFocused] = useState(0);

  const visibleIds = show1x1
    ? displayIds.slice(focused, focused + 1)
    : displayIds.slice(0, 4);

  return (
    <main className="wiki-shell">
      <TopBar
        actions={[
          { href: "/products/all", label: "All products" },
          { href: "/", label: "Home" },
        ]}
      />

      <div className="compare-toolbar">
        <h1 className="compare-toolbar-title">Compare ({displayIds.length})</h1>

        <div className="compare-toolbar-controls">
          {/* Layout toggle */}
          <div className="wiki-tab-layout-toggle" role="group" aria-label="Layout">
            <button
              type="button"
              className={`wiki-tab-layout-btn${layout === "1x1" ? " active" : ""}`}
              onClick={() => setLayout("1x1")}
              aria-pressed={layout === "1x1"}
            >
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="3" width="14" height="14" rx="1.5" />
              </svg>
              1×1
            </button>
            <button
              type="button"
              className={`wiki-tab-layout-btn${layout === "2x2" ? " active" : ""}`}
              onClick={() => setLayout("2x2")}
              aria-pressed={layout === "2x2"}
            >
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="2" y="2" width="7" height="7" rx="1" />
                <rect x="11" y="2" width="7" height="7" rx="1" />
                <rect x="2" y="11" width="7" height="7" rx="1" />
                <rect x="11" y="11" width="7" height="7" rx="1" />
              </svg>
              2×2
            </button>
          </div>

          {/* 1x1 prev/next */}
          {show1x1 && displayIds.length > 1 && (
            <div className="compare-1x1-nav">
              <button
                type="button"
                className="wiki-button"
                onClick={() => setFocused((i) => Math.max(i - 1, 0))}
                disabled={focused === 0}
              >‹ Prev</button>
              <span className="compare-1x1-counter">{focused + 1} / {displayIds.length}</span>
              <button
                type="button"
                className="wiki-button"
                onClick={() => setFocused((i) => Math.min(i + 1, displayIds.length - 1))}
                disabled={focused >= displayIds.length - 1}
              >Next ›</button>
            </div>
          )}
        </div>
      </div>

      <div className={`compare-grid${layout === "2x2" ? " compare-grid-2x2" : ""}`}>
        {visibleIds.map((id) => (
          <ProductPane key={id} id={id} />
        ))}

        {visibleIds.length === 0 && (
          <p className="wiki-muted" style={{ padding: "2rem" }}>
            No items to compare. Add products using the compare button on product pages.
          </p>
        )}
      </div>
    </main>
  );
}
