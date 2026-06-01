import { NextResponse } from "next/server";
import {
  getSessionJwt,
  loadUserContext,
  saveUserSchemaData,
  upsertFavoriteIds,
} from "@/app/lib/auth-server";
import { readFavIds } from "@/app/lib/auth-types";

export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ favorites: [] as string[] }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ favorites: [] as string[] }, { status: 401 });
  }

  return NextResponse.json({ favorites: readFavIds(context.user.data) });
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

  if (!context.schema) {
    return NextResponse.json({ error: "User schema /api/customusers endpoint is not writable." }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { entryId?: unknown; star?: unknown } | null;
  const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
  const star = Boolean(body?.star);

  if (!entryId) {
    return NextResponse.json({ error: "entryId is required." }, { status: 400 });
  }

  const nextFav = upsertFavoriteIds(context.schema.data, entryId, star);
  const nextData = {
    ...context.schema.data,
    fav: nextFav,
  };

  // Only update the `data` JSON field on the customuser record.
  const saved = await saveUserSchemaData(context.schema.path, { data: nextData });
  if (!saved) {
    return NextResponse.json({ error: "Failed to persist favorites in /api/customusers." }, { status: 500 });
  }

  return NextResponse.json({ favorites: nextFav });
}
