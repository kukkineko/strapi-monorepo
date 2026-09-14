/**
 * Shared, framework-agnostic types + sanitizers for "Liste erstellen" project
 * lists. Kept free of React / browser APIs so both the client store
 * ([[lists]] in app/lib/lists.ts) and server code (auth mapping, the
 * /api/auth/lists route) can import it.
 *
 * Lists persist on the user's Strapi `appuser` record (json `lists` field), so
 * the same shapes are validated on the way in and out on both sides.
 */

export type ListItem = {
  /** documentId of the linked entry (stable across sessions). */
  entryId: string;
  /** Snapshot of the article name/artNr so rows render without a round-trip. */
  title: string;
  artNr?: string;
  /** User-editable position number. Free-form — any two items may share one. */
  position: number;
  /** User-editable quantity. */
  amount: number;
};

export type Project = {
  id: string;
  name: string;
  items: ListItem[];
  createdAt: number;
  updatedAt: number;
};

export function generateListId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeItem(raw: unknown): ListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entryId = typeof r.entryId === "string" ? r.entryId.trim() : "";
  if (!entryId) return null;
  const position = Number(r.position);
  const amount = Number(r.amount);
  return {
    entryId,
    title: typeof r.title === "string" ? r.title : entryId,
    artNr: typeof r.artNr === "string" && r.artNr.trim() ? r.artNr : undefined,
    position: Number.isFinite(position) ? position : 0,
    amount: Number.isFinite(amount) && amount > 0 ? amount : 1,
  };
}

export function sanitizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id : generateListId();
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : "Liste";
  const items = Array.isArray(r.items)
    ? r.items.map(sanitizeItem).filter((i): i is ListItem => i !== null)
    : [];
  const createdAt = Number(r.createdAt);
  const updatedAt = Number(r.updatedAt);
  return {
    id,
    name,
    items,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

/** Coerce arbitrary stored/received JSON into a clean Project[] (drops junk). */
export function sanitizeProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeProject).filter((p): p is Project => p !== null);
}
