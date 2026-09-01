import { NextResponse } from "next/server";
import sharp from "sharp";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import { uploadMedia } from "@/app/lib/entries";

/* Uploads are later served unauthenticated from this app's own origin (see
 * the /uploads/:path* rewrite in next.config.ts), so an allowlist matters
 * here for more than correctness: anything that can carry an active script
 * (SVG, HTML, ...) would run as same-origin stored XSS the moment someone
 * opens an attachment link. Everything else is a plain DoS/quota concern. */
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);
const MAX_FILES_PER_UPLOAD = 30;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB — covers large scanned TIFFs
const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB per request

async function convertTiffToJpeg(file: File): Promise<File> {
  const isTiff = /\.tiff?$/i.test(file.name) || file.type === "image/tiff";
  if (!isTiff) return file;
  const arrayBuffer = await file.arrayBuffer();
  const jpegBuffer = await sharp(new Uint8Array(arrayBuffer)).jpeg({ quality: 92 }).toBuffer();
  const newName = file.name.replace(/\.tiff?$/i, ".jpg");
  return new File([jpegBuffer.buffer as ArrayBuffer], newName, { type: "image/jpeg" });
}

/**
 * POST /api/media
 *
 * Upload files to the Strapi media library. Only editors (write access) may
 * upload, and the Strapi token stays on the server. Body is multipart form
 * data with one or more `files` fields. Returns { ids: number[] }.
 */
export async function POST(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!context.user.trusted) {
    return NextResponse.json(
      { error: "Permission denied. Only editors can upload media." },
      { status: 403 },
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const rawFiles = form.getAll("files").filter((f): f is File => f instanceof File);
  if (rawFiles.length === 0) {
    return NextResponse.json({ error: "No files provided." }, { status: 400 });
  }
  if (rawFiles.length > MAX_FILES_PER_UPLOAD) {
    return NextResponse.json(
      { error: `Too many files in one upload (max ${MAX_FILES_PER_UPLOAD}).` },
      { status: 413 },
    );
  }
  let totalBytes = 0;
  for (const f of rawFiles) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `"${f.name}" exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB per-file limit.` },
        { status: 413 },
      );
    }
    totalBytes += f.size;
    const mime = f.type || "application/octet-stream";
    const isTiff = /\.tiff?$/i.test(f.name); // TIFF often arrives without a proper MIME type
    if (!ALLOWED_MIME_TYPES.has(mime) && !isTiff) {
      return NextResponse.json(
        { error: `"${f.name}" has an unsupported file type (${mime}).` },
        { status: 415 },
      );
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: `Upload exceeds the ${MAX_TOTAL_BYTES / (1024 * 1024)} MB total limit.` },
      { status: 413 },
    );
  }

  try {
    const files = await Promise.all(rawFiles.map(convertTiffToJpeg));
    const ids = await uploadMedia(files);
    return NextResponse.json({ ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
