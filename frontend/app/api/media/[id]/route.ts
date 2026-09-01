import { type NextRequest, NextResponse } from "next/server";
import { getSessionJwt, loadUserContextCached } from "@/app/lib/auth-server";
import { getMediaById } from "@/app/lib/entries";

/**
 * GET /api/media/:id
 *
 * Returns media metadata (id, name, absolute url) for the browser. The Strapi
 * token stays on the server — the browser never talks to Strapi directly.
 * Requires a session like every other data-reading route in this app —
 * without it, a sequential numeric id is enough to enumerate the entire
 * media library unauthenticated.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json(null, { status: 401 });
  const context = await loadUserContextCached(jwt);
  if (!context?.user) return NextResponse.json(null, { status: 401 });
  if (context.user.blocked) return NextResponse.json(null, { status: 403 });

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
