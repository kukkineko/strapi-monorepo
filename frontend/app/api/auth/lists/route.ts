import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, updateMe } from "@/app/lib/auth-server";
import { sanitizeProjects, type Project } from "@/app/lib/list-types";
import { removeSharedList, upsertSharedList } from "@/app/lib/shared-lists";

export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ lists: [] as Project[] }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ lists: [] as Project[] }, { status: 401 });
  }

  // ownerId lets the client (app/lib/lists.ts) detect "this browser's cached
  // lists belong to a different account" — e.g. two people signing into
  // their own accounts on the same shared computer — and discard the stale
  // cache instead of migrating it onto whoever is signed in now.
  return NextResponse.json({ lists: context.user.lists, ownerId: context.user.documentId });
}

export async function POST(request: Request) {
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

  const body = (await request.json().catch(() => null)) as { lists?: unknown } | null;
  if (!body || !Array.isArray(body.lists)) {
    return NextResponse.json({ error: "lists must be an array." }, { status: 400 });
  }

  // Sanitize before persisting so only well-formed project data is stored.
  const lists = sanitizeProjects(body.lists);

  // Keep the cross-user shared-list store (app/lib/shared-lists.ts) in step
  // with whatever this save actually contains: refresh the snapshot for any
  // list that still carries a shareCode, and drop codes that were unshared
  // (or whose list was deleted) since the previous save — there's no separate
  // "unshare" endpoint, this diff against the previous saved state is the
  // only place that transition is visible.
  const previousCodes = new Set(
    context.user.lists.map((p) => p.shareCode).filter((c): c is string => Boolean(c)),
  );
  const nextCodes = new Map(
    lists.filter((p): p is Project & { shareCode: string } => Boolean(p.shareCode)).map((p) => [p.shareCode, p]),
  );
  const ownerUserId = context.user.documentId;
  await Promise.all([
    ...[...previousCodes].filter((code) => !nextCodes.has(code)).map((code) => removeSharedList(ownerUserId, code)),
    ...[...nextCodes.entries()].map(([code, project]) => upsertSharedList(ownerUserId, code, project)),
  ]);

  const updated = await updateMe(jwt, { lists });
  if (!updated) {
    return NextResponse.json({ error: "Failed to persist lists." }, { status: 500 });
  }

  return NextResponse.json({ lists: updated.lists });
}
