import { NextResponse } from "next/server";
import { createCustomUser, loadUserContext, saveUserSchemaData, setSessionJwt } from "@/app/lib/auth-server";
import {
  buildCompanyJson,
  buildNameJson,
  buildUsernameJson,
  hydrateAuthUserFromProfile,
  toJsonField,
  toObjectRecord,
  type AuthUser,
} from "@/app/lib/auth-types";

const STRAPI_BASE_URL = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_COLLISION_TOKEN = process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN;

function sanitizeUser(payload: unknown): AuthUser | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const source = payload as Record<string, unknown>;
  const id = Number(source.id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  const data = toObjectRecord(source.data);

  return {
    id,
    userID: typeof source.userID === "string" ? source.userID : "",
    name: toJsonField(source.name ?? source.name_Surname),
    username: toJsonField(source.username),
    email: typeof source.email === "string" ? source.email : "",
    company: toJsonField(source.company ?? data.company),
    confirmed: Boolean(source.confirmed),
    trusted: Boolean(source.trusted),
    blocked: Boolean(source.blocked),
    employee: Boolean(source.employee),
    administrator: Boolean(source.administrator ?? source.admin),
    data,
  };
}

function normalizeSlug(value: string): string {
  const lowered = value.trim().toLowerCase();
  const ascii = lowered.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = ascii.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "user";
}

function buildUsernameCandidates(firstName: string, surname: string): string[] {
  const firstNormalized = normalizeSlug(firstName).replace(/_/g, "");
  const surnameNormalized = normalizeSlug(surname).replace(/_/g, "");

  const firstBase = firstNormalized || "us";
  const surnameBase = surnameNormalized || "usr";

  const firstStart = Math.min(2, firstBase.length);
  const surnameStart = Math.min(3, surnameBase.length);

  const candidates: string[] = [
    `${firstBase.slice(0, firstStart)}${surnameBase.slice(0, surnameStart)}`,
  ];

  let currentFirst = firstStart;
  let currentSurname = surnameStart;

  while (currentSurname < surnameBase.length) {
    currentSurname += 1;
    candidates.push(`${firstBase.slice(0, currentFirst)}${surnameBase.slice(0, currentSurname)}`);
  }

  while (currentFirst < firstBase.length) {
    currentFirst += 1;
    candidates.push(`${firstBase.slice(0, currentFirst)}${surnameBase.slice(0, surnameBase.length)}`);
  }

  const fullBase = `${firstBase}${surnameBase}`;
  candidates.push(fullBase);

  for (let i = 1; i <= 9; i++) {
    candidates.push(`${fullBase}${i}`);
  }

  return Array.from(new Set(candidates.map((value) => value.toLowerCase()).filter(Boolean)));
}

function looksLikeUsernameCollision(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("username") && (lowered.includes("taken") || lowered.includes("already") || lowered.includes("exists") || lowered.includes("unique"));
}

async function usernameExists(username: string): Promise<boolean> {
  if (!STRAPI_COLLISION_TOKEN) {
    return false;
  }

  const params = new URLSearchParams({
    "filters[username][$eq]": username,
    "pagination[pageSize]": "1",
  });

  const response = await fetch(`${STRAPI_BASE_URL}/api/users?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${STRAPI_COLLISION_TOKEN}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  return Array.isArray(payload) && payload.length > 0;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    surname?: unknown;
    email?: unknown;
    company?: unknown;
    password?: unknown;
  } | null;

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const surname = typeof body?.surname === "string" ? body.surname.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const company = typeof body?.company === "string" ? body.company.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const nameJson = buildNameJson(name, surname);
  const companyJson = buildCompanyJson(company);

  if (!name || !surname || !email || !password) {
    return NextResponse.json({ error: "Name, surname, email, and password are required." }, { status: 400 });
  }

  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }

  const usernameCandidates = buildUsernameCandidates(name, surname);

  let successfulPayload: { jwt: string; user: unknown } | null = null;
  let lastError = "Registration failed.";

  for (const username of usernameCandidates) {
    const exists = await usernameExists(username);
    if (exists) {
      lastError = `Username ${username} already exists.`;
      continue;
    }

    const response = await fetch(`${STRAPI_BASE_URL}/api/auth/local/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        email,
        password,
      }),
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as
      | { jwt?: unknown; user?: unknown; error?: { message?: string } }
      | null;

    if (response.status === 429) {
      return NextResponse.json({ error: "Registration is being rate-limited by the backend. Please wait a moment and try again." }, { status: 429 });
    }

    if (!response.ok) {
      lastError = payload?.error?.message || lastError;
      if (looksLikeUsernameCollision(lastError)) {
        continue;
      }
      return NextResponse.json({ error: lastError }, { status: response.status || 400 });
    }

    const jwt = typeof payload?.jwt === "string" ? payload.jwt.trim() : "";
    if (!jwt) {
      return NextResponse.json({ error: "Registration succeeded but no session token was returned." }, { status: 400 });
    }

    successfulPayload = {
      jwt,
      user: payload?.user,
    };

    if (successfulPayload) {
      break;
    }
  }

  if (!successfulPayload) {
    return NextResponse.json({ error: lastError }, { status: 400 });
  }

  await setSessionJwt(successfulPayload.jwt);

  const usernameJson = buildUsernameJson(usernameCandidates[0] ?? "");

  // Best-effort: create or update the customuser record in /api/customusers.
  const context = await loadUserContext(successfulPayload.jwt);

  const customUserFields: Record<string, unknown> = {
    name: nameJson,
    username: usernameJson,
    email,
    company: companyJson,
    confirmed: false,
    trusted: false,
    blocked: false,
    employee: false,
    administrator: false,
    data: {},
  };

  if (context?.schema) {
    // Customuser record already exists (unlikely for new registration) — update it.
    await saveUserSchemaData(context.schema.path, customUserFields);
  } else {
    // No customuser record yet — create one via POST /api/customusers.
    await createCustomUser(customUserFields);
  }

  // Re-load so the response includes the freshly created customuser data.
  const refreshed = await loadUserContext(successfulPayload.jwt);

  const user = refreshed?.user ?? (sanitizeUser(successfulPayload.user) ? hydrateAuthUserFromProfile(sanitizeUser(successfulPayload.user)!, customUserFields) : null);
  return NextResponse.json({ user });
}
