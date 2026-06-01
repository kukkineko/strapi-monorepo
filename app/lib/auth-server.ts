import { cookies } from "next/headers";
import {
  hydrateAuthUserFromProfile,
  readFavIds,
  toJsonField,
  toObjectRecord,
  type AuthUser,
} from "@/app/lib/auth-types";

export const AUTH_COOKIE_NAME = "wiki_auth_jwt";

const STRAPI_BASE_URL = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_USER_SCHEMA_PATH = process.env.STRAPI_USER_SCHEMA_PATH ?? "/api/customusers";
const STRAPI_API_TOKEN = process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";

type UserSchemaRecord = {
  id: number;
  documentId: string;
  data: Record<string, unknown>;
  path: string;
};

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }

  return Boolean(value);
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function joinUrl(path: string): string {
  return `${STRAPI_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function userAuthHeaders(jwt: string): HeadersInit {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
}

function apiTokenHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function looksLikeStrapiRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { id?: unknown; documentId?: unknown };
  return candidate.id !== undefined || candidate.documentId !== undefined;
}

function parseSchemaRecord(payload: unknown): { id: number; documentId: string; record: Record<string, unknown>; data: Record<string, unknown> } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const source = payload as { data?: unknown; id?: unknown; documentId?: unknown; attributes?: unknown };
  const wrappedData = source.data;

  // Strapi list response: { data: [ {...}, ... ] }
  if (Array.isArray(wrappedData) && wrappedData.length > 0) {
    return parseSchemaRecord(wrappedData[0]);
  }

  // Strapi v5 single response: { data: { id, documentId, ... } }
  // Only unwrap if the nested object looks like a Strapi record (has id or
  // documentId).  This avoids mistaking a content-type field literally named
  // "data" (our JSON field) for the Strapi wrapper.
  if (looksLikeStrapiRecord(wrappedData)) {
    return parseSchemaRecord(wrappedData);
  }

  // At this point `source` IS the flat record itself.
  const id = Number(source.id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  const documentId = typeof source.documentId === "string" ? source.documentId : "";

  // Strapi v4 keeps fields under `attributes`; v5 returns them flat.
  const record = source.attributes
    ? toObjectRecord(source.attributes)
    : toObjectRecord(source);

  // The customuser's `data` JSON field (used for favorites etc.).
  const data = toObjectRecord(record.data);

  return {
    id,
    documentId,
    record,
    data,
  };
}

async function tryFetchSchemaRecord(path: string): Promise<{ id: number; documentId: string; record: Record<string, unknown>; data: Record<string, unknown> } | null> {
  const response = await fetch(joinUrl(path), {
    headers: apiTokenHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as unknown;
  return parseSchemaRecord(payload);
}

export async function getSessionJwt(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value?.trim();
  return token ? token : null;
}

export async function setSessionJwt(jwt: string) {
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionJwt() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE_NAME);
}

export async function getStrapiMe(jwt: string): Promise<AuthUser | null> {
  const response = await fetch(joinUrl("/api/users/me"), {
    headers: userAuthHeaders(jwt),
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const id = Number(payload.id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  const data = toObjectRecord(payload.data);

  // The built-in Strapi user only has username (string), email, confirmed,
  // blocked, provider.  All other fields live on the customuser record and
  // will be filled in by hydrateAuthUserFromProfile when loadUserContext
  // fetches from /api/customusers.  Default every customuser-only field to
  // its empty/false value here so the hydration step can override them.
  const user: AuthUser = {
    id,
    userID: "",
    name: {},
    username: toJsonField(payload.username),
    email: toStringValue(payload.email),
    company: {},
    confirmed: false,
    trusted: false,
    blocked: false,
    employee: false,
    administrator: false,
    data: {},
  };

  return user;
}

export async function loadUserContext(jwt: string): Promise<{ user: AuthUser; schema: UserSchemaRecord | null } | null> {
  const me = await getStrapiMe(jwt);
  if (!me) {
    return null;
  }

  const schemaRoots = [STRAPI_USER_SCHEMA_PATH].filter((value, index, source) => Boolean(value) && source.indexOf(value) === index);

  for (const root of schemaRoots) {
    // Look up the customuser record by email (the natural join key with the
    // Strapi built-in user).
    const schemaPathCandidates = [
      `${root}?filters[email][$eq]=${encodeURIComponent(me.email)}&pagination[pageSize]=1&populate=*`,
    ];

    for (const path of schemaPathCandidates) {
      const parsed = await tryFetchSchemaRecord(path);
      if (parsed) {
        // Strapi v5 uses documentId for REST paths, not the numeric id.
        const docPath = parsed.documentId
          ? `${root}/${parsed.documentId}`
          : `${root}/${parsed.id}`;

        return {
          user: hydrateAuthUserFromProfile(me, parsed.record),
          schema: {
            id: parsed.id,
            documentId: parsed.documentId,
            data: parsed.data,
            path: docPath,
          },
        };
      }
    }
  }

  return {
    user: me,
    schema: null,
  };
}

export async function createCustomUser(fields: Record<string, unknown>): Promise<boolean> {
  // Strapi v5 content API: POST /api/customusers  { data: { ...fields } }
  const response = await fetch(joinUrl(STRAPI_USER_SCHEMA_PATH), {
    method: "POST",
    headers: apiTokenHeaders(),
    body: JSON.stringify({ data: fields }),
    cache: "no-store",
  });

  return response.ok;
}

export async function saveUserSchemaData(schemaPath: string, fields: Record<string, unknown>): Promise<boolean> {
  // Strapi v5 content API: PUT /api/customusers/:documentId  { data: { ...fields } }
  const response = await fetch(joinUrl(schemaPath), {
    method: "PUT",
    headers: apiTokenHeaders(),
    body: JSON.stringify({ data: fields }),
    cache: "no-store",
  });

  return response.ok;
}

export function upsertFavoriteIds(currentData: Record<string, unknown>, entryId: string, star: boolean): string[] {
  const currentFav = readFavIds(currentData);
  const deduped = new Set(currentFav);

  if (star) {
    deduped.add(entryId);
  } else {
    deduped.delete(entryId);
  }

  return Array.from(deduped);
}
