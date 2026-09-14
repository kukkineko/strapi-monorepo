import { NextResponse } from "next/server";
import {
  getSessionJwt,
  loadUserContext,
  updateMe,
  upsertFavoriteIds,
} from "@/app/lib/auth-server";

export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ favorites: [] as string[] }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ favorites: [] as string[] }, { status: 401 });
  }

  return NextResponse.json({ favorites: context.user.favorites });
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

  const body = (await request.json().catch(() => null)) as { entryId?: unknown; star?: unknown } | null;
  const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
  const star = Boolean(body?.star);

  if (!entryId) {
    return NextResponse.json({ error: "entryId is required." }, { status: 400 });
  }

  const nextFav = upsertFavoriteIds(context.user.favorites, entryId, star);
  const updated = await updateMe(jwt, { favorites: nextFav });
  if (!updated) {
    return NextResponse.json({ error: "Failed to persist favorites." }, { status: 500 });
  }

  return NextResponse.json({ favorites: updated.favorites });
}
