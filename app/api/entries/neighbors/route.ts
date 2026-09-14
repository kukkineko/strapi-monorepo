import { type NextRequest, NextResponse } from "next/server";
import { getArtNrNeighbors } from "@/app/lib/entries";
import { getSessionJwt, loadUserContextCached } from "@/app/lib/auth-server";

const EMPTY = { before: [], after: [] };

/**
 * GET /api/entries/neighbors?artNr=...&count=...
 *
 * Server-side proxy for the artNr-neighbours window on the product page so the
 * Strapi token never reaches the browser. The neighbour projection only returns
 * title / artNr / EAN / pictures, so there are no employee-only fields to strip.
 */
export async function GET(req: NextRequest) {
  const artNr = req.nextUrl.searchParams.get("artNr") ?? "";
  const count = Math.max(
    1,
    Math.min(parseInt(req.nextUrl.searchParams.get("count") ?? "3", 10) || 3, 50),
  );

  if (!artNr.trim()) {
    return NextResponse.json(EMPTY, { headers: { "Cache-Control": "private, no-store" } });
  }

  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json(EMPTY, { status: 401 });

  // Run auth and the neighbour lookup concurrently; the result is only released
  // after auth passes below, so an unauthorized caller still gets nothing.
  const [context, neighbors] = await Promise.all([
    loadUserContextCached(jwt),
    getArtNrNeighbors(artNr, count),
  ]);

  if (!context?.user) return NextResponse.json(EMPTY, { status: 401 });
  if (context.user.blocked) return NextResponse.json(EMPTY, { status: 403 });

  return NextResponse.json(neighbors, {
    headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" },
  });
}
