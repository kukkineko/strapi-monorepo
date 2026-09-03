import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import { sanitizeProject } from "@/app/lib/list-types";
import { createShareCode } from "@/app/lib/shared-lists";

/** POST — mint a share code for one of the caller's own lists. */
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

  const body = (await request.json().catch(() => null)) as {
    projectId?: unknown;
    name?: unknown;
    items?: unknown;
  } | null;

  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }

  // Sanitize the caller-supplied snapshot through the same validation used
  // for the rest of the list system, so a malformed/forged body can't reach
  // the shared store.
  const project = sanitizeProject({ id: projectId, name: body?.name, items: body?.items });
  if (!project) {
    return NextResponse.json({ error: "Invalid list data." }, { status: 400 });
  }

  const code = await createShareCode(context.user.documentId, project);
  return NextResponse.json({ code });
}
