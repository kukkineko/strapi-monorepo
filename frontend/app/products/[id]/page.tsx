"use client";

import Link from "next/link";
import Image from "next/image";
import { useParams, useSearchParams } from "next/navigation";
import { FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState, WheelEvent as ReactWheelEvent } from "react";
import { TopBar } from "@/app/components/top-bar";
import { AddToListButton } from "@/app/components/add-to-list-button";
import { useLanguage } from "@/app/components/language-provider";
import {
  SECTION_ADD_ICON,
  SECTION_ADD_ICON_OFFSET_Y,
  SECTION_ADD_ICON_SIZE,
} from "@/app/lib/topbar-icons";
import type { Entry, EntryMedia, EntryNeighbors, EntryPayload, LinkEntry } from "@/app/lib/entries";
import { getArtNrNeighbors, getEntryById, getMediaById, listEntries, normalizeRubrikValue, normalizeRubrikValues, parseRubrikNumber, parseLinkEntries, searchEntries, serializeLinkEntries, uploadMedia } from "@/app/lib/entries";
import { parseIgsEntries, getIgsFieldValue, setIgsFieldValue } from "@/app/lib/igs";
import type { AuthUser } from "@/app/lib/auth-types";

type TextEntry = {
  title: string;
  description: string;
  link?: string;
  attachments?: Array<string | number>;
};

type RelationsGraphNode = {
  id: string;
  title: string;
  subTitle: string;
  imageUrl?: string;
  isCurrent: boolean;
  isKnown: boolean;
};

type RelationsGraphEdge = {
  source: string;
  target: string;
};

const REL_NODE_RADIUS = 92;
const REL_NODE_DIAMETER = REL_NODE_RADIUS * 2;
const REL_MIN_NODE_DISTANCE = REL_NODE_DIAMETER * 2.5;
const REL_LAYOUT_PADDING = 180;

/* ── artNr neighbours window ── */
const NEIGHBOR_RANGE_MIN = 1;
const NEIGHBOR_RANGE_MAX = 20;
const NEIGHBOR_RANGE_DEFAULT = 3;
const NEIGHBOR_RANGE_KEY = "wiki-variants-range";

type SectionType = "issues" | "docs" | "links" | "tickets";


function parseTextEntries(value?: string): TextEntry[] {
  if (!value?.trim()) {
    return [];
  }

  try {
    // Try parsing as JSON first
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        title: (item as TextEntry).title || "",
        description: (item as TextEntry).description || "",
        link: (item as TextEntry).link,
        attachments: (item as TextEntry).attachments || [],
      }));
    }
  } catch {
    // Fall back to old text format for backward compatibility
  }

  // Old text format: multi-line blocks separated by \n\n
  return value
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const titleLine = lines[0]?.trim() || "";
      const entry: TextEntry = {
        title: titleLine,
        description: "",
        attachments: [],
      };

      let descLines: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith("link:")) {
          entry.link = line.slice(5).trim();
        } else if (line.startsWith("attachment:")) {
          entry.attachments = entry.attachments || [];
          entry.attachments.push(line.slice(11).trim());
        } else {
          descLines.push(line);
        }
      }

      entry.description = descLines.join("\n").trim();
      return entry;
    });
}

function serializeTextEntries(entries: TextEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      title: entry.title.trim(),
      description: entry.description?.trim() || "",
      ...(entry.link && { link: entry.link.trim() }),
      ...(entry.attachments?.length && { attachments: entry.attachments.filter(Boolean) }),
    }))
  );
}

