/**
 * Audit-log types and helpers.
 *
 * Every content-modifying action (create / update / delete) performed by a
 * user with the editor role is recorded as an {@link AuditLogEntry} in that
 * user's `appuser.auditLog` JSON array.  The log is capped at
 * {@link MAX_LOG_ENTRIES} per user so the JSON field never grows unbounded.
 *
 * The admin panel aggregates logs from all users via the
 * `GET /api/audit-log` endpoint.
 */

/* ─── types ─────────────────────────────────────────────────────────────── */

export type AuditAction = "create" | "update" | "delete";

/**
 * Subset of entry fields that are captured in a before-snapshot.
 * Only the fields relevant to the changed section are stored.
 */
export type EntryFieldSnapshot = {
  title?: string;
  artNr?: string;
  EAN?: string;
  desc?: string;
  rubrik?: string | string[] | Record<string, unknown>;
  tags?: string;
  docs?: string;
  links?: string;
  issues?: string;
  tickets?: string;
  igs?: string;
};

/**
 * Snapshot stored alongside an audit entry so the action can be reversed.
 *
 * - `before`      — for single-entry updates: the before-state of the changed fields
 * - `createdId`   — for creates: the documentId that was created (deleted on revert)
 * - `entries`     — for bulk operations: per-entry before-states (capped at 50)
 * - `truncated`   — true when a bulk snapshot was capped and full undo is not possible
 */
export type AuditSnapshot = {
  before?: EntryFieldSnapshot;
  createdId?: string;
  entries?: Array<{ id: string; before: EntryFieldSnapshot }>;
  truncated?: boolean;
};

export type AuditLogEntry = {
  /** "create" | "update" | "delete" */
  action: AuditAction;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Strapi documentId (or numeric id as string) of the affected entry */
  entryId: string;
  /** Title of the entry at the time of the action */
  entryTitle: string;
  /**
   * Which part of the entry was affected.
   * "entry" = the entry as a whole (create / full edit / delete)
   * "issues" | "docs" | "links" | "tickets" | "images" | "igs" = a sub-section
   */
  section: string;
  /** Human-readable summary of what changed */
  details: string;
  /**
   * Before-state snapshot enabling this action to be reversed.
   * Present on all write operations; absent on legacy log entries.
   */
  snapshot?: AuditSnapshot;
};

/**
 * Shape returned by `GET /api/audit-log` — a single log entry enriched with
 * the user who performed the action.
 */
export type UserAuditRecord = AuditLogEntry & {
  userEmail: string;
  userDisplayName: string;
};

/* ─── constants ─────────────────────────────────────────────────────────── */

/** Maximum audit-log entries kept per user. Oldest entries are evicted. */
export const MAX_LOG_ENTRIES = 200;

/* ─── helpers ───────────────────────────────────────────────────────────── */

/**
 * Append a new audit-log entry to a user's audit-log array and return the
 * updated array (newest first, capped at {@link MAX_LOG_ENTRIES}).  The caller
 * persists the result to the appuser via `updateMe(jwt, { auditLog })`.
 */
export function appendAuditLog(
  currentLog: unknown,
  entry: AuditLogEntry,
): AuditLogEntry[] {
  const existing = Array.isArray(currentLog) ? (currentLog as AuditLogEntry[]) : [];
  // Newest entries first; cap at MAX_LOG_ENTRIES.
  return [entry, ...existing].slice(0, MAX_LOG_ENTRIES);
}

/**
 * Read the audit log from a user's `data` object.
 */
export function readAuditLog(data: unknown): AuditLogEntry[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }

  const record = data as Record<string, unknown>;

  if (!Array.isArray(record.auditLog)) {
    return [];
  }

  return (record.auditLog as unknown[]).filter(
    (item): item is AuditLogEntry =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as AuditLogEntry).action === "string" &&
      typeof (item as AuditLogEntry).timestamp === "string",
  );
}

/** Maximum entries captured in a bulk-operation snapshot. */
export const MAX_SNAPSHOT_ENTRIES = 50;

/**
 * Extract the fields relevant to `section` from an entry, to be stored as a
 * before-snapshot.  Returns only the fields that could be touched by an edit
 * of that section so that an undo only restores what actually changed.
 */
export function snapshotForSection(
  entry: { title?: string; artNr?: string; EAN?: string; desc?: string; rubrik?: unknown; tags?: string; docs?: string; links?: string; issues?: string; tickets?: string; igs?: string },
  section: string,
): EntryFieldSnapshot {
  const rubrik = entry.rubrik as string | string[] | Record<string, unknown> | undefined;
  switch (section) {
    case "links":   return { title: entry.title, links: entry.links };
    case "docs":    return { title: entry.title, docs: entry.docs };
    case "issues":  return { title: entry.title, issues: entry.issues };
    case "tickets": return { title: entry.title, tickets: entry.tickets };
    case "igs":     return { title: entry.title, igs: entry.igs };
    case "tags":    return { title: entry.title, tags: entry.tags };
    case "rubrik":  return { title: entry.title, rubrik };
    default:        // "entry" — full metadata block
      return {
        title: entry.title,
        artNr: entry.artNr,
        EAN: entry.EAN,
        desc: entry.desc,
        rubrik,
        tags: entry.tags,
        docs: entry.docs,
      };
  }
}

/**
 * Build a human-readable details string for a section change.
 */
export function buildAuditDetails(
  action: AuditAction,
  section: string,
  entryTitle: string,
): string {
  const verb =
    action === "create"
      ? "Created"
      : action === "delete"
        ? "Deleted"
        : "Updated";

  if (section === "entry") {
    return `${verb} entry "${entryTitle}"`;
  }

  return `${verb} ${section} on "${entryTitle}"`;
}
