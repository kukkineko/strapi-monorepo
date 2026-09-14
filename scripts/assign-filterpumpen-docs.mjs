/**
 * Assign the 25 filter-pump datasheets/manuals researched for the ERA check HH
 * weight audit to their matching Strapi entries (by exact artNr).
 *
 * Source folder: C:/Users/mguerel/Documents/Filterpumpen-Gewichte/datenblaetter
 * Each file is named "<artNr>.pdf". Content-identical files (e.g. the same
 * Zodiac FloPro manual copied under several model artNrs) are uploaded once
 * and reused, same as scripts/assign-waermepumpen-docs.mjs.
 *
 * Usage:
 *   node scripts/assign-filterpumpen-docs.mjs [--dry-run]
 */

import fs     from "fs";
import path   from "path";
import crypto from "crypto";
import { readFile } from "fs/promises";

const ROOT = "C:/Users/mguerel/Documents/Filterpumpen-Gewichte/datenblaetter";
const CACHE_PATH = new URL("../../Filterpumpen-Gewichte/ergebnis/.assign-cache.json", import.meta.url);

const DRY_RUN = process.argv.includes("--dry-run");

const DOC_TYPE_PROSPEKT   = "Prospekte";
const DOC_TYPE_ANLEITUNG  = "Bedienungsanleitungen - Einbauanleitungen - Anschlussanleitungen";

const ARTNRS = {
  "03801":     DOC_TYPE_PROSPEKT,
  "03804":     DOC_TYPE_PROSPEKT,
  "438778":    DOC_TYPE_ANLEITUNG,
  "438780":    DOC_TYPE_ANLEITUNG,
  "SBRD627":   DOC_TYPE_ANLEITUNG,
  "SBRD629":   DOC_TYPE_ANLEITUNG,
  "SBRD631":   DOC_TYPE_ANLEITUNG,
  "SBRD632":   DOC_TYPE_ANLEITUNG,
  "SBRD633":   DOC_TYPE_ANLEITUNG,
  "SBRD716":   DOC_TYPE_ANLEITUNG,
  "SBRD751":   DOC_TYPE_ANLEITUNG,
  "SBRD754":   DOC_TYPE_ANLEITUNG,
  "WP000147":  DOC_TYPE_ANLEITUNG,
  "WP000148":  DOC_TYPE_ANLEITUNG,
  "WP000149":  DOC_TYPE_ANLEITUNG,
  "WP000150":  DOC_TYPE_ANLEITUNG,
  "WP000151":  DOC_TYPE_ANLEITUNG,
  "WP000152":  DOC_TYPE_ANLEITUNG,
  "WP000153":  DOC_TYPE_ANLEITUNG,
  "WP000154":  DOC_TYPE_ANLEITUNG,
  "WP000155":  DOC_TYPE_ANLEITUNG,
  "WP000221":  DOC_TYPE_ANLEITUNG,
  "WP000222":  DOC_TYPE_ANLEITUNG,
  "WP000003":  DOC_TYPE_ANLEITUNG,
  "WP000079":  DOC_TYPE_ANLEITUNG,
};

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

let uploadCache = {};
try { uploadCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")); } catch { uploadCache = {}; }
function saveCache() {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(uploadCache, null, 2)); } catch { /* ignore */ }
}

async function mediaExists(id) {
  try {
    const res = await fetch(`${STRAPI_URL}/api/upload/files/${id}`, { headers: AUTH_HEADERS });
    return res.ok;
  } catch { return false; }
}

async function findExistingByContent(hash, uploadName, sizeBytes) {
  const sizeKb = Math.round((sizeBytes / 1000) * 100) / 100;
  try {
    const url =
      `${STRAPI_URL}/api/upload/files` +
      `?filters[name][$eq]=${encodeURIComponent(uploadName)}` +
      `&sort=id:asc&pagination[pageSize]=100`;
    const res = await fetch(url, { headers: AUTH_HEADERS });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    for (const f of list) {
      if (f.name !== uploadName || Math.abs((f.size ?? 0) - sizeKb) >= 0.02) continue;
      const fres = await fetch(`${STRAPI_URL}${f.url}`, { headers: AUTH_HEADERS });
      if (!fres.ok) continue;
      const buf = Buffer.from(await fres.arrayBuffer());
      if (crypto.createHash("sha256").update(buf).digest("hex") === hash) return f.id;
    }
    return null;
  } catch { return null; }
}

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

