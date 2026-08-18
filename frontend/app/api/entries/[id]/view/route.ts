import { type NextRequest, NextResponse } from "next/server";
import { getSessionJwt, loadUserContextCached } from "@/app/lib/auth-server";
import { recordView } from "@/app/lib/page-views";

/**
 * POST /api/entries/:id/view
 *
 * Records one view of an item page. `:id` is the entry's documentId (the
 * product page passes `entry.documentId`).
 *
 * The view is de-duplicated per user per item on a rolling 24h window (see
 * recordView), so we need to identify the caller. We resolve the user from the
 * session cookie via the cached context loader to keep the per-view overhead
 * low. Anonymous callers are rejected — the site is login-gated anyway.
 *
 * Fire-and-forget from the client's perspective: any failure returns a soft
 * error and never affects the article the user is reading.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id?.trim()) {
    return NextResponse.json({ ok: false, error: "Missing id." }, { status: 400 });
  }

  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ ok: false }, { status: 401 });

  const context = await loadUserContextCached(jwt);
  if (!context?.user) return NextResponse.json({ ok: false }, { status: 401 });

  const userId = context.user.userID || String(context.user.id);

  try {
    const counted = await recordView(id, userId);
    return NextResponse.json({ ok: true, counted });
  } catch {
    // Never surface a counter failure to the reader.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
