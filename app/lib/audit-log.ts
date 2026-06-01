/**
 * Audit-log types and helpers.
 *
 * Every content-modifying action (create / update / delete) performed by a
 * trusted user is recorded as an {@link AuditLogEntry} inside that user's
 * `customuser.data.auditLog` JSON array.  The log is capped at
 * {@link MAX_LOG_ENTRIES} per user so the JSON field never grows unbounded.
 *
 * The admin panel aggregates logs from all users via the
 * `GET /api/audit-log` endpoint.
 */

/* ─── types ─────────────────────────────────────────────────────────────── */

export type AuditAction = "create" | "update" | "delete";

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
 * Append a new audit-log entry to the user's `data` object and return the
 * updated `data`.  The caller is responsible for persisting the result to
 * Strapi via {@link saveUserSchemaData}.
 */
export function appendAuditLog(
  currentData: Record<string, unknown>,
  entry: AuditLogEntry,
): Record<string, unknown> {
  const existing = Array.isArray(currentData.auditLog)
    ? (currentData.auditLog as AuditLogEntry[])
    : [];

  // Newest entries first; cap at MAX_LOG_ENTRIES.
  const updated = [entry, ...existing].slice(0, MAX_LOG_ENTRIES);

  return {
    ...currentData,
    auditLog: updated,
  };
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
