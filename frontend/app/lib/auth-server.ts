import { cookies } from "next/headers";
import { mapApiUserToAuthUser, type AuthUser } from "@/app/lib/auth-types";
import type { AuditLogEntry } from "@/app/lib/audit-log";

export const AUTH_COOKIE_NAME = "wiki_auth_jwt";

const STRAPI_BASE_URL = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const AUTH_BASE = `${STRAPI_BASE_URL}/api/app-auth`;

/* ─── session cookie ────────────────────────────────────────────────────── */

export async function getSessionJwt(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value?.trim();
  return token ? token : null;
}

export async function setSessionJwt(jwt: string) {
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionJwt() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE_NAME);
}

/* ─── request helpers ───────────────────────────────────────────────────── */

function bearer(jwt: string): HeadersInit {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
}

type AuthResult =
  | { ok: true; jwt: string; user: AuthUser | null }
  | { ok: false; status: number; error: string };

async function postAuth(path: string, body: Record<string, unknown>): Promise<AuthResult> {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | { jwt?: unknown; user?: unknown; error?: { message?: string } | string }
    | null;

  if (!response.ok) {
    const error =
      (payload && typeof payload.error === "object" && payload.error?.message) ||
      (payload && typeof payload.error === "string" && payload.error) ||
      "Authentication failed.";
    return { ok: false, status: response.status || 400, error };
  }

  const jwt = typeof payload?.jwt === "string" ? payload.jwt.trim() : "";
  if (!jwt) {
    return { ok: false, status: 400, error: "No session token was returned." };
  }
  return { ok: true, jwt, user: mapApiUserToAuthUser(payload?.user) };
}

/* ─── auth flows ────────────────────────────────────────────────────────── */

export function loginUser(identifier: string, password: string): Promise<AuthResult> {
  return postAuth("/login", { identifier, password });
}

export function registerUser(fields: {
  username: string;
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  company?: string;
}): Promise<AuthResult> {
  return postAuth("/register", fields);
}

/** Load the current user from the bearer JWT. Single source of truth. */
export async function loadUserContext(jwt: string): Promise<{ user: AuthUser } | null> {
  const response = await fetch(`${AUTH_BASE}/me`, {
    headers: bearer(jwt),
    cache: "no-store",
  });
  if (!response.ok) return null;

  const payload = (await response.json().catch(() => null)) as { user?: unknown } | null;
  const user = mapApiUserToAuthUser(payload?.user);
  return user ? { user } : null;
}

/* ─── short-TTL user-context cache (read paths only) ─────────────────────────
 * loadUserContext() is an uncached round-trip to Strapi's /me on every call.
 * Hot read endpoints (e.g. live search, fired on every keystroke) re-run it
 * needlessly. loadUserContextCached() memoises the result per-JWT for a few
 * seconds so rapid successive reads skip the round-trip.
 *
 * Deliberately NOT used by mutation/permission-changing routes — those keep
 * calling loadUserContext() directly so a freshly blocked user or role change
 * is enforced immediately, not up to USER_CONTEXT_TTL_MS later.
 */
const USER_CONTEXT_TTL_MS = 30_000;
const USER_CONTEXT_CACHE_MAX = 200;
const userContextCache = new Map<string, { value: { user: AuthUser } | null; expiresAt: number }>();
const userContextInFlight = new Map<string, Promise<{ user: AuthUser } | null>>();

export async function loadUserContextCached(jwt: string): Promise<{ user: AuthUser } | null> {
  const now = Date.now();
  const cached = userContextCache.get(jwt);
  if (cached && now < cached.expiresAt) return cached.value;

  const inFlight = userContextInFlight.get(jwt);
  if (inFlight) return inFlight;

  const request = (async () => {
    const ctx = await loadUserContext(jwt);
    // Prune expired entries when the map grows (JWTs rotate on re-login, so
    // stale keys would otherwise accumulate over time).
    if (userContextCache.size >= USER_CONTEXT_CACHE_MAX) {
      const cutoff = Date.now();
      for (const [k, v] of userContextCache) {
        if (v.expiresAt <= cutoff) userContextCache.delete(k);
      }
    }
    userContextCache.set(jwt, { value: ctx, expiresAt: Date.now() + USER_CONTEXT_TTL_MS });
    return ctx;
  })();

  userContextInFlight.set(jwt, request);
  try {
    return await request;
  } finally {
    userContextInFlight.delete(jwt);
  }
}

/** Convenience: just the user. */
export async function getStrapiMe(jwt: string): Promise<AuthUser | null> {
  const context = await loadUserContext(jwt);
  return context?.user ?? null;
}

/** Self-update (favorites, auditLog, profile fields). Uses the caller's JWT. */
export async function updateMe(jwt: string, fields: Record<string, unknown>): Promise<AuthUser | null> {
  const response = await fetch(`${AUTH_BASE}/me`, {
    method: "PUT",
    headers: bearer(jwt),
    body: JSON.stringify(fields),
    cache: "no-store",
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as { user?: unknown } | null;
  return mapApiUserToAuthUser(payload?.user);
}

/* ─── admin (administrator role required, enforced server-side) ──────────── */

export async function adminListUsers(jwt: string): Promise<AuthUser[]> {
  const response = await fetch(`${AUTH_BASE}/users`, {
    headers: bearer(jwt),
    cache: "no-store",
  });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as { users?: unknown[] } | null;
  const list = Array.isArray(payload?.users) ? payload!.users : [];
  return list
    .map((item) => mapApiUserToAuthUser(item))
    .filter((u): u is AuthUser => u !== null);
}

export async function adminUpdateUser(
  jwt: string,
  target: { documentId?: string; email?: string },
  fields: { roles?: string[]; blocked?: boolean; confirmed?: boolean; auditLog?: AuditLogEntry[] },
): Promise<boolean> {
  const response = await fetch(`${AUTH_BASE}/users`, {
    method: "PUT",
    headers: bearer(jwt),
    body: JSON.stringify({ ...target, fields }),
    cache: "no-store",
  });
  return response.ok;
}

/** Full user dump including password hashes (administrator only). For backups. */
export async function adminExportUsers(jwt: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${AUTH_BASE}/export`, {
    headers: bearer(jwt),
    cache: "no-store",
  });
  if (!response.ok) return [];
  const payload = (await response.json().catch(() => null)) as { users?: unknown[] } | null;
  return Array.isArray(payload?.users) ? (payload!.users as Record<string, unknown>[]) : [];
}

/** Upsert users by email, preserving password hashes (administrator only). */
export async function adminImportUsers(
  jwt: string,
  users: Record<string, unknown>[],
): Promise<{ ok: boolean; created: number; updated: number; skipped: number }> {
  const response = await fetch(`${AUTH_BASE}/import`, {
    method: "POST",
    headers: bearer(jwt),
    body: JSON.stringify({ users }),
    cache: "no-store",
  });
  if (!response.ok) return { ok: false, created: 0, updated: 0, skipped: users.length };
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; created?: number; updated?: number; skipped?: number }
    | null;
  return {
    ok: Boolean(payload?.ok),
    created: Number(payload?.created ?? 0),
    updated: Number(payload?.updated ?? 0),
    skipped: Number(payload?.skipped ?? 0),
  };
}

/* ─── favorites helper ──────────────────────────────────────────────────── */

export function upsertFavoriteIds(currentFavorites: string[], entryId: string, star: boolean): string[] {
  const deduped = new Set(Array.isArray(currentFavorites) ? currentFavorites : []);
  if (star) {
    deduped.add(entryId);
  } else {
    deduped.delete(entryId);
  }
  return Array.from(deduped);
}
