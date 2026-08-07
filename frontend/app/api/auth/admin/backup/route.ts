import { NextResponse } from "next/server";
import {
  getSessionJwt,
  loadUserContext,
  adminExportUsers,
  adminImportUsers,
} from "@/app/lib/auth-server";

const STRAPI_BASE_URL = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_API_TOKEN = process.env.STRAPI_TOKEN ?? "";

const PAGE_SIZE = 100;

type StrapiListResponse<T> = {
  data?: T[];
  meta?: {
    pagination?: {
      page?: number;
      pageCount?: number;
    };
  };
};

type BackupPayload = {
  backupVersion?: number;
  collections?: {
    entries?: Array<Record<string, unknown>>;
    appusers?: Array<Record<string, unknown>>;
    /** Legacy key from backupVersion 1 backups. */
    customusers?: Array<Record<string, unknown>>;
  };
};

function parseText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function normalizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const attributes = raw.attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    return {
      ...raw,
      ...(attributes as Record<string, unknown>),
    };
  }

  return raw;
}

function normalizeJsonTextField(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function sanitizeEntryPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const source = normalizeRecord(raw);

  const payload: Record<string, unknown> = {
    title: parseText(source.title),
  };

  const directKeys = ["artNr", "EAN", "desc", "rubrik"];
  for (const key of directKeys) {
    const value = source[key];
    if (value !== undefined) {
      payload[key] = value;
    }
  }

  const jsonTextKeys = ["tags", "docs", "links", "issues", "tickets"] as const;
  for (const key of jsonTextKeys) {
    const value = normalizeJsonTextField(source[key]);
    if (value !== undefined) {
      payload[key] = value;
    }
  }

  const igsValue = source.IGS ?? source.igs;
  const igsText = normalizeJsonTextField(igsValue);
  if (igsText !== undefined) {
    payload.IGS = igsText;
  }

  return payload;
}

async function fetchCollectionPage<T>(
  path: string,
  page: number,
  pageSize = PAGE_SIZE
): Promise<{ data: T[]; pageCount: number }> {
  const join = path.includes("?") ? "&" : "?";
  const url = `${STRAPI_BASE_URL}${path}${join}pagination[page]=${page}&pagination[pageSize]=${pageSize}&pagination[withCount]=true`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${path} (status ${response.status}).`);
  }

  const payload = (await response.json()) as StrapiListResponse<T>;
  const data = Array.isArray(payload.data) ? payload.data : [];
  const pageCount = payload.meta?.pagination?.pageCount ?? 1;

  return { data, pageCount };
}

async function fetchAllCollection<T>(path: string): Promise<T[]> {
  const all: T[] = [];

  const first = await fetchCollectionPage<T>(path, 1);
  all.push(...first.data);

  for (let page = 2; page <= first.pageCount; page += 1) {
    const next = await fetchCollectionPage<T>(path, page);
    all.push(...next.data);
  }

  return all;
}

export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (!STRAPI_API_TOKEN) {
    return NextResponse.json(
      { error: "Missing STRAPI API token for backups." },
      { status: 500 }
    );
  }

  try {
    const [entries, appusers] = await Promise.all([
      fetchAllCollection<Record<string, unknown>>("/api/entries?populate=*"),
      adminExportUsers(jwt),
    ]);

    const createdAt = new Date();
    const backup = {
      backupVersion: 2,
      createdAt: createdAt.toISOString(),
      source: STRAPI_BASE_URL,
      collections: {
        entries,
        appusers,
      },
    };

    const filename = `strapi-backup-${createdAt.toISOString().replace(/[:.]/g, "-")}.json`;

    return new NextResponse(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backup export failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (!STRAPI_API_TOKEN) {
    return NextResponse.json({ error: "Missing STRAPI API token for imports." }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as { backup?: BackupPayload } | null;
  const backup = body?.backup;
  if (!backup?.collections) {
    return NextResponse.json({ error: "Invalid backup payload." }, { status: 400 });
  }

  const importEntries = Array.isArray(backup.collections.entries) ? backup.collections.entries : [];
  const importUsers = Array.isArray(backup.collections.appusers)
    ? backup.collections.appusers
    : Array.isArray(backup.collections.customusers)
      ? backup.collections.customusers
      : [];

  try {
    const existingEntries = await fetchAllCollection<Record<string, unknown>>(
      "/api/entries?fields[0]=documentId&fields[1]=title",
    );

    const entryDocIds = new Set(
      existingEntries
        .map((entry) => parseText(normalizeRecord(entry).documentId))
        .filter(Boolean)
    );

    let entriesCreated = 0;
    let entriesUpdated = 0;
    let entriesSkipped = 0;
    let usersCreated = 0;
    let usersUpdated = 0;
    let usersSkipped = 0;

    for (const entryRaw of importEntries) {
      const normalized = normalizeRecord(entryRaw);
      const documentId = parseText(normalized.documentId);
      const payload = sanitizeEntryPayload(normalized);

      if (!parseText(payload.title)) {
        entriesSkipped += 1;
        continue;
      }

      if (documentId && entryDocIds.has(documentId)) {
        const updateRes = await fetch(`${STRAPI_BASE_URL}/api/entries/${documentId}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${STRAPI_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ data: payload }),
          cache: "no-store",
        });

        if (updateRes.ok) {
          entriesUpdated += 1;
        } else {
          entriesSkipped += 1;
        }

        continue;
      }

      const createRes = await fetch(`${STRAPI_BASE_URL}/api/entries`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STRAPI_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: payload }),
        cache: "no-store",
      });

      if (createRes.ok) {
        entriesCreated += 1;
      } else {
        entriesSkipped += 1;
      }
    }

    // Users are upserted by email (password hashes preserved) via the
    // administrator-only /api/app-auth/import endpoint.
    const userReport = await adminImportUsers(jwt, importUsers as Record<string, unknown>[]);
    usersCreated = userReport.created;
    usersUpdated = userReport.updated;
    usersSkipped = userReport.skipped;

    return NextResponse.json({
      ok: true,
      report: {
        entries: {
          created: entriesCreated,
          updated: entriesUpdated,
          skipped: entriesSkipped,
        },
        users: {
          created: usersCreated,
          updated: usersUpdated,
          skipped: usersSkipped,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
