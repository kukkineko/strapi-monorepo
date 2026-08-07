/**
 * Convert existing TIFF images in Strapi to JPEG.
 *
 * Streams media page-by-page, never holding more than one page in memory.
 * For each TIFF found: converts, uploads JPEG, patches entry references,
 * then deletes the original TIFF.
 *
 * Usage:
 *   node scripts/convert-tiff-to-jpeg.mjs [--dry-run]
 */

import fs from "fs";

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("sharp not found — run: npm install sharp");
  process.exit(1);
}

/* ── Config ───────────────────────────────────────────────────────────────── */

const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

const envRaw = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
const envVars = Object.fromEntries(
  envRaw.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    return m ? [[m[1], m[2].trim()]] : [];
  }),
);

const STRAPI_URL   = (envVars.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_TOKEN = envVars.STRAPI_TOKEN ?? "";

if (!STRAPI_TOKEN) { console.error("STRAPI_TOKEN missing in .env.local"); process.exit(1); }

const AUTH = { Authorization: `Bearer ${STRAPI_TOKEN}` };

/* ── Strapi helpers ───────────────────────────────────────────────────────── */

async function downloadMedia(url) {
  if (!url.startsWith("http")) url = STRAPI_URL + url;
  const res = await fetch(url, { headers: AUTH });
  if (!res.ok) throw new Error(`Download failed ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadJpeg(buffer, originalName) {
  const newName = originalName.replace(/\.tiff?$/i, ".jpg");
  const form = new FormData();
  form.append("files", new File([buffer.buffer], newName, { type: "image/jpeg" }));
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: "POST", headers: AUTH, body: form,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text().catch(() => "")}`);
  const data = await res.json();
  const item = Array.isArray(data) ? data[0] : data;
  if (!item?.id) throw new Error("Upload returned no id");
  return item;
}

async function deleteMedia(id) {
  const res = await fetch(`${STRAPI_URL}/api/upload/files/${id}`, {
    method: "DELETE", headers: AUTH,
  });
  if (!res.ok) console.warn(`  ⚠ Could not delete old media ${id}: ${res.status}`);
}

/** Find entries whose pictures or miscFile contain the given media ID. */
async function findEntriesReferencingMedia(mediaId) {
  const results = [];
  for (const relation of ["pictures", "miscFile"]) {
    let page = 1;
    while (true) {
      const url =
        `${STRAPI_URL}/api/entries` +
        `?filters[${relation}][id][$eq]=${mediaId}` +
        `&populate[0]=pictures&populate[1]=miscFile` +
        `&fields[0]=documentId&fields[1]=id` +
        `&pagination[page]=${page}&pagination[pageSize]=50`;
      const res = await fetch(url, { headers: AUTH });
      if (!res.ok) break;
      const body = await res.json();
      const items = Array.isArray(body.data) ? body.data : [];
      for (const entry of items) {
        const src = entry.attributes ?? entry;
        const documentId = String(src.documentId ?? entry.documentId ?? entry.id ?? "");
        if (!documentId) continue;
        const picIds  = extractIds(src.pictures);
        const miscIds = extractIds(src.miscFile);
        results.push({ documentId, picIds, miscIds });
      }
      if (items.length < 50) break;
      page++;
    }
  }
  // deduplicate by documentId (entry might appear in both queries)
  const seen = new Set();
  return results.filter(({ documentId }) => {
    if (seen.has(documentId)) return false;
    seen.add(documentId);
    return true;
  });
}

function extractIds(relation) {
  const arr = Array.isArray(relation?.data) ? relation.data
    : Array.isArray(relation) ? relation : [];
  return arr.map((m) => Number(m?.id ?? 0)).filter((n) => n > 0);
}

async function updateEntryMedia(documentId, pictures, miscFile) {
  const res = await fetch(`${STRAPI_URL}/api/entries/${documentId}`, {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { pictures, miscFile } }),
  });
  if (!res.ok) throw new Error(`Failed to update ${documentId}: ${res.status} ${await res.text().catch(() => "")}`);
}

/* ── Main — stream media page by page ────────────────────────────────────── */

console.log(DRY_RUN ? "=== DRY RUN — no writes ===" : "=== Converting TIFFs to JPEG ===");
console.log();

let converted = 0, errors = 0, page = 1;

while (true) {
  const res = await fetch(
    `${STRAPI_URL}/api/upload/files?pagination[page]=${page}&pagination[pageSize]=100&sort=id:asc`,
    { headers: AUTH },
  );
  if (!res.ok) throw new Error(`Failed to list media page ${page}: ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body) ? body : (body.results ?? []);
  if (items.length === 0) break;

  for (const item of items) {
    const isTiff =
      item.mime === "image/tiff" ||
      /\.tiff?$/i.test(item.name ?? "") ||
      /\.tiff?(\?|#|$)/i.test(item.url ?? "");
    if (!isTiff) continue;

    console.log(`Found TIFF [${item.id}] ${item.name}`);

    try {
      // Download
      const orig = await downloadMedia(item.url ?? "");
      console.log(`  Downloaded ${Math.round(orig.length / 1024)} KB`);

      // Convert
      const jpeg = await sharp(orig).jpeg({ quality: 92 }).toBuffer();
      console.log(`  Converted  ${Math.round(jpeg.length / 1024)} KB JPEG`);

      // Find referencing entries
      const refs = await findEntriesReferencingMedia(item.id);

      if (DRY_RUN) {
        if (refs.length > 0) {
          console.log(`  Would update ${refs.length} entry reference(s):`);
          for (const { documentId } of refs) console.log(`    • ${documentId}`);
        } else {
          console.log(`  No entry references (orphan media)`);
        }
        console.log(`  Would delete old TIFF [${item.id}]`);
        console.log();
        converted++;
        continue;
      }

      // Upload JPEG
      const newMedia = await uploadJpeg(jpeg, item.name ?? "image.tiff");
      console.log(`  Uploaded as [${newMedia.id}] ${newMedia.name}`);

      // Update entries
      for (const { documentId, picIds, miscIds } of refs) {
        const newPics  = picIds.map((id) => id === item.id ? newMedia.id : id);
        const newMisc  = miscIds.map((id) => id === item.id ? newMedia.id : id);
        await updateEntryMedia(documentId, newPics, newMisc);
        console.log(`  Updated entry ${documentId}`);
      }

      // Delete old TIFF
      await deleteMedia(item.id);
      console.log(`  Deleted old TIFF [${item.id}]`);
      console.log();
      converted++;
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      errors++;
      console.log();
    }
  }

  if (items.length < 100) break;
  page++;
}

if (converted === 0 && errors === 0) {
  console.log("No TIFF images found. Nothing to do.");
} else {
  console.log(`Done. ${converted} converted, ${errors} error(s).`);
  if (DRY_RUN) console.log("(Dry run — no changes were made)");
}
