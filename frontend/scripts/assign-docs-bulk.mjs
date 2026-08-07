/**
 * Bulk-assign documents from product-files-new to Strapi entries.
 *
 * Structure:  <root>/<DocType Folder>/<artNr1>_<artNr2>.pdf
 *
 * For each file:
 *  1. Extract artNrs from the numbered filename.
 *  2. Upload the PDF to Strapi named "<FolderName>.pdf".
 *  3. Find all entries whose artNr matches any of the extracted numbers.
 *  4. Append { title: folderName, attachments: [mediaId] } to each entry's docs.
 *
 * Usage:
 *   node scripts/assign-docs-bulk.mjs [--dry-run] [--folder <path>] [--include-videos]
 */

import fs   from "fs";
import path from "path";
import { readFile } from "fs/promises";

/* ── Config ───────────────────────────────────────────────────────────────── */

const DEFAULT_ROOT = "C:/Users/mguerel/Documents/repo/dokumente/product-files-new";
const SKIP_FOLDERS = new Set(["old"]);

// Parse CLI args
const args         = process.argv.slice(2);
const DRY_RUN      = args.includes("--dry-run");
const INC_VIDEOS   = args.includes("--include-videos");
const folderArgIdx = args.indexOf("--folder");
const ROOT         = folderArgIdx !== -1 ? args[folderArgIdx + 1] : DEFAULT_ROOT;

// Read env from .env.local
const envRaw   = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
const envVars  = Object.fromEntries(
  envRaw.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    return m ? [[m[1], m[2].trim()]] : [];
  }),
);

const STRAPI_URL   = (envVars.STRAPI_URL   ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_TOKEN = envVars.STRAPI_TOKEN  ?? "";

if (!STRAPI_TOKEN) { console.error("STRAPI_TOKEN missing in .env.local"); process.exit(1); }

const AUTH_HEADERS = { Authorization: `Bearer ${STRAPI_TOKEN}` };

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Parse artNrs from a filename — numeric underscore-separated tokens. */
function parseArtNrs(filename) {
  const bare   = filename.replace(/\.[^.]+$/, ""); // strip extension
  const tokens = bare.split("_");
  const artNrs = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) artNrs.push(t);
    else break; // first non-numeric token ends the artNr section
  }
  return artNrs;
}

/** Find Strapi entries matching a single artNr. */
async function findByArtNr(artNr) {
  const url =
    `${STRAPI_URL}/api/entries` +
    `?filters[artNr][$eq]=${encodeURIComponent(artNr)}` +
    `&fields[0]=documentId&fields[1]=title&fields[2]=artNr&fields[3]=docs` +
    `&pagination[pageSize]=10`;

  const res = await fetch(url, { headers: AUTH_HEADERS });
  if (!res.ok) return [];

  const body = await res.json();
  const raw  = Array.isArray(body.data) ? body.data : [];

  return raw.map((item) => {
    const src = item.attributes ?? item;
    return {
      documentId: String(src.documentId ?? item.documentId ?? ""),
      title:      String(src.title      ?? item.title      ?? ""),
      artNr:      src.artNr  ?? item.artNr,
      docs:       src.docs   ?? item.docs,
    };
  }).filter((e) => e.documentId);
}