async function uploadFile(filePath, uploadName) {
  const buffer = await readFile(filePath);
  const hash   = crypto.createHash("sha256").update(buffer).digest("hex");

  const cached = uploadCache[hash];
  if (cached != null && await mediaExists(cached)) return { id: cached, reused: true };

  const existing = await findExistingByContent(hash, uploadName, buffer.length);
  if (existing != null) {
    uploadCache[hash] = existing; saveCache();
    return { id: existing, reused: true };
  }

  const form = new FormData();
  form.append("files", new Blob([buffer], { type: "application/pdf" }), uploadName);

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
  uploadCache[hash] = id; saveCache();
  return { id, reused: false };
}

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

async function main() {
  console.log(`Root:    ${ROOT}`);
  console.log(`Mode:    ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Strapi:  ${STRAPI_URL}\n`);

  const stats = { uploaded: 0, reused: 0, assigned: 0, skipped: 0, noMatch: 0, missingFile: 0, errors: 0 };
  const noMatchList = [];
  const errors = [];

  for (const [artNr, docType] of Object.entries(ARTNRS)) {
    const filePath = path.join(ROOT, `${artNr}.pdf`);
    if (!fs.existsSync(filePath)) {
      console.log(`  MISSING FILE  ${artNr}.pdf`);
      stats.missingFile++;
      continue;
    }

    const matches = await findByArtNr(artNr);
    if (matches.length === 0) {
      console.log(`  NOMATCH  ${artNr}  (${docType})`);
      stats.noMatch++;
      noMatchList.push(artNr);
      continue;
    }

    console.log(`${artNr}  → ${docType}  matches=${matches.map((m) => m.title).join(", ")}`);

    if (DRY_RUN) {
      stats.assigned += matches.length;
      continue;
    }

    let mediaId;
    try {
      const up = await uploadFile(filePath, `${docType}.pdf`);
      mediaId = up.id;
      if (up.reused) { stats.reused++; console.log(`    reused   → mediaId=${mediaId}`); }
      else           { stats.uploaded++; console.log(`    uploaded → mediaId=${mediaId}`); }
    } catch (err) {
      console.error(`    ERROR uploading: ${err.message}`);
      errors.push({ artNr, error: err.message });
      stats.errors++;
      continue;
    }

    for (const match of matches) {
      try {
        const outcome = await appendDoc(match, docType, mediaId);
        console.log(`    ${outcome === "skipped" ? "SKIP " : "OK   "} ${match.title} (${match.documentId})`);
        if (outcome === "skipped") stats.skipped++;
        else stats.assigned++;
      } catch (err) {
        console.error(`    ERROR assigning to ${match.title}: ${err.message}`);
        errors.push({ artNr, entry: match.documentId, error: err.message });
        stats.errors++;
      }
    }
  }

  console.log("\n══════════════════════════════════");
  console.log(`Uploaded     : ${stats.uploaded}`);
  console.log(`Reused       : ${stats.reused}`);
  console.log(`Assigned     : ${stats.assigned}`);
  console.log(`Skipped      : ${stats.skipped}`);
  console.log(`No match     : ${stats.noMatch}`);
  console.log(`Missing file : ${stats.missingFile}`);
  console.log(`Errors       : ${stats.errors}`);

  if (noMatchList.length > 0) {
    console.log(`\nNo matching Strapi entry (artNr not found): ${noMatchList.join(", ")}`);
  }
  if (errors.length > 0) {
    console.log("\nError details:");
    errors.forEach((e) => console.log(`  ${e.artNr}${e.entry ? ` → ${e.entry}` : ""}: ${e.error}`));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
