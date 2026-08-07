import { NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import {
  getEntryById,
  updateEntry,
  parseLinkEntries,
  serializeLinkEntries,
} from "@/app/lib/entries";
import type { LinkVote } from "@/app/lib/entries";

/**
 * POST /api/entries/vote
 * Body: { entryId, targetId, vote: 1 | -1 | 0, reason?: string }
 *
 * Casts or removes a thumbs-up (1) / thumbs-down (-1) vote on the link
 * between entryId and targetId. Vote 0 removes any existing vote.
 * Updates both sides of the bidirectional link.
 */
export async function POST(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const context = await loadUserContext(jwt);
  if (!context?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const userId = context.user.userID || String(context.user.id);
  if (!userId) return NextResponse.json({ error: "Cannot identify user." }, { status: 400 });

  const body = (await request.json().catch(() => null)) as {
    entryId?: unknown;
    targetId?: unknown;
    vote?: unknown;
    reason?: unknown;
  } | null;

  const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
  const targetId = typeof body?.targetId === "string" ? body.targetId.trim() : "";
  const voteVal = body?.vote === 1 ? 1 : body?.vote === -1 ? -1 : 0;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  if (!entryId || !targetId) {
    return NextResponse.json({ error: "entryId and targetId are required." }, { status: 400 });
  }
  if (entryId === targetId) {
    return NextResponse.json({ error: "Cannot vote on self-link." }, { status: 400 });
  }

  async function applyVote(docId: string, linkedId: string) {
    const entry = await getEntryById(docId);
    if (!entry) return;
    const links = parseLinkEntries(entry.links);
    const idx = links.findIndex((l) => l.id === linkedId);
    if (idx === -1) return; // link doesn't exist on this side
    const linkEntry = { ...links[idx]! };
    const votes: Record<string, LinkVote> = { ...(linkEntry.votes ?? {}) };
    if (voteVal === 0) {
      delete votes[userId];
    } else {
      votes[userId] = { v: voteVal as 1 | -1, ...(reason ? { r: reason } : {}) };
    }
    linkEntry.votes = Object.keys(votes).length > 0 ? votes : undefined;
    links[idx] = linkEntry;
    await updateEntry(docId, {
      title: entry.title,
      links: serializeLinkEntries(links),
    });
  }

  try {
    await Promise.all([applyVote(entryId, targetId), applyVote(targetId, entryId)]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vote failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