/** Upload a file buffer to Strapi, naming it `uploadName`. Returns media id. */
async function uploadFile(filePath, uploadName) {
  const buffer = await readFile(filePath);
  const ext    = path.extname(filePath).toLowerCase();
  const mime   = ext === ".pdf"  ? "application/pdf"
               : ext === ".mp4"  ? "video/mp4"
               : "application/octet-stream";

  const form = new FormData();
  form.append("files", new Blob([buffer], { type: mime }), uploadName);

  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method:  "POST",
    headers: AUTH_HEADERS,
    body:    form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(`Upload failed (${res.status}): ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const id   = Array.isArray(data) ? data[0]?.id : data?.id;
  if (!id) throw new Error("No media id in upload response.");
  return id;
}

/** Append a doc entry to the given Strapi entry. Skips if already present. */
async function appendDoc(entry, docType, mediaId) {
  let existing = [];
  try {
    const raw = entry.docs;
    if (raw?.trim()) existing = JSON.parse(raw);
  } catch { /* ignore */ }

  const alreadyPresent = existing.some(
    (d) => d.title === docType && (d.attachments ?? []).includes(mediaId),
  );
  if (alreadyPresent) return "skipped";

  const updated = [
    ...existing,
    { title: docType, description: "", attachments: [mediaId] },
  ];

  const res = await fetch(`${STRAPI_URL}/api/entries/${entry.documentId}`, {
    method:  "PUT",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body:    JSON.stringify({ data: { docs: JSON.stringify(updated) } }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(`PUT failed (${res.status}): ${JSON.stringify(err)}`);
  }
  return "assigned";
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Root:    ${ROOT}`);
  console.log(`Mode:    ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Strapi:  ${STRAPI_URL}\n`);

  const subfolders = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_FOLDERS.has(d.name))
    .map((d) => d.name);

  const stats = { uploaded: 0, assigned: 0, skipped: 0, noArtNr: 0, noMatch: 0, errors: 0 };
  const errors = [];

  for (const folder of subfolders) {
    const folderPath = path.join(ROOT, folder);
    const files      = fs.readdirSync(folderPath).filter((f) => {
      if (/\.pdf$/i.test(f))  return true;
      if (/\.mp4$/i.test(f))  return INC_VIDEOS;
      return false;
    });

    const ext        = folder === "Produktvideos" ? ".mp4" : ".pdf";
    const uploadName = folder + ext;

    console.log(`\n── ${folder} (${files.length} files) ──`);

    for (const filename of files) {
      const filePath = path.join(folderPath, filename);
      const artNrs   = parseArtNrs(filename);

      if (artNrs.length === 0) {
        console.log(`  SKIP  ${filename}  (no artNrs parsed)`);
        stats.noArtNr++;
        continue;
      }

      // Resolve all unique matches across all artNrs
      const seen    = new Set();
      const matches = [];
      for (const nr of artNrs) {
        const entries = await findByArtNr(nr);
        for (const e of entries) {
          if (!seen.has(e.documentId)) { seen.add(e.documentId); matches.push(e); }
        }
      }

      if (matches.length === 0) {
        console.log(`  NOMATCH  ${filename}  artNrs=[${artNrs.join(",")}]`);
        stats.noMatch++;
        continue;
      }

      console.log(`  ${filename}  → artNrs=[${artNrs.join(",")}]  matches=${matches.length}`);

      if (DRY_RUN) {
        matches.forEach((m) => console.log(`    → ${m.title} (${m.documentId})`));
        stats.uploaded++;
        stats.assigned += matches.length;
        continue;
      }

      // Upload once, assign to all matches
      let mediaId;
      try {
        mediaId = await uploadFile(filePath, uploadName);
        stats.uploaded++;
        console.log(`    uploaded → mediaId=${mediaId}`);
      } catch (err) {
        console.error(`    ERROR uploading: ${err.message}`);
        errors.push({ file: filename, error: err.message });
        stats.errors++;
        continue;
      }

      for (const match of matches) {
        try {
          const outcome = await appendDoc(match, folder, mediaId);
          console.log(`    ${outcome === "skipped" ? "SKIP " : "OK   "} ${match.title}`);
          if (outcome === "skipped") stats.skipped++;
          else stats.assigned++;
        } catch (err) {
          console.error(`    ERROR assigning to ${match.title}: ${err.message}`);
          errors.push({ file: filename, entry: match.documentId, error: err.message });
          stats.errors++;
        }
      }
    }
  }

  console.log("\n══════════════════════════════════");
  console.log(`Uploaded : ${stats.uploaded}`);
  console.log(`Assigned : ${stats.assigned}`);
  console.log(`Skipped  : ${stats.skipped}`);
  console.log(`No artNr : ${stats.noArtNr}`);
  console.log(`No match : ${stats.noMatch}`);
  console.log(`Errors   : ${stats.errors}`);

  if (errors.length > 0) {
    console.log("\nError details:");
    errors.forEach((e) => console.log(`  ${e.file}${e.entry ? ` → ${e.entry}` : ""}: ${e.error}`));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
