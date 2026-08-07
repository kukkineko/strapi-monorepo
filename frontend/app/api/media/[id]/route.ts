import { type NextRequest, NextResponse } from "next/server";
import { getMediaById } from "@/app/lib/entries";

/**
 * GET /api/media/:id
 *
 * Returns media metadata (id, name, absolute url) for the browser. The Strapi
 * token stays on the server — the browser never talks to Strapi directly.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId <= 0) {
    return NextResponse.json(null, { status: 400 });
  }

  const media = await getMediaById(numId);
  if (!media) {
    return NextResponse.json(null, { status: 404 });
  }

  return NextResponse.json(media, {
    headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=600" },
  });
}
