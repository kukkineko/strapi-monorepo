import { type NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";

const STRAPI_BASE = (process.env.NEXT_PUBLIC_STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? process.env.NEXT_PUBLIC_STRAPI_TOKEN ?? "";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${STRAPI_TOKEN}` };
}

/* ── Filename parsing ──────────────────────────────────────────────────────── */

/**
 * Parse a PDF filename into article numbers and a document type label.
 *
 * Rules:
 *  - Split on `_`
 *  - Leading tokens that consist only of digits (after stripping a leading
 *    zero) are article numbers. We keep the *original* token (not stripped)
 *    so the search hits Strapi's stored artNr exactly.
 *  - First non-numeric token starts the document-type label; remaining
 *    tokens are joined with a space.
 *  - The `.pdf` extension is stripped before splitting.
 *
 * Example:
 *   "03135_03136_03460_Installationsanleitung.pdf"
 *     → artNrs: ["03135","03136","03460"]
 *       docType: "Installationsanleitung"
 */
export function parseDocFilename(filename: string): {
  artNrs: string[];
  docType: string;
} {
  const bare = filename.replace(/\.pdf$/i, "");
  const tokens = bare.split("_");

  const artNrs: string[] = [];
  let labelStart = tokens.length;

  for (let i = 0; i < tokens.length; i++) {
    if (/^\d+$/.test(tokens[i]!)) {
      artNrs.push(tokens[i]!);
    } else {
      labelStart = i;
      break;
    }
  }

  const docType = tokens.slice(labelStart).join(" ").trim() || "Dokument";
  return { artNrs, docType };
}

/* ── Strapi helpers ────────────────────────────────────────────────────────── */

type StrapiEntry = {
  documentId: string;
  title: string;
  artNr?: string;
  docs?: string;
};

/** Fetch up to 5 Strapi entries where artNr exactly matches `value`. */
async function findByArtNr(artNr: string): Promise<StrapiEntry[]> {
  const enc = encodeURIComponent;
  const url =
    `${STRAPI_BASE}/api/entries` +
    `?filters[artNr][$eq]=${enc(artNr)}` +
    `&fields[0]=documentId&fields[1]=title&fields[2]=artNr&fields[3]=docs` +
    `&pagination[pageSize]=5`;
  const res = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: unknown[] };
  const raw = Array.isArray(body.data) ? body.data : [];
  return raw.map((item) => {
    const obj = item as Record<string, unknown>;
    const src = (obj.attributes as Record<string, unknown> | undefined) ?? obj;
    return {
      documentId: (src.documentId ?? obj.documentId ?? "") as string,
      title:      (src.title ?? obj.title ?? "") as string,
      artNr:      (src.artNr ?? obj.artNr ?? undefined) as string | undefined,
      docs:       (src.docs ?? obj.docs ?? undefined) as string | undefined,
    };
  }).filter((e) => e.documentId);
}

type TextEntry = {
  title:       string;
  description: string;
  link?:       string;
  attachments?: (string | number)[];
};

function parseDocs(raw?: string): TextEntry[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as TextEntry[];
  } catch { /* ignore */ }
  return [];
}

function serializeDocs(entries: TextEntry[]): string {
  return JSON.stringify(entries);
}

/**
 * Upload a PDF file from the local filesystem to Strapi's media library.
 * Returns the uploaded media ID.
 */
async function uploadToStrapi(filePath: string, filename: string): Promise<number> {
  const fileBytes = fs.readFileSync(filePath);
  const blob = new Blob([fileBytes], { type: "application/pdf" });

  const form = new FormData();
  form.append("files", blob, filename);

  const res = await fetch(`${STRAPI_BASE}/api/upload`, {
    method:  "POST",
    headers: authHeaders(), // no Content-Type — browser sets it with boundary
    body:    form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as Array<{ id: number }>;
  const id = data[0]?.id;
  if (!id) throw new Error("Upload succeeded but returned no media ID.");
  return id;
}

/**
 * Append a document entry to an entry's `docs` field.
 * If the entry already has a doc with the same title+attachmentId, it is skipped.
 */
async function appendDoc(
  documentId: string,
  existingDocs: TextEntry[],
  newEntry: TextEntry,
): Promise<void> {
  // Dedup: skip if a doc with the same title and same attachment already exists.
  const alreadyPresent = existingDocs.some(
    (d) =>
      d.title === newEntry.title &&
      newEntry.attachments?.every((a) => d.attachments?.includes(a)),
  );
  if (alreadyPresent) return;

  const updated = [...existingDocs, newEntry];
  const res = await fetch(`${STRAPI_BASE}/api/entries/${documentId}`, {
    method:  "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body:    JSON.stringify({ data: { docs: serializeDocs(updated) } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT entries/${documentId} failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

/* ── Auth guard ───────────────────────────────────────────────────────────── */

async function requireAdmin(req: NextRequest): Promise<true | NextResponse> {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const ctx = await loadUserContext(jwt);
  if (!ctx?.user?.administrator)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  if (!STRAPI_TOKEN)
    return NextResponse.json({ error: "Missing Strapi API token." }, { status: 500 });
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  GET  /api/auth/admin/assign-docs?folder=<path>                           */
/*  Preview: scan folder, parse filenames, resolve Strapi matches.            */
/* ══════════════════════════════════════════════════════════════════════════ */

export type DocFile = {
  filename: string;
  artNrs:   string[];
  docType:  string;
  matches:  StrapiEntry[];
  /** True when every artNr found at least one Strapi entry. */
  allMatched: boolean;
};

export type ScanResult = {
  folder:  string;
  files:   DocFile[];
};

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard !== true) return guard;

  const { searchParams } = new URL(req.url);
  const folder = searchParams.get("folder")?.trim() ?? "";

  if (!folder) {
    return NextResponse.json({ error: "Missing `folder` query parameter." }, { status: 400 });
  }

  // Resolve the path and verify it exists and is a directory.
  let resolvedFolder: string;
  try {
    resolvedFolder = path.resolve(folder);
    const stat = fs.statSync(resolvedFolder);
    if (!stat.isDirectory())
      return NextResponse.json({ error: `"${folder}" is not a directory.` }, { status: 400 });
  } catch {
    return NextResponse.json({ error: `Cannot access folder: "${folder}".` }, { status: 400 });
  }

  // List PDF files.
  const allFiles = fs.readdirSync(resolvedFolder);
  const pdfFiles = allFiles.filter((f) => /\.pdf$/i.test(f)).sort();

  if (pdfFiles.length === 0) {
    return NextResponse.json({ folder: resolvedFolder, files: [] } satisfies ScanResult);
  }

  // For each PDF, parse artNrs and query Strapi in parallel (batched).
  const BATCH = 8;
  const results: DocFile[] = [];

  for (let i = 0; i < pdfFiles.length; i += BATCH) {
    const chunk = pdfFiles.slice(i, i + BATCH);
    const chunkResults = await Promise.all(
      chunk.map(async (filename) => {
        const { artNrs, docType } = parseDocFilename(filename);
        // Resolve matches for every artNr in parallel.
        const matchArrays = await Promise.all(artNrs.map((nr) => findByArtNr(nr)));
        // Flatten, deduplicate by documentId.
        const seen = new Set<string>();
        const matches: StrapiEntry[] = [];
        for (const arr of matchArrays) {
          for (const entry of arr) {
            if (!seen.has(entry.documentId)) {
              seen.add(entry.documentId);
              matches.push(entry);
            }
          }
        }
        const allMatched = artNrs.length > 0 && matchArrays.every((m) => m.length > 0);
        return { filename, artNrs, docType, matches, allMatched } satisfies DocFile;
      }),
    );
    results.push(...chunkResults);
  }

  return NextResponse.json({ folder: resolvedFolder, files: results } satisfies ScanResult);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  POST /api/auth/admin/assign-docs                                          */
/*  Body: { folder: string; filenames?: string[] }                            */
/*  Assign: upload each PDF to Strapi media, append doc entry to matches.     */
/* ══════════════════════════════════════════════════════════════════════════ */

type AssignResult = {
  assigned: number;
  skipped:  number;
  errors:   Array<{ filename: string; error: string }>;
  details:  Array<{ filename: string; docType: string; artNr: string; entry: string; mediaId?: number }>;
};

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard !== true) return guard;

  const body = (await req.json()) as { folder?: string; filenames?: string[] };
  const folder = body.folder?.trim() ?? "";
  if (!folder)
    return NextResponse.json({ error: "Missing `folder` in body." }, { status: 400 });

  let resolvedFolder: string;
  try {
    resolvedFolder = path.resolve(folder);
    fs.statSync(resolvedFolder).isDirectory();
  } catch {
    return NextResponse.json({ error: `Cannot access folder: "${folder}".` }, { status: 400 });
  }

  // Filenames to process — either subset specified by caller or all PDFs.
  const allFiles = fs.readdirSync(resolvedFolder).filter((f) => /\.pdf$/i.test(f));
  const toProcess = body.filenames?.length
    ? allFiles.filter((f) => body.filenames!.includes(f))
    : allFiles;

  const result: AssignResult = { assigned: 0, skipped: 0, errors: [], details: [] };

  for (const filename of toProcess) {
    const filePath = path.join(resolvedFolder, filename);
    const { artNrs, docType } = parseDocFilename(filename);
    if (artNrs.length === 0) {
      result.skipped++;
      continue;
    }

    // Resolve Strapi entries for all artNrs.
    const matchArrays = await Promise.all(artNrs.map((nr) => findByArtNr(nr)));
    const seen = new Set<string>();
    const allMatches: Array<StrapiEntry & { matchedArtNr: string }> = [];
    for (let i = 0; i < artNrs.length; i++) {
      for (const entry of matchArrays[i]!) {
        if (!seen.has(entry.documentId)) {
          seen.add(entry.documentId);
          allMatches.push({ ...entry, matchedArtNr: artNrs[i]! });
        }
      }
    }

    if (allMatches.length === 0) {
      result.skipped++;
      continue;
    }

    // Upload the PDF to Strapi once.
    let mediaId: number;
    try {
      mediaId = await uploadToStrapi(filePath, filename);
    } catch (err) {
      result.errors.push({
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Append the doc to each matched entry.
    for (const match of allMatches) {
      const existingDocs = parseDocs(match.docs);
      const newEntry: TextEntry = {
        title:       docType,
        description: "",
        attachments: [mediaId],
      };
      try {
        await appendDoc(match.documentId, existingDocs, newEntry);
        result.assigned++;
        result.details.push({
          filename,
          docType,
          artNr:   match.matchedArtNr,
          entry:   match.title,
          mediaId,
        });
      } catch (err) {
        result.errors.push({
          filename: `${filename} → ${match.documentId}`,
          error:    err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return NextResponse.json(result);
}