function normalizeExternalLink(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed.replace(/^\/+/, "")}`;
}

/**
 * Strapi media relations must be written as arrays of file IDs. The loaded
 * Entry holds populated media objects, so map them down to their numeric ids —
 * sending the full objects makes Strapi drop the relation (wiping the images).
 */
function toMediaIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((m) => (typeof m === "number" ? m : Number((m as { id?: unknown } | null)?.id)))
    .filter((n): n is number => Number.isFinite(n) && n > 0);
}

function buildEntryPayload(entry: Entry, updates: Partial<EntryPayload> = {}): EntryPayload {
  return {
    title: entry.title,
    artNr: entry.artNr,
    EAN: entry.EAN,
    desc: entry.desc,
    tags: entry.tags,
    docs: entry.docs,
    links: entry.links,
    issues: entry.issues,
    tickets: entry.tickets,
    igs: entry.igs,
    pictures: toMediaIds(entry.pictures),
    miscFile: toMediaIds(entry.miscFile),
    ...updates,
  };
}

function isImageAttachment(value: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|svg|tiff?)(\?|#|$)/i.test(value);
}

function isPdfAttachment(value: string): boolean {
  return /\.pdf(\?|#|$)/i.test(value);
}

/** Uppercase file extension for display, or "—" when none can be derived. */
function fileTypeLabel(value: string): string {
  const clean = value.split(/[?#]/)[0] ?? value;
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match ? match[1]!.toUpperCase() : "—";
}

/**
 * Inline preview for a document attachment: images render directly, PDFs embed
 * in an iframe, everything else falls back to a download prompt.
 */
function renderDocPreviewPane(media: EntryMedia, fallbackText: string) {
  if (isImageAttachment(media.url)) {
    return <img className="wiki-doc-viewer-image" src={media.url} alt={media.name ?? ""} />;
  }
  if (isPdfAttachment(media.url)) {
    return (
      <iframe className="wiki-doc-viewer-frame" src={media.url} title={media.name ?? "PDF"} />
    );
  }
  return (
    <div className="wiki-doc-viewer-fallback">
      <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      <p className="wiki-doc-viewer-fallback-name">{media.name ?? "Document"}</p>
      <p className="wiki-muted">{fallbackText}</p>
    </div>
  );
}

function edgeKey(source: string, target: string): string {
  return source < target ? `${source}::${target}` : `${target}::${source}`;
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function buildGraphLayout(
  nodes: RelationsGraphNode[],
  edges: RelationsGraphEdge[],
  width: number,
  height: number,
  minDistance: number
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) {
    return positions;
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.32;
  const nodeRadius = REL_NODE_RADIUS;
  const minX = nodeRadius + 20;
  const maxX = width - nodeRadius - 20;
  const minY = nodeRadius + 20;
  const maxY = height - nodeRadius - 20;

  nodes.forEach((node, index) => {
    const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
    const jitterSeed = hashText(node.id);
    const jitterX = ((jitterSeed % 17) - 8) * 1.5;
    const jitterY = (((jitterSeed >> 4) % 17) - 8) * 1.5;
    positions.set(node.id, {
      x: centerX + Math.cos(angle) * radius + jitterX,
      y: centerY + Math.sin(angle) * radius + jitterY,
    });
  });

  const velocity = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    velocity.set(node.id, { x: 0, y: 0 });
  }

  const iterations = 240;
  for (let step = 0; step < iterations; step++) {
    const forces = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      forces.set(node.id, { x: 0, y: 0 });
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const posA = positions.get(a.id)!;
        const posB = positions.get(b.id)!;
        let dx = posB.x - posA.x;
        let dy = posB.y - posA.y;
        const distSq = Math.max(dx * dx + dy * dy, 0.01);
        const dist = Math.sqrt(distSq);

        dx /= dist;
        dy /= dist;

        const repulsion = (minDistance * minDistance * 0.55) / distSq;
        const fx = dx * repulsion;
        const fy = dy * repulsion;

        const forceA = forces.get(a.id)!;
        const forceB = forces.get(b.id)!;
        forceA.x -= fx;
        forceA.y -= fy;
        forceB.x += fx;
        forceB.y += fy;
      }
    }

    for (const edge of edges) {
      const posA = positions.get(edge.source);
      const posB = positions.get(edge.target);
      if (!posA || !posB) {
        continue;
      }

      let dx = posB.x - posA.x;
      let dy = posB.y - posA.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.001);
      dx /= dist;
      dy /= dist;

      const spring = (dist - Math.max(minDistance * 1.04, 180)) * 0.045;
      const fx = dx * spring;
      const fy = dy * spring;

      const forceA = forces.get(edge.source)!;
      const forceB = forces.get(edge.target)!;
      forceA.x += fx;
      forceA.y += fy;
      forceB.x -= fx;
      forceB.y -= fy;
    }

    for (const node of nodes) {
      const pos = positions.get(node.id)!;
      const force = forces.get(node.id)!;
      const vel = velocity.get(node.id)!;

      force.x += (centerX - pos.x) * 0.002;
      force.y += (centerY - pos.y) * 0.002;

      vel.x = (vel.x + force.x * 0.05) * 0.82;
      vel.y = (vel.y + force.y * 0.05) * 0.82;

      pos.x = Math.min(maxX, Math.max(minX, pos.x + vel.x));
      pos.y = Math.min(maxY, Math.max(minY, pos.y + vel.y));
    }

    // Hard-separation pass: enforce minimum spacing regardless of force solver drift.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const posA = positions.get(a.id)!;
        const posB = positions.get(b.id)!;
        let dx = posB.x - posA.x;
        let dy = posB.y - posA.y;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 0.001) {
          const seed = hashText(`${a.id}-${b.id}`);
          const theta = (seed % 360) * (Math.PI / 180);
          dx = Math.cos(theta);
          dy = Math.sin(theta);
          dist = 1;
        }

        if (dist < minDistance) {
          const overlap = (minDistance - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;

          posA.x = Math.min(maxX, Math.max(minX, posA.x - nx * overlap));
          posA.y = Math.min(maxY, Math.max(minY, posA.y - ny * overlap));
          posB.x = Math.min(maxX, Math.max(minX, posB.x + nx * overlap));
          posB.y = Math.min(maxY, Math.max(minY, posB.y + ny * overlap));
        }
      }
    }
  }

  return positions;
}

/* ── Rubrik helpers ──────────────────────────────────────────────────────────── */

const RUBRIK_OPTIONS = [
  { value: "", label: "— (keine)" },
  ...Array.from({ length: 15 }, (_, i) => {
    const n = i + 1;
    const code = `R${String(n).padStart(2, "0")}`;
    return { value: code, label: code };
  }),
  { value: "replacements", label: "Ersatzteile" },
  { value: "extra", label: "Extra" },
];

function displaySingleRubrik(raw: string): string {
  const num = parseRubrikNumber(raw);
  if (num !== null) return `R${String(num).padStart(2, "0")}`;
  const lo = raw.toLowerCase();
  if (lo === "replacement" || lo === "replacements") return "Ers.";
  if (lo === "extra" || lo === "extras") return "Ext.";
  return raw.slice(0, 4) || "—";
}

function displayRubrik(value: unknown): string {
  if (value == null || (typeof value === "string" && !value.trim())) return "—";
  if (Array.isArray(value) && value.length === 0) return "—";
  const values = normalizeRubrikValues(value);
  if (values.length > 0) return values.map(displaySingleRubrik).join(", ");
  const first = normalizeRubrikValue(value);
  return displaySingleRubrik(first) || "—";
}

/** Canonicalizes a rubrik value for set membership: numbered rubriks collapse
 * to "R01".."R15" regardless of input format, everything else is upper-cased. */
function canonicalRubrikValue(raw: string): string {
  const num = parseRubrikNumber(raw);
  return num !== null ? `R${String(num).padStart(2, "0")}` : raw.trim().toUpperCase();
}

export default function ProductPage() {
  const { t } = useLanguage();
  const params = useParams<{ id: string | string[] }>();
  const searchParams = useSearchParams();
  const rawId = params.id;

  const entryId = useMemo(() => {
    const value = Array.isArray(rawId) ? rawId[0] : rawId;
    return value?.trim() ? value : null;
  }, [rawId]);
  /* Only ever follow `from` if it's a same-origin relative path — it lands
     directly in an <a href>, so an unvalidated value (e.g. "javascript:…" or
     an absolute "https://evil.example" URL) would execute or redirect off-site
     the moment a user clicks the back button. A leading "/" not followed by
     another "/" (which would make it protocol-relative) is the only shape
     that's safe to trust. */
  const rawFromList = searchParams.get("from");
  const fromList = rawFromList && /^\/(?!\/)/.test(rawFromList) ? rawFromList : null;

  const [entry, setEntry] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ── favourites ── */
  const [authUser,    setAuthUser]    = useState<AuthUser | null>(null);
  const [isFavorited, setIsFavorited] = useState(false);
  const [favLoading,  setFavLoading]  = useState(true);
  const [favSaving,   setFavSaving]   = useState(false);
  const [rubrikEditing, setRubrikEditing] = useState(false);
  const [rubrikSaving,  setRubrikSaving]  = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [neighborRange, setNeighborRange] = useState<number>(() => {
    if (typeof window === "undefined") return NEIGHBOR_RANGE_DEFAULT;
    const saved = Number(window.localStorage.getItem(NEIGHBOR_RANGE_KEY));
    if (!Number.isFinite(saved)) return NEIGHBOR_RANGE_DEFAULT;
    return Math.min(NEIGHBOR_RANGE_MAX, Math.max(NEIGHBOR_RANGE_MIN, Math.round(saved)));
  });
  const [neighbors, setNeighbors] = useState<EntryNeighbors>({ before: [], after: [] });
  const [neighborsLoading, setNeighborsLoading] = useState(false);
  const variantsTrackRef = useRef<HTMLDivElement>(null);
  const variantsCurrentRef = useRef<HTMLDivElement>(null);
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [showRelationsGraph, setShowRelationsGraph] = useState(false);
  const [relationsZoom, setRelationsZoom] = useState(1);
  const [relationsPan, setRelationsPan] = useState({ x: 0, y: 0 });
  const [isDraggingRelations, setIsDraggingRelations] = useState(false);
  const [lastDragPoint, setLastDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [lastPinch, setLastPinch] = useState<{ dist: number } | null>(null);
  const relSvgRef      = useRef<SVGSVGElement>(null);
  const rubrikWrapRef  = useRef<HTMLDivElement>(null);
  /* documentIds whose view we've already counted this mount — guards against
     double-counting from re-renders and React StrictMode's double effect. */
  const viewedRef      = useRef<Set<string>>(new Set());
  const relTouchRef = useRef({
    onTouchStart: (_e: TouchEvent) => {},
    onTouchMove:  (_e: TouchEvent) => {},
    onTouchEnd:   (_e: TouchEvent) => {},
  });
  const [activeSection, setActiveSection] = useState<SectionType | null>(null);
  const [sectionTitle, setSectionTitle] = useState("");
  const [sectionDescription, setSectionDescription] = useState("");
  const [ticketLink, setTicketLink] = useState("");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [linkQuery, setLinkQuery] = useState("");
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [savingSection, setSavingSection] = useState(false);
  const [catalogEntries, setCatalogEntries] = useState<Entry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [linkedEntriesLookup, setLinkedEntriesLookup] = useState<Map<string, Entry>>(new Map());
  const [linkSearchResults, setLinkSearchResults] = useState<Entry[]>([]);
  const [linkSearchLoading, setLinkSearchLoading] = useState(false);
  const [linkConfidence, setLinkConfidence] = useState("");
  const [linkSource, setLinkSource] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkDesc, setLinkDesc] = useState("");
  const [relationsView, setRelationsView] = useState<"list" | "graph">("list");
  const [selectedRelationIndex, setSelectedRelationIndex] = useState<number | null>(null);
  const [docPreviewIndex, setDocPreviewIndex] = useState<number | null>(null);
  const [docPreviewAttachment, setDocPreviewAttachment] = useState(0);
  const [issuePreviewIndex, setIssuePreviewIndex] = useState<number | null>(null);
  const [inheritedIssuePreviewIndex, setInheritedIssuePreviewIndex] = useState<number | null>(null);
  const [ticketPreviewIndex, setTicketPreviewIndex] = useState<number | null>(null);
  const [resolvedAttachmentMedia, setResolvedAttachmentMedia] = useState<Map<number, { id: number; name?: string; url: string }>>(new Map());
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [savingTag, setSavingTag] = useState(false);
  const [votingLinkId, setVotingLinkId] = useState<string | null>(null);
  const [voteReason, setVoteReason] = useState("");
  const [showVoteReason, setShowVoteReason] = useState(false);
  const [pendingVote, setPendingVote] = useState<1 | -1 | null>(null);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const imageUploadInputRef = useRef<HTMLInputElement>(null);

  const imageList = useMemo(() => entry?.pictureUrls ?? [], [entry?.pictureUrls]);

  const safeImageIndex = Math.min(imageIndex, Math.max(imageList.length - 1, 0));

  const tags = useMemo(() => {
    if (!entry?.tags) return [];
    try {
      // Try parsing as JSON array first
      const parsed = JSON.parse(entry.tags);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      // Fall back to comma/newline separated format
    }
    return entry.tags
      .split(/[,\n]/)
      .map((item: string) => item.trim())
      .filter(Boolean);
  }, [entry?.tags]);

  const issues = useMemo(() => parseTextEntries(entry?.issues), [entry?.issues]);
  const docsEntries = useMemo(() => parseTextEntries(entry?.docs), [entry?.docs]);
  const ticketsEntries = useMemo(() => parseTextEntries(entry?.tickets), [entry?.tickets]);
  const linkEntries = useMemo(() => parseLinkEntries(entry?.links), [entry?.links]);

  /* ── Inherited problems ──────────────────────────────────────────────────
     A problem on a product should surface on the products directly linked to
     it. We only look at the products this entry links to (linkedEntriesLookup
     already holds their full data, issues included) — never transitively — so
     a problem travels exactly one hop along the relation chain. Because links
     are stored bidirectionally, this covers both the "up" and "down" direction
     of a chain. These entries are read-only here; they belong to their source
     product and are edited there. */
  const inheritedIssues = useMemo(() => {
    if (!entry) return [];
    const currentId = entry.documentId;
    const seenSources = new Set<string>();
    const result: Array<{
      key: string;
      issue: TextEntry;
      sourceId: string;
      sourceTitle: string;
      sourceArtNr?: string;
    }> = [];

    for (const link of linkEntries) {
      const source = linkedEntriesLookup.get(link.id);
      if (!source || source.documentId === currentId) continue;
      if (seenSources.has(source.documentId)) continue;
      seenSources.add(source.documentId);

      parseTextEntries(source.issues).forEach((issue, idx) => {
        result.push({
          key: `${source.documentId}-${idx}`,
          issue,
          sourceId: source.documentId,
          sourceTitle: source.title,
          sourceArtNr: source.artNr,
        });
      });
    }

    return result;
  }, [entry, linkEntries, linkedEntriesLookup]);

  const igsStructured = useMemo(() => {
    const raw = entry?.igs;
    if (!raw?.trim()) return null;
    const get = (candidates: string[]) => getIgsFieldValue(raw, candidates) ?? "";
    const entries = parseIgsEntries(raw);
    const infoEntry = entries?.find((e) => e.name.toLowerCase() === "info");
    const dsuValues: string[] = [];
    if (infoEntry && Array.isArray(infoEntry.value)) {
      for (const dsu of infoEntry.value as Array<{ name: string; value: unknown }>) {
        dsuValues.push(typeof dsu.value === "string" ? dsu.value.trim() : String(dsu.value ?? "").trim());
      }
    }
    while (dsuValues.length < 6) dsuValues.push("");
    return {
      bez1: get(["Bezeichnung 1", "C"]),
      bez2: get(["Bezeichnung 2", "D"]),
      bez3: get(["Bezeichnung 3", "IR"]),
      bez4: get(["Bezeichnung 4", "IS"]),
      kurztext: get(["Kurztext", "BY"]),
      land: get(["Ursprungsland", "P"]),
      auslauf: get(["Auslaufart", "R"]),
      rubrik: get(["Rubrik"]),
      dsu: dsuValues.slice(0, 6),
    };
  }, [entry?.igs]);
  const igsContent = useMemo(() => {
    const raw = entry?.igs?.trim();
    if (!raw) {
      return null;
    }

    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [entry?.igs]);
  const miscFileById = useMemo(() => {
    const map = new Map<number, { id: number; name?: string; url: string }>();
    for (const item of entry?.miscFiles ?? []) {
      map.set(item.id, item);
    }
    return map;
  }, [entry?.miscFiles]);

  const attachmentMediaById = useMemo(() => {
    const map = new Map<number, { id: number; name?: string; url: string }>(miscFileById);
    for (const [id, media] of resolvedAttachmentMedia.entries()) {
      if (!map.has(id)) {
        map.set(id, media);
      }
    }
    return map;
  }, [miscFileById, resolvedAttachmentMedia]);

  useEffect(() => {
    async function resolveMissingAttachmentMedia() {
      const allSections = [...issues, ...docsEntries, ...ticketsEntries, ...inheritedIssues.map((i) => i.issue)];
      const ids = Array.from(
        new Set(
          allSections
            .flatMap((item) => item.attachments ?? [])
            .map((value) => Number(value))
            .filter((value) => !Number.isNaN(value) && value > 0)
        )
      );

      const missingIds = ids.filter(
        (id) => !miscFileById.has(id) && !resolvedAttachmentMedia.has(id)
      );

      if (missingIds.length === 0) {
        return;
      }

      const resolved = await Promise.all(missingIds.map((id) => getMediaById(id)));
      setResolvedAttachmentMedia((current) => {
        const next = new Map(current);
        for (const media of resolved) {
          if (media) {
            next.set(media.id, media);
          }
        }
        return next;
      });
    }

    void resolveMissingAttachmentMedia();
  }, [issues, docsEntries, ticketsEntries, inheritedIssues, miscFileById, resolvedAttachmentMedia]);

  useEffect(() => {
    async function loadEntry() {
      if (!entryId) {
        setError(t.page.invalidPageId);
        setLoading(false);
        return;
      }

      try {
        setError(null);
        const data = await getEntryById(entryId);
        setEntry(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : t.page.failedToLoadPage;
        setError(message);
      } finally {
        setLoading(false);
      }
    }

    void loadEntry();
  }, [entryId, t.page.failedToLoadPage, t.page.invalidPageId]);

  /* ── Record a page view once the entry has loaded ────────────────────────
     Fires one increment per documentId per mount. Keyed on the resolved
     documentId (not the URL param, which may be a numeric id) so the counter
     store is consistent with what the admin Page Views tab joins against.
     Fire-and-forget: a failed view write must never disturb the page. */
  useEffect(() => {
    const docId = entry?.documentId;
    if (!docId || viewedRef.current.has(docId)) return;
    viewedRef.current.add(docId);
    void fetch(`/api/entries/${encodeURIComponent(docId)}/view`, {
      method: "POST",
      keepalive: true,
    }).catch(() => {});
  }, [entry?.documentId]);

  /* ── artNr neighbours (variants & replacement parts) ── */
  useEffect(() => {
    const artNr = entry?.artNr?.trim();
    if (!artNr) {
      setNeighbors({ before: [], after: [] });
      setNeighborsLoading(false);
      return;
    }

    let cancelled = false;
    setNeighborsLoading(true);

    void getArtNrNeighbors(artNr, neighborRange)
      .then((result) => {
        if (!cancelled) setNeighbors(result);
      })
      .catch(() => {
        if (!cancelled) setNeighbors({ before: [], after: [] });
      })
      .finally(() => {
        if (!cancelled) setNeighborsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [entry?.artNr, neighborRange]);

  /* Keep the current item centred in the horizontal variants strip. */
  useEffect(() => {
    const track = variantsTrackRef.current;
    const current = variantsCurrentRef.current;
    if (!track || !current) return;
    track.scrollLeft = current.offsetLeft - track.clientWidth / 2 + current.clientWidth / 2;
  }, [neighbors, entry?.documentId]);

  /* Mouse-wheel over the strip scrolls it horizontally. Uses a native
     non-passive listener so we can preventDefault the vertical page scroll. */
  useEffect(() => {
    const track = variantsTrackRef.current;
    if (!track) return;
    const onWheel = (e: WheelEvent) => {
      if (track.scrollWidth <= track.clientWidth) return;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      e.preventDefault();
      track.scrollLeft += delta;
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [entry?.artNr]);

  /* Persist the chosen range so it survives reloads. */
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(NEIGHBOR_RANGE_KEY, String(neighborRange));
    }
  }, [neighborRange]);

  /* Reset to the first attachment whenever a different document opens. */
  useEffect(() => {
    setDocPreviewAttachment(0);
  }, [docPreviewIndex]);

  function renderVariantThumb(url?: string) {
    if (url && !failedImages.has(url)) {
      return (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailedImages((prev) => new Set([...prev, url]))}
        />
      );
    }
    return <span className="wiki-variant-thumb-empty" aria-hidden="true" />;
  }

  function variantInfo(item: Entry): string | null {
    const desc = item.desc?.trim();
    if (desc) return desc;
    if (item.EAN?.trim()) return `EAN ${item.EAN.trim()}`;
    return null;
  }

  function renderVariantCard(item: Entry) {
    const info = variantInfo(item);
    return (
      <Link key={item.documentId} href={`/products/${item.documentId}`} className="wiki-variant-card">
        <span className="wiki-variant-card-thumb">{renderVariantThumb(item.pictureUrls?.[0])}</span>
        <span className="wiki-variant-card-artnr">{item.artNr ?? "—"}</span>
        <span className="wiki-variant-card-title">{item.title}</span>
        {info && <span className="wiki-variant-card-info">{info}</span>}
      </Link>
    );
  }

  /* ── auth + favourites ── */
  useEffect(() => {
    async function checkFavourite() {
      try {
        const meRes = await fetch("/api/auth/me");
        if (!meRes.ok) { setFavLoading(false); return; }
        const meData = (await meRes.json()) as { user: AuthUser | null };
        const user = meData.user;
        setAuthUser(user);
        if (!user || !entryId) { setFavLoading(false); return; }

        const favRes = await fetch("/api/auth/favorites");
        if (favRes.ok) {
          const favData = (await favRes.json()) as { favorites: string[] };
          setIsFavorited(favData.favorites.includes(entryId));
        }
      } catch {
        /* not logged in or network error — silently ignore */
      } finally {
        setFavLoading(false);
      }
    }
    void checkFavourite();
  }, [entryId]);

  async function handleToggleFavorite() {
    if (!authUser || !entryId || favSaving) return;
    const next = !isFavorited;
    setIsFavorited(next);           // optimistic update
    setFavSaving(true);
    try {
      const res = await fetch("/api/auth/favorites", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ entryId, star: next }),
      });
      if (!res.ok) setIsFavorited(!next); // revert on failure
    } catch {
      setIsFavorited(!next);              // revert on error
    } finally {
      setFavSaving(false);
    }
  }

  async function handleToggleRubrik(value: string) {
    if (!entry || !entryId || rubrikSaving) return;
    let nextRubriks: string[];
    if (!value) {
      nextRubriks = [];
    } else {
      // Toggle within the full current set of assigned rubriks (numbered and
      // non-numbered alike) so picking one category never wipes out the others.
      const canonical = canonicalRubrikValue(value);
      const currentCanonical = normalizeRubrikValues(entry.rubrik).map(canonicalRubrikValue);
      nextRubriks = currentCanonical.includes(canonical)
        ? currentCanonical.filter((v) => v !== canonical)
        : [...currentCanonical, canonical];
    }
    setRubrikSaving(true);
    try {
      // Mirror the rubrik into the IGS blob so the IGS view reflects the change.
      // Use the friendly labels (R01…, Ers., Ext.), or "N.K." when uncategorized.
      // setIgsFieldValue returns null when there is no IGS data, leaving it untouched.
      const rubrikText =
        nextRubriks.length === 0
          ? "N.K. (Nicht kategorisiert)"
          : nextRubriks.map(displaySingleRubrik).join(", ");
      const nextIgs = setIgsFieldValue(entry.igs, "Rubrik", rubrikText);
      const fullPayload = buildEntryPayload(entry, {
        rubrik: nextRubriks,
        ...(nextIgs !== null ? { igs: nextIgs } : {}),
      });
      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fullPayload, _auditSection: "rubrik", _auditAction: "update" }),
      });
      if (res.ok) {
        const updated = (await res.json()) as Entry;
        setEntry(updated);
      } else {
        console.error("rubrik update failed", res.status, await res.text());
      }
    } catch (err) {
      console.error("rubrik update error", err);
    } finally {
      setRubrikSaving(false);
    }
  }

  useEffect(() => {
    if (!rubrikEditing) return;
    function handleOutside(e: MouseEvent) {
      if (rubrikWrapRef.current && !rubrikWrapRef.current.contains(e.target as Node)) {
        setRubrikEditing(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [rubrikEditing]);

  useEffect(() => {
    async function loadLinkedEntries() {
      if (linkEntries.length === 0) {
        setLinkedEntriesLookup(new Map());
        return;
      }

      const uniqueIds = Array.from(new Set(linkEntries.map((e) => e.id)));
      const resolved = await Promise.all(uniqueIds.map((id) => getEntryById(id)));
      const lookup = new Map<string, Entry>();

      for (let i = 0; i < uniqueIds.length; i++) {
        const requestedId = uniqueIds[i]!;
        const linkedEntry = resolved[i];
        if (!linkedEntry) {
          continue;
        }

        lookup.set(requestedId, linkedEntry);
        lookup.set(linkedEntry.documentId, linkedEntry);
        lookup.set(String(linkedEntry.id), linkedEntry);
      }

      setLinkedEntriesLookup(lookup);
    }

    void loadLinkedEntries();
  }, [linkEntries]);

  useEffect(() => {
    const needsCatalog = showRelationsGraph;
    if (!needsCatalog || catalogEntries.length > 0 || catalogLoading) {
      return;
    }

    let cancelled = false;
    setCatalogLoading(true);

    void listEntries()
      .then((data) => {
        if (!cancelled) {
          setCatalogEntries(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogEntries([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCatalogLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, showRelationsGraph, catalogEntries.length, catalogLoading]);

  useEffect(() => {
    if (activeSection !== "links") {
      setLinkSearchResults([]);
      setLinkSearchLoading(false);
      return;
    }

    const query = linkQuery.trim();
    if (!query) {
      setLinkSearchResults([]);
      setLinkSearchLoading(false);
      return;
    }

    let cancelled = false;
    setLinkSearchLoading(true);

    void searchEntries(query, 24)
      .then((results) => {
        if (cancelled) {
          return;
        }

        const filtered = entryId
          ? results.filter((catalogEntry) => catalogEntry.documentId !== entryId)
          : results;
        setLinkSearchResults(filtered);
      })
      .catch(() => {
        if (!cancelled) {
          setLinkSearchResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkSearchLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, entryId, linkQuery]);

  const linkResults = useMemo(() => {
    const query = linkQuery.trim().toLowerCase();
    const source = query ? linkSearchResults : catalogEntries;

    return source
      .filter((catalogEntry) => catalogEntry.documentId !== entryId)
      .filter((catalogEntry) => {
        if (!query) {
          return true;
        }

        const text = `${catalogEntry.title} ${catalogEntry.artNr ?? ""} ${catalogEntry.EAN ?? ""} ${catalogEntry.documentId} ${catalogEntry.id}`.toLowerCase();
        return text.includes(query);
      })
      .slice(0, 12);
  }, [catalogEntries, entryId, linkQuery, linkSearchResults]);

  const relationsGraph = useMemo(() => {
    if (!entry) {
      return {
        nodes: [] as RelationsGraphNode[],
        edges: [] as RelationsGraphEdge[],
      };
    }

    const allKnownEntries = new Map<string, Entry>();
    const numericIdToDocumentId = new Map<string, string>();
    for (const catalogEntry of catalogEntries) {
      allKnownEntries.set(catalogEntry.documentId, catalogEntry);
      numericIdToDocumentId.set(String(catalogEntry.id), catalogEntry.documentId);
    }
    for (const linkedEntry of linkedEntriesLookup.values()) {
      allKnownEntries.set(linkedEntry.documentId, linkedEntry);
      numericIdToDocumentId.set(String(linkedEntry.id), linkedEntry.documentId);
    }
    allKnownEntries.set(entry.documentId, entry);
    numericIdToDocumentId.set(String(entry.id), entry.documentId);

    const resolveLinkId = (raw: string): string => {
      if (allKnownEntries.has(raw)) {
        return raw;
      }
      return numericIdToDocumentId.get(raw) ?? raw;
    };

    const adjacency = new Map<string, Set<string>>();
    const ensureAdjacency = (id: string) => {
      if (!adjacency.has(id)) {
        adjacency.set(id, new Set());
      }
      return adjacency.get(id)!;
    };

    for (const currentEntry of allKnownEntries.values()) {
      const source = currentEntry.documentId;
      const linked = parseLinkEntries(currentEntry.links)
        .map((e) => resolveLinkId(e.id))
        .filter(Boolean)
        .filter((target) => target !== source);

      for (const target of linked) {
        ensureAdjacency(source).add(target);
        ensureAdjacency(target).add(source);
      }
    }

    const currentId = entry.documentId;
    const visited = new Set<string>([currentId]);
    const queue: string[] = [currentId];

    while (queue.length > 0) {
      const source = queue.shift()!;
      const neighbors = adjacency.get(source);
      if (!neighbors) {
        continue;
      }

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const nodes: RelationsGraphNode[] = Array.from(visited).map((nodeId) => {
      const known = allKnownEntries.get(nodeId);
      return {
        id: nodeId,
        title: known?.title ?? nodeId,
        subTitle: known?.artNr ?? nodeId,
        imageUrl: known?.pictureUrls?.[0],
        isCurrent: nodeId === currentId,
        isKnown: Boolean(known),
      };
    });

    const nodeSet = new Set(nodes.map((node) => node.id));
    const edgeSet = new Set<string>();
    const edges: RelationsGraphEdge[] = [];

    for (const source of nodeSet) {
      const neighbors = adjacency.get(source);
      if (!neighbors) {
        continue;
      }

      for (const target of neighbors) {
        if (!nodeSet.has(target)) {
          continue;
        }

        const key = edgeKey(source, target);
        if (edgeSet.has(key)) {
          continue;
        }

        edgeSet.add(key);
        edges.push({ source, target });
      }
    }

    return { nodes, edges };
  }, [catalogEntries, entry, linkEntries, linkedEntriesLookup]);

  const relationsViewport = useMemo(() => {
    const nodeCount = Math.max(relationsGraph.nodes.length, 1);
    const aspect = 980 / 620;
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodeCount * aspect)));
    const rows = Math.max(1, Math.ceil(nodeCount / cols));

    const minWidth = 980;
    const minHeight = 620;
    const width = Math.max(minWidth, cols * REL_MIN_NODE_DISTANCE + REL_LAYOUT_PADDING * 2);
    const height = Math.max(minHeight, rows * REL_MIN_NODE_DISTANCE + REL_LAYOUT_PADDING * 2);

    return { width, height };
  }, [relationsGraph.nodes.length]);

  const relationsLayout = useMemo(
    () =>
      buildGraphLayout(
        relationsGraph.nodes,
        relationsGraph.edges,
        relationsViewport.width,
        relationsViewport.height,
        REL_MIN_NODE_DISTANCE
      ),
    [relationsGraph, relationsViewport]
  );

  useEffect(() => {
    if (!showRelationsGraph) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [showRelationsGraph]);

  /* ── Touch handler bodies – updated every render so they always capture  */
  /* the latest state values (isDraggingRelations, lastDragPoint, etc.).    */
  relTouchRef.current.onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      setLastPinch(null);
      setIsDraggingRelations(true);
      setLastDragPoint({ x: e.touches[0]!.clientX, y: e.touches[0]!.clientY });
    } else if (e.touches.length >= 2) {
      setIsDraggingRelations(false);
      setLastDragPoint(null);
      const t0 = e.touches[0]!, t1 = e.touches[1]!;
      setLastPinch({ dist: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY) });
    }
  };

  relTouchRef.current.onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    const svgEl = relSvgRef.current;
    if (!svgEl) return;
    const bounds = svgEl.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    if (e.touches.length === 1 && isDraggingRelations && lastDragPoint) {
      const t = e.touches[0]!;
      const dx = t.clientX - lastDragPoint.x;
      const dy = t.clientY - lastDragPoint.y;
      setRelationsPan((p) => ({
        x: p.x + (dx / bounds.width)  * relationsViewport.width,
        y: p.y + (dy / bounds.height) * relationsViewport.height,
      }));
      setLastDragPoint({ x: t.clientX, y: t.clientY });
    } else if (e.touches.length >= 2 && lastPinch) {
      const t0 = e.touches[0]!, t1 = e.touches[1]!;
      const newDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const factor  = newDist / lastPinch.dist;
      const midX    = (t0.clientX + t1.clientX) / 2;
      const midY    = (t0.clientY + t1.clientY) / 2;
      const cursorX = ((midX - bounds.left) / bounds.width)  * relationsViewport.width;
      const cursorY = ((midY - bounds.top)  / bounds.height) * relationsViewport.height;
      setRelationsZoom((current) => {
        const next = Math.min(2.8, Math.max(0.45, current * factor));
        setRelationsPan((pan) => {
          const worldX = (cursorX - pan.x) / current;
          const worldY = (cursorY - pan.y) / current;
          return { x: cursorX - worldX * next, y: cursorY - worldY * next };
        });
        return next;
      });
      setLastPinch({ dist: newDist });
    }
  };

  relTouchRef.current.onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length === 0) {
      setIsDraggingRelations(false);
      setLastDragPoint(null);
      setLastPinch(null);
    } else if (e.touches.length === 1) {
      setLastPinch(null);
      setLastDragPoint({ x: e.touches[0]!.clientX, y: e.touches[0]!.clientY });
    }
  };

  /* ── Attach non-passive touch listeners to the SVG ──────────────────── */
  useEffect(() => {
    if (!showRelationsGraph) return;
    const svg = relSvgRef.current;
    if (!svg) return;

    const handleStart  = (e: TouchEvent) => relTouchRef.current.onTouchStart(e);
    const handleMove   = (e: TouchEvent) => relTouchRef.current.onTouchMove(e);
    const handleEnd    = (e: TouchEvent) => relTouchRef.current.onTouchEnd(e);

    svg.addEventListener("touchstart",  handleStart, { passive: false });
    svg.addEventListener("touchmove",   handleMove,  { passive: false });
    svg.addEventListener("touchend",    handleEnd);
    svg.addEventListener("touchcancel", handleEnd);

    return () => {
      svg.removeEventListener("touchstart",  handleStart);
      svg.removeEventListener("touchmove",   handleMove);
      svg.removeEventListener("touchend",    handleEnd);
      svg.removeEventListener("touchcancel", handleEnd);
    };
  }, [showRelationsGraph]); // eslint-disable-line react-hooks/exhaustive-deps

  function openRelationsGraph() {
    setRelationsZoom(1);
    setRelationsPan({ x: 0, y: 0 });
    setIsDraggingRelations(false);
    setLastDragPoint(null);
    setLastPinch(null);
    setRelationsView("list");
    setShowRelationsGraph(true);
  }

  function closeRelationsGraph() {
    setShowRelationsGraph(false);
    setIsDraggingRelations(false);
    setLastDragPoint(null);
    setLastPinch(null);
  }

  function onRelationsWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const cursorX = ((event.clientX - bounds.left) / bounds.width) * relationsViewport.width;
    const cursorY = ((event.clientY - bounds.top) / bounds.height) * relationsViewport.height;

    setRelationsZoom((current) => {
      const factor = event.deltaY < 0 ? 1.12 : 0.88;
      const next = Math.min(2.8, Math.max(0.45, current * factor));

      setRelationsPan((pan) => {
        const worldX = (cursorX - pan.x) / current;
        const worldY = (cursorY - pan.y) / current;
        return {
          x: cursorX - worldX * next,
          y: cursorY - worldY * next,
        };
      });

      return next;
    });
  }

  function onRelationsMouseDown(event: ReactMouseEvent<SVGSVGElement>) {
    setIsDraggingRelations(true);
    setLastDragPoint({ x: event.clientX, y: event.clientY });
  }

  function onRelationsMouseMove(event: ReactMouseEvent<SVGSVGElement>) {
    if (!isDraggingRelations || !lastDragPoint) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const dx = event.clientX - lastDragPoint.x;
    const dy = event.clientY - lastDragPoint.y;
    const dxGraph = (dx / bounds.width) * relationsViewport.width;
    const dyGraph = (dy / bounds.height) * relationsViewport.height;
    setRelationsPan((current) => ({ x: current.x + dxGraph, y: current.y + dyGraph }));
    setLastDragPoint({ x: event.clientX, y: event.clientY });
  }

  function onRelationsMouseUp() {
    setIsDraggingRelations(false);
    setLastDragPoint(null);
  }

  function resetRelationsView() {
    setRelationsZoom(1);
    setRelationsPan({ x: 0, y: 0 });
  }

  function closeSectionEditor() {
    setActiveSection(null);
    setEditingIndex(null);
    setSectionError(null);
    setLinkConfidence("");
    setLinkSource("");
    setLinkUrl("");
    setLinkDesc("");
  }

  function openSectionEditor(section: SectionType, index: number | null = null) {
    setActiveSection(section);
    setEditingIndex(index);
    setSectionError(null);
    const isEditing = index !== null;

    if (section === "links") {
      const existingEntry = isEditing ? linkEntries[index] ?? null : null;
      setSectionTitle("");
      setSectionDescription("");
      setTicketLink("");
      setSelectedLinkId(existingEntry?.id ?? null);
      setLinkConfidence(existingEntry?.confidence !== undefined ? String(Math.round(existingEntry.confidence * 100)) : "");
      setLinkSource(existingEntry?.source ?? "");
      setLinkUrl(existingEntry?.link ?? "");
      setLinkDesc(existingEntry?.desc ?? "");
    } else {
      const existingEntries =
        section === "issues"
          ? issues
          : section === "docs"
            ? docsEntries
            : ticketsEntries;
      const current = isEditing ? existingEntries[index] : null;
      setSectionTitle(current?.title ?? "");
      setSectionDescription(current?.description ?? "");
      setTicketLink(current?.link ?? "");
      setSelectedLinkId(null);
    }

    setAttachmentFiles([]);
    setLinkQuery("");
  }

  async function handleDeleteSectionEntry(section: SectionType, index: number) {
    if (!entry || !entryId) {
      return;
    }

    try {
      setSavingSection(true);
      setSectionError(null);

      let updatedPayload: Partial<EntryPayload> = {};

      if (section === "links") {
        const entryToRemove = linkEntries[index];
        const idToRemove = entryToRemove?.id;
        const nextLinks = serializeLinkEntries(linkEntries.filter((_, i) => i !== index));
        updatedPayload = { links: nextLinks };

        if (idToRemove) {
          try {
            const linkedProduct = await getEntryById(idToRemove);
            if (linkedProduct) {
              const linkedProductLinks = parseLinkEntries(linkedProduct.links);
              if (linkedProductLinks.some((e) => e.id === entryId)) {
                const backwardLinks = serializeLinkEntries(
                  linkedProductLinks.filter((e) => e.id !== entryId)
                );
                const backPayload = buildEntryPayload(linkedProduct, { links: backwardLinks });
                await fetch(`/api/entries/${encodeURIComponent(idToRemove)}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ ...backPayload, _auditSection: "links", _auditAction: "delete" }),
                });
              }
            }
          } catch (backLinkError) {
            console.error("Failed to remove backward link:", backLinkError);
          }
        }
      } else {
        const existingEntries =
          section === "issues" ? issues : section === "docs" ? docsEntries : ticketsEntries;
        const nextTextEntries = serializeTextEntries(existingEntries.filter((_, i) => i !== index));
        updatedPayload =
          section === "issues"
            ? { issues: nextTextEntries }
            : section === "docs"
              ? { docs: nextTextEntries }
              : { tickets: nextTextEntries };
      }

      const fullPayload = buildEntryPayload(entry, updatedPayload);
      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fullPayload, _auditSection: section, _auditAction: "delete" }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? t.page.failedToSaveIssue);
      }

      const updated = (await res.json()) as Entry;
      setEntry(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : t.page.failedToSaveIssue;
      setSectionError(message);
    } finally {
      setSavingSection(false);
    }
  }

  async function handleAddTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = newTag.trim();
    if (!value || !entry || !entryId || savingTag) return;
    // Ignore duplicates (case-insensitive).
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setNewTag("");
      return;
    }

    try {
      setSavingTag(true);
      const nextTags = [...tags, value];
      const fullPayload = buildEntryPayload(entry, { tags: JSON.stringify(nextTags) });
      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fullPayload, _auditSection: "tags", _auditAction: "update" }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to add tag.");
      }
      const updated = (await res.json()) as Entry;
      setEntry(updated);
      setNewTag("");
      // Keep the input open so several tags can be added in a row.
    } catch (err) {
      console.error("[handleAddTag] Failed to add tag:", err);
    } finally {
      setSavingTag(false);
    }
  }

  async function handleAddImages(files: File[]) {
    if (files.length === 0 || !entry || !entryId || uploadingImages) return;

    try {
      setUploadingImages(true);
      setImageUploadError(null);
      const uploadedIds = await uploadMedia(files);
      const existingIds = toMediaIds(entry.pictures) ?? [];
      const mergedIds = Array.from(new Set([...existingIds, ...uploadedIds]));
      const fullPayload = buildEntryPayload(entry, { pictures: mergedIds });
      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fullPayload, _auditSection: "images" }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to upload images.");
      }
      const updated = (await res.json()) as Entry;
      setEntry(updated);
      setImageIndex(existingIds.length); // jump to the first newly added image
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to upload images.";
      setImageUploadError(message);
    } finally {
      setUploadingImages(false);
    }
  }

  async function castVote(targetId: string, vote: 1 | -1 | 0, reason?: string) {
    if (!entryId || votingLinkId) return;
    setVotingLinkId(targetId);
    try {
      await fetch("/api/entries/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId, targetId, vote, reason: reason?.trim() || undefined }),
      });
      // Refresh the entry to get updated votes
      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`);
      if (res.ok) {
        const updated = (await res.json()) as Entry;
        setEntry(updated);
      }
    } finally {
      setVotingLinkId(null);
    }
  }

  async function handleSectionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!entry || !entryId || !activeSection) {
      return;
    }

    try {
      setSavingSection(true);
      setSectionError(null);

      let updatedPayload: Partial<EntryPayload> = {};

      if (activeSection === "links") {
        if (!selectedLinkId) {
          setSectionError(t.page.linkSelectionRequired);
          return;
        }

        const confidenceVal =
          linkConfidence.trim() !== ""
            ? Math.min(1, Math.max(0, Number(linkConfidence) / 100))
            : undefined;
        const sourceVal = linkSource.trim() || undefined;
        const newLinkEntry: LinkEntry = {
          id: selectedLinkId,
          ...(confidenceVal !== undefined && { confidence: confidenceVal }),
          ...(sourceVal && { source: sourceVal }),
          ...(linkUrl.trim() && { link: linkUrl.trim() }),
          ...(linkDesc.trim() && { desc: linkDesc.trim() }),
        };

        const nextLinkValues = [...linkEntries];
        if (editingIndex !== null) {
          nextLinkValues[editingIndex] = newLinkEntry;
        } else {
          nextLinkValues.push(newLinkEntry);
        }

        const seenIds = new Set<string>();
        const deduped = nextLinkValues.filter((e) => {
          if (seenIds.has(e.id)) return false;
          seenIds.add(e.id);
          return true;
        });

        const nextLinks = serializeLinkEntries(deduped);
        updatedPayload = { links: nextLinks };

        // Add bidirectional link: also update the linked product to link back to this one
        try {
          const linkedProduct = await getEntryById(selectedLinkId);
          if (linkedProduct) {
            const linkedProductLinks = parseLinkEntries(linkedProduct.links);
            if (!linkedProductLinks.some((e) => e.id === entryId)) {
              const backwardLinks = serializeLinkEntries(
                [...linkedProductLinks.filter((e) => e.id !== entryId), { id: entryId! }]
              );
              const backPayload = buildEntryPayload(linkedProduct, { links: backwardLinks });
              await fetch(`/api/entries/${encodeURIComponent(selectedLinkId)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...backPayload, _auditSection: "links" }),
              });
            }
          }
        } catch (backLinkError) {
          // Log but don't fail the forward link if backward link fails
          console.error("Failed to create backward link:", backLinkError);
        }
      } else {
        if (!sectionTitle.trim()) {
          setSectionError(t.form.titleRequired);
          return;
        }

        const existingEntries =
          activeSection === "issues"
            ? issues
            : activeSection === "docs"
              ? docsEntries
              : ticketsEntries;

        const existingAttachments =
          editingIndex !== null ? existingEntries[editingIndex]?.attachments ?? [] : [];
        let uploadedAttachmentIds: number[] = [];
        if (attachmentFiles.length > 0) {
          uploadedAttachmentIds = await uploadMedia(attachmentFiles);
        }

        const mergedAttachmentIds = Array.from(
          new Set([
            ...existingAttachments.map((value) => Number(value)).filter((value) => !Number.isNaN(value)),
            ...uploadedAttachmentIds,
          ])
        );

        const newEntry: TextEntry = {
          title: sectionTitle.trim(),
          description: sectionDescription.trim(),
          link:
            activeSection === "tickets" || activeSection === "docs"
              ? ticketLink.trim() || undefined
              : undefined,
          attachments: mergedAttachmentIds,
        };

        const nextEntries =
          editingIndex !== null
            ? existingEntries.map((item, index) => (index === editingIndex ? newEntry : item))
            : [...existingEntries, newEntry];

        const nextTextEntries = serializeTextEntries(nextEntries);

        updatedPayload =
          activeSection === "issues"
            ? { issues: nextTextEntries }
            : activeSection === "docs"
              ? { docs: nextTextEntries }
              : { tickets: nextTextEntries };

        if (uploadedAttachmentIds.length > 0) {
          const existingMiscIds = (entry.miscFiles ?? []).map((item) => item.id);
          updatedPayload.miscFile = Array.from(new Set([...existingMiscIds, ...uploadedAttachmentIds]));
        }
      }

      const fullPayload = buildEntryPayload(entry, updatedPayload);
      const auditAction = editingIndex !== null ? "update" : "create";
      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fullPayload, _auditSection: activeSection, _auditAction: auditAction }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? t.page.failedToSaveIssue);
      }

      const updated = (await res.json()) as Entry;
      setEntry(updated);
      closeSectionEditor();
    } catch (err) {
      const message = err instanceof Error ? err.message : t.page.failedToSaveIssue;
      console.error("Section save error:", err);
      setSectionError(message);
    } finally {
      setSavingSection(false);
    }
  }

  return (
    <main className="wiki-shell">
      <TopBar
        actions={[
          { href: fromList ?? "/products/all", label: t.nav.back, isBack: true },
          { href: "/", label: t.nav.home },
          ...(entryId
            ? [{ href: `/products/${entryId}/edit`, label: t.nav.editThisPage, adminOnly: true }]
            : []),
        ]}
      />

      <article className="wiki-card">
        {loading && <p className="wiki-muted">{t.page.loadingArticle}</p>}
        {error && <p className="wiki-error">{error}</p>}

        {!loading && !error && !entry && (
          <p className="wiki-muted">{t.page.articleNotFound}</p>
        )}

        {!loading && !error && entry && (
          <>
            <div className="wiki-detail-grid">
              <div className="wiki-info-card wiki-detail-name">
                <div className="wiki-detail-name-shell">
                  <div className="wiki-detail-name-main">
                <div className="wiki-name-header-row">
                  <span className="wiki-info-label">{t.listing.nameLabel}</span>
                </div>
                <span className="wiki-info-value wiki-info-value-name">{entry.title}</span>
                <div className="wiki-name-meta-row">
                  <div className="wiki-info-field compact">
                    <span className="wiki-info-label">{t.page.artNr}</span>
                    <span className="wiki-info-value" title={entry.artNr ?? "-"}>{entry.artNr ?? "-"}</span>
                  </div>
                  <div className="wiki-info-field compact">
                    <span className="wiki-info-label">{t.page.ean}</span>
                    <span className="wiki-info-value" title={entry.EAN ?? "-"}>{entry.EAN ?? "-"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span className="wiki-info-label">{t.page.tags}</span>
                  {authUser?.trusted && (
                    <button
                      type="button"
                      className="wiki-section-trigger"
                      onClick={() => setAddingTag((open) => !open)}
                      aria-label={t.page.addTag}
                      title={t.page.addTag}
                    >
                      <Image
                        src={SECTION_ADD_ICON}
                        alt=""
                        aria-hidden="true"
                        width={SECTION_ADD_ICON_SIZE}
                        height={SECTION_ADD_ICON_SIZE}
                        style={{ transform: `translateY(-${SECTION_ADD_ICON_OFFSET_Y}px)` }}
                      />
                    </button>
                  )}
                </div>
                <div className="wiki-tags-wrap">
                  {tags.length > 0 ? (
                    tags.map((tag) => (
                      <span key={tag} className="wiki-tag-pill">
                        {tag}
                      </span>
                    ))
                  ) : (
                    !addingTag && <span className="wiki-muted">{t.page.noTags}</span>
                  )}
                  {addingTag && authUser?.trusted && (
                    <form
                      onSubmit={handleAddTag}
                      style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}
                    >
                      <input
                        type="text"
                        value={newTag}
                        onChange={(e) => setNewTag(e.target.value)}
                        placeholder={t.page.newTagPlaceholder}
                        autoFocus
                        disabled={savingTag}
                        style={{
                          fontSize: "0.78rem",
                          padding: "0.18rem 0.55rem",
                          borderRadius: "999px",
                          border: "1px solid #cbd5e1",
                          minWidth: "96px",
                        }}
                      />
                      <button
                        type="submit"
                        className="wiki-tag-pill"
                        disabled={savingTag || !newTag.trim()}
                        title={t.page.addTag}
                        style={{ cursor: "pointer", border: "none" }}
                      >
                        {savingTag ? "…" : "✓"}
                      </button>
                    </form>
                  )}
                </div>
                  </div>{/* end wiki-detail-name-main */}
                  <div className="wiki-name-header-actions">
                    {/* ── Rubrik category badge ── */}
                    <div className="wiki-rubrik-badge-wrap" ref={rubrikWrapRef}>
                      {authUser?.trusted ? (
                        <button
                          type="button"
                          className="wiki-rubrik-badge wiki-rubrik-badge--editable"
                          onClick={() => setRubrikEditing((o) => !o)}
                          title="Rubrik setzen"
                          disabled={rubrikSaving}
                        >
                          <span className="wiki-rubrik-badge-label">Rubrik</span>
                          {rubrikSaving ? "…" : displayRubrik(entry.rubrik)}
                        </button>
                      ) : (
                        <span className="wiki-rubrik-badge">
                          <span className="wiki-rubrik-badge-label">Rubrik</span>
                          {displayRubrik(entry.rubrik)}
                        </span>
                      )}
                      {rubrikEditing && !rubrikSaving && (
                        <div className="wiki-rubrik-dropdown">
                          {RUBRIK_OPTIONS.map((opt) => {
                            const currentCanonical = normalizeRubrikValues(entry.rubrik).map(canonicalRubrikValue);
                            const isActive    = opt.value === ""
                              ? currentCanonical.length === 0
                              : currentCanonical.includes(canonicalRubrikValue(opt.value));
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                className={`wiki-rubrik-option${isActive ? " active" : ""}`}
                                onClick={() => void handleToggleRubrik(opt.value)}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {/* ── Favourite star button ── */}
                    {!favLoading && authUser && (
                      <button
                        type="button"
                        className={`wiki-fav-button${isFavorited ? " active" : ""}`}
                        onClick={() => void handleToggleFavorite()}
                        disabled={favSaving}
                        title={isFavorited ? "Remove from favourites" : "Add to favourites"}
                        aria-label={isFavorited ? "Remove from favourites" : "Add to favourites"}
                        aria-pressed={isFavorited}
                      >
                        {isFavorited ? "★" : "☆"}
                      </button>
                    )}
                    {/* ── Add to list (open to everybody) ── */}
                    {entryId && (
                      <AddToListButton entryId={entryId} title={entry.title} artNr={entry.artNr} />
                    )}
                  </div>{/* end wiki-name-header-actions */}
                </div>{/* end wiki-detail-name-shell */}
              </div>

              <div className="wiki-panel wiki-detail-summary">
                <h2>{t.page.summary}</h2>
                <p>{entry.desc?.trim() || t.page.summaryShortFallback}</p>
              </div>

              <div className="wiki-panel wiki-media-panel wiki-detail-images">
                <div className="wiki-section-header">
                  <h2>{t.page.images}</h2>
                  {authUser?.trusted && (
                    <>
                      <button
                        type="button"
                        className="wiki-section-trigger"
                        onClick={() => imageUploadInputRef.current?.click()}
                        disabled={uploadingImages}
                        aria-label={t.page.addImages}
                        title={t.page.addImages}
                      >
                        <Image
                          src={SECTION_ADD_ICON}
                          alt=""
                          aria-hidden="true"
                          width={SECTION_ADD_ICON_SIZE}
                          height={SECTION_ADD_ICON_SIZE}
                          style={{ transform: `translateY(-${SECTION_ADD_ICON_OFFSET_Y}px)` }}
                        />
                      </button>
                      <input
                        ref={imageUploadInputRef}
                        type="file"
                        multiple
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          event.target.value = "";
                          if (files.length > 0) void handleAddImages(files);
                        }}
                      />
                    </>
                  )}
                </div>
                {imageUploadError && <p className="wiki-error">{imageUploadError}</p>}
                <div className="wiki-carousel">
                  {imageList.length > 0 ? (
                    <>
                      {failedImages.has(imageList[safeImageIndex]) ? (
                        <a
                          href={imageList[safeImageIndex]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="wiki-carousel-image-fallback"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <path d="M21 15l-5-5L5 21" />
                          </svg>
                          <span>Image cannot be displayed in browser — click to open</span>
                        </a>
                      ) : (
                        <img
                          src={imageList[safeImageIndex]}
                          alt={`${entry.title} ${t.page.imageAlt} ${safeImageIndex + 1}`}
                          className="wiki-carousel-image"
                          onClick={() => setShowModal(true)}
                          onError={() =>
                            setFailedImages((prev) => new Set([...prev, imageList[safeImageIndex]]))
                          }
                        />
                      )}

                      {imageList.length > 1 && (
                        <>
                          <button
                            type="button"
                            className="wiki-carousel-btn left"
                            onClick={() => setImageIndex((current) => Math.max(current - 1, 0))}
                            aria-label={t.page.previousImage}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true" className="wiki-carousel-icon">
                              <path d="M14.5 5L8.5 12L14.5 19" />
                            </svg>
                          </button>

                          <button
                            type="button"
                            className="wiki-carousel-btn right"
                            onClick={() =>
                              setImageIndex((current) => Math.min(current + 1, imageList.length - 1))
                            }
                            aria-label={t.page.nextImage}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true" className="wiki-carousel-icon">
                              <path d="M9.5 5L15.5 12L9.5 19" />
                            </svg>
                          </button>
                        </>
                      )}

                      <div className="wiki-carousel-label">
                        {t.page.imageCounter} {safeImageIndex + 1} {t.page.imageOf} {imageList.length}
                      </div>
                    </>
                  ) : (
                    <p className="wiki-no-images">{t.page.noImages}</p>
                  )}
                </div>
              </div>

            </div>

            <section className="wiki-panel wiki-variants-panel">
              <div className="wiki-variants-header">
                <div className="wiki-variants-heading">
                  <h2>{t.page.variants}</h2>
                  <p className="wiki-variants-hint">{t.page.variantsHint}</p>
                </div>
                <div className="wiki-variants-stepper" role="group" aria-label={t.page.variantsRange}>
                  <span className="wiki-variants-stepper-label">{t.page.variantsRange}</span>
                  <button
                    type="button"
                    className="wiki-variants-stepper-btn"
                    onClick={() => setNeighborRange((n) => Math.max(NEIGHBOR_RANGE_MIN, n - 1))}
                    disabled={neighborRange <= NEIGHBOR_RANGE_MIN}
                    aria-label={t.page.variantsFewer}
                    title={t.page.variantsFewer}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="wiki-variants-stepper-icon">
                      <path d="M14.5 5L8.5 12L14.5 19" />
                    </svg>
                  </button>
                  <span className="wiki-variants-stepper-value" aria-live="polite">{neighborRange}</span>
                  <button
                    type="button"
                    className="wiki-variants-stepper-btn"
                    onClick={() => setNeighborRange((n) => Math.min(NEIGHBOR_RANGE_MAX, n + 1))}
                    disabled={neighborRange >= NEIGHBOR_RANGE_MAX}
                    aria-label={t.page.variantsMore}
                    title={t.page.variantsMore}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" className="wiki-variants-stepper-icon">
                      <path d="M9.5 5L15.5 12L9.5 19" />
                    </svg>
                  </button>
                </div>
              </div>

              {!entry.artNr?.trim() ? (
                <p className="wiki-muted">{t.page.variantsNoArtNr}</p>
              ) : (
                <div
                  className={`wiki-variants-track${neighborsLoading ? " is-loading" : ""}`}
                  ref={variantsTrackRef}
                >
                    {neighbors.before.map(renderVariantCard)}

                    <div
                      ref={variantsCurrentRef}
                      className="wiki-variant-card wiki-variant-card--current"
                      aria-current="true"
                    >
                      <span className="wiki-variant-card-badge">{t.page.variantsCurrent}</span>
                      <span className="wiki-variant-card-thumb">
                        {renderVariantThumb(entry.pictureUrls?.[0])}
                      </span>
                      <span className="wiki-variant-card-artnr">{entry.artNr}</span>
                      <span className="wiki-variant-card-title">{entry.title}</span>
                      {variantInfo(entry) && (
                        <span className="wiki-variant-card-info">{variantInfo(entry)}</span>
                      )}
                    </div>

                    {neighbors.after.map(renderVariantCard)}

                    {!neighborsLoading &&
                      neighbors.before.length === 0 &&
                      neighbors.after.length === 0 && (
                        <p className="wiki-muted wiki-variants-empty">{t.page.variantsNone}</p>
                      )}
                </div>
              )}
            </section>

            <div className="wiki-lower-grid">
              {authUser?.employee && (
              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2>{t.page.issues}</h2>
                  {authUser?.trusted && (
                  <button
                    type="button"
                    className="wiki-section-trigger"
                    onClick={() => openSectionEditor("issues")}
                    aria-label={t.page.addIssue}
                    title={t.page.addIssue}
                  >
                    <Image
                      src={SECTION_ADD_ICON}
                      alt=""
                      aria-hidden="true"
                      width={SECTION_ADD_ICON_SIZE}
                      height={SECTION_ADD_ICON_SIZE}
                      style={{ transform: `translateY(-${SECTION_ADD_ICON_OFFSET_Y}px)` }}
                    />
                  </button>
                  )}
                </div>
                <div className="wiki-list-cards issues">
                  {issues.map((item, index) => (
                      <article key={`${item.title}-${index}`} className="wiki-note-card">
                        <button
                          type="button"
                          className="wiki-doc-card-link"
                          onClick={() => setIssuePreviewIndex(index)}
                        >
                          <strong>{item.title}</strong>
                          {item.description ? <p>{item.description}</p> : null}
                          {item.attachments?.length ? (
                            <div className="wiki-card-attachments">
                              {item.attachments.map((attachment, idx) => {
                                const media = attachmentMediaById.get(Number(attachment));
                                if (!media) {
                                  return null;
                                }

                                return (
                                  <span key={`${media.id}-${idx}`} className="wiki-card-attachment-inline">
                                    {media.name ?? `Attachment ${idx + 1}`}
                                  </span>
                                );
                              })}
                            </div>
                          ) : null}
                        </button>
                      </article>
                    ))}

                  {inheritedIssues.map((item, index) => (
                    <article key={item.key} className="wiki-note-card wiki-note-card-inherited">
                      <button
                        type="button"
                        className="wiki-doc-card-link"
                        onClick={() => setInheritedIssuePreviewIndex(index)}
                      >
                        <span className="wiki-inherited-badge">⚠ {t.page.linkedProblemBadge}</span>
                        <strong>{item.issue.title}</strong>
                        {item.issue.description ? <p>{item.issue.description}</p> : null}
                        <span className="wiki-inherited-source">
                          {t.page.problemFrom} {item.sourceTitle}
                          {item.sourceArtNr ? ` (${item.sourceArtNr})` : ""}
                        </span>
                      </button>
                    </article>
                  ))}

                  {issues.length === 0 && inheritedIssues.length === 0 && (
                    <p className="wiki-muted">{t.page.noIssues}</p>
                  )}
                </div>
              </section>
              )}

              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2>{t.page.docs}</h2>
                  {authUser?.trusted && (
                  <button
                    type="button"
                    className="wiki-section-trigger"
                    onClick={() => openSectionEditor("docs")}
                    aria-label={t.page.addDocs}
                    title={t.page.addDocs}
                  >
                    <Image
                      src={SECTION_ADD_ICON}
                      alt=""
                      aria-hidden="true"
                      width={SECTION_ADD_ICON_SIZE}
                      height={SECTION_ADD_ICON_SIZE}
                      style={{ transform: `translateY(-${SECTION_ADD_ICON_OFFSET_Y}px)` }}
                    />
                  </button>
                  )}
                </div>
                <div className="wiki-list-cards docs">
                  {docsEntries.length > 0 ? (
                    docsEntries.map((item, index) => {
                      const href = normalizeExternalLink(item.link);
                      return (
                        <article key={`${item.title}-${index}`} className="wiki-note-card">
                          <button
                            type="button"
                            className="wiki-doc-card-link"
                            onClick={() => setDocPreviewIndex(index)}
                          >
                            <strong>{item.title}</strong>
                            {item.description ? <p>{item.description}</p> : null}
                            {href ? <span className="wiki-card-link">{item.link}</span> : null}
                            {item.attachments?.length ? (
                              <div className="wiki-card-attachments">
                                {item.attachments.map((attachment, idx) => {
                                  const media = attachmentMediaById.get(Number(attachment));
                                  if (!media) {
                                    return null;
                                  }

                                  return (
                                    <span key={`${media.id}-${idx}`} className="wiki-card-attachment-inline">
                                      {media.name ?? `Attachment ${idx + 1}`}
                                    </span>
                                  );
                                })}
                              </div>
                            ) : null}
                          </button>
                        </article>
                      );
                    })
                  ) : (
                    <p className="wiki-muted">{t.page.noDocs}</p>
                  )}
                </div>
              </section>

              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2 className="wiki-links-heading">{t.page.links}</h2>
                  <div className="wiki-section-header-actions">
                    {linkEntries.length > 0 && (
                      <button
                        type="button"
                        className="wiki-section-trigger wiki-links-expand-btn"
                        onClick={openRelationsGraph}
                        aria-label="View all relations"
                        title="View all relations"
                      >
                        <svg viewBox="0 0 20 20" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4" />
                          <rect x="6" y="6" width="8" height="8" rx="1" />
                        </svg>
                      </button>
                    )}
                    {authUser?.trusted && (
                    <button
                      type="button"
                      className="wiki-section-trigger"
                      onClick={() => openSectionEditor("links")}
                      aria-label={t.page.addLinks}
                      title={t.page.addLinks}
                    >
                      <Image
                        src={SECTION_ADD_ICON}
                        alt=""
                        aria-hidden="true"
                        width={SECTION_ADD_ICON_SIZE}
                        height={SECTION_ADD_ICON_SIZE}
                        style={{ transform: `translateY(-${SECTION_ADD_ICON_OFFSET_Y}px)` }}
                      />
                    </button>
                    )}
                  </div>
                </div>
                <div className="wiki-list-cards links wiki-link-list">
                  {linkEntries.length > 0 ? (
                    linkEntries.map((linkEntry, index) => {
                      const value = linkEntry.id;
                      const linkedEntry =
                        linkedEntriesLookup.get(value) ??
                        catalogEntries.find(
                        (catalogEntry) =>
                          catalogEntry.documentId === value || String(catalogEntry.id) === value
                      );
                      const targetId = linkedEntry?.documentId ?? value;
                      const linkedImage = linkedEntry?.pictureUrls?.[0];

                      return (
                        <article key={`${value}-${index}`} className="wiki-note-card">
                          <button
                            type="button"
                            className="wiki-linked-entry"
                            onClick={() => setSelectedRelationIndex(index)}
                          >
                            {linkedImage ? (
                              <img src={linkedImage} alt={linkedEntry?.title ?? value} className="wiki-link-thumbnail" />
                            ) : (
                              <div className="wiki-link-thumbnail wiki-link-placeholder">no image</div>
                            )}
                            <div className="wiki-link-text">
                              <strong>{linkedEntry?.title ?? value}</strong>
                              <span>{linkedEntry?.artNr ?? (linkedEntry?.documentId ?? value)}</span>
                            </div>
                            <div className="wiki-link-badges">
                              {linkEntry.confidence !== undefined && (
                                <span className="wiki-relation-confidence">{Math.round(linkEntry.confidence * 100)}%</span>
                              )}
                              {linkEntry.source && (
                                <span className="wiki-relation-source">{linkEntry.source}</span>
                              )}
                            </div>
                          </button>
                        </article>
                      );
                    })
                  ) : (
                    <p className="wiki-muted">{t.page.noLinks}</p>
                  )}
                </div>
              </section>

              {authUser?.employee && (
              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2>{t.page.tickets}</h2>
                  {authUser?.trusted && (
                  <button
                    type="button"
                    className="wiki-section-trigger"
                    onClick={() => openSectionEditor("tickets")}
                    aria-label={t.page.addTickets}
                    title={t.page.addTickets}
                  >
                    <Image
                      src={SECTION_ADD_ICON}
                      alt=""
                      aria-hidden="true"
                      width={SECTION_ADD_ICON_SIZE}
                      height={SECTION_ADD_ICON_SIZE}
                      style={{ transform: `translateY(-${SECTION_ADD_ICON_OFFSET_Y}px)` }}
                    />
                  </button>
                  )}
                </div>
                <div className="wiki-list-cards tickets">
                  {ticketsEntries.length > 0 ? (
                    ticketsEntries.map((item, index) => (
                      <article key={`${item.title}-${index}`} className="wiki-note-card">
                        <button
                          type="button"
                          className="wiki-doc-card-link"
                          onClick={() => setTicketPreviewIndex(index)}
                        >
                          <strong>{item.title}</strong>
                          {item.description ? <p>{item.description}</p> : null}
                          {normalizeExternalLink(item.link) ? (
                            <span className="wiki-card-link">{item.link}</span>
                          ) : null}
                          {item.attachments?.length ? (
                            <div className="wiki-card-attachments">
                              {item.attachments.map((attachment, idx) => {
                                const media = attachmentMediaById.get(Number(attachment));
                                if (!media) {
                                  return null;
                                }

                                return (
                                  <span key={`${media.id}-${idx}`} className="wiki-card-attachment-inline">
                                    {media.name ?? `Attachment ${idx + 1}`}
                                  </span>
                                );
                              })}
                            </div>
                          ) : null}
                        </button>
                      </article>
                    ))
                  ) : (
                    <p className="wiki-muted">{t.page.noTickets}</p>
                  )}
                </div>
              </section>
              )}

              {authUser?.employee && (
              <section className="wiki-panel wiki-igs-panel">
                <h2>IGS INFO</h2>
                {igsStructured ? (
                  <div className="wiki-igs-json">
                    <div className="wiki-igs-pairs">
                      <div className="wiki-igs-pair-row">
                        <span className="wiki-igs-cell">
                          <em>Bezeichnung 1</em>
                          <strong>{igsStructured.bez1 || "——————————————————"}</strong>
                        </span>
                        <span className="wiki-igs-cell">
                          <em>Bezeichnung 2</em>
                          <strong>{igsStructured.bez2 || "——————————————————"}</strong>
                        </span>
                      </div>

                      <div className="wiki-igs-pair-row">
                        <span className="wiki-igs-cell">
                          <em>Bezeichnung 3</em>
                          <strong>{igsStructured.bez3 || "——————————————————"}</strong>
                        </span>
                        <span className="wiki-igs-cell">
                          <em>Bezeichnung 4</em>
                          <strong>{igsStructured.bez4 || "——————————————————"}</strong>
                        </span>
                      </div>

                      <div className="wiki-igs-quad-row">
                        <span className="wiki-igs-cell wiki-igs-cell-inline">
                          <em>Kurztext:</em>
                          <strong>{igsStructured.kurztext || "————"}</strong>
                        </span>
                        <span className="wiki-igs-cell wiki-igs-cell-inline">
                          <em>Land:</em>
                          <strong>{igsStructured.land || "———"}</strong>
                        </span>
                        <span className="wiki-igs-cell wiki-igs-cell-inline">
                          <em>Auslauf:</em>
                          <strong>{igsStructured.auslauf || "—"}</strong>
                        </span>
                        <span className="wiki-igs-cell wiki-igs-cell-inline">
                          <em>Rubrik:</em>
                          <strong>{igsStructured.rubrik || "——"}</strong>
                        </span>
                      </div>

                      <div className="wiki-igs-pair-row">
                        <span className="wiki-igs-dsu-cell">{igsStructured.dsu[0] || "————————————————————————————————————————————————————"}</span>
                        <span className="wiki-igs-dsu-cell">{igsStructured.dsu[1] || "————————————————————————————————————————————————————"}</span>
                      </div>

                      <div className="wiki-igs-pair-row">
                        <span className="wiki-igs-dsu-cell">{igsStructured.dsu[2] || "————————————————————————————————————————————————————"}</span>
                        <span className="wiki-igs-dsu-cell">{igsStructured.dsu[3] || "————————————————————————————————————————————————————"}</span>
                      </div>

                      <div className="wiki-igs-pair-row">
                        <span className="wiki-igs-dsu-cell">{igsStructured.dsu[4] || "————————————————————————————————————————————————————"}</span>
                        <span className="wiki-igs-dsu-cell">{igsStructured.dsu[5] || "————————————————————————————————————————————————————"}</span>
                      </div>
                    </div>
                  </div>
                ) : igsContent ? (
                  <pre className="wiki-igs-json">{igsContent}</pre>
                ) : (
                  <div className="wiki-igs-placeholder">No IGS data</div>
                )}
              </section>
              )}
            </div>
          </>
        )}

        {!loading && !error && entry && showModal && imageList.length > 0 && (
          <div className="wiki-modal" onClick={() => setShowModal(false)}>
            {failedImages.has(imageList[safeImageIndex]) ? (
              <a
                href={imageList[safeImageIndex]}
                target="_blank"
                rel="noopener noreferrer"
                className="wiki-modal-image-fallback"
                onClick={(e) => e.stopPropagation()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                <span>Image cannot be displayed in browser — click to open file</span>
              </a>
            ) : (
              <img
                src={imageList[safeImageIndex]}
                alt={`${entry.title} ${t.page.imageAltZoom} ${safeImageIndex + 1}`}
                className="wiki-modal-image"
                onError={() =>
                  setFailedImages((prev) => new Set([...prev, imageList[safeImageIndex]]))
                }
              />
            )}
          </div>
        )}

        {!loading && !error && entry && activeSection && authUser?.trusted && (
          <div className="wiki-modal wiki-form-modal" onClick={closeSectionEditor}>
            <div
              className="wiki-modal-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="section-dialog-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="wiki-modal-header">
                <div>
                  <h2 id="section-dialog-title">
                    {editingIndex !== null
                      ? activeSection === "issues"
                        ? "Edit Issue"
                        : activeSection === "docs"
                          ? "Edit Document"
                          : activeSection === "links"
                            ? "Edit Link"
                            : "Edit Ticket"
                      : activeSection === "issues"
                        ? t.page.addIssue
                        : activeSection === "docs"
                          ? t.page.addDocs
                          : activeSection === "links"
                            ? t.page.addLinks
                            : t.page.addTickets}
                  </h2>
                  <p>
                    {activeSection === "links"
                      ? t.page.linkDialogSubtitle
                      : t.page.sectionDialogSubtitle}
                  </p>
                </div>
                <button
                  type="button"
                  className="wiki-modal-close"
                  onClick={closeSectionEditor}
                  aria-label={t.page.closeIssueDialog}
                >
                  ×
                </button>
              </div>

              <form className="wiki-form wiki-issue-form" onSubmit={handleSectionSubmit}>
                {activeSection === "links" ? (
                  <>
                    <label>
                      {t.page.linkSearchPlaceholder}
                      <input
                        type="search"
                        value={linkQuery}
                        onChange={(event) => setLinkQuery(event.target.value)}
                        placeholder={t.page.linkSearchPlaceholder}
                        autoFocus
                      />
                    </label>

                    <div className="wiki-search-results">
                      {linkSearchLoading ? (
                        <p className="wiki-muted">Searching...</p>
                      ) : linkResults.length > 0 ? (
                        linkResults.map((catalogEntry) => {
                          const isSelected = selectedLinkId === catalogEntry.documentId;

                          return (
                            <button
                              key={catalogEntry.documentId}
                              type="button"
                              className={`wiki-search-result ${isSelected ? "active" : ""}`}
                              onClick={() => setSelectedLinkId(catalogEntry.documentId)}
                            >
                              <strong>{catalogEntry.title}</strong>
                              <span>
                                {catalogEntry.artNr ?? "-"} · {catalogEntry.documentId}
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <p className="wiki-muted">{t.home.globalSearchNoResults}</p>
                      )}
                    </div>

                    {selectedLinkId && (
                      <p className="wiki-selection-note">
                        {t.page.selectedLink}: {selectedLinkId}
                      </p>
                    )}

                    <label>
                      Confidence (%)
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={linkConfidence}
                        onChange={(e) => setLinkConfidence(e.target.value)}
                        placeholder="0–100 (optional)"
                      />
                    </label>

                    <label>
                      Source
                      <input
                        type="text"
                        value={linkSource}
                        onChange={(e) => setLinkSource(e.target.value)}
                        placeholder="e.g. manual, import, auto"
                      />
                    </label>

                    <label>
                      Link URL (optional)
                      <input
                        type="url"
                        value={linkUrl}
                        onChange={(e) => setLinkUrl(e.target.value)}
                        placeholder="https://example.com"
                      />
                    </label>

                    <label>
                      Note (optional)
                      <textarea
                        value={linkDesc}
                        onChange={(e) => setLinkDesc(e.target.value)}
                        rows={3}
                        placeholder="Note about this relation"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      {t.form.title}
                      <input
                        type="text"
                        value={sectionTitle}
                        onChange={(event) => setSectionTitle(event.target.value)}
                        autoFocus
                      />
                    </label>

                    <label>
                      {t.form.description}
                      <textarea
                        value={sectionDescription}
                        onChange={(event) => setSectionDescription(event.target.value)}
                        rows={6}
                      />
                    </label>

                    {(activeSection === "tickets" || activeSection === "docs") && (
                      <label>
                        {activeSection === "docs" ? "Document Link" : t.page.ticketLink}
                        <input
                          type="url"
                          value={ticketLink}
                          onChange={(event) => setTicketLink(event.target.value)}
                          placeholder="https://example.com"
                        />
                      </label>
                    )}

                    {activeSection !== "tickets" && (
                      <label>
                        {t.page.attachFile}
                        <input
                          type="file"
                          multiple
                          onChange={(event) =>
                            setAttachmentFiles(Array.from(event.target.files || []))
                          }
                        />
                      </label>
                    )}

                    {attachmentFiles.length > 0 && (
                      <div className="wiki-attachments-preview">
                        <p className="wiki-muted">{attachmentFiles.length} file(s) selected (not persisted yet)</p>
                        {attachmentFiles.map((file, idx) => (
                          <div key={idx} className="wiki-attachment-item">
                            <span>
                              {file.name}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setAttachmentFiles(
                                  attachmentFiles.filter((_, i) => i !== idx)
                                )
                              }
                              className="wiki-button-small"
                            >
                              {t.page.removeAttachment}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {sectionError && <p className="wiki-error">{sectionError}</p>}

                <div className="wiki-actions">
                  <button
                    type="button"
                    className="wiki-button secondary"
                    onClick={closeSectionEditor}
                  >
                    {t.page.closeIssueDialog}
                  </button>
                  <button type="submit" className="wiki-button primary" disabled={savingSection}>
                    {savingSection ? t.form.saving : t.form.saveChanges}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Doc Preview Modal */}
        {docPreviewIndex !== null && docsEntries[docPreviewIndex] && (() => {
          const doc = docsEntries[docPreviewIndex]!;
          const mediaList = (doc.attachments ?? [])
            .map((a) => attachmentMediaById.get(Number(a)))
            .filter((m): m is EntryMedia => Boolean(m));
          const active = mediaList[docPreviewAttachment] ?? mediaList[0] ?? null;
          const sourceLink = doc.link ? normalizeExternalLink(doc.link) : null;

          return (
            <div
              className="wiki-modal-overlay"
              onClick={() => setDocPreviewIndex(null)}
              role="dialog"
              aria-modal="true"
              aria-labelledby="doc-preview-title"
            >
              <div className="wiki-modal-dialog wiki-doc-viewer" onClick={(e) => e.stopPropagation()}>
                <header className="wiki-doc-viewer-header">
                  <h2 id="doc-preview-title">{doc.title}</h2>
                  <button
                    type="button"
                    className="wiki-modal-close"
                    onClick={() => setDocPreviewIndex(null)}
                    aria-label={t.page.docClose}
                  >
                    ✕
                  </button>
                </header>

                <div className="wiki-doc-viewer-body">
                  <div className="wiki-doc-viewer-main">
                    <div className="wiki-doc-viewer-stage">
                      {active ? (
                        renderDocPreviewPane(active, t.page.docNoPreview)
                      ) : (
                        <div className="wiki-doc-viewer-fallback">
                          <p className="wiki-muted">{t.page.docNoFile}</p>
                        </div>
                      )}
                    </div>

                    {mediaList.length > 1 && (
                      <div className="wiki-doc-viewer-tabs" role="tablist">
                        {mediaList.map((m, i) => (
                          <button
                            key={`${m.id}-${i}`}
                            type="button"
                            role="tab"
                            aria-selected={i === docPreviewAttachment}
                            className={`wiki-doc-viewer-tab${i === docPreviewAttachment ? " active" : ""}`}
                            onClick={() => setDocPreviewAttachment(i)}
                            title={m.name ?? `${t.page.docFile} ${i + 1}`}
                          >
                            {m.name ?? `${t.page.docFile} ${i + 1}`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <aside className="wiki-doc-viewer-meta">
                    <h3>{t.page.docDetails}</h3>
                    <dl className="wiki-doc-meta-list">
                      <dt>{t.page.docName}</dt>
                      <dd>{doc.title || "—"}</dd>

                      {doc.description ? (
                        <>
                          <dt>{t.page.docDescription}</dt>
                          <dd>{doc.description}</dd>
                        </>
                      ) : null}

                      {active ? (
                        <>
                          <dt>{t.page.docFile}</dt>
                          <dd className="wiki-doc-meta-break">{active.name ?? "—"}</dd>
                          <dt>{t.page.docType}</dt>
                          <dd>{fileTypeLabel(active.url)}</dd>
                        </>
                      ) : null}

                      {sourceLink ? (
                        <>
                          <dt>{t.page.docSource}</dt>
                          <dd className="wiki-doc-meta-break">
                            <a href={sourceLink} target="_blank" rel="noopener noreferrer">
                              {doc.link}
                            </a>
                          </dd>
                        </>
                      ) : null}
                    </dl>

                    <div className="wiki-doc-viewer-actions">
                      {active ? (
                        <a className="wiki-button primary" href={active.url} download={active.name ?? ""}>
                          {t.page.docDownload}
                        </a>
                      ) : null}
                      {active ? (
                        <a
                          className="wiki-button secondary"
                          href={active.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t.page.docOpenNewTab}
                        </a>
                      ) : null}
                      {sourceLink ? (
                        <a
                          className="wiki-button secondary"
                          href={sourceLink}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t.page.docOpenSource}
                        </a>
                      ) : null}
                    </div>
                  </aside>
                </div>
              </div>
            </div>
          );
        })()}

        {issuePreviewIndex !== null && issues[issuePreviewIndex] && (
          <div
            className="wiki-modal-overlay"
            onClick={() => setIssuePreviewIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="issue-preview-title"
          >
            <div className="wiki-modal-dialog wiki-preview-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="wiki-modal-content">
                <div className="wiki-modal-header">
                  <h2 id="issue-preview-title">{issues[issuePreviewIndex]?.title}</h2>
                  <button
                    type="button"
                    className="wiki-modal-close"
                    onClick={() => setIssuePreviewIndex(null)}
                    aria-label="Close preview"
                  >
                    ✕
                  </button>
                </div>

                <div className="wiki-modal-body">
                  {issues[issuePreviewIndex]?.description && (
                    <div className="wiki-doc-preview-desc">
                      <p>{issues[issuePreviewIndex].description}</p>
                    </div>
                  )}

                  {issues[issuePreviewIndex]?.attachments?.length ? (
                    <div className="wiki-doc-preview-attachments">
                      <h3>Attachments</h3>
                      <div className="wiki-card-attachments">
                        {issues[issuePreviewIndex].attachments.map((attachment, idx) => {
                          const media = attachmentMediaById.get(Number(attachment));
                          if (!media) {
                            return null;
                          }

                          return (
                            <a
                              key={`${media.id}-${idx}`}
                              href={media.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="wiki-card-attachment"
                            >
                              {isImageAttachment(media.url) ? (
                                <img
                                  src={media.url}
                                  alt={media.name ?? `Attachment ${idx + 1}`}
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                />
                              ) : null}
                              <span>{media.name ?? `Attachment ${idx + 1}`}</span>
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="wiki-modal-footer">
                  <button
                    type="button"
                    className="wiki-button secondary"
                    onClick={() => setIssuePreviewIndex(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {inheritedIssuePreviewIndex !== null && inheritedIssues[inheritedIssuePreviewIndex] && (
          <div
            className="wiki-modal-overlay"
            onClick={() => setInheritedIssuePreviewIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="inherited-issue-preview-title"
          >
            <div className="wiki-modal-dialog wiki-preview-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="wiki-modal-content">
                <div className="wiki-modal-header">
                  <h2 id="inherited-issue-preview-title">
                    {inheritedIssues[inheritedIssuePreviewIndex]?.issue.title}
                  </h2>
                  <button
                    type="button"
                    className="wiki-modal-close"
                    onClick={() => setInheritedIssuePreviewIndex(null)}
                    aria-label="Close preview"
                  >
                    ✕
                  </button>
                </div>

                <div className="wiki-modal-body">
                  <div className="wiki-inherited-source-line">
                    <span className="wiki-inherited-badge">⚠ {t.page.linkedProblemBadge}</span>
                    <span>
                      {t.page.problemSource}:{" "}
                      <Link
                        href={`/products/${inheritedIssues[inheritedIssuePreviewIndex]!.sourceId}`}
                        className="wiki-card-link"
                      >
                        {inheritedIssues[inheritedIssuePreviewIndex]!.sourceTitle}
                        {inheritedIssues[inheritedIssuePreviewIndex]!.sourceArtNr
                          ? ` (${inheritedIssues[inheritedIssuePreviewIndex]!.sourceArtNr})`
                          : ""}
                      </Link>
                    </span>
                  </div>

                  {inheritedIssues[inheritedIssuePreviewIndex]?.issue.description && (
                    <div className="wiki-doc-preview-desc">
                      <p>{inheritedIssues[inheritedIssuePreviewIndex].issue.description}</p>
                    </div>
                  )}

                  {inheritedIssues[inheritedIssuePreviewIndex]?.issue.attachments?.length ? (
                    <div className="wiki-doc-preview-attachments">
                      <h3>Attachments</h3>
                      <div className="wiki-card-attachments">
                        {inheritedIssues[inheritedIssuePreviewIndex]!.issue.attachments!.map((attachment, idx) => {
                          const media = attachmentMediaById.get(Number(attachment));
                          if (!media) {
                            return null;
                          }

                          return (
                            <a
                              key={`${media.id}-${idx}`}
                              href={media.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="wiki-card-attachment"
                            >
                              {isImageAttachment(media.url) ? (
                                <img
                                  src={media.url}
                                  alt={media.name ?? `Attachment ${idx + 1}`}
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                />
                              ) : null}
                              <span>{media.name ?? `Attachment ${idx + 1}`}</span>
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="wiki-modal-footer">
                  <Link
                    href={`/products/${inheritedIssues[inheritedIssuePreviewIndex]!.sourceId}`}
                    className="wiki-button"
                  >
                    {t.page.openSourceProduct}
                  </Link>
                  <button
                    type="button"
                    className="wiki-button secondary"
                    onClick={() => setInheritedIssuePreviewIndex(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {ticketPreviewIndex !== null && ticketsEntries[ticketPreviewIndex] && (
          <div
            className="wiki-modal-overlay"
            onClick={() => setTicketPreviewIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ticket-preview-title"
          >
            <div className="wiki-modal-dialog wiki-preview-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="wiki-modal-content">
                <div className="wiki-modal-header">
                  <h2 id="ticket-preview-title">{ticketsEntries[ticketPreviewIndex]?.title}</h2>
                  <button
                    type="button"
                    className="wiki-modal-close"
                    onClick={() => setTicketPreviewIndex(null)}
                    aria-label="Close preview"
                  >
                    ✕
                  </button>
                </div>

                <div className="wiki-modal-body">
                  {ticketsEntries[ticketPreviewIndex]?.description && (
                    <div className="wiki-doc-preview-desc">
                      <p>{ticketsEntries[ticketPreviewIndex].description}</p>
                    </div>
                  )}

                  {ticketsEntries[ticketPreviewIndex]?.attachments?.length ? (
                    <div className="wiki-doc-preview-attachments">
                      <h3>Attachments</h3>
                      <div className="wiki-card-attachments">
                        {ticketsEntries[ticketPreviewIndex].attachments.map((attachment, idx) => {
                          const media = attachmentMediaById.get(Number(attachment));
                          if (!media) {
                            return null;
                          }

                          return (
                            <a
                              key={`${media.id}-${idx}`}
                              href={media.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="wiki-card-attachment"
                            >
                              {isImageAttachment(media.url) ? (
                                <img
                                  src={media.url}
                                  alt={media.name ?? `Attachment ${idx + 1}`}
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                />
                              ) : null}
                              <span>{media.name ?? `Attachment ${idx + 1}`}</span>
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="wiki-modal-footer">
                  {ticketsEntries[ticketPreviewIndex]?.link && normalizeExternalLink(ticketsEntries[ticketPreviewIndex].link) && (
                    <a
                      href={normalizeExternalLink(ticketsEntries[ticketPreviewIndex].link)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="wiki-button primary"
                    >
                      Open Link →
                    </a>
                  )}
                  <button
                    type="button"
                    className="wiki-button secondary"
                    onClick={() => setTicketPreviewIndex(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!loading && !error && entry && selectedRelationIndex !== null && (() => {
          const linkEntry = linkEntries[selectedRelationIndex];
          if (!linkEntry) return null;
          const linkedEntry =
            linkedEntriesLookup.get(linkEntry.id) ??
            catalogEntries.find(
              (c) => c.documentId === linkEntry.id || String(c.id) === linkEntry.id
            );
          const targetId = linkedEntry?.documentId ?? linkEntry.id;
          const linkedImage = linkedEntry?.pictureUrls?.[0];
          const confidencePct =
            linkEntry.confidence !== undefined
              ? Math.round(linkEntry.confidence * 100)
              : null;
          const votes = linkEntry.votes ?? {};
          const upCount = Object.values(votes).filter((v) => v.v === 1).length;
          const downCount = Object.values(votes).filter((v) => v.v === -1).length;
          const myUserId = authUser?.userID ?? "";
          const myVote = myUserId && votes[myUserId] ? votes[myUserId]!.v : 0;

          return (
            <div
              className="wiki-modal-overlay"
              onClick={() => { setSelectedRelationIndex(null); setShowVoteReason(false); setPendingVote(null); setVoteReason(""); }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="relation-detail-title"
            >
              <div
                className="wiki-modal-dialog wiki-relation-detail-dialog"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="wiki-modal-content">
                  <div className="wiki-modal-header">
                    <h2 id="relation-detail-title">{linkedEntry?.title ?? linkEntry.id}</h2>
                    <button
                      type="button"
                      className="wiki-modal-close"
                      onClick={() => { setSelectedRelationIndex(null); setShowVoteReason(false); setPendingVote(null); setVoteReason(""); }}
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="wiki-relation-detail-body">
                    <Link
                      href={`/products/${targetId}`}
                      className="wiki-relation-detail-image-link"
                    >
                      {linkedImage ? (
                        <img
                          src={linkedImage}
                          alt={linkedEntry?.title ?? linkEntry.id}
                          className="wiki-relation-detail-image"
                        />
                      ) : (
                        <div className="wiki-relation-detail-image-placeholder">
                          {linkedEntry?.title?.slice(0, 2) ?? "?"}
                        </div>
                      )}
                    </Link>

                    <div className="wiki-relation-detail-info">
                      {linkedEntry?.artNr && (
                        <p className="wiki-relation-detail-row">
                          <span className="wiki-relation-detail-label">Art. Nr</span>
                          <span>{linkedEntry.artNr}</span>
                        </p>
                      )}
                      {linkedEntry?.EAN && (
                        <p className="wiki-relation-detail-row">
                          <span className="wiki-relation-detail-label">EAN</span>
                          <span>{linkedEntry.EAN}</span>
                        </p>
                      )}
                      {(confidencePct !== null || linkEntry.source) && (
                        <div className="wiki-relations-list-meta" style={{ marginTop: "0.5rem" }}>
                          {confidencePct !== null && (
                            <span className="wiki-relation-confidence">{confidencePct}%</span>
                          )}
                          {linkEntry.source && (
                            <span className="wiki-relation-source">{linkEntry.source}</span>
                          )}
                        </div>
                      )}
                      {authUser && (
                        <div style={{ marginTop: "0.75rem" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                            <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Confidence:</span>
                            <button
                              type="button"
                              title="Thumbs up — I agree with this link"
                              disabled={!!votingLinkId}
                              onClick={() => {
                                if (myVote === 1) {
                                  void castVote(targetId, 0);
                                } else {
                                  setPendingVote(1);
                                  setShowVoteReason(true);
                                  setVoteReason("");
                                }
                              }}
                              style={{
                                background: myVote === 1 ? "#dcfce7" : "transparent",
                                border: `1px solid ${myVote === 1 ? "#16a34a" : "#cbd5e1"}`,
                                borderRadius: "6px",
                                padding: "2px 8px",
                                cursor: "pointer",
                                fontSize: "0.85rem",
                                color: myVote === 1 ? "#16a34a" : "#64748b",
                              }}
                            >
                              👍 {upCount > 0 ? upCount : ""}
                            </button>
                            <button
                              type="button"
                              title="Thumbs down — I doubt this link"
                              disabled={!!votingLinkId}
                              onClick={() => {
                                if (myVote === -1) {
                                  void castVote(targetId, 0);
                                } else {
                                  setPendingVote(-1);
                                  setShowVoteReason(true);
                                  setVoteReason("");
                                }
                              }}
                              style={{
                                background: myVote === -1 ? "#fee2e2" : "transparent",
                                border: `1px solid ${myVote === -1 ? "#dc2626" : "#cbd5e1"}`,
                                borderRadius: "6px",
                                padding: "2px 8px",
                                cursor: "pointer",
                                fontSize: "0.85rem",
                                color: myVote === -1 ? "#dc2626" : "#64748b",
                              }}
                            >
                              👎 {downCount > 0 ? downCount : ""}
                            </button>
                            {votingLinkId === targetId && <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>…</span>}
                          </div>
                          {showVoteReason && (
                            <div
                              style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem", alignItems: "center" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="text"
                                value={voteReason}
                                onChange={(e) => setVoteReason(e.target.value)}
                                placeholder="Reason (optional)"
                                style={{
                                  flex: 1,
                                  fontSize: "0.8rem",
                                  padding: "3px 8px",
                                  borderRadius: "6px",
                                  border: "1px solid #cbd5e1",
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    if (pendingVote) {
                                      void castVote(targetId, pendingVote, voteReason);
                                      setShowVoteReason(false);
                                      setPendingVote(null);
                                    }
                                  }
                                  if (e.key === "Escape") {
                                    setShowVoteReason(false);
                                    setPendingVote(null);
                                  }
                                }}
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (pendingVote) {
                                    void castVote(targetId, pendingVote, voteReason);
                                    setShowVoteReason(false);
                                    setPendingVote(null);
                                  }
                                }}
                                style={{
                                  fontSize: "0.8rem",
                                  padding: "3px 10px",
                                  borderRadius: "6px",
                                  border: "1px solid #2563eb",
                                  background: "#2563eb",
                                  color: "#fff",
                                  cursor: "pointer",
                                }}
                              >
                                {pendingVote === 1 ? "👍" : "👎"} Submit
                              </button>
                              <button
                                type="button"
                                onClick={() => { setShowVoteReason(false); setPendingVote(null); }}
                                style={{
                                  fontSize: "0.8rem",
                                  padding: "3px 8px",
                                  borderRadius: "6px",
                                  border: "1px solid #cbd5e1",
                                  background: "transparent",
                                  cursor: "pointer",
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {linkEntry.link && (
                        <p className="wiki-relation-detail-row">
                          <span className="wiki-relation-detail-label">Reference</span>
                          <a href={linkEntry.link} target="_blank" rel="noopener noreferrer" className="wiki-relation-detail-ref-link">
                            {linkEntry.link}
                          </a>
                        </p>
                      )}
                      {linkEntry.desc && (
                        <p className="wiki-relation-detail-desc">{linkEntry.desc}</p>
                      )}
                      {!linkEntry.desc && linkedEntry?.desc && (
                        <p className="wiki-relation-detail-desc">{linkedEntry.desc}</p>
                      )}
                    </div>
                  </div>

                  <div className="wiki-modal-footer">
                    <Link href={`/products/${targetId}`} className="wiki-button primary">
                      Go to item →
                    </Link>
                    <button
                      type="button"
                      className="wiki-button secondary"
                      onClick={() => { setSelectedRelationIndex(null); setShowVoteReason(false); setPendingVote(null); setVoteReason(""); }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {!loading && !error && entry && showRelationsGraph && (
          <div
            className="wiki-modal-overlay"
            onClick={closeRelationsGraph}
            onWheel={(event) => { if (relationsView === "graph") event.preventDefault(); }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="relations-dialog-title"
          >
            <div className="wiki-modal-dialog wiki-relations-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="wiki-modal-content wiki-relations-content">
                <div className="wiki-modal-header">
                  <div>
                    <h2 id="relations-dialog-title">Related Items</h2>
                    <p className="wiki-relations-meta">
                      {linkEntries.length} relation{linkEntries.length !== 1 ? "s" : ""}
                      {relationsView === "graph" && ` · ${relationsGraph.nodes.length} nodes`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="wiki-modal-close"
                    onClick={closeRelationsGraph}
                    aria-label="Close relations"
                  >
                    ✕
                  </button>
                </div>

                <div className="wiki-relations-toolbar">
                  <div className="wiki-relations-view-toggle">
                    <button
                      type="button"
                      className={`wiki-button-small${relationsView === "list" ? " active" : ""}`}
                      onClick={() => setRelationsView("list")}
                    >
                      List
                    </button>
                    <button
                      type="button"
                      className={`wiki-button-small${relationsView === "graph" ? " active" : ""}`}
                      onClick={() => setRelationsView("graph")}
                    >
                      Graph
                    </button>
                  </div>
                  {relationsView === "graph" && (
                    <>
                      <span>Zoom: {Math.round(relationsZoom * 100)}%</span>
                      <button type="button" className="wiki-button-small" onClick={resetRelationsView}>
                        Reset View
                      </button>
                    </>
                  )}
                </div>

                {relationsView === "list" ? (
                  <div className="wiki-relations-list">
                    {linkEntries.length === 0 ? (
                      <p className="wiki-muted">No related items for this product.</p>
                    ) : (
                      linkEntries.map((linkEntry, index) => {
                        const linkedEntry =
                          linkedEntriesLookup.get(linkEntry.id) ??
                          catalogEntries.find(
                            (catalogEntry) =>
                              catalogEntry.documentId === linkEntry.id ||
                              String(catalogEntry.id) === linkEntry.id
                          );
                        const targetId = linkedEntry?.documentId ?? linkEntry.id;
                        const linkedImage = linkedEntry?.pictureUrls?.[0];
                        const confidencePct =
                          linkEntry.confidence !== undefined
                            ? Math.round(linkEntry.confidence * 100)
                            : null;

                        return (
                          <article key={`${linkEntry.id}-${index}`} className="wiki-relations-list-card">
                            <Link
                              href={`/products/${targetId}`}
                              className="wiki-relations-list-image-link"
                              onClick={closeRelationsGraph}
                            >
                              {linkedImage ? (
                                <img
                                  src={linkedImage}
                                  alt={linkedEntry?.title ?? linkEntry.id}
                                  className="wiki-relations-list-image"
                                />
                              ) : (
                                <div className="wiki-relations-list-image wiki-relations-list-image-placeholder">
                                  {linkedEntry ? linkedEntry.title.slice(0, 2) : "?"}
                                </div>
                              )}
                            </Link>
                            <div className="wiki-relations-list-info">
                              {linkedEntry ? (
                                <Link
                                  href={`/products/${targetId}`}
                                  className="wiki-relations-list-title"
                                  onClick={closeRelationsGraph}
                                >
                                  {linkedEntry.title}
                                </Link>
                              ) : (
                                <span className="wiki-relations-list-title wiki-muted">{linkEntry.id}</span>
                              )}
                              {linkedEntry?.artNr && (
                                <span className="wiki-relations-list-artnr">{linkedEntry.artNr}</span>
                              )}
                              <div className="wiki-relations-list-meta">
                                {confidencePct !== null && (
                                  <span className="wiki-relation-confidence">{confidencePct}%</span>
                                )}
                                {linkEntry.source && (
                                  <span className="wiki-relation-source">{linkEntry.source}</span>
                                )}
                              </div>
                            </div>
                          </article>
                        );
                      })
                    )}
                    {catalogLoading && (
                      <p className="wiki-muted">Loading catalogue...</p>
                    )}
                  </div>
                ) : (
                  relationsGraph.nodes.length === 0 ? (
                    <p className="wiki-muted">No link graph available for this product.</p>
                  ) : (
                    <svg
                      ref={relSvgRef}
                      className={`wiki-relations-canvas ${isDraggingRelations ? "dragging" : ""}`}
                      viewBox={`0 0 ${relationsViewport.width} ${relationsViewport.height}`}
                      role="img"
                      aria-label="Product links graph"
                      onWheel={onRelationsWheel}
                      onMouseDown={onRelationsMouseDown}
                      onMouseMove={onRelationsMouseMove}
                      onMouseUp={onRelationsMouseUp}
                      onMouseLeave={onRelationsMouseUp}
                    >
                      <defs>
                        <clipPath id="rel-node-img-clip">
                          <circle cx="0" cy="-28" r="38" />
                        </clipPath>
                        <clipPath id="rel-node-content-clip">
                          <circle cx="0" cy="0" r={REL_NODE_RADIUS - 3} />
                        </clipPath>
                      </defs>

                      <g transform={`translate(${relationsPan.x}, ${relationsPan.y}) scale(${relationsZoom})`}>
                        {relationsGraph.edges.map((edge) => {
                          const source = relationsLayout.get(edge.source);
                          const target = relationsLayout.get(edge.target);
                          if (!source || !target) return null;
                          return (
                            <line
                              key={`${edge.source}-${edge.target}`}
                              className="wiki-relations-edge"
                              x1={source.x}
                              y1={source.y}
                              x2={target.x}
                              y2={target.y}
                            />
                          );
                        })}

                        {relationsGraph.nodes.map((node) => {
                          const pos = relationsLayout.get(node.id);
                          if (!pos) return null;
                          const nodeClass = `wiki-relations-node ${node.isCurrent ? "current" : ""} ${node.isKnown ? "" : "unknown"}`;
                          return (
                            <g
                              key={node.id}
                              className={nodeClass}
                              transform={`translate(${pos.x}, ${pos.y})`}
                            >
                              <title>{node.title}</title>
                              <circle r={REL_NODE_RADIUS} />
                              <g clipPath="url(#rel-node-content-clip)">
                                {node.imageUrl ? (
                                  <image
                                    href={node.imageUrl}
                                    x="-38"
                                    y="-66"
                                    width="76"
                                    height="76"
                                    clipPath="url(#rel-node-img-clip)"
                                    preserveAspectRatio="xMidYMid slice"
                                  />
                                ) : (
                                  <circle
                                    cx="0"
                                    cy="-28"
                                    r="38"
                                    className="wiki-relations-node-image-fallback"
                                  />
                                )}
                                <text
                                  className="wiki-relations-node-title-svg"
                                  x="0"
                                  y="22"
                                  textAnchor="middle"
                                  dominantBaseline="middle"
                                >
                                  {node.title}
                                </text>
                                <text
                                  className="wiki-relations-node-subtitle-svg"
                                  x="0"
                                  y="50"
                                  textAnchor="middle"
                                  dominantBaseline="middle"
                                >
                                  {node.subTitle}
                                </text>
                              </g>
                            </g>
                          );
                        })}
                      </g>
                    </svg>
                  )
                )}

                <div className="wiki-modal-footer">
                  <button
                    type="button"
                    className="wiki-button secondary"
                    onClick={closeRelationsGraph}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </article>
    </main>
  );
}
