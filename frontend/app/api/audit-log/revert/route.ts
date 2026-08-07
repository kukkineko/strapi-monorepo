import { NextResponse } from "next/server";
import {
  getSessionJwt,
  loadUserContext,
  updateMe,
  adminListUsers,
  adminUpdateUser,
} from "@/app/lib/auth-server";
import {
  getEntryById,
  updateEntry,
  createEntry,
} from "@/app/lib/entries";
import type { EntryPayload } from "@/app/lib/entries";
import {
  appendAuditLog,
  type AuditLogEntry,
  type EntryFieldSnapshot,
} from "@/app/lib/audit-log";

const STRAPI_URL = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");
const STRAPI_TOKEN = process.env.STRAPI_TOKEN ?? "";

async function deleteEntry(documentId: string): Promise<void> {
  const res = await fetch(`${STRAPI_URL}/api/entries/${documentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(json?.error?.message ?? "Failed to delete entry.");
  }
}

function buildPayloadFromSnapshot(snapshot: EntryFieldSnapshot, currentTitle: string): EntryPayload {
  return {
    title: snapshot.title ?? currentTitle,
    ...(snapshot.artNr    !== undefined && { artNr: snapshot.artNr }),
    ...(snapshot.EAN      !== undefined && { EAN: snapshot.EAN }),
    ...(snapshot.desc     !== undefined && { desc: snapshot.desc }),
    ...(snapshot.rubrik   !== undefined && { rubrik: snapshot.rubrik }),
    ...(snapshot.tags     !== undefined && { tags: snapshot.tags }),
    ...(snapshot.docs     !== undefined && { docs: snapshot.docs }),
    ...(snapshot.links    !== undefined && { links: snapshot.links }),
    ...(snapshot.issues   !== undefined && { issues: snapshot.issues }),
    ...(snapshot.tickets  !== undefined && { tickets: snapshot.tickets }),
    ...(snapshot.igs      !== undefined && { igs: snapshot.igs }),
  };
}

/**
 * POST /api/audit-log/revert
 *
 * Reverses a single audit-log action identified by its timestamp.
 *
 * Body:
 *   { timestamp: string, userEmail?: string }
 *
 * - `timestamp`  — the exact ISO timestamp of the log entry to revert.
 * - `userEmail`  — whose log to revert.  Defaults to the session user.
 *                  Only administrators may revert another user's actions.
 *
 * After a successful revert the original log entry is removed from the
 * user's log and a new "undo" entry is appended.
 */
export async function POST(request: Request) {
  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const context = await loadUserContext(jwt);
  if (!context?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  if (context.user.blocked) return NextResponse.json({ error: "Your account has been suspended." }, { status: 403 });
  if (!context.user.trusted) return NextResponse.json({ error: "Permission denied. Only editors can revert actions." }, { status: 403 });

  const body = (await request.json().catch(() => null)) as
    | { timestamp?: unknown; userEmail?: unknown }
    | null;

  const timestamp = typeof body?.timestamp === "string" ? body.timestamp.trim() : "";
  const targetEmail = typeof body?.userEmail === "string" ? body.userEmail.trim() : "";

  if (!timestamp) return NextResponse.json({ error: "timestamp is required." }, { status: 400 });

  /* ── Resolve the target user and their audit log ─────────────────────── */
  const isSelf = !targetEmail || targetEmail === context.user.email;

  if (!isSelf && !context.user.administrator) {
    return NextResponse.json(
      { error: "Only administrators may revert another user's actions." },
      { status: 403 },
    );
  }

  let targetUserEmail: string;
  let targetAuditLog: AuditLogEntry[];

  if (isSelf) {
    targetUserEmail = context.user.email;
    targetAuditLog  = Array.isArray(context.user.auditLog) ? (context.user.auditLog as AuditLogEntry[]) : [];
  } else {
    const users = await adminListUsers(jwt);
    const targetUser = users.find((u) => u.email === targetEmail);
    if (!targetUser) return NextResponse.json({ error: "Target user not found." }, { status: 404 });
    targetUserEmail = targetUser.email;
    targetAuditLog  = Array.isArray(targetUser.auditLog) ? (targetUser.auditLog as AuditLogEntry[]) : [];
  }

  /* ── Find the log entry ──────────────────────────────────────────────── */
  const entryIdx = targetAuditLog.findIndex((e) => e.timestamp === timestamp);
  if (entryIdx === -1) {
    return NextResponse.json({ error: "Audit log entry not found." }, { status: 404 });
  }

  const logEntry = targetAuditLog[entryIdx]!;

  if (!logEntry.snapshot) {
    return NextResponse.json(
      { error: "This log entry has no stored snapshot and cannot be undone." },
      { status: 422 },
    );
  }

  const { snapshot } = logEntry;

  /* ── Apply the reverse operation ─────────────────────────────────────── */
  try {
    if (logEntry.action === "create" && snapshot.createdId) {
      // Undo create → delete the created entry
      const existing = await getEntryById(snapshot.createdId);
      if (existing) {
        await deleteEntry(snapshot.createdId);
      }
      // If already gone, treat as already undone — still clean up the log.

    } else if (logEntry.action === "delete" && snapshot.before?.title) {
      // Undo delete → recreate the entry (new documentId; media not restored)
      await createEntry(buildPayloadFromSnapshot(snapshot.before, snapshot.before.title));

    } else if (logEntry.action === "update" && snapshot.before) {
      // Undo single-entry update → restore the before-state fields
      const current = await getEntryById(logEntry.entryId);
      if (!current) {
        return NextResponse.json(
          { error: `Entry "${logEntry.entryTitle}" no longer exists and cannot be restored.` },
          { status: 422 },
        );
      }
      await updateEntry(logEntry.entryId, buildPayloadFromSnapshot(snapshot.before, current.title));

    } else if (logEntry.action === "update" && snapshot.entries && snapshot.entries.length > 0) {
      // Undo bulk update → restore each entry's before-state
      const errors: string[] = [];
      for (const { id, before } of snapshot.entries) {
        try {
          const current = await getEntryById(id);
          if (!current) continue; // entry deleted, skip
          await updateEntry(id, buildPayloadFromSnapshot(before, current.title));
        } catch (err) {
          errors.push(id);
          console.error(`[revert] failed to restore ${id}:`, err);
        }
      }
      if (errors.length > 0 && errors.length === snapshot.entries.length) {
        return NextResponse.json({ error: "All entries failed to restore." }, { status: 500 });
      }

    } else {
      return NextResponse.json(
        { error: "Cannot determine how to undo this log entry." },
        { status: 422 },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Revert failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  /* ── Update the target user's audit log ──────────────────────────────── */
  const revertNote: AuditLogEntry = {
    action: "update",
    timestamp: new Date().toISOString(),
    entryId: logEntry.entryId,
    entryTitle: logEntry.entryTitle,
    section: logEntry.section,
    details: `Undid: ${logEntry.details}`,
  };

  const newLog = appendAuditLog(
    targetAuditLog.filter((_, i) => i !== entryIdx),
    revertNote,
  );

  if (isSelf) {
    await updateMe(jwt, { auditLog: newLog });
  } else {
    await adminUpdateUser(jwt, { email: targetUserEmail }, { auditLog: newLog });
  }

  return NextResponse.json({
    ok: true,
    truncated: snapshot.truncated ?? false,
    entriesRestored: snapshot.entries?.length ?? (snapshot.before ? 1 : 0),
  });
}
