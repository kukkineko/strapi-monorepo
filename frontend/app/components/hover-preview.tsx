"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Entry } from "@/app/lib/entries";

/* ─── constants ────────────────────────────────────────────────────────────── */

const PREVIEW_WIDTH = 296;
const PREVIEW_GAP   = 10;
const SHOW_DELAY_MS = 220;

/* ─── helpers ──────────────────────────────────────────────────────────────── */

function parseMatchcodes(igs?: string): { mc1: string; mc2: string } {
  if (!igs) return { mc1: "", mc2: "" };
  try {
    const parsed = JSON.parse(igs) as Record<string, unknown>;
    const first  = parsed.HC ?? parsed["Matchcode 1"];
    const second = parsed.HD ?? parsed["Matchcode 2"];
    return {
      mc1: typeof first  === "string" && first.trim()  ? first.trim()  : "",
      mc2: typeof second === "string" && second.trim() ? second.trim() : "",
    };
  } catch {
    return { mc1: "", mc2: "" };
  }
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

/* ─── hook ─────────────────────────────────────────────────────────────────── */

export interface HoverTarget {
  entry:   Entry;
  rect:    DOMRect;
}

export function useHoverPreview() {
  const [target,  setTarget]  = useState<HoverTarget | null>(null);
  const timerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elementRef            = useRef<HTMLElement | null>(null);

  /* hide when hovered element leaves the viewport (also fires if element
     is removed from the DOM and IntersectionObserver detects 0 intersection) */
  useEffect(() => {
    const el = elementRef.current;
    if (!target || !el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) {
          if (timerRef.current) clearTimeout(timerRef.current);
          setTarget(null);
        }
      },
      { threshold: 0 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [target]);

  /* hide on any scroll — capture:true catches nested scroll containers too */
  useEffect(() => {
    if (!target) return;
    const hide = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setTarget(null);
    };
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", hide, { capture: true });
  }, [target]);

  /* cleanup timer on unmount */
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const showPreview = useCallback((entry: Entry, el: HTMLElement) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    elementRef.current = el;
    timerRef.current = setTimeout(() => {
      setTarget({ entry, rect: el.getBoundingClientRect() });
    }, SHOW_DELAY_MS);
  }, []);

  const hidePreview = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    elementRef.current = null;
    setTarget(null);
  }, []);

  return { target, showPreview, hidePreview };
}

/* ─── component ─────────────────────────────────────────────────────────────── */

interface HoverPreviewProps {
  target: HoverTarget | null;
}

export function HoverPreview({ target }: HoverPreviewProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted || !target) return null;

  const { entry, rect } = target;

  /* ── positioning: prefer right side, fall back to left, then centered ── */
  const vw  = window.innerWidth;
  const vh  = window.innerHeight;

  let left: number;
  let originX: string;

  if (rect.right + PREVIEW_GAP + PREVIEW_WIDTH <= vw) {
    left    = rect.right + PREVIEW_GAP;
    originX = "left center";
  } else if (rect.left - PREVIEW_GAP - PREVIEW_WIDTH >= 0) {
    left    = rect.left - PREVIEW_GAP - PREVIEW_WIDTH;
    originX = "right center";
  } else {
    left    = Math.max(8, Math.min(vw - PREVIEW_WIDTH - 8, rect.left));
    originX = "top center";
  }

  /* vertical: center on the anchor, clamped to viewport */
  const estimatedH = 320;
  const idealTop   = rect.top + rect.height / 2 - estimatedH / 2;
  const top        = Math.max(8, Math.min(vh - estimatedH - 8, idealTop));

  /* ── entry data ── */
  const { mc1, mc2 } = parseMatchcodes(entry.igs);
  const tags          = parseTags(entry.tags);
  const thumb         = entry.pictureUrls?.[0];
  const desc          = entry.desc?.trim() ?? "";

  return createPortal(
    <div
      className="wiki-hover-preview"
      style={{
        position:        "fixed",
        left,
        top,
        width:           PREVIEW_WIDTH,
        zIndex:          9999,
        transformOrigin: originX,
      }}
      aria-hidden="true"
    >
      {thumb && (
        <div className="wiki-hover-preview-image">
          <img src={thumb} alt="" />
        </div>
      )}

      <div className="wiki-hover-preview-body">
        <div className="wiki-hover-preview-title">{entry.title}</div>

        {(entry.artNr || entry.EAN) && (
          <div className="wiki-hover-preview-meta">
            {entry.artNr && <span>ArtNr:&nbsp;<strong>{entry.artNr}</strong></span>}
            {entry.artNr && entry.EAN && <span className="wiki-hover-preview-sep">·</span>}
            {entry.EAN   && <span>EAN:&nbsp;<strong>{entry.EAN}</strong></span>}
          </div>
        )}

        {(mc1 || mc2) && (
          <div className="wiki-hover-preview-matchcodes">
            {mc1 && <span>{mc1}</span>}
            {mc1 && mc2 && <span className="wiki-hover-preview-sep">·</span>}
            {mc2 && <span>{mc2}</span>}
          </div>
        )}

        {desc && (
          <div className="wiki-hover-preview-desc">
            {desc.length > 220 ? `${desc.slice(0, 217).trimEnd()}…` : desc}
          </div>
        )}

        {tags.length > 0 && (
          <div className="wiki-hover-preview-tags">
            {tags.slice(0, 8).map((tag) => (
              <span key={tag} className="wiki-tag-pill">{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
