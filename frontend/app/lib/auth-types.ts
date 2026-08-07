import type { AuditLogEntry } from "@/app/lib/audit-log";
import { sanitizeProjects, type Project } from "@/app/lib/list-types";

/**
 * The single application user, as consumed by the frontend.
 *
 * The backend now exposes one `appuser` record (see /api/app-auth) carrying a
 * normalized shape: `firstName`/`lastName`/`company` strings, a `roles` array,
 * and `favorites`/`auditLog` arrays. To keep the many existing UI/gating call
 * sites working unchanged, this type ALSO retains the legacy JSON-record fields
 * (`name`, `username`, `company`) and the derived permission booleans
 * (`trusted`/`employee`/`administrator`). `roles` is the source of truth; the
 * booleans are computed from it via {@link mapApiUserToAuthUser}.
 */
export type AuthUser = {
  id: number;
  documentId: string;
  userID: string;
  email: string;
  firstName: string;
  lastName: string;
  companyName: string;
  /** Legacy display shapes — kept so display helpers keep working. */
  name: Record<string, unknown>;
  username: Record<string, unknown>;
  company: Record<string, unknown>;
  /** Canonical role list (editor | staff | administrator). */
  roles: string[];
  favorites: string[];
  /** "Liste erstellen" project lists, persisted on the appuser record. */
  lists: Project[];
  auditLog: AuditLogEntry[];
  /** Legacy `{ fav, auditLog }` bag — kept for readFavIds() compatibility. */
  data: Record<string, unknown>;
  confirmed: boolean;
  blocked: boolean;
  /** Derived from `roles` for backward-compatible permission gates. */
  trusted: boolean;
  employee: boolean;
  administrator: boolean;
};

/* ─── roles ─────────────────────────────────────────────────────────────── */

export const ROLES = ["editor", "staff", "administrator"] as const;
export type Role = (typeof ROLES)[number];

/** Human labels for the role UI. */
export const ROLE_LABELS: Record<Role, string> = {
  editor: "Editor (edit entries)",
  staff: "Staff (sees internal fields)",
  administrator: "Administrator (full admin)",
};

export function normalizeRoles(value: unknown): Role[] {
  if (!Array.isArray(value)) return [];
  const out: Role[] = [];
  for (const item of value) {
    const r = String(item).trim().toLowerCase();
    if ((ROLES as readonly string[]).includes(r) && !out.includes(r as Role)) {
      out.push(r as Role);
    }
  }
  return out;
}

export function hasRole(user: Pick<AuthUser, "roles"> | null | undefined, role: Role): boolean {
  return Boolean(user && Array.isArray(user.roles) && user.roles.includes(role));
}

/* ─── record helpers ────────────────────────────────────────────────────── */

export function toObjectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/**
 * Normalise a value into a Record. Raw strings (e.g. `"johndoe"`) are wrapped
 * as `{ value: <string> }` so callers always get a Record.
 */
export function toJsonField(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { value: trimmed };
    }
  }
  return { value };
}

/* ─── API → AuthUser mapping ────────────────────────────────────────────── */

/**
 * Map a sanitized appuser from the /api/app-auth endpoints into the {@link
 * AuthUser} shape the frontend expects, deriving the legacy display records and
 * the permission booleans from the canonical fields.
 */
export function mapApiUserToAuthUser(api: unknown): AuthUser | null {
  const r = toObjectRecord(api);
  const id = Number(r.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const roles = normalizeRoles(r.roles);
  const favorites = Array.isArray(r.favorites) ? r.favorites.map((v) => String(v)).filter(Boolean) : [];
  const lists = sanitizeProjects(r.lists);
  const auditLog = Array.isArray(r.auditLog) ? (r.auditLog as AuditLogEntry[]) : [];
  const firstName = typeof r.firstName === "string" ? r.firstName : "";
  const lastName = typeof r.lastName === "string" ? r.lastName : "";
  const companyName = typeof r.company === "string" ? r.company : "";
  const username = typeof r.username === "string" ? r.username : "";

  return {
    id,
    documentId: typeof r.documentId === "string" ? r.documentId : "",
    userID: username,
    email: typeof r.email === "string" ? r.email : "",
    firstName,
    lastName,
    companyName,
    name: { name: firstName, surname: lastName },
    username: { value: username },
    company: companyName ? { name: companyName } : {},
    roles,
    favorites,
    lists,
    auditLog,
    data: { fav: favorites, auditLog },
    confirmed: Boolean(r.confirmed),
    blocked: Boolean(r.blocked),
    trusted: roles.includes("editor") && !Boolean(r.blocked),
    employee: roles.includes("staff") && !Boolean(r.blocked),
    administrator: roles.includes("administrator") && !Boolean(r.blocked),
  };
}

/* ─── display helpers (unchanged shapes) ────────────────────────────────── */

/** Extract a display string from the `name` JSON field ({name, surname}). */
export function displayName(name: Record<string, unknown>): string {
  const firstName = typeof name.name === "string" ? name.name.trim() : "";
  const surname = typeof name.surname === "string" ? name.surname.trim() : "";
  return [firstName, surname].filter(Boolean).join(" ");
}

/** Extract a display string from the `username` JSON field. */
export function displayUsername(username: Record<string, unknown>): string {
  if (typeof username.value === "string" && username.value.trim()) {
    return username.value.trim();
  }
  if (typeof username.display === "string" && username.display.trim()) {
    return username.display.trim();
  }
  for (const val of Object.values(username)) {
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

/** Extract a display string from the `company` JSON field. */
export function displayCompany(company: Record<string, unknown>): string {
  if (typeof company.name === "string" && company.name.trim()) {
    return company.name.trim();
  }
  if (typeof company.value === "string" && company.value.trim()) {
    return company.value.trim();
  }
  for (const val of Object.values(company)) {
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

/* ─── favorites ─────────────────────────────────────────────────────────── */

export function readFavIds(data: unknown): string[] {
  // Accept either the legacy `{ fav: [...] }` bag or a raw array.
  if (Array.isArray(data)) {
    return data.map((item) => String(item).trim()).filter(Boolean);
  }
  const record = toObjectRecord(data);
  const rawFav = record.fav;
  if (!Array.isArray(rawFav)) return [];
  return rawFav.map((item) => String(item).trim()).filter(Boolean);
}
