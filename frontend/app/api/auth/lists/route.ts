import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext, updateMe } from "@/app/lib/auth-server";
import { sanitizeProjects, type Project } from "@/app/lib/list-types";

export async function GET() {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ lists: [] as Project[] }, { status: 401 });
  }

  const context = await loadUserContext(jwt);
  if (!context?.user) {
    return NextResponse.json({ lists: [] as Project[] }, { status: 401 });
  }

  return NextResponse.json({ lists: context.user.lists });
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

  const updated = await updateMe(jwt, { lists });
  if (!updated) {
    return NextResponse.json({ error: "Failed to persist lists." }, { status: 500 });
  }

  return NextResponse.json({ lists: updated.lists });
}
