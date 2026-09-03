import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import { normalizeShareCode } from "@/app/lib/list-types";
import { getSharedList } from "@/app/lib/shared-lists";
import { clientIpFromHeaders, isRateLimited } from "@/app/lib/rate-limit";

const REDEEM_LIMIT = 30;
const REDEEM_WINDOW_MS = 10 * 60 * 1000;

/** GET — resolve a share code to a read-only list snapshot. */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (context.user.blocked) {
    return NextResponse.json({ error: "Your account has been suspended." }, { status: 403 });
  }

  // The keyspace (31^8) already makes guessing infeasible; this rate limit
  // is defense in depth against a scripted sweep from one IP.
  const ip = clientIpFromHeaders(request.headers);
  if (isRateLimited(`lists-share-redeem:${ip}`, REDEEM_LIMIT, REDEEM_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a while and try again." },
      { status: 429 },
    );
  }

  const raw = (await params).code;
  const code = normalizeShareCode(raw);
  if (!code) {
    return NextResponse.json({ error: "List not found." }, { status: 404 });
  }

  const shared = await getSharedList(code);
  if (!shared) {
    return NextResponse.json({ error: "List not found." }, { status: 404 });
  }

  return NextResponse.json(shared);
}
