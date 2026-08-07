import { NextResponse } from "next/server";
import sharp from "sharp";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import { uploadMedia } from "@/app/lib/entries";

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

  try {
    const files = await Promise.all(rawFiles.map(convertTiffToJpeg));
    const ids = await uploadMedia(files);
    return NextResponse.json({ ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
