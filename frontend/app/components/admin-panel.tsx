"use client";

import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  displayName as formatDisplayName,
  displayUsername,
  displayCompany,
  type AuthUser,
} from "@/app/lib/auth-types";
import type { AuditLogEntry, UserAuditRecord } from "@/app/lib/audit-log";
import {
  type Entry,
  type LinkEntry,
  parseLinkEntries,
  serializeLinkEntries,
  searchEntries,
  getEntryById,
  uploadMedia,
} from "@/app/lib/entries";

/* ─── shared types ───────────────────────────────────────────────────────── */

type ImportReport = {
  entries: { created: number; updated: number; skipped: number };
  users:   { created: number; updated: number; skipped: number };
};

type GraphNode = {
  id:       string;
  label:    string;
  type:     "all" | "category" | "product";
  category?: string;
};

type GraphEdge = {
  source: string;
  target: string;
  type:   "all-category" | "category-product" | "product-product";
};

type DBStats = {
  totalEntries:          number;
  totalUsers:            number;
  totalLinkPairs:        number;
  totalLinkReferences:   number;
  entriesWithLinks:      number;
  danglingReferences:    number;
  selfReferences:        number;
  oneSidedPairs:         number;
  entriesWithDocs:       number;
  entriesWithImages:     number;
  linksWithConfidence:   number;
  linksWithoutConfidence: number;
  avgConfidence:         number | null;
  confidenceLow:         number;
  confidenceMedium:      number;
  confidenceHigh:        number;
  entriesWithTags:       number;
  totalTagCount:         number;
  avgTagsPerEntry:       number;
  categories:            Record<string, number>;
  generatedAt:           string;
};

type DBData = {
  stats: DBStats;
};

/* ─── types ──────────────────────────────────────────────────────────────── */

export type BooleanUserFlag =
  | "confirmed"
  | "trusted"
  | "employee"
  | "administrator"
  | "blocked";

const FLAGS: Array<{
  key:       BooleanUserFlag;
  label:     string;
  colorKey:  string;
}> = [
  { key: "confirmed",     label: "Confirmed", colorKey: "confirmed" },
  { key: "trusted",       label: "Trusted",   colorKey: "trusted"   },
  { key: "employee",      label: "Employee",  colorKey: "employee"  },
  { key: "administrator", label: "Admin",     colorKey: "admin"     },
  { key: "blocked",       label: "Blocked",   colorKey: "blocked"   },
];

/* ─── helpers ────────────────────────────────────────────────────────────── */

function getUserInitials(user: AuthUser): string {
  const name = formatDisplayName(user.name);
  if (name.trim()) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last  = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
  }
  const uname = displayUsername(user.username);
  if (uname) return uname[0]!.toUpperCase();
  return user.email?.[0]?.toUpperCase() ?? "?";
}

const AVATAR_PALETTE = [
  "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899",
  "#06b6d4", "#10b981", "#f59e0b", "#ef4444",
  "#0ea5e9", "#84cc16",
];

function getAvatarColor(user: AuthUser): string {
  const str = user.email || user.userID || "user";
  let hash  = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]!;
}

/* ─── FlagToggle ─────────────────────────────────────────────────────────── */

function FlagToggle({
  value,
  colorKey,
  label,
  disabled,
  onChange,
}: {
  value:    boolean;
  colorKey: string;
  label:    string;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      className={`wiki-flag-toggle flag-${colorKey}${value ? " on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!value)}
    >
      <span className="wiki-flag-toggle-knob" />
    </button>
  );
}

/* ─── UserDetailDrawer ───────────────────────────────────────────────────── */
/* Per-user detail modal showing their individual audit log with revert ops.  */

const AUDIT_ACTION_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  create: { bg: "#dcfce7", text: "#166534", label: "CREATE" },
  update: { bg: "#dbeafe", text: "#1e40af", label: "UPDATE" },
  delete: { bg: "#fee2e2", text: "#991b1b", label: "DELETE" },
};

function UserDetailDrawer({
  user,
  onClose,
  onUpdated,
}: {
  user:      AuthUser;
  onClose:   () => void;
  onUpdated: (updated: AuthUser) => void;
}) {
  const [selected,   setSelected]   = useState<Set<string>>(new Set());
  const [dateFrom,   setDateFrom]   = useState("");
  const [dateTo,     setDateTo]     = useState("");
  const [reverting,  setReverting]  = useState(false);
  const [revertMsg,  setRevertMsg]  = useState("");
  const [revertErr,  setRevertErr]  = useState("");
  // per-entry undo state: timestamp → "idle" | "pending" | "done" | "error"
  const [undoStates, setUndoStates] = useState<Map<string, string>>(new Map());
  const [undoErrors,  setUndoErrors]  = useState<Map<string, string>>(new Map());

  const displayedName =
    formatDisplayName(user.name) ||
    displayUsername(user.username) ||
    user.email.split("@")[0];

  /* apply date-range filter to the log */
  const filteredLog = useMemo<AuditLogEntry[]>(() => {
    const log = Array.isArray(user.auditLog) ? user.auditLog : [];
    return log.filter((e) => {
      if (dateFrom && e.timestamp < dateFrom) return false;
      if (dateTo) {
        const endOfDay = `${dateTo}T23:59:59.999Z`;
        if (e.timestamp > endOfDay) return false;
      }
      return true;
    });
  }, [user.auditLog, dateFrom, dateTo]);

  function toggleEntry(ts: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ts)) next.delete(ts); else next.add(ts);
      return next;
    });
  }

  function selectAll() { setSelected(new Set(filteredLog.map((e) => e.timestamp))); }
  function selectNone() { setSelected(new Set()); }

  function selectByDateRange() {
    /* When date inputs are set, select all filtered entries automatically. */
    setSelected(new Set(filteredLog.map((e) => e.timestamp)));
  }

  async function handleRevert() {
    if (reverting || selected.size === 0) return;
    if (!window.confirm(
      `Remove ${selected.size} audit entr${selected.size === 1 ? "y" : "ies"} from ${user.email}?\n\nThis only removes the log records — it does not undo the actual data changes.`
    )) return;

    setReverting(true);
    setRevertMsg("");
    setRevertErr("");

    try {
      const res = await fetch("/api/auth/admin/users", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          email:                  user.email,
          removeAuditTimestamps:  Array.from(selected),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; remaining?: number; error?: string };
      if (!res.ok || !data.ok) {
        setRevertErr(data.error ?? "Revert failed.");
      } else {
        const removed = selected.size;
        const nextLog = (user.auditLog ?? []).filter((e) => !selected.has(e.timestamp));
        onUpdated({ ...user, auditLog: nextLog });
        setSelected(new Set());
        setRevertMsg(`Removed ${removed} log entr${removed === 1 ? "y" : "ies"}. ${data.remaining ?? 0} remaining.`);
      }
    } catch {
      setRevertErr("Network error. Please try again.");
    } finally {
      setReverting(false);
    }
  }

  const selectedInView = useMemo(
    () => filteredLog.filter((e) => selected.has(e.timestamp)).length,
    [filteredLog, selected],
  );

  async function handleUndoEntry(entry: AuditLogEntry) {
    const key = entry.timestamp;
    if (undoStates.get(key) === "pending") return;
    if (!window.confirm(
      `Undo this action?\n\n"${entry.details}"\n\nThis will restore the data to its previous state.`
    )) return;
    setUndoStates((p) => new Map(p).set(key, "pending"));
    setUndoErrors((p) => { const n = new Map(p); n.delete(key); return n; });
    try {
      const res = await fetch("/api/audit-log/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: entry.timestamp, userEmail: user.email }),
      });
      const data = (await res.json()) as { ok?: boolean; truncated?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Undo failed.");
      // Remove the reverted entry from this user's local log.
      const nextLog = (user.auditLog ?? []).filter((e) => e.timestamp !== key);
      onUpdated({ ...user, auditLog: nextLog });
      setUndoStates((p) => new Map(p).set(key, "done"));
      if (data.truncated) {
        window.alert("Undo was partial — snapshot capped at 50 entries. Some changes may not have been restored.");
      }
    } catch (err) {
      setUndoErrors((p) => new Map(p).set(key, err instanceof Error ? err.message : "Undo failed."));
      setUndoStates((p) => new Map(p).set(key, "error"));
    }
  }

  const content = (
    <div className="wiki-user-detail-overlay" onClick={onClose}>
      <div className="wiki-user-detail-dialog" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="wiki-user-detail-header">
          <div
            className="wiki-admin-avatar"
            style={{ background: getAvatarColor(user), flexShrink: 0 }}
            aria-hidden="true"
          >
            {getUserInitials(user)}
          </div>
          <div className="wiki-user-detail-header-info">
            <h2>{displayedName}</h2>
            <p>{user.email}{user.administrator ? " · Admin" : user.employee ? " · Employee" : user.trusted ? " · Editor" : ""}</p>
          </div>
          {!user.confirmed && (
            <span className="wiki-admin-row-pending-badge">Pending</span>
          )}
          <button
            type="button"
            className="wiki-user-detail-close"
            onClick={onClose}
            aria-label="Close"
          >×</button>
        </div>

        {/* Body */}
        <div className="wiki-user-detail-body">

          {/* Toolbar */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div className="wiki-user-detail-toolbar">
              <span className="wiki-user-detail-toolbar-label">
                {user.auditLog?.length ?? 0} log entries total
              </span>
              <span style={{ flex: 1 }} />
              <button type="button" className="wiki-admin-view-btn" onClick={selectAll}>
                Select all {filteredLog.length > 0 ? `(${filteredLog.length})` : ""}
              </button>
              <button type="button" className="wiki-admin-view-btn" onClick={selectNone}>
                Clear
              </button>
            </div>

            {/* Date range filter */}
            <div className="wiki-user-detail-date-range">
              <span>From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); selectByDateRange(); }}
              />
              <span>to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); selectByDateRange(); }}
              />
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  className="wiki-admin-view-btn"
                  onClick={() => { setDateFrom(""); setDateTo(""); setSelected(new Set()); }}
                >
                  Clear filter
                </button>
              )}
            </div>
          </div>

          {/* Log entries */}
          {filteredLog.length === 0 ? (
            <p className="wiki-muted" style={{ textAlign: "center", padding: "2rem 0" }}>
              {(user.auditLog?.length ?? 0) === 0 ? "No audit log entries." : "No entries match the date filter."}
            </p>
          ) : (
            <div className="wiki-user-detail-log-list">
              {filteredLog.map((entry, idx) => {
                const isChecked = selected.has(entry.timestamp);
                const actionStyle = AUDIT_ACTION_COLORS[entry.action] ?? AUDIT_ACTION_COLORS.update!;
                const date = new Date(entry.timestamp);
                const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
                const timeStr = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

                return (
                  <div
                    key={`${entry.timestamp}-${idx}`}
                    className={`wiki-user-detail-log-entry${isChecked ? " checked" : ""}`}
                    onClick={() => toggleEntry(entry.timestamp)}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleEntry(entry.timestamp)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ marginTop: "3px" }}
                    />

                    {/* Badge */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.2rem" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.12rem 0.45rem",
                          borderRadius: "6px",
                          fontSize: "0.65rem",
                          fontWeight: 700,
                          background: actionStyle.bg,
                          color: actionStyle.text,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {actionStyle.label}
                      </span>
                      <span style={{ fontSize: "0.62rem", color: "var(--muted)", textTransform: "uppercase" }}>
                        {entry.section}
                      </span>
                    </div>

                    {/* Detail */}
                    <div className="wiki-user-detail-log-meta">
                      <span className="wiki-user-detail-log-details" title={entry.details}>
                        {entry.details}
                      </span>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                        <span className="wiki-user-detail-log-time">
                          {dateStr} at {timeStr} · {entry.entryId}
                        </span>
                        {entry.snapshot && undoStates.get(entry.timestamp) !== "done" && (
                          <button
                            type="button"
                            style={{
                              fontSize: "0.65rem",
                              padding: "0.08rem 0.4rem",
                              borderRadius: "4px",
                              border: "1px solid var(--line)",
                              background: undoStates.get(entry.timestamp) === "pending" ? "var(--stage-bg)" : "var(--surface)",
                              color: "var(--muted)",
                              cursor: undoStates.get(entry.timestamp) === "pending" ? "default" : "pointer",
                              fontWeight: 500,
                            }}
                            disabled={undoStates.get(entry.timestamp) === "pending"}
                            onClick={(e) => { e.stopPropagation(); void handleUndoEntry(entry); }}
                            title={entry.snapshot?.truncated ? "Partial undo — snapshot capped at 50 entries" : "Undo this action"}
                          >
                            {undoStates.get(entry.timestamp) === "pending" ? "Undoing…" : "↩ Undo"}
                          </button>
                        )}
                        {undoStates.get(entry.timestamp) === "error" && (
                          <span style={{ fontSize: "0.65rem", color: "#dc2626" }}>
                            {undoErrors.get(entry.timestamp)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="wiki-user-detail-footer">
          <span className="wiki-user-detail-footer-count">
            {selectedInView > 0
              ? `${selectedInView} entry${selectedInView !== 1 ? "ies" : ""} selected`
              : "No entries selected"}
          </span>
          {revertMsg && <span style={{ fontSize: "0.8rem", color: "#10b981" }}>{revertMsg}</span>}
          {revertErr && <span style={{ fontSize: "0.8rem", color: "#dc2626" }}>{revertErr}</span>}
          <button type="button" className="wiki-button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="wiki-button"
            style={selectedInView > 0 ? { background: "#dc2626", color: "#fff", borderColor: "#dc2626" } : undefined}
            disabled={reverting || selectedInView === 0}
            onClick={() => void handleRevert()}
          >
            {reverting ? "Removing…" : `Revert selected (${selectedInView})`}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

/* ─── UserEditDialog ─────────────────────────────────────────────────────── */
/* Lets an administrator edit a user's name and company. */

function UserEditDialog({
  user,
  onClose,
  onSaved,
}: {
  user:    AuthUser;
  onClose: () => void;
  onSaved: (updated: AuthUser) => void;
}) {
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName,  setLastName]  = useState(user.lastName ?? "");
  const [company,   setCompany]   = useState(user.companyName ?? "");
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/auth/admin/users", {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          email:  user.email,
          fields: { firstName: firstName.trim(), lastName: lastName.trim(), company: company.trim() },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Failed to save changes.");
        return;
      }
      onSaved({
        ...user,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        companyName: company.trim(),
        name: { name: firstName.trim(), surname: lastName.trim() },
        company: company.trim() ? { name: company.trim() } : {},
      });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const content = (
    <div className="wiki-user-detail-overlay" onClick={onClose}>
      <div
        className="wiki-user-detail-dialog"
        style={{ maxWidth: "440px", maxHeight: "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wiki-user-detail-header">
          <div
            className="wiki-admin-avatar"
            style={{ background: getAvatarColor(user), flexShrink: 0 }}
            aria-hidden="true"
          >
            {getUserInitials(user)}
          </div>
          <div className="wiki-user-detail-header-info">
            <h2>Edit user</h2>
            <p>{user.email}</p>
          </div>
          <button type="button" className="wiki-user-detail-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={handleSubmit} className="wiki-login-form" style={{ padding: "1.25rem" }}>
          <div className="wiki-gate-name-row">
            <label>
              <span>First name</span>
              <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
            </label>
            <label>
              <span>Last name</span>
              <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
            </label>
          </div>
          <label>
            <span>Company</span>
            <input type="text" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" />
          </label>
          {error && <p className="wiki-error" style={{ margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="submit" className="wiki-button primary" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="wiki-button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

/* ─── AdminPanelContent ──────────────────────────────────────────────────── */
/* Embeddable content block — no modal chrome or header.                      */
/* Used directly in the UserPanel admin tab.                                  */

export function AdminPanelContent() {
  const router = useRouter();

  const [users,          setUsers]          = useState<AuthUser[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState("");
  const [query,          setQuery]          = useState("");
  const [showPending,    setShowPending]    = useState(false);
  const [viewingUser,    setViewingUser]    = useState<AuthUser | null>(null);
  const [editingUser,    setEditingUser]    = useState<AuthUser | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Map<string, Partial<Record<BooleanUserFlag, boolean>>>>(new Map());
  const [savingAll,      setSavingAll]      = useState(false);
  const [savedAll,       setSavedAll]       = useState(false);

  /* fetch users */
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/auth/admin/users");
        if (!res.ok) { setError("Failed to load users."); return; }
        const data = (await res.json()) as { users: AuthUser[] };
        setUsers(data.users ?? []);
      } catch {
        setError("Network error loading users.");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  /* pending-change helpers */
  const hasPending = pendingChanges.size > 0;
  const pendingCount = useMemo(
    () => Array.from(pendingChanges.values()).reduce((s, c) => s + Object.keys(c).length, 0),
    [pendingChanges],
  );

  function stageChange(email: string, field: BooleanUserFlag, value: boolean) {
    setPendingChanges((prev) => {
      const next        = new Map(prev);
      const userChanges = { ...next.get(email) };
      const original    = users.find((u) => u.email === email)?.[field];

      if (value === original) {
        // Toggle back to original — remove from pending
        delete userChanges[field];
        if (Object.keys(userChanges).length === 0) next.delete(email);
        else next.set(email, userChanges);
      } else {
        next.set(email, { ...userChanges, [field]: value });
      }
      return next;
    });
  }

  /* effective users: server state + unsaved overrides applied for display */
  const effectiveUsers = useMemo(() => {
    if (pendingChanges.size === 0) return users;
    return users.map((u) => {
      const changes = pendingChanges.get(u.email);
      return changes ? { ...u, ...changes } : u;
    });
  }, [users, pendingChanges]);

  /* save all pending changes then refresh Next.js cache */
  async function saveAllChanges() {
    if (savingAll || !hasPending) return;
    setSavingAll(true);
    setSavedAll(false);
    const saved: string[] = [];

    for (const [email] of pendingChanges.entries()) {
      const eff = effectiveUsers.find((u) => u.email === email);
      if (!eff) continue;

      /* Translate the Trusted/Employee/Admin toggles into the canonical role
         list; Confirmed/Blocked remain account-status booleans. */
      const roles: string[] = [];
      if (eff.trusted) roles.push("editor");
      if (eff.employee) roles.push("staff");
      if (eff.administrator) roles.push("administrator");
      const fields = { roles, confirmed: eff.confirmed, blocked: eff.blocked };

      try {
        const res = await fetch("/api/auth/admin/users", {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ email, fields }),
        });
        if (res.ok) {
          setUsers((prev) => prev.map((u) => u.email === email ? {
            ...u,
            roles,
            confirmed: eff.confirmed,
            blocked: eff.blocked,
            trusted: eff.trusted,
            employee: eff.employee,
            administrator: eff.administrator,
          } : u));
          saved.push(email);
        }
      } catch { /* keep that user in pending */ }
    }

    setPendingChanges((prev) => {
      const next = new Map(prev);
      for (const email of saved) next.delete(email);
      return next;
    });

    setSavingAll(false);

    if (saved.length > 0) {
      setSavedAll(true);
      setTimeout(() => setSavedAll(false), 2200);
      /* Invalidate Next.js router cache so employee-flag changes are visible
         immediately on the next page visit — no hard refresh needed. */
      router.refresh();
    }
  }

  /* filter */
  const filteredUsers = useMemo(() => {
    let result = showPending
      ? effectiveUsers.filter((u) => !u.confirmed && !u.blocked)
      : effectiveUsers;

    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter((u) => {
        const name    = formatDisplayName(u.name).toLowerCase();
        const company = displayCompany(u.company).toLowerCase();
        return (
          name.includes(q) ||
          u.email.toLowerCase().includes(q) ||
          company.includes(q)
        );
      });
    }
    return result;
  }, [effectiveUsers, query, showPending]);

  /* stats (based on effective/pending state so counts update instantly) */
  const stats = useMemo(() => ({
    total:     effectiveUsers.length,
    confirmed: effectiveUsers.filter((u) => u.confirmed).length,
    pending:   effectiveUsers.filter((u) => !u.confirmed && !u.blocked).length,
    admins:    effectiveUsers.filter((u) => u.administrator).length,
    blocked:   effectiveUsers.filter((u) => u.blocked).length,
  }), [effectiveUsers]);

  return (
    <>
      {/* ── Stats ── */}
      {!loading && !error && (
        <div className="wiki-admin-stats" style={{ flexWrap: "wrap" }}>
          <div className="wiki-admin-stat">
            <span className="wiki-admin-stat-num">{stats.total}</span>
            <span className="wiki-admin-stat-lbl">Users</span>
          </div>
          <div className="wiki-admin-stat stat-confirmed">
            <span className="wiki-admin-stat-num">{stats.confirmed}</span>
            <span className="wiki-admin-stat-lbl">Confirmed</span>
          </div>
          {stats.pending > 0 && (
            <button
              type="button"
              className={`wiki-admin-stat stat-pending${showPending ? " wiki-admin-stat--active" : ""}`}
              style={{ cursor: "pointer", border: showPending ? "2px solid #f59e0b" : "1px solid #fde68a", borderRadius: "10px", background: showPending ? "#fef3c7" : undefined }}
              title={showPending ? "Showing pending only — click to show all" : "Click to filter pending users"}
              onClick={() => setShowPending((p) => !p)}
            >
              <span className="wiki-admin-stat-num">{stats.pending}</span>
              <span className="wiki-admin-stat-lbl">Pending ⚠</span>
            </button>
          )}
          <div className="wiki-admin-stat stat-admin">
            <span className="wiki-admin-stat-num">{stats.admins}</span>
            <span className="wiki-admin-stat-lbl">Admins</span>
          </div>
          {stats.blocked > 0 && (
            <div className="wiki-admin-stat stat-blocked">
              <span className="wiki-admin-stat-num">{stats.blocked}</span>
              <span className="wiki-admin-stat-lbl">Blocked</span>
            </div>
          )}
        </div>
      )}

      {/* ── Pending users banner ── */}
      {!loading && !error && showPending && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "10px", padding: "0.65rem 1rem", fontSize: "0.84rem", color: "#92400e" }}>
          <strong>Pending approval:</strong> showing {filteredUsers.length} unconfirmed user{filteredUsers.length !== 1 ? "s" : ""}. Click the Confirmed toggle to approve, then Save Settings.
          <button type="button" style={{ marginLeft: "1rem", fontSize: "0.78rem", color: "#2563eb", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }} onClick={() => setShowPending(false)}>
            Show all users
          </button>
        </div>
      )}

      {/* ── Search + Save bar ── */}
      {!loading && !error && (
        <div className="wiki-admin-search-row">
          <div className="wiki-admin-search-wrap">
            <svg className="wiki-admin-search-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2"/>
              <path d="M16.65 16.65L21 21" fill="none" stroke="currentColor" strokeWidth="2"/>
            </svg>
            <input
              type="search"
              className="wiki-admin-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email or company…"
              aria-label="Search users"
            />
          </div>
          {query && (
            <span className="wiki-admin-search-count">
              {filteredUsers.length} / {effectiveUsers.length}
            </span>
          )}

          {/* Save Settings button — visible only when there are pending changes */}
          <div className="wiki-admin-save-bar">
            {hasPending && !savedAll && (
              <span className="wiki-admin-pending-label">
                {pendingCount} unsaved change{pendingCount !== 1 ? "s" : ""}
              </span>
            )}
            <button
              type="button"
              className={[
                "wiki-admin-save-btn",
                savingAll ? "saving" : "",
                savedAll  ? "saved"  : "",
                !hasPending && !savedAll ? "idle" : "",
              ].filter(Boolean).join(" ")}
              disabled={savingAll || (!hasPending && !savedAll)}
              onClick={() => void saveAllChanges()}
            >
              {savingAll ? (
                <><span className="wiki-admin-spinner" aria-hidden="true" /> Saving…</>
              ) : savedAll ? (
                "✓ Saved & synced"
              ) : (
                "Save Settings"
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── States ── */}
      {loading && (
        <div className="wiki-admin-loading">
          <span className="wiki-admin-spinner" aria-hidden="true" />
          Loading users…
        </div>
      )}
      {error && <p className="wiki-error wiki-admin-error">{error}</p>}

      {/* ── Table ── */}
      {!loading && !error && (
        <div className="wiki-admin-table-wrap">
          <table className="wiki-admin-table">
            <thead>
              <tr>
                <th className="wiki-admin-th-user">User</th>
                {FLAGS.map(({ key, label, colorKey }) => (
                  <th
                    key={key}
                    className={`wiki-admin-th-flag flag-th-${colorKey}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={1 + FLAGS.length} className="wiki-admin-empty">
                    {query ? "No users match your search." : "No users found."}
                  </td>
                </tr>
              )}

              {filteredUsers.map((user) => {
                const initials      = getUserInitials(user);
                const avatarColor   = getAvatarColor(user);
                const displayedName =
                  formatDisplayName(user.name) ||
                  displayUsername(user.username) ||
                  "—";
                const company       = displayCompany(user.company);
                const isPending     = pendingChanges.has(user.email);

                return (
                  <tr
                    key={user.email}
                    className={[
                      "wiki-admin-row",
                      isPending ? "row-pending" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    {/* user cell */}
                    <td className="wiki-admin-td-user">
                      <div className="wiki-admin-user-cell">
                        <div
                          className="wiki-admin-avatar"
                          style={{ background: avatarColor }}
                          aria-hidden="true"
                        >
                          {initials}
                        </div>
                        <div className="wiki-admin-user-info">
                          <span className="wiki-admin-user-name">
                            {displayedName}
                            {isPending && (
                              <span className="wiki-admin-pending-dot" title="Unsaved changes" aria-label="Unsaved changes" />
                            )}
                            {!user.confirmed && !user.blocked && (
                              <span className="wiki-admin-row-pending-badge">Pending</span>
                            )}
                          </span>
                          <span className="wiki-admin-user-email">{user.email}</span>
                          {company && (
                            <span className="wiki-admin-user-company">{company}</span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="wiki-admin-view-btn"
                          onClick={() => setEditingUser(user)}
                          title="Edit name / company"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="wiki-admin-view-btn"
                          onClick={() => setViewingUser(user)}
                          title="View audit log"
                        >
                          View
                        </button>
                      </div>
                    </td>

                    {/* flag toggles — stage changes locally, save on button click */}
                    {FLAGS.map(({ key, label, colorKey }) => (
                      <td key={key} className="wiki-admin-td-flag">
                        <FlagToggle
                          value={user[key]}
                          colorKey={colorKey}
                          label={`${label} for ${displayedName}`}
                          disabled={savingAll}
                          onChange={(next) => stageChange(user.email, key, next)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── User Detail Drawer ── */}
      {viewingUser && (
        <UserDetailDrawer
          user={viewingUser}
          onClose={() => setViewingUser(null)}
          onUpdated={(updated) => {
            /* Reflect the updated auditLog in the local users list */
            setUsers((prev) =>
              prev.map((u) => u.email === updated.email ? { ...u, auditLog: updated.auditLog } : u)
            );
            setViewingUser(updated);
          }}
        />
      )}

      {/* ── User Edit Dialog ── */}
      {editingUser && (
        <UserEditDialog
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={(updated) => {
            setUsers((prev) => prev.map((u) => u.email === updated.email ? updated : u));
            setEditingUser(null);
          }}
        />
      )}
    </>
  );
}

/* ─── DBBackupContent ────────────────────────────────────────────────────── */
/* Export a full JSON backup or import one back into Strapi.                  */

export function DBBackupContent() {
  const [exportState, setExportState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [exportError, setExportError] = useState("");

  const [importState, setImportState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [importError, setImportError] = useState("");
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  async function handleExport() {
    setExportState("loading");
    setExportError("");
    try {
      const res = await fetch("/api/auth/admin/backup");
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Export failed.");
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const a = document.createElement("a");
      a.href     = url;
      a.download = match?.[1] ?? "strapi-backup.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportState("done");
      setTimeout(() => setExportState("idle"), 2500);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
      setExportState("error");
    }
  }

  async function handleImport() {
    if (!selectedFile) return;
    setImportState("loading");
    setImportError("");
    setImportReport(null);
    try {
      const text   = await selectedFile.text();
      const backup = JSON.parse(text) as unknown;
      const res    = await fetch("/api/auth/admin/backup", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ backup }),
      });
      const data = (await res.json()) as { ok?: boolean; report?: ImportReport; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Import failed.");
      }
      setImportReport(data.report ?? null);
      setImportState("done");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
      setImportState("error");
    }
  }

  return (
    <div className="wiki-admin-db-section">
      {/* ── Export card ── */}
      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">⬇</span>
          <div>
            <h3>Export Backup</h3>
            <p>Download a full JSON backup of all entries and users.</p>
          </div>
        </div>
        <button
          type="button"
          className={[
            "wiki-admin-db-btn",
            "export",
            exportState === "loading" ? "loading" : "",
            exportState === "done"    ? "done"    : "",
          ].filter(Boolean).join(" ")}
          disabled={exportState === "loading"}
          onClick={() => void handleExport()}
        >
          {exportState === "loading" && <span className="wiki-admin-spinner" aria-hidden="true" />}
          {exportState === "done"    ? "✓ Downloaded!" :
           exportState === "loading" ? "Exporting…"   : "Export DB Backup"}
        </button>
        {exportState === "error" && <p className="wiki-error">{exportError}</p>}
      </div>

      {/* ── Import card ── */}
      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">⬆</span>
          <div>
            <h3>Import Backup</h3>
            <p>
              Restore from a previously exported JSON backup. Existing records are
              updated; new ones are created.
            </p>
          </div>
        </div>

        <div className="wiki-admin-db-import-row">
          <label className="wiki-admin-db-file-label">
            <input
              type="file"
              accept=".json,application/json"
              className="wiki-admin-db-file-input"
              onChange={(e) => {
                setSelectedFile(e.target.files?.[0] ?? null);
                setImportState("idle");
                setImportReport(null);
                setImportError("");
              }}
            />
            <span className="wiki-admin-db-file-name">
              {selectedFile ? selectedFile.name : "Choose backup file…"}
            </span>
          </label>

          <button
            type="button"
            className={[
              "wiki-admin-db-btn",
              "import",
              importState === "loading" ? "loading" : "",
              importState === "done"    ? "done"    : "",
            ].filter(Boolean).join(" ")}
            disabled={!selectedFile || importState === "loading"}
            onClick={() => void handleImport()}
          >
            {importState === "loading" && <span className="wiki-admin-spinner" aria-hidden="true" />}
            {importState === "done"    ? "✓ Imported!" :
             importState === "loading" ? "Importing…"  : "Import"}
          </button>
        </div>

        {importState === "error" && <p className="wiki-error">{importError}</p>}

        {importState === "done" && importReport && (
          <div className="wiki-admin-db-report">
            <div className="wiki-admin-db-report-section">
              <strong>Entries</strong>
              <span className="wiki-admin-db-report-pill created">{importReport.entries.created} created</span>
              <span className="wiki-admin-db-report-pill updated">{importReport.entries.updated} updated</span>
              {importReport.entries.skipped > 0 && (
                <span className="wiki-admin-db-report-pill skipped">{importReport.entries.skipped} skipped</span>
              )}
            </div>
            <div className="wiki-admin-db-report-section">
              <strong>Users</strong>
              <span className="wiki-admin-db-report-pill created">{importReport.users.created} created</span>
              <span className="wiki-admin-db-report-pill updated">{importReport.users.updated} updated</span>
              {importReport.users.skipped > 0 && (
                <span className="wiki-admin-db-report-pill skipped">{importReport.users.skipped} skipped</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── CrossLinkGraph ─────────────────────────────────────────────────────── */
/* Canvas-based force-directed graph. Simulation runs synchronously (all      */
/* steps before first paint) so no animation glitch or per-frame freeze.      */
/* Grid-based O(n) repulsion handles unlimited products. Pan + pinch-zoom     */
/* work on both mouse and touch (passive:false listeners). Auto-fits on load. */

const GRAPH_PALETTE = [
  "#3b82f6","#6366f1","#8b5cf6","#ec4899",
  "#06b6d4","#10b981","#f59e0b","#ef4444",
  "#0ea5e9","#84cc16","#14b8a6","#f97316",
  "#a855f7","#64748b","#22c55e","#e11d48",
];

/* Canvas display dimensions (CSS px) – decoupled from simulation space */
const CSS_W = 700, CSS_H = 520;
/* Virtual simulation coordinate space — kept in the same ~1.346 aspect
 * ratio as the canvas so the laid-out bbox fills the display area without
 * leaving large empty strips. Must match the constants in
 * `app/api/auth/admin/db/route.ts`; only used as a fallback centre when a
 * node has no server-supplied position. */
const SIM_W = 2200, SIM_H = 1640;

function CrossLinkGraph({
  nodes,
  edges,
  positions,
  totalProducts,
  onNavigate,
}: {
  nodes:         GraphNode[];
  edges:         GraphEdge[];
  positions:     Record<string, { x: number; y: number }>;
  totalProducts: number;
  /**
   * Invoked when the user clicks a product node and the graph wants to
   * route to that entry's detail page. If supplied, the parent is
   * responsible for closing any owning modal (e.g. the UserPanel) before
   * navigating — otherwise the portal-rendered panel stays pinned over the
   * new page. If omitted, the graph falls back to plain router.push.
   */
  onNavigate?: (documentId: string) => void;
}) {
  const router    = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panRef    = useRef({ x: 0, y: 0 });
  const zoomRef   = useRef(1);
  const dragRef   = useRef<{ x: number; y: number } | null>(null);
  const pinchRef  = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef    = useRef(false);
  const drawFrameRef   = useRef<number | null>(null);
  /* Latest onNavigate is held in a ref so the event-listener useEffect (which
     mounts once) always invokes the current prop. Without this, the listener
     would capture the prop from the first render and call a stale onClose
     after the parent re-renders. */
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => { onNavigateRef.current = onNavigate; }, [onNavigate]);
  const [zoomPct, setZoomPct] = useState(100);

  type LayoutData = {
    positions: Map<string, { x: number; y: number }>;
    catColor:  Map<string, string>;
    catPos:    Map<string, { x: number; y: number }>;
    catNodes:  GraphNode[];
    prodNodes: GraphNode[];
    prodById:  Map<string, GraphNode>;
    prodRadius: Map<string, number>;
    prodLabel:  Map<string, string>;
    ppEdges:   GraphEdge[];
  };
  const layoutRef = useRef<LayoutData | null>(null);

  function getProductRadius(label: string): number {
    const trimmed = label.trim();
    if (trimmed.length <= 6) return 22;
    if (trimmed.length <= 10) return 20;
    if (trimmed.length <= 16) return 18;
    return 17;
  }

  function fitLabel(label: string, maxChars: number): string {
    if (label.length <= maxChars) return label;
    return `${label.slice(0, Math.max(1, maxChars - 1))}…`;
  }

  function scheduleDraw() {
    if (drawFrameRef.current !== null) return;
    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = null;
      draw();
    });
  }

  function worldPointFromClient(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    const sx = CSS_W / (bounds.width || CSS_W);
    const sy = CSS_H / (bounds.height || CSS_H);
    const lx = (clientX - bounds.left) * sx;
    const ly = (clientY - bounds.top) * sy;
    return {
      x: (lx - panRef.current.x) / zoomRef.current,
      y: (ly - panRef.current.y) / zoomRef.current,
    };
  }

  function hitProduct(clientX: number, clientY: number): GraphNode | null {
    const layout = layoutRef.current;
    const point = worldPointFromClient(clientX, clientY);
    if (!layout || !point) return null;

    for (const n of layout.prodNodes) {
      const pos = layout.positions.get(n.id);
      const radius = layout.prodRadius.get(n.id) ?? 18;
      if (!pos) continue;
      const distance = Math.hypot(point.x - pos.x, point.y - pos.y);
      if (distance <= radius) return n;
    }
    return null;
  }

  /* ── draw ─────────────────────────────────────────────────────────────── */
  /* Reads only from stable refs + constants – safe to call from a stale     */
  /* closure inside the event-listener useEffect.                            */
  function draw() {
    const canvas = canvasRef.current;
    if (!canvas || !layoutRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { positions, catColor, catPos, catNodes, prodNodes, prodById, prodRadius, prodLabel, ppEdges } = layoutRef.current;
    const dpr = window.devicePixelRatio || 1;
    const z   = zoomRef.current;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // reset to DPR baseline
    ctx.clearRect(0, 0, CSS_W, CSS_H);
    ctx.translate(panRef.current.x, panRef.current.y);
    ctx.scale(z, z);

    const allP = catPos.get("all")!;

    /* category spokes */
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth   = 1.5 / z; // scale-invariant 1.5px on screen
    for (const [id, p] of catPos) {
      if (id === "all") continue;
      ctx.beginPath(); ctx.moveTo(allP.x, allP.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }

    /* product–product edges – O(1) source lookup via prodById map */
    ctx.globalAlpha = 0.4;
    ctx.lineWidth   = 1 / z; // scale-invariant 1px on screen
    for (const e of ppEdges) {
      const a = positions.get(e.source), b = positions.get(e.target);
      if (!a || !b) continue;
      ctx.strokeStyle = catColor.get(prodById.get(e.source)?.category ?? "") ?? "#94a3b8";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* product dots – larger circles with labels inside */
    for (const n of prodNodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const radius = prodRadius.get(n.id) ?? 18;
      const label = prodLabel.get(n.id) ?? n.label;
      ctx.fillStyle = catColor.get(n.category ?? "") ?? "#94a3b8";
      ctx.shadowColor = "#0f172a22";
      ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;

      const fontSize = label.length > 16 ? 6 : label.length > 11 ? 7 : label.length > 7 ? 8 : 9;
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${fontSize}px system-ui,sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, p.x, p.y);
    }

    /* category circles – label inside circle, white bold text */
    for (const n of catNodes) {
      const p = catPos.get(n.id);
      if (!p) continue;
      const color = catColor.get(n.id) ?? "#94a3b8";
      const label = n.label.toUpperCase();
      const fontSize = label.length > 10 ? 7 : label.length > 6 ? 8 : 9;
      ctx.font = `bold ${fontSize}px system-ui,sans-serif`;
      const radius = Math.max(18, Math.ceil(ctx.measureText(label).width / 2 + 8));
      ctx.shadowColor = color + "66"; ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle    = "#ffffff";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, p.x, p.y);
    }

    /* "ALL" centre node */
    ctx.shadowColor = "#1e40af44"; ctx.shadowBlur = 14;
    ctx.fillStyle = "#1e40af";
    ctx.beginPath(); ctx.arc(allP.x, allP.y, 20, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle    = "#ffffff";
    ctx.font         = "bold 11px system-ui,sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("ALL", allP.x, allP.y);

    ctx.restore();
  }

  /* ── Fit-to-view – computes zoom/pan to show all nodes with padding ───── */
  function fitView() {
    const layout = layoutRef.current;
    if (!layout) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [, p] of layout.positions) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const pad   = 50;
    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);
    const z = Math.min(
      (CSS_W - pad * 2) / bboxW,
      (CSS_H - pad * 2) / bboxH,
      2,
    );
    panRef.current  = {
      x: CSS_W / 2 - ((minX + maxX) / 2) * z,
      y: CSS_H / 2 - ((minY + maxY) / 2) * z,
    };
    zoomRef.current = z;
    setZoomPct(Math.round(z * 100));
    draw();
  }

  /* ── Layout from pre-computed server positions ───────────────────────── */
  /* The server has already run the O(n) concentric-ring layout and returned */
  /* positions as a plain object. We just convert it to a Map and render.    */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const prodNodes = nodes.filter((n) => n.type === "product");
    const catNodes  = nodes.filter((n) => n.type === "category");

    const catColor = new Map<string, string>();
    catNodes.forEach((n, i) => catColor.set(n.id, GRAPH_PALETTE[i % GRAPH_PALETTE.length]!));

    /* Convert pre-computed positions Record → Map */
    const posMap = new Map<string, { x: number; y: number }>();
    for (const [id, p] of Object.entries(positions)) posMap.set(id, p);

    /* Build catPos from the pre-computed positions (includes "all" hub) */
    const cx = SIM_W / 2, cy = SIM_H / 2;
    const catPos = new Map<string, { x: number; y: number }>();
    catPos.set("all", posMap.get("all") ?? { x: cx, y: cy });
    for (const n of catNodes) {
      const p = posMap.get(n.id);
      if (p) catPos.set(n.id, p);
    }

    const ppEdges  = edges.filter((e) => e.type === "product-product");
    const prodById = new Map(prodNodes.map((n) => [n.id, n]));
    const prodRadius = new Map<string, number>();
    const prodLabel = new Map<string, string>();
    for (const n of prodNodes) {
      const radius = getProductRadius(n.label);
      prodRadius.set(n.id, radius);
      const maxChars = radius >= 22 ? 14 : radius >= 20 ? 12 : radius >= 18 ? 10 : 9;
      prodLabel.set(n.id, fitLabel(n.label, maxChars));
    }

    layoutRef.current = { positions: posMap, catColor, catPos, catNodes, prodNodes, prodById, prodRadius, prodLabel, ppEdges };

    /* Set canvas resolution with DPR scaling */
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = CSS_W * dpr;
    canvas.height = CSS_H * dpr;

    /* Auto-fit so all products are immediately visible */
    fitView();
  }, [nodes, edges, positions]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Event listeners (wheel + mouse + touch, passive:false where needed) */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    /* Convert client coords → CSS_W/CSS_H logical canvas coords */
    function getScale() {
      const r = canvas!.getBoundingClientRect();
      return { sx: CSS_W / (r.width || CSS_W), sy: CSS_H / (r.height || CSS_H), bounds: r };
    }

    function applyZoom(factor: number, clientX: number, clientY: number) {
      const { sx, sy, bounds } = getScale();
      const lx = (clientX - bounds.left) * sx;
      const ly = (clientY - bounds.top)  * sy;
      const oldZ = zoomRef.current;
      const newZ = Math.min(12, Math.max(0.05, oldZ * factor));
      const wx = (lx - panRef.current.x) / oldZ;
      const wy = (ly - panRef.current.y) / oldZ;
      panRef.current  = { x: lx - wx * newZ, y: ly - wy * newZ };
      zoomRef.current = newZ;
      setZoomPct(Math.round(newZ * 100));
      scheduleDraw();
    }

    function onWheel(e: WheelEvent) {
      /* Plain wheel zooms the canvas; preventDefault stops the same wheel
         delta from also scrolling something else. The enclosing UserPanel
         additionally locks <html> scroll (see user-panel.tsx) so an
         un-prevented wheel here can't slide the underlying page either. */
      e.preventDefault();
      applyZoom(e.deltaY < 0 ? 1.12 : 0.88, e.clientX, e.clientY);
    }

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      clickStartRef.current = { x: e.clientX, y: e.clientY };
      draggedRef.current = false;
      dragRef.current = { x: e.clientX, y: e.clientY };
      canvas!.style.cursor = "grabbing";
    }

    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) {
        const hovered = hitProduct(e.clientX, e.clientY);
        canvas!.style.cursor = hovered ? "pointer" : "grab";
        return;
      }
      const { sx, sy } = getScale();
      if (clickStartRef.current) {
        const moved = Math.hypot(e.clientX - clickStartRef.current.x, e.clientY - clickStartRef.current.y);
        if (moved > 4) draggedRef.current = true;
      }
      panRef.current = {
        x: panRef.current.x + (e.clientX - dragRef.current.x) * sx,
        y: panRef.current.y + (e.clientY - dragRef.current.y) * sy,
      };
      dragRef.current = { x: e.clientX, y: e.clientY };
      draw();
    }

    function onMouseUp(e: MouseEvent) {
      const moved = draggedRef.current;
      dragRef.current = null;
      canvas!.style.cursor = "grab";
      if (moved) return;
      const hit = hitProduct(e.clientX, e.clientY);
      if (!hit) return;
      const docId = hit.id.startsWith("product:") ? hit.id.slice("product:".length) : hit.id;
      /* Prefer the parent-supplied navigator: it can close the enclosing
         modal (UserPanel) before routing, so the new page isn't covered by
         a now-stale portal. Read through the ref so this listener — which
         was registered once at mount — always sees the latest callback.
         Fallback to router.push when nothing was wired in. */
      const navigate = onNavigateRef.current;
      if (navigate) navigate(docId);
      else router.push(`/products/${docId}`);
    }

    function pinchDist(t0: Touch, t1: Touch) {
      return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    }

    function onTouchStart(e: TouchEvent) {
      e.preventDefault();
      if (e.touches.length === 1) {
        dragRef.current  = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
        pinchRef.current = null;
      } else if (e.touches.length >= 2) {
        dragRef.current = null;
        const t0 = e.touches[0]!, t1 = e.touches[1]!;
        pinchRef.current = {
          dist: pinchDist(t0, t1),
          midX: (t0.clientX + t1.clientX) / 2,
          midY: (t0.clientY + t1.clientY) / 2,
        };
      }
    }

    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      if (e.touches.length === 1 && dragRef.current) {
        const t = e.touches[0]!;
        const { sx, sy } = getScale();
        panRef.current = {
          x: panRef.current.x + (t.clientX - dragRef.current.x) * sx,
          y: panRef.current.y + (t.clientY - dragRef.current.y) * sy,
        };
        dragRef.current = { x: t.clientX, y: t.clientY };
        scheduleDraw();
      } else if (e.touches.length >= 2 && pinchRef.current) {
        const t0 = e.touches[0]!, t1 = e.touches[1]!;
        const newDist = pinchDist(t0, t1);
        const midX    = (t0.clientX + t1.clientX) / 2;
        const midY    = (t0.clientY + t1.clientY) / 2;
        applyZoom(newDist / pinchRef.current.dist, midX, midY);
        pinchRef.current = { dist: newDist, midX, midY };
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length === 0) {
        dragRef.current = null; pinchRef.current = null;
      } else if (e.touches.length === 1) {
        pinchRef.current = null;
        dragRef.current  = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
      }
    }

    canvas.addEventListener("wheel",       onWheel,      { passive: false });
    canvas.addEventListener("mousedown",   onMouseDown);
    canvas.addEventListener("mousemove",   onMouseMove);
    canvas.addEventListener("mouseup",     onMouseUp);
    canvas.addEventListener("mouseleave",  onMouseUp);
    canvas.addEventListener("touchstart",  onTouchStart, { passive: false });
    canvas.addEventListener("touchmove",   onTouchMove,  { passive: false });
    canvas.addEventListener("touchend",    onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchEnd);

    return () => {
      if (drawFrameRef.current !== null) {
        window.cancelAnimationFrame(drawFrameRef.current);
        drawFrameRef.current = null;
      }
      canvas.removeEventListener("wheel",       onWheel);
      canvas.removeEventListener("mousedown",   onMouseDown);
      canvas.removeEventListener("mousemove",   onMouseMove);
      canvas.removeEventListener("mouseup",     onMouseUp);
      canvas.removeEventListener("mouseleave",  onMouseUp);
      canvas.removeEventListener("touchstart",  onTouchStart);
      canvas.removeEventListener("touchmove",   onTouchMove);
      canvas.removeEventListener("touchend",    onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetView() {
    panRef.current  = { x: 0, y: 0 };
    zoomRef.current = 1;
    setZoomPct(100);
    scheduleDraw();
  }

  /* The server returns every article in the database — no sampling, no
     per-category cap. `shownProducts` and `totalProducts` therefore agree,
     and the note below makes that explicit so admins can see at a glance
     that the visualisation is complete. */
  const shownProducts = nodes.filter((n) => n.type === "product").length;
  const completeness =
    shownProducts === totalProducts
      ? `${shownProducts.toLocaleString()} of ${totalProducts.toLocaleString()} articles · all entries shown`
      : `${shownProducts.toLocaleString()} of ${totalProducts.toLocaleString()} articles shown`;

  return (
    <div className="wiki-admin-graph-wrap">
      <div className="wiki-admin-graph-controls">
        <span className="wiki-admin-graph-zoom">Zoom: {zoomPct}%</span>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button type="button" className="wiki-admin-graph-reset" onClick={fitView}>
            Fit View
          </button>
          <button type="button" className="wiki-admin-graph-reset" onClick={resetView}>
            Reset
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="wiki-admin-graph-canvas"
        style={{ width: "100%", maxWidth: `${CSS_W}px`, height: "auto", cursor: "grab" }}
        aria-label={`Cross-link graph – ${completeness} – click a node to open it · drag to pan · Ctrl or Cmd plus wheel to zoom, or pinch on touch`}
      />
      <p className="wiki-admin-graph-note">
        {completeness}
        {" · click a node to open it · drag to pan · Ctrl/⌘ + wheel (or pinch) to zoom · Fit View to reset"}
      </p>
    </div>
  );
}

/* ─── DBStatsOverview ────────────────────────────────────────────────────── */
/* Fetches and displays live DB statistics (the default "Overview" tab).      */

function DBStatsOverview() {
  const [data,    setData]    = useState<DBData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  /**
   * UI toggle: hide the "unassigned" bucket in the category-distribution
   * chart. The bucket counts every entry whose `rubrik` doesn't parse to
   * one of r01-r15 / replacements / extra — overwhelmingly the largest
   * bar in most databases, which dwarfs every meaningful category. Off by
   * default (admin sees everything); on filters the chart only.
   */
  const [hideUnassigned, setHideUnassigned] = useState(false);
  const [fixLinksState, setFixLinksState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [fixLinksResult, setFixLinksResult] = useState<{ updated: number; backLinksAdded: number } | null>(null);
  const [fixLinksError, setFixLinksError] = useState("");
  const [fixConfState, setFixConfState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [fixConfResult, setFixConfResult] = useState<{ updated: number; fixed: number } | null>(null);
  const [fixConfError, setFixConfError] = useState("");

  async function handleFixLinks() {
    if (fixLinksState === "running") return;
    if (!window.confirm(
      "This will scan all entries and add missing back-links so every link pair is bidirectional.\n\nProceed?"
    )) return;
    setFixLinksState("running");
    setFixLinksResult(null);
    setFixLinksError("");
    try {
      const res = await fetch("/api/entries/fix-links", { method: "POST" });
      const data = (await res.json()) as { updated?: number; backLinksAdded?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Fix failed.");
      setFixLinksResult({ updated: data.updated ?? 0, backLinksAdded: data.backLinksAdded ?? 0 });
      setFixLinksState("done");
      void load(true);
    } catch (err) {
      setFixLinksError(err instanceof Error ? err.message : "Fix failed.");
      setFixLinksState("error");
    }
  }

  async function handleFixConfidence() {
    if (fixConfState === "running") return;
    if (!window.confirm(
      "This will assign a default 50% confidence to every link that has no confidence score yet.\n\n" +
      "Links that already have a score are left unchanged. Proceed?"
    )) return;
    setFixConfState("running");
    setFixConfResult(null);
    setFixConfError("");
    try {
      const res = await fetch("/api/entries/fix-confidence", { method: "POST" });
      const data = (await res.json()) as { updated?: number; fixed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Fix failed.");
      setFixConfResult({ updated: data.updated ?? 0, fixed: data.fixed ?? 0 });
      setFixConfState("done");
      void load(true);
    } catch (err) {
      setFixConfError(err instanceof Error ? err.message : "Fix failed.");
      setFixConfState("error");
    }
  }

  /**
   * @param forceFresh  When true, pass `?nocache=1` to bypass the server's
   *                    "use cache" memoization. Used by the Refresh
   *                    button so the admin can see freshly-saved links
   *                    immediately rather than waiting for the 5-minute
   *                    revalidation window.
   */
  async function load(forceFresh = false) {
    setLoading(true);
    setError("");
    try {
      const url = forceFresh
        ? "/api/auth/admin/db?nocache=1"
        : "/api/auth/admin/db";
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to load statistics.");
      }
      setData((await res.json()) as DBData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load statistics.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="wiki-admin-loading">
        <span className="wiki-admin-spinner" aria-hidden="true" />
        Loading statistics…
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <p className="wiki-error wiki-admin-error">{error}</p>
        <button type="button" className="wiki-admin-db-btn" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { stats } = data;
  /* Visible rows in the bar chart. Always drop empty buckets; optionally
     drop "unassigned" when the toggle is on so the admin can see the
     real category distribution without the orphan bucket dominating. */
  const allCategoryEntries = Object.entries(stats.categories).filter(
    ([, count]) => count > 0,
  );
  const categoryEntries = hideUnassigned
    ? allCategoryEntries.filter(([cat]) => cat !== "unassigned")
    : allCategoryEntries;
  const unassignedCount = stats.categories["unassigned"] ?? 0;
  const maxCount = Math.max(...categoryEntries.map(([, c]) => c), 1);

  const fmt = (n: number) => n.toLocaleString();
  const avgLinks =
    stats.entriesWithLinks > 0
      ? (stats.totalLinkReferences / stats.entriesWithLinks).toFixed(2)
      : "0";
  const linkedPct =
    stats.totalEntries > 0
      ? ((stats.entriesWithLinks / stats.totalEntries) * 100).toFixed(1)
      : "0.0";
  const hasIntegrityIssues =
    stats.danglingReferences > 0 ||
    stats.selfReferences > 0 ||
    stats.oneSidedPairs > 0;

  return (
    <div className="wiki-admin-db-section">
      <div className="wiki-admin-stats">
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(stats.totalEntries)}</span>
          <span className="wiki-admin-stat-lbl">Entries</span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(stats.totalUsers)}</span>
          <span className="wiki-admin-stat-lbl">Users</span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(stats.totalLinkPairs)}</span>
          <span className="wiki-admin-stat-lbl">Cross-links</span>
          <span className="wiki-admin-stat-sub">unique pairs</span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(stats.totalLinkReferences)}</span>
          <span className="wiki-admin-stat-lbl">References</span>
          <span className="wiki-admin-stat-sub">directed entries</span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(stats.entriesWithImages)}</span>
          <span className="wiki-admin-stat-lbl">With Image</span>
          <span className="wiki-admin-stat-sub">
            {stats.totalEntries > 0
              ? `${((stats.entriesWithImages / stats.totalEntries) * 100).toFixed(1)}%`
              : "0%"}
          </span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(stats.entriesWithDocs)}</span>
          <span className="wiki-admin-stat-lbl">With Document</span>
          <span className="wiki-admin-stat-sub">
            {stats.totalEntries > 0
              ? `${((stats.entriesWithDocs / stats.totalEntries) * 100).toFixed(1)}%`
              : "0%"}
          </span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(stats.entriesWithTags)}</span>
          <span className="wiki-admin-stat-lbl">With Tags</span>
          <span className="wiki-admin-stat-sub">
            {stats.totalEntries > 0
              ? `${((stats.entriesWithTags / stats.totalEntries) * 100).toFixed(1)}%`
              : "0%"}
          </span>
        </div>
      </div>

      {/* ── Link metrics + integrity panel ──
          Surfaces "how the cross-links are distributed" and flags any data
          consistency problems the matcher cares about (dangling targets,
          self-links, one-sided pairs). Integrity rows render only when
          their counter is non-zero so a healthy database stays quiet. */}
      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">🧮</span>
          <div>
            <h3>Link metrics</h3>
            <p>How references are distributed across entries.</p>
          </div>
        </div>

        <dl className="wiki-admin-db-metrics">
          <div className="wiki-admin-db-metric">
            <dt>Entries with at least one link</dt>
            <dd>
              {fmt(stats.entriesWithLinks)}
              <span className="wiki-admin-db-metric-sub">
                {" "}({linkedPct}% of {fmt(stats.totalEntries)})
              </span>
            </dd>
          </div>
          <div className="wiki-admin-db-metric">
            <dt>Average links per linked entry</dt>
            <dd>{avgLinks}</dd>
          </div>

          {hasIntegrityIssues ? (
            <>
              <div className="wiki-admin-db-metric-section">Data integrity</div>
              {stats.danglingReferences > 0 && (
                <div className="wiki-admin-db-metric warn">
                  <dt>Dangling references</dt>
                  <dd>
                    {fmt(stats.danglingReferences)}
                    <span className="wiki-admin-db-metric-sub">
                      {" "}point at deleted entries
                    </span>
                  </dd>
                </div>
              )}
              {stats.selfReferences > 0 && (
                <div className="wiki-admin-db-metric warn">
                  <dt>Self-references</dt>
                  <dd>
                    {fmt(stats.selfReferences)}
                    <span className="wiki-admin-db-metric-sub">
                      {" "}entries link to themselves
                    </span>
                  </dd>
                </div>
              )}
              {stats.oneSidedPairs > 0 && (
                <div className="wiki-admin-db-metric warn">
                  <dt>One-sided pairs</dt>
                  <dd>
                    {fmt(stats.oneSidedPairs)}
                    <span className="wiki-admin-db-metric-sub">
                      {" "}of {fmt(stats.totalLinkPairs)} pairs only stored on one side
                    </span>
                  </dd>
                </div>
              )}
            </>
          ) : (
            <div className="wiki-admin-db-metric ok">
              <dt>Data integrity</dt>
              <dd>
                ✓ No dangling, self or one-sided links
              </dd>
            </div>
          )}
        </dl>

        {/* Fix one-sided links action */}
        {stats.oneSidedPairs > 0 && (
          <div style={{ padding: "0 1rem 1rem", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className={[
                "wiki-admin-db-btn",
                fixLinksState === "running" ? "loading" : "",
                fixLinksState === "done"    ? "done"    : "",
              ].filter(Boolean).join(" ")}
              disabled={fixLinksState === "running"}
              onClick={() => void handleFixLinks()}
            >
              {fixLinksState === "running" && <span className="wiki-admin-spinner" aria-hidden="true" />}
              {fixLinksState === "done"    ? "✓ Links fixed!" :
               fixLinksState === "running" ? "Fixing…"        : `Fix ${fmt(stats.oneSidedPairs)} one-sided pair${stats.oneSidedPairs !== 1 ? "s" : ""}`}
            </button>
            {fixLinksResult && fixLinksState === "done" && (
              <span style={{ fontSize: "0.82rem", color: "#10b981" }}>
                Added {fixLinksResult.backLinksAdded} back-link{fixLinksResult.backLinksAdded !== 1 ? "s" : ""} across {fixLinksResult.updated} entr{fixLinksResult.updated !== 1 ? "ies" : "y"}.
              </span>
            )}
            {fixLinksState === "error" && (
              <span style={{ fontSize: "0.82rem", color: "#dc2626" }}>{fixLinksError}</span>
            )}
          </div>
        )}
      </div>

      {/* ── Tag metrics ── */}
      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">🏷️</span>
          <div>
            <h3>Tag metrics</h3>
            <p>How tags are distributed across entries.</p>
          </div>
        </div>
        <dl className="wiki-admin-db-metrics">
          <div className="wiki-admin-db-metric">
            <dt>Articles with at least one tag</dt>
            <dd>
              {fmt(stats.entriesWithTags)}
              <span className="wiki-admin-db-metric-sub">
                {" "}({stats.totalEntries > 0
                  ? `${((stats.entriesWithTags / stats.totalEntries) * 100).toFixed(1)}%`
                  : "0%"} of {fmt(stats.totalEntries)})
              </span>
            </dd>
          </div>
          <div className="wiki-admin-db-metric">
            <dt>Total tags assigned</dt>
            <dd>{fmt(stats.totalTagCount)}</dd>
          </div>
          <div className="wiki-admin-db-metric">
            <dt>Average tags per tagged article</dt>
            <dd>{stats.avgTagsPerEntry > 0 ? stats.avgTagsPerEntry.toFixed(2) : "0"}</dd>
          </div>
        </dl>
      </div>

      {/* ── Category distribution ── */}
      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">📊</span>
          <div>
            <h3>Category Distribution</h3>
            <p>Entries per category (non-empty only)</p>
          </div>
          {/* Toggle: hide the "unassigned" bucket. Pushed to the right of
              the card header via margin-left:auto in CSS. Only shown when
              there's actually an unassigned bucket to hide. */}
          {unassignedCount > 0 && (
            <label className="wiki-admin-db-card-toggle">
              <input
                type="checkbox"
                checked={hideUnassigned}
                onChange={(e) => setHideUnassigned(e.target.checked)}
              />
              <span>
                Hide unassigned
                <span className="wiki-admin-db-card-toggle-count">
                  ({unassignedCount.toLocaleString()})
                </span>
              </span>
            </label>
          )}
        </div>
        <div className="wiki-admin-db-chart">
          {categoryEntries.length === 0 ? (
            <p className="wiki-admin-db-chart-empty">
              {hideUnassigned
                ? "No assigned categories to display."
                : "No categories with entries."}
            </p>
          ) : (
            categoryEntries.map(([cat, count]) => (
              <div key={cat} className="wiki-admin-db-chart-row">
                <span className="wiki-admin-db-chart-label">{cat}</span>
                <div className="wiki-admin-db-chart-bar-wrap">
                  <div className="wiki-admin-db-chart-bar" style={{ width: `${(count / maxCount) * 100}%` }} />
                </div>
                <span className="wiki-admin-db-chart-count">{count.toLocaleString()}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Confidence distribution ── */}
      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">🎯</span>
          <div>
            <h3>Link Confidence</h3>
            <p>Distribution of confidence scores across all stored relation edges.</p>
          </div>
        </div>
        <dl className="wiki-admin-db-metrics">
          <div className="wiki-admin-db-metric">
            <dt>Average confidence</dt>
            <dd>
              {stats.avgConfidence !== null
                ? `${stats.avgConfidence}%`
                : <span style={{ color: "#9ca3af" }}>no data</span>}
            </dd>
          </div>
          <div className="wiki-admin-db-metric">
            <dt>Links with confidence metadata</dt>
            <dd>
              {fmt(stats.linksWithConfidence)}
              {stats.linksWithoutConfidence > 0 && (
                <span className="wiki-admin-db-metric-sub warn">
                  {" "}· {fmt(stats.linksWithoutConfidence)} without
                </span>
              )}
            </dd>
          </div>
        </dl>

        {/* Assign a default 50% confidence to links that have none */}
        {(stats.linksWithoutConfidence > 0 || fixConfState === "done") && (
          <div style={{ padding: "0 1rem 1rem", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className={[
                "wiki-admin-db-btn",
                fixConfState === "running" ? "loading" : "",
                fixConfState === "done"    ? "done"    : "",
              ].filter(Boolean).join(" ")}
              disabled={fixConfState === "running" || stats.linksWithoutConfidence === 0}
              onClick={() => void handleFixConfidence()}
            >
              {fixConfState === "running" && <span className="wiki-admin-spinner" aria-hidden="true" />}
              {fixConfState === "done"    ? "✓ Confidence fixed!" :
               fixConfState === "running" ? "Fixing…"             : `Fix ${fmt(stats.linksWithoutConfidence)} link${stats.linksWithoutConfidence !== 1 ? "s" : ""} → 50%`}
            </button>
            {fixConfResult && fixConfState === "done" && (
              <span style={{ fontSize: "0.82rem", color: "#10b981" }}>
                Set {fixConfResult.fixed} link{fixConfResult.fixed !== 1 ? "s" : ""} to 50% across {fixConfResult.updated} entr{fixConfResult.updated !== 1 ? "ies" : "y"}.
              </span>
            )}
            {fixConfState === "error" && (
              <span style={{ fontSize: "0.82rem", color: "#dc2626" }}>{fixConfError}</span>
            )}
          </div>
        )}

        {stats.linksWithConfidence > 0 && (
          <div style={{ padding: "0 1rem 1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {[
              { label: "Low (< 34%)",   count: stats.confidenceLow,    color: "#ef4444" },
              { label: "Medium (34–66%)", count: stats.confidenceMedium, color: "#f59e0b" },
              { label: "High (> 66%)",  count: stats.confidenceHigh,   color: "#10b981" },
            ].map(({ label, count, color }) => {
              const pct = stats.linksWithConfidence > 0 ? (count / stats.linksWithConfidence) * 100 : 0;
              return (
                <div key={label} className="wiki-admin-db-chart-row">
                  <span className="wiki-admin-db-chart-label" style={{ minWidth: "9rem" }}>{label}</span>
                  <div className="wiki-admin-db-chart-bar-wrap">
                    <div className="wiki-admin-db-chart-bar" style={{ width: `${pct}%`, background: color }} />
                  </div>
                  <span className="wiki-admin-db-chart-count">{count.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="wiki-admin-db-generated">
        Generated {new Date(stats.generatedAt).toLocaleString()}
        {" · "}
        <button
          type="button"
          className="wiki-admin-db-refresh-link"
          onClick={() => void load(true)}
          title="Bypass the 5-minute server cache and recompute now"
        >
          Refresh
        </button>
      </p>
    </div>
  );
}

/* ─── PageViewsContent ───────────────────────────────────────────────────── */
/* Ranked list of how many times each item page has been opened. Data comes   */
/* from the file-backed view counter (see app/lib/page-views.ts).             */

type ViewCounts = { day: number; week: number; month: number; year: number; all: number };

type ViewItem = {
  documentId: string;
  title:      string;
  artNr:      string | null;
  last:       string | null;
  counts:     ViewCounts;
};

type ViewStatsData = {
  items:       ViewItem[];
  generatedAt: string;
};

type ViewRange = keyof ViewCounts;

const VIEW_RANGES: Array<{ key: ViewRange; label: string; window: string }> = [
  { key: "day",   label: "Day",      window: "last 24 hours" },
  { key: "week",  label: "Week",     window: "last 7 days"   },
  { key: "month", label: "Month",    window: "last 30 days"  },
  { key: "year",  label: "Year",     window: "last 365 days" },
  { key: "all",   label: "All time", window: "all time"      },
];

function PageViewsContent({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [data,    setData]    = useState<ViewStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [query,   setQuery]   = useState("");
  const [range,   setRange]   = useState<ViewRange>("all");
  /* documentId of the item currently hovered in either the list or the chart —
     drives the two-way highlight between them. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/entries/views/stats");
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "Failed to load page views.");
      }
      setData((await res.json()) as ViewStatsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load page views.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/set-state-in-effect

  /* Rank + filter for the selected window. An item only appears if it has at
     least one view inside the window, so "Day" shows just what's been opened
     in the last 24h, sorted by that window's count. */
  const rankedItems = useMemo(() => {
    const items = data?.items ?? [];
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => i.counts[range] > 0)
      .filter((i) =>
        !q ||
        i.title.toLowerCase().includes(q) ||
        (i.artNr ?? "").toLowerCase().includes(q) ||
        i.documentId.toLowerCase().includes(q),
      )
      .sort((a, b) => b.counts[range] - a.counts[range] || a.title.localeCompare(b.title));
  }, [data?.items, query, range]);

  const totalInRange = useMemo(
    () => (data?.items ?? []).reduce((sum, i) => sum + i.counts[range], 0),
    [data?.items, range],
  );
  const itemsInRange = useMemo(
    () => (data?.items ?? []).filter((i) => i.counts[range] > 0).length,
    [data?.items, range],
  );
  if (loading) {
    return (
      <div className="wiki-admin-loading">
        <span className="wiki-admin-spinner" aria-hidden="true" />
        Loading page views…
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <p className="wiki-error wiki-admin-error">{error}</p>
        <button type="button" className="wiki-admin-db-btn" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const fmt = (n: number) => n.toLocaleString();
  const activeRange = VIEW_RANGES.find((r) => r.key === range) ?? VIEW_RANGES[VIEW_RANGES.length - 1]!;
  /* Cap the linked list + chart to a hover-navigable size. Items are already
     sorted desc, so shown[0] is the tallest bar. */
  const shown = rankedItems.slice(0, 50);
  const maxCount = Math.max(shown[0]?.counts[range] ?? 1, 1);

  return (
    <div className="wiki-admin-db-section">
      {/* ── Time-range selector ── */}
      <div className="wiki-user-panel-tabs" role="tablist" aria-label="View time range">
        {VIEW_RANGES.map((r) => (
          <button
            key={r.key}
            type="button" role="tab"
            aria-selected={range === r.key}
            className={`wiki-user-panel-tab-btn${range === r.key ? " active" : ""}`}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* ── Summary stats (for the selected window) ── */}
      <div className="wiki-admin-stats">
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(totalInRange)}</span>
          <span className="wiki-admin-stat-lbl">Views</span>
          <span className="wiki-admin-stat-sub">{activeRange.window}</span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{fmt(itemsInRange)}</span>
          <span className="wiki-admin-stat-lbl">Items Viewed</span>
          <span className="wiki-admin-stat-sub">{activeRange.window}</span>
        </div>
      </div>

      {/* ── Most viewed items ── */}
      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">👁️</span>
          <div>
            <h3>Most Viewed Items</h3>
            <p>Item-page opens ({activeRange.window}). Counted once per user per 24&nbsp;h.</p>
          </div>
        </div>

        {data.items.length === 0 ? (
          <p className="wiki-admin-db-chart-empty">
            No page views recorded yet. Views are counted as logged-in users open item pages.
          </p>
        ) : (
          <>
            {/* Search */}
            <div className="wiki-admin-search-row" style={{ padding: "0 1rem" }}>
              <div className="wiki-admin-search-wrap">
                <svg className="wiki-admin-search-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="M16.65 16.65L21 21" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
                <input
                  type="search"
                  className="wiki-admin-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, ArtNr or ID…"
                  aria-label="Search viewed items"
                />
              </div>
              {query.trim() && (
                <span className="wiki-admin-search-count">
                  {rankedItems.length}
                </span>
              )}
            </div>

            {rankedItems.length === 0 ? (
              <p className="wiki-admin-db-chart-empty">
                {query.trim()
                  ? "No items match your search."
                  : `No item views in the ${activeRange.window}.`}
              </p>
            ) : (
              <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", padding: "0 1rem 0.25rem", alignItems: "stretch" }}>
                {/* Ranked list (left, text left-aligned) */}
                <div style={{ flex: "1 1 260px", minWidth: 0, maxHeight: "260px", overflowY: "auto" }}>
                  {shown.map((item) => {
                    const active = hoveredId === item.documentId;
                    const lastStr = item.last
                      ? new Date(item.last).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                      : "—";
                    return (
                      <button
                        key={item.documentId}
                        id={`pvrow-${item.documentId}`}
                        type="button"
                        onMouseEnter={() => setHoveredId(item.documentId)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={() => { onClose(); router.push(`/products/${item.documentId}`); }}
                        title={`Open ${item.title} · last viewed ${lastStr}`}
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: "0.6rem",
                          width: "100%",
                          padding: "0.3rem 0.5rem",
                          borderRadius: "6px",
                          border: "none",
                          textAlign: "left",
                          cursor: "pointer",
                          background: active ? "#dbeafe" : "transparent",
                          color: active ? "#1e40af" : "inherit",
                          fontWeight: active ? 600 : 400,
                          transition: "background 0.1s",
                        }}
                      >
                        <span style={{ minWidth: "3.2rem", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                          {fmt(item.counts[range])}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.title}
                          {item.artNr && <span className="wiki-admin-db-metric-sub"> · {item.artNr}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Vertical bar chart (right) — bars rise bottom→up; hover links to the list */}
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "260px", overflowX: "auto", paddingBottom: "2px" }}>
                    {shown.map((item) => {
                      const active = hoveredId === item.documentId;
                      const heightPct = Math.max(2, (item.counts[range] / maxCount) * 100);
                      return (
                        <div
                          key={item.documentId}
                          role="button"
                          aria-label={`${item.title}, ${fmt(item.counts[range])} views`}
                          onMouseEnter={() => {
                            setHoveredId(item.documentId);
                            document.getElementById(`pvrow-${item.documentId}`)?.scrollIntoView({ block: "nearest" });
                          }}
                          onMouseLeave={() => setHoveredId(null)}
                          onClick={() => { onClose(); router.push(`/products/${item.documentId}`); }}
                          title={`${item.title} — ${fmt(item.counts[range])} view${item.counts[range] === 1 ? "" : "s"}`}
                          style={{
                            flex: "1 0 8px",
                            minWidth: "8px",
                            height: `${heightPct}%`,
                            background: active ? "#2563eb" : "#bfdbfe",
                            borderRadius: "3px 3px 0 0",
                            cursor: "pointer",
                            transition: "background 0.1s, height 0.15s",
                          }}
                        />
                      );
                    })}
                  </div>
                  <p className="wiki-muted" style={{ textAlign: "center", fontSize: "0.7rem", margin: "0.35rem 0 0" }}>
                    Views per item · hover a bar to find it in the list
                  </p>
                </div>
              </div>
            )}
            {rankedItems.length > shown.length && (
              <p className="wiki-muted" style={{ textAlign: "center", padding: "0.5rem 0" }}>
                Showing top {shown.length} of {rankedItems.length} items
              </p>
            )}
          </>
        )}
      </div>

      <p className="wiki-admin-db-generated">
        Generated {new Date(data.generatedAt).toLocaleString()}
        {" · "}
        <button type="button" className="wiki-admin-db-refresh-link" onClick={() => void load()}>
          Refresh
        </button>
      </p>
    </div>
  );
}

/* ─── DBStatsContent ─────────────────────────────────────────────────────── */
/* Tabbed wrapper: the original stats overview plus a Page Views tab.         */

export function DBStatsContent({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "views">("overview");

  return (
    <div className="wiki-admin-db-section" style={{ gap: "1rem" }}>
      <div className="wiki-user-panel-tabs" role="tablist">
        <button
          type="button" role="tab"
          aria-selected={tab === "overview"}
          className={`wiki-user-panel-tab-btn${tab === "overview" ? " active" : ""}`}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button" role="tab"
          aria-selected={tab === "views"}
          className={`wiki-user-panel-tab-btn${tab === "views" ? " active" : ""}`}
          onClick={() => setTab("views")}
        >
          Page Views
        </button>
      </div>

      {tab === "overview" ? <DBStatsOverview /> : <PageViewsContent onClose={onClose} />}
    </div>
  );
}

/* ─── AuditLogContent ───────────────────────────────────────────────────── */
/* Displays a chronological audit trail of all content changes.               */

const ACTION_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  create: { bg: "#dcfce7", text: "#166534", label: "CREATE" },
  update: { bg: "#dbeafe", text: "#1e40af", label: "UPDATE" },
  delete: { bg: "#fee2e2", text: "#991b1b", label: "DELETE" },
};

export function AuditLogContent() {
  const [logs,    setLogs]    = useState<UserAuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [query,   setQuery]   = useState("");
  const [filterAction, setFilterAction] = useState<string>("all");
  // timestamp → "idle" | "pending" | "done" | "error"
  const [undoStates, setUndoStates] = useState<Map<string, string>>(new Map());
  const [undoErrors,  setUndoErrors]  = useState<Map<string, string>>(new Map());

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/audit-log");
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to load audit logs.");
      }
      const data = (await res.json()) as { logs: UserAuditRecord[] };
      setLogs(data.logs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit logs.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUndo(log: UserAuditRecord) {
    const key = log.timestamp;
    if (undoStates.get(key) === "pending") return;
    if (!window.confirm(
      `Undo this action?\n\n"${log.details}"\n\nThis will restore the data to its previous state.`
    )) return;
    setUndoStates((p) => new Map(p).set(key, "pending"));
    setUndoErrors((p) => { const n = new Map(p); n.delete(key); return n; });
    try {
      const res = await fetch("/api/audit-log/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: log.timestamp, userEmail: log.userEmail }),
      });
      const data = (await res.json()) as { ok?: boolean; truncated?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Undo failed.");
      setUndoStates((p) => new Map(p).set(key, "done"));
      // Remove the reverted entry from the local list.
      setLogs((prev) => prev.filter((l) => l.timestamp !== key));
      if (data.truncated) {
        window.alert("Undo was partial — the operation affected more entries than could be stored in the snapshot (limit: 50). Some entries may not have been restored.");
      }
    } catch (err) {
      setUndoErrors((p) => new Map(p).set(key, err instanceof Error ? err.message : "Undo failed."));
      setUndoStates((p) => new Map(p).set(key, "error"));
    }
  }

  const filteredLogs = useMemo(() => {
    let result = logs;

    if (filterAction !== "all") {
      result = result.filter((log) => log.action === filterAction);
    }

    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter((log) =>
        log.entryTitle.toLowerCase().includes(q) ||
        log.userEmail.toLowerCase().includes(q) ||
        log.userDisplayName.toLowerCase().includes(q) ||
        log.details.toLowerCase().includes(q) ||
        log.section.toLowerCase().includes(q) ||
        log.entryId.toLowerCase().includes(q)
      );
    }

    return result;
  }, [logs, query, filterAction]);

  if (loading) {
    return (
      <div className="wiki-admin-loading">
        <span className="wiki-admin-spinner" aria-hidden="true" />
        Loading audit logs…
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <p className="wiki-error wiki-admin-error">{error}</p>
        <button type="button" className="wiki-admin-db-btn" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="wiki-admin-db-section">
      {/* ── Stats ── */}
      <div className="wiki-admin-stats">
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{logs.length}</span>
          <span className="wiki-admin-stat-lbl">Total Actions</span>
        </div>
        <div className="wiki-admin-stat stat-confirmed">
          <span className="wiki-admin-stat-num">{logs.filter((l) => l.action === "create").length}</span>
          <span className="wiki-admin-stat-lbl">Creates</span>
        </div>
        <div className="wiki-admin-stat">
          <span className="wiki-admin-stat-num">{logs.filter((l) => l.action === "update").length}</span>
          <span className="wiki-admin-stat-lbl">Updates</span>
        </div>
        {logs.filter((l) => l.action === "delete").length > 0 && (
          <div className="wiki-admin-stat stat-blocked">
            <span className="wiki-admin-stat-num">{logs.filter((l) => l.action === "delete").length}</span>
            <span className="wiki-admin-stat-lbl">Deletes</span>
          </div>
        )}
      </div>

      {/* ── Search + Filter bar ── */}
      <div className="wiki-admin-search-row">
        <div className="wiki-admin-search-wrap">
          <svg className="wiki-admin-search-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2"/>
            <path d="M16.65 16.65L21 21" fill="none" stroke="currentColor" strokeWidth="2"/>
          </svg>
          <input
            type="search"
            className="wiki-admin-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by user, entry, or action…"
            aria-label="Search audit logs"
          />
        </div>
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          style={{
            padding: "0.4rem 0.6rem",
            borderRadius: "8px",
            border: "1px solid var(--line)",
            fontSize: "0.82rem",
            background: "var(--surface)",
            color: "var(--foreground)",
            cursor: "pointer",
          }}
        >
          <option value="all">All Actions</option>
          <option value="create">Creates</option>
          <option value="update">Updates</option>
          <option value="delete">Deletes</option>
        </select>
        {(query || filterAction !== "all") && (
          <span className="wiki-admin-search-count">
            {filteredLogs.length} / {logs.length}
          </span>
        )}
      </div>

      {/* ── Log list ── */}
      {filteredLogs.length === 0 ? (
        <p className="wiki-muted" style={{ textAlign: "center", padding: "2rem 0" }}>
          {logs.length === 0 ? "No audit log entries yet." : "No entries match your search."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {filteredLogs.slice(0, 200).map((log, idx) => {
            const actionStyle = ACTION_COLORS[log.action] ?? ACTION_COLORS.update!;
            const date = new Date(log.timestamp);
            const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
            const timeStr = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

            return (
              <div
                key={`${log.timestamp}-${log.entryId}-${idx}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "0.75rem",
                  padding: "0.75rem 1rem",
                  borderRadius: "10px",
                  background: "#fafbfc",
                  border: "1px solid #e2e8f0",
                  alignItems: "start",
                }}
              >
                {/* Action badge */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.25rem", minWidth: "4.5rem" }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.15rem 0.5rem",
                      borderRadius: "6px",
                      fontSize: "0.68rem",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      background: actionStyle.bg,
                      color: actionStyle.text,
                    }}
                  >
                    {actionStyle.label}
                  </span>
                  <span style={{ fontSize: "0.65rem", color: "var(--muted)", textTransform: "uppercase" }}>
                    {log.section}
                  </span>
                </div>

                {/* Details */}
                <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", minWidth: 0 }}>
                  <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--foreground)" }}>
                    {log.details}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                    by <strong>{log.userDisplayName}</strong>{" "}
                    <span style={{ color: "var(--muted)" }}>({log.userEmail})</span>
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                      {dateStr} at {timeStr} · ID: {log.entryId}
                    </span>
                    {log.snapshot && undoStates.get(log.timestamp) !== "done" && (
                      <button
                        type="button"
                        style={{
                          fontSize: "0.7rem",
                          padding: "0.1rem 0.45rem",
                          borderRadius: "5px",
                          border: "1px solid var(--line)",
                          background: undoStates.get(log.timestamp) === "pending" ? "var(--stage-bg)" : "var(--surface)",
                          color: "var(--muted)",
                          cursor: undoStates.get(log.timestamp) === "pending" ? "default" : "pointer",
                          fontWeight: 500,
                        }}
                        disabled={undoStates.get(log.timestamp) === "pending"}
                        onClick={() => void handleUndo(log)}
                        title={log.snapshot?.truncated ? "Partial undo — snapshot capped at 50 entries" : "Undo this action"}
                      >
                        {undoStates.get(log.timestamp) === "pending" ? "Undoing…" : "↩ Undo"}
                      </button>
                    )}
                    {undoStates.get(log.timestamp) === "error" && (
                      <span style={{ fontSize: "0.7rem", color: "#dc2626" }}>
                        {undoErrors.get(log.timestamp)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredLogs.length > 200 && (
            <p className="wiki-muted" style={{ textAlign: "center", padding: "0.5rem 0" }}>
              Showing first 200 of {filteredLogs.length} entries
            </p>
          )}
        </div>
      )}

      {/* ── Refresh ── */}
      <p className="wiki-admin-db-generated" style={{ marginTop: "1rem" }}>
        <button type="button" className="wiki-admin-db-refresh-link" onClick={() => void load()}>
          Refresh
        </button>
      </p>
    </div>
  );
}

/* ─── LinkConfidenceContent ──────────────────────────────────────────────── */

export function LinkConfidenceContent() {
  const [query,         setQuery]         = useState("");
  const [searchResults, setSearchResults] = useState<Entry[]>([]);
  const [searching,     setSearching]     = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [parsedLinks,   setParsedLinks]   = useState<LinkEntry[]>([]);
  const [linkTitles,    setLinkTitles]    = useState<Record<string, string>>({});
  const [editingId,     setEditingId]     = useState<string | null>(null);
  const [editConfidence, setEditConfidence] = useState(50);
  const [editSource,    setEditSource]    = useState("");
  const [editLink,      setEditLink]      = useState("");
  const [editDesc,      setEditDesc]      = useState("");
  const [saving,        setSaving]        = useState(false);
  const [saveError,     setSaveError]     = useState("");
  const [savedId,       setSavedId]       = useState<string | null>(null);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleQueryChange(q: string) {
    setQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(() => {
      setSearching(true);
      void searchEntries(q).then((r) => { setSearchResults(r); setSearching(false); });
    }, 300);
  }

  async function selectEntry(entry: Entry) {
    const full = (await getEntryById(entry.documentId)) ?? entry;
    setSelectedEntry(full);
    const links = parseLinkEntries(full.links);
    setParsedLinks(links);
    setLinkTitles({});
    setSearchResults([]);
    setQuery("");
    setEditingId(null);
    setSaveError("");
    void Promise.all(
      links.map((le) =>
        getEntryById(le.id).then((e) => {
          if (e) setLinkTitles((prev) => ({ ...prev, [le.id]: e.title }));
        }),
      ),
    );
  }

  function startEdit(le: LinkEntry) {
    setEditingId(le.id);
    setEditConfidence(Math.round((le.confidence ?? 0.5) * 100));
    setEditSource(le.source ?? "");
    setEditLink(le.link ?? "");
    setEditDesc(le.desc ?? "");
    setSaveError("");
  }

  function cancelEdit() { setEditingId(null); setSaveError(""); }

  async function saveEdit() {
    if (!selectedEntry || !editingId) return;
    setSaving(true);
    setSaveError("");
    const updated = parsedLinks.map((le) =>
      le.id === editingId
        ? {
            ...le,
            confidence: editConfidence / 100,
            source:     editSource.trim() || undefined,
            link:       editLink.trim()   || undefined,
            desc:       editDesc.trim()   || undefined,
          }
        : le,
    );
    try {
      const res = await fetch(
        `/api/entries/${encodeURIComponent(selectedEntry.documentId)}`,
        {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ links: serializeLinkEntries(updated) }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      setParsedLinks(updated);
      setEditingId(null);
      setSavedId(editingId);
      setTimeout(() => setSavedId(null), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wiki-admin-db-inner">
      <h3 className="wiki-admin-db-section-title">Link Confidence Editor</h3>

      {!selectedEntry ? (
        <>
          <div className="wiki-link-conf-search">
            <input
              type="search"
              placeholder="Search for a product…"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
            />
            {searching && <span className="wiki-admin-spinner" aria-hidden="true" />}
          </div>
          {searchResults.length > 0 && (
            <div className="wiki-link-conf-results">
              {searchResults.map((e) => (
                <button
                  key={e.documentId}
                  type="button"
                  className="wiki-link-conf-result-btn"
                  onClick={() => void selectEntry(e)}
                >
                  <strong>{e.title}</strong>
                  {e.artNr && <span>{e.artNr}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="wiki-link-conf-product-header">
            <button
              type="button"
              onClick={() => { setSelectedEntry(null); setEditingId(null); setSaveError(""); }}
            >
              ← Back
            </button>
            <strong>{selectedEntry.title}</strong>
            <span>{parsedLinks.length} relation{parsedLinks.length !== 1 ? "s" : ""}</span>
          </div>

          {parsedLinks.length === 0 ? (
            <p style={{ padding: "1rem", color: "var(--muted)", fontSize: "0.85rem" }}>
              No relations found for this product.
            </p>
          ) : (
            <div className="wiki-link-conf-link-rows">
              {parsedLinks.map((le) => {
                const isEditing = editingId === le.id;
                const pct   = Math.round((le.confidence ?? 0.5) * 100);
                const title = linkTitles[le.id] ?? le.id;
                return (
                  <div key={le.id} className={`wiki-link-conf-link-row${isEditing ? " editing" : ""}`}>
                    <div className="wiki-link-conf-link-header">
                      <span className="wiki-link-conf-link-title">{title}</span>
                      {savedId === le.id && (
                        <span className="wiki-link-conf-save-flash">Saved ✓</span>
                      )}
                      {!isEditing && (
                        <button
                          type="button"
                          className="wiki-admin-db-btn"
                          style={{ padding: "0.2rem 0.6rem", fontSize: "0.78rem" }}
                          onClick={() => startEdit(le)}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    <div className="wiki-link-conf-meta">
                      <span className="wiki-relation-confidence">{pct}%</span>
                      {le.source && <span className="wiki-relation-source">{le.source}</span>}
                      {le.link && (
                        <a
                          href={le.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="wiki-relation-detail-ref-link"
                          style={{ fontSize: "0.78rem" }}
                        >
                          Link ↗
                        </a>
                      )}
                    </div>
                    {le.desc && (
                      <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
                        {le.desc}
                      </p>
                    )}
                    {isEditing && (
                      <div className="wiki-link-conf-edit-form">
                        <div className="wiki-link-conf-slider-row">
                          <label>Confidence</label>
                          <input
                            type="range"
                            min={0} max={100} step={1}
                            value={editConfidence}
                            onChange={(e) => setEditConfidence(Number(e.target.value))}
                          />
                          <span className="wiki-link-conf-slider-val">{editConfidence}%</span>
                        </div>
                        <label>
                          Source
                          <input
                            type="text"
                            value={editSource}
                            onChange={(e) => setEditSource(e.target.value)}
                            placeholder="e.g. Manual, Partslist AI parse"
                          />
                        </label>
                        <label>
                          Link URL
                          <input
                            type="url"
                            value={editLink}
                            onChange={(e) => setEditLink(e.target.value)}
                            placeholder="https://…"
                          />
                        </label>
                        <label>
                          Note
                          <textarea
                            rows={2}
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="Optional relation note…"
                          />
                        </label>
                        {saveError && (
                          <p style={{ gridColumn: "1/-1", color: "#dc2626", fontSize: "0.8rem", margin: 0 }}>
                            {saveError}
                          </p>
                        )}
                        <div className="wiki-link-conf-edit-actions">
                          <button
                            type="button"
                            className="wiki-admin-db-btn import"
                            disabled={saving}
                            onClick={() => void saveEdit()}
                          >
                            {saving ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            className="wiki-admin-db-btn"
                            onClick={cancelEdit}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── AssignDocsContent ──────────────────────────────────────────────────── */
/* Pick a folder with the native folder picker, parse PDF filenames for       */
/* article numbers, look up matching Strapi entries, and bulk-assign docs.    */

/** Parse a PDF filename → { artNrs, docType }.
 *  Leading underscore-separated digit tokens are article numbers;
 *  the first non-digit token starts the document-type label. */
function parseDocFilename(filename: string): { artNrs: string[]; docType: string } {
  const bare   = filename.replace(/\.pdf$/i, "");
  const tokens = bare.split("_");
  const artNrs: string[] = [];
  let labelStart = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d+$/.test(tokens[i]!)) { artNrs.push(tokens[i]!); }
    else { labelStart = i; break; }
  }
  return { artNrs, docType: tokens.slice(labelStart).join(" ").trim() || "Dokument" };
}

type DocMatch = { documentId: string; title: string; artNr?: string };

type DocFileLocal = {
  file:         File;
  filename:     string;   // basename (used as key)
  relativePath: string;   // path relative to root folder, for display
  artNrs:       string[];
  searchName:   string;   // filename-derived title search (used when no artNr)
  docType:      string;
  matches:      DocMatch[];
};

type AssignDetail = { filename: string; docType: string; entry: string };
type AssignError  = { filename: string; error: string };

type AssignResultLocal = {
  assigned: number;
  skipped:  number;
  errors:   AssignError[];
  details:  AssignDetail[];
};

type TextEntryLocal = {
  title:        string;
  description:  string;
  link?:        string;
  attachments?: (string | number)[];
};

function parseDocsLocal(raw?: string): TextEntryLocal[] {
  if (!raw?.trim()) return [];
  try {
    const p = JSON.parse(raw) as unknown;
    if (Array.isArray(p)) return p as TextEntryLocal[];
  } catch { /* ignore */ }
  return [];
}

export function AssignDocsContent() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [folderName,   setFolderName]   = useState("");   // display label
  const [files,        setFiles]        = useState<DocFileLocal[]>([]);
  const [scanning,     setScanning]     = useState(false);
  const [scanError,    setScanError]    = useState("");
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [assigning,    setAssigning]    = useState(false);
  const [assignResult, setAssignResult] = useState<AssignResultLocal | null>(null);
  const [assignError,  setAssignError]  = useState("");

  /* ── Folder picker handler ── */
  async function handleFilesChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []).filter((f) =>
      /\.pdf$/i.test(f.name),
    );
    if (!chosen.length) return;

    // Derive folder display name from the webkitRelativePath of the first file.
    const firstRel = (chosen[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    setFolderName(firstRel ? firstRel.split("/")[0]! : "Selected folder");

    setScanning(true);
    setScanError("");
    setAssignResult(null);
    setSelected(new Set());

    try {
      // Parse filenames client-side.
      const parsed = chosen.map((f) => {
        const relFull = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
        // Parts: [rootFolder, ...subfolders, filename]
        const parts       = relFull.split("/");
        const subfolders  = parts.slice(1, -1); // everything between root and basename
        const fromFile    = parseDocFilename(f.name);
        // If nested in subfolder(s), use the subfolder path as docType
        const docType     = subfolders.length > 0
          ? subfolders.join(" / ")
          : fromFile.docType;
        const relativePath = parts.slice(1).join("/"); // strip root folder
        // When the filename carries no article number, fall back to searching
        // the DB by the filename itself (underscores → spaces) against titles.
        const searchName = fromFile.artNrs.length === 0
          ? f.name.replace(/\.pdf$/i, "").replace(/_/g, " ").trim()
          : "";
        return { file: f, filename: f.name, relativePath, artNrs: fromFile.artNrs, searchName, docType };
      });

      // Collect unique artNrs and filename searches across all files.
      const allArtNrs = Array.from(new Set(parsed.flatMap((p) => p.artNrs)));
      const allNames  = Array.from(new Set(parsed.map((p) => p.searchName).filter(Boolean)));

      // Ask the server to resolve artNrs / names → Strapi entries (keeps token server-side).
      let matchMap:     Record<string, DocMatch[]> = {};
      let nameMatchMap: Record<string, DocMatch[]> = {};
      if (allArtNrs.length > 0 || allNames.length > 0) {
        const params = new URLSearchParams();
        allArtNrs.forEach((nr) => params.append("artNrs[]", nr));
        allNames.forEach((n)  => params.append("names[]",  n));
        const res  = await fetch(`/api/auth/admin/assign-docs?${params.toString()}`);
        const body = (await res.json()) as {
          matches?:     Record<string, DocMatch[]>;
          nameMatches?: Record<string, DocMatch[]>;
          error?:       string;
        };
        if (!res.ok) throw new Error(body.error ?? "Lookup failed.");
        matchMap     = body.matches     ?? {};
        nameMatchMap = body.nameMatches ?? {};
      }

      // Build per-file match lists (deduplicated by documentId). Files with an
      // article number match on artNr; files without one fall back to the
      // filename→title search.
      const result: DocFileLocal[] = parsed.map((p) => {
        const seen = new Set<string>();
        const matches: DocMatch[] = [];
        const pools = p.artNrs.length > 0
          ? p.artNrs.map((nr) => matchMap[nr] ?? [])
          : [nameMatchMap[p.searchName] ?? []];
        for (const pool of pools) {
          for (const m of pool) {
            if (!seen.has(m.documentId)) { seen.add(m.documentId); matches.push(m); }
          }
        }
        return { ...p, matches };
      });

      setFiles(result);
      setSelected(new Set(result.filter((f) => f.matches.length > 0).map((f) => f.relativePath)));
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed.");
      setFiles([]);
    } finally {
      setScanning(false);
      // Reset the input so the same folder can be re-selected after changes.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  /* ── Selection helpers ── */
  function toggleFile(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    const eligible = files.filter((f) => f.matches.length > 0).map((f) => f.relativePath);
    const allSel   = eligible.every((f) => selected.has(f));
    setSelected(allSel ? new Set() : new Set(eligible));
  }

  /* ── Assignment ── */
  async function handleAssign() {
    if (!files.length || selected.size === 0) return;
    setAssigning(true);
    setAssignError("");
    setAssignResult(null);

    const result: AssignResultLocal = { assigned: 0, skipped: 0, errors: [], details: [] };

    const toProcess = files.filter((f) => selected.has(f.relativePath));

    for (const docFile of toProcess) {
      if (docFile.matches.length === 0) { result.skipped++; continue; }

      // 1. Upload the PDF to Strapi media library.
      let mediaId: number;
      try {
        const ids = await uploadMedia([docFile.file]);
        mediaId = ids[0]!;
        if (!mediaId) throw new Error("No media ID returned.");
      } catch (err) {
        result.errors.push({ filename: docFile.relativePath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      // 2. For each matched entry: fetch current docs, append, PUT back.
      for (const match of docFile.matches) {
        try {
          // Fetch current entry to get live docs field.
          const current = await getEntryById(match.documentId);
          const existing = parseDocsLocal(current?.docs);

          // Dedup: skip if same title + attachment already exists.
          const alreadyPresent = existing.some(
            (d) => d.title === docFile.docType && d.attachments?.includes(mediaId),
          );
          if (alreadyPresent) { result.skipped++; continue; }

          const updated: TextEntryLocal[] = [
            ...existing,
            { title: docFile.docType, description: "", attachments: [mediaId] },
          ];

          // PUT via the Next.js API route (adds auth + audit log).
          const putRes = await fetch(`/api/entries/${match.documentId}`, {
            method:  "PUT",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ docs: JSON.stringify(updated), _auditSection: "docs" }),
          });
          if (!putRes.ok) {
            const body = (await putRes.json()) as { error?: string };
            throw new Error(body.error ?? `PUT failed (${putRes.status})`);
          }

          result.assigned++;
          result.details.push({ filename: docFile.relativePath, docType: docFile.docType, entry: match.title || match.documentId });
        } catch (err) {
          result.errors.push({
            filename: `${docFile.relativePath} → ${match.title || match.documentId}`,
            error:    err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    setAssignResult(result);
    setAssigning(false);
  }

  /* ── Derived counts ── */
  const eligibleCount  = files.filter((f) => f.matches.length > 0).length;
  const noMatchCount   = files.filter((f) => f.matches.length === 0 && f.artNrs.length > 0).length;
  const noArtNrCount   = files.filter((f) => f.matches.length === 0 && f.artNrs.length === 0).length;
  const allEligibleSel = eligibleCount > 0 && files.filter((f) => f.matches.length > 0).every((f) => selected.has(f.relativePath));

  return (
    <div className="wiki-assign-docs">

      {/* ── Folder picker ── */}
      {/* Hidden file input — webkitdirectory lets the user pick an entire folder */}
      <input
        ref={fileInputRef}
        type="file"
        // @ts-expect-error -- webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        multiple
        accept=".pdf"
        style={{ display: "none" }}
        onChange={(e) => void handleFilesChosen(e)}
      />

      <div className="wiki-assign-docs-picker">
        <button
          type="button"
          className="wiki-assign-docs-browse-btn"
          disabled={scanning || assigning}
          onClick={() => fileInputRef.current?.click()}
        >
          📂 Browse folder…
        </button>
        {folderName && !scanning && (
          <span className="wiki-assign-docs-folder-name">{folderName}</span>
        )}
        {scanning && <span className="wiki-assign-docs-scanning">Scanning…</span>}
      </div>

      <p className="wiki-assign-docs-hint">
        PDFs can be organised in subfolders — the subfolder name becomes the document type.
        Filenames ideally start with article numbers like <code>03135_03136_Installationsanleitung.pdf</code>.
        If a file sits directly in the root folder, the part after the numbers is used as the type instead.
        When a filename has no article number, the product is looked up by the filename against product names instead.
      </p>

      {scanError && <p className="wiki-error">{scanError}</p>}

      {/* ── File list ── */}
      {files.length > 0 && (
        <div className="wiki-assign-docs-results">
          <div className="wiki-assign-docs-results-header">
            <span className="wiki-assign-docs-results-title">
              {files.length} PDF{files.length !== 1 ? "s" : ""}
              {eligibleCount > 0 && ` · ${eligibleCount} matched`}
              {noMatchCount  > 0 && ` · ${noMatchCount} unmatched`}
              {noArtNrCount  > 0 && ` · ${noArtNrCount} no match`}
            </span>
            {eligibleCount > 0 && (
              <button type="button" className="wiki-assign-docs-toggle-all" onClick={toggleAll}>
                {allEligibleSel ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>

          <div className="wiki-assign-docs-file-list">
            {files.map((f) => {
              const hasMatches = f.matches.length > 0;
              return (
                <div key={f.relativePath} className={`wiki-assign-docs-file${hasMatches ? "" : " no-match"}`}>
                  {hasMatches ? (
                    <input
                      type="checkbox"
                      className="wiki-assign-docs-check"
                      checked={selected.has(f.relativePath)}
                      onChange={() => toggleFile(f.relativePath)}
                      disabled={assigning}
                    />
                  ) : (
                    <span className="wiki-assign-docs-no-match-icon" aria-hidden="true">⚠</span>
                  )}
                  <div className="wiki-assign-docs-file-info">
                    <span className="wiki-assign-docs-filename" title={f.relativePath}>{f.relativePath || f.filename}</span>
                    <span className="wiki-assign-docs-doctype">{f.docType}</span>
                    {f.artNrs.length > 0 ? (
                      <span className="wiki-assign-docs-artnrs">{f.artNrs.join(", ")}</span>
                    ) : hasMatches ? (
                      <span className="wiki-assign-docs-artnrs">by name: “{f.searchName}”</span>
                    ) : (
                      <span className="wiki-assign-docs-warn">No article numbers in filename</span>
                    )}
                    {hasMatches ? (
                      <span className="wiki-assign-docs-matches">
                        {f.matches.map((m) => (
                          <span key={m.documentId} className="wiki-assign-docs-match-pill">
                            {m.title || m.artNr || m.documentId}
                          </span>
                        ))}
                      </span>
                    ) : f.artNrs.length > 0 ? (
                      <span className="wiki-assign-docs-warn">No matching entries found</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {eligibleCount > 0 && (
            <div className="wiki-assign-docs-actions">
              <button
                type="button"
                className="wiki-assign-docs-assign-btn"
                disabled={selected.size === 0 || assigning}
                onClick={() => void handleAssign()}
              >
                {assigning ? "Assigning…" : `Assign ${selected.size} document${selected.size !== 1 ? "s" : ""}`}
              </button>
              <span className="wiki-assign-docs-selected-count">
                {selected.size} of {eligibleCount} selected
              </span>
            </div>
          )}
        </div>
      )}

      {assignError && <p className="wiki-error" style={{ marginTop: "1rem" }}>{assignError}</p>}

      {/* ── Summary ── */}
      {assignResult && (
        <div className="wiki-assign-docs-summary">
          <div className="wiki-assign-docs-summary-row ok">
            <span>✓ Assigned</span>
            <strong>{assignResult.assigned}</strong>
          </div>
          <div className="wiki-assign-docs-summary-row">
            <span>Skipped</span>
            <strong>{assignResult.skipped}</strong>
          </div>
          {assignResult.errors.length > 0 && (
            <div className="wiki-assign-docs-summary-row error">
              <span>Errors</span>
              <strong>{assignResult.errors.length}</strong>
            </div>
          )}
          {assignResult.details.length > 0 && (
            <details className="wiki-assign-docs-details">
              <summary>{assignResult.details.length} assignment{assignResult.details.length !== 1 ? "s" : ""} made</summary>
              <ul>
                {assignResult.details.map((d, i) => (
                  <li key={i}><strong>{d.entry}</strong> ← {d.filename} ({d.docType})</li>
                ))}
              </ul>
            </details>
          )}
          {assignResult.errors.length > 0 && (
            <details className="wiki-assign-docs-details error">
              <summary>{assignResult.errors.length} error{assignResult.errors.length !== 1 ? "s" : ""}</summary>
              <ul>
                {assignResult.errors.map((e, i) => (
                  <li key={i}><strong>{e.filename}</strong>: {e.error}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── AdminPanel ─────────────────────────────────────────────────────────── */
/* Standalone modal — wraps AdminPanelContent with modal chrome and header.   */
/* Kept for potential standalone use; the UserPanel embeds AdminPanelContent. */

export function AdminPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="wiki-modal" onClick={onClose}>
      <div
        className="wiki-admin-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wiki-admin-header">
          <div className="wiki-admin-header-left">
            <span className="wiki-admin-header-icon" aria-hidden="true">⚙</span>
            <div>
              <h2>Admin Panel</h2>
              <p>Manage user accounts and permissions</p>
            </div>
          </div>
          <button
            type="button"
            className="wiki-modal-close"
            onClick={onClose}
            aria-label="Close admin panel"
          >
            ×
          </button>
        </div>
        <AdminPanelContent />
      </div>
    </div>
  );
}

/* ─── StrapiTokenCard ────────────────────────────────────────────────────── */
/* Lets an administrator paste in STRAPI_TOKEN from the browser when the host   */
/* has no working .env.local yet (e.g. right after restoring from a           */
/* scripts/db-backup.sh export, which deliberately never includes .env       */
/* files). Also doubles as a quick way to rotate the token later.            */

function StrapiTokenCard() {
  const [status,  setStatus]  = useState<"loading" | "missing" | "configured">("loading");
  const [hint,    setHint]    = useState<string | null>(null);
  const [value,   setValue]   = useState("");
  const [saving,  setSaving]  = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/auth/admin/strapi-token");
        const data = (await res.json()) as { configured?: boolean; hint?: string | null };
        setStatus(data.configured ? "configured" : "missing");
        setHint(data.hint ?? null);
      } catch {
        setStatus("missing");
      }
    })();
  }, []);

  async function handleSave() {
    if (!value.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/admin/strapi-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; hint?: string; message?: string; error?: string };
      if (!res.ok || !data.ok) {
        setMessage({ kind: "error", text: data.error ?? "Failed to save token." });
        return;
      }
      setStatus("configured");
      setHint(data.hint ?? null);
      setValue("");
      setMessage({ kind: "ok", text: data.message ?? "Saved." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Failed to save token." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wiki-admin-db-card">
      <div className="wiki-admin-db-card-header">
        <span className="wiki-admin-db-card-icon" aria-hidden="true">🔑</span>
        <div>
          <h3>Strapi API Token</h3>
          <p>
            {status === "loading" && "Checking configuration…"}
            {status === "missing" &&
              "Not configured — the site can't reach Strapi's /api/entries until this is set."}
            {status === "configured" &&
              `Configured${hint ? ` (ends in ${hint})` : ""}. Paste a new token below to rotate it.`}
          </p>
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <input
          type="password"
          className="wiki-admin-search"
          style={{ flex: "1 1 260px" }}
          placeholder="Paste the Strapi API token…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <button
          type="button"
          className="wiki-admin-db-btn"
          disabled={saving || !value.trim()}
          onClick={() => void handleSave()}
        >
          {saving && <span className="wiki-admin-spinner" aria-hidden="true" />}
          {saving ? "Saving…" : "Save Token"}
        </button>
      </div>
      {message && (
        <p className={message.kind === "error" ? "wiki-error" : undefined}>{message.text}</p>
      )}
    </div>
  );
}

/* ─── ServerContent ──────────────────────────────────────────────────────── */
/* Build + restart button with streaming log output.                          */

export function ServerContent() {
  const [state,  setState]  = useState<"idle" | "running" | "done" | "error">("idle");
  const [lines,  setLines]  = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  async function handleRebuild() {
    if (state === "running") return;
    if (!window.confirm("This will run `npm run build` and then restart pm2. The site will be briefly unavailable. Proceed?")) return;

    setState("running");
    setLines([]);

    try {
      const res = await fetch("/api/auth/admin/rebuild", { method: "POST" });
      if (!res.ok || !res.body) {
        setState("error");
        setLines(["Request failed — check server logs."]);
        return;
      }

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const text = JSON.parse(dataLine.slice(5).trim()) as string;
          if (text.startsWith("__DONE__")) {
            setState("done");
            setLines((prev) => [...prev, text.slice(8)]);
          } else if (text.startsWith("__ERROR__")) {
            setState("error");
            setLines((prev) => [...prev, text.slice(9)]);
          } else {
            setLines((prev) => [...prev, text]);
          }
        }
        /* auto-scroll */
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    } catch (err) {
      setState("error");
      setLines((prev) => [...prev, err instanceof Error ? err.message : "Unknown error"]);
    }
  }

  const btnLabel =
    state === "running" ? "Building…" :
    state === "done"    ? "✓ Done — restart another build?" :
    state === "error"   ? "Retry Build & Restart" :
    "Build & Restart Server";

  return (
    <div className="wiki-admin-db-section">
      <StrapiTokenCard />

      <div className="wiki-admin-db-card">
        <div className="wiki-admin-db-card-header">
          <span className="wiki-admin-db-card-icon" aria-hidden="true">🔄</span>
          <div>
            <h3>Build &amp; Restart</h3>
            <p>Runs <code>npm run build</code> then <code>pm2 restart all</code>. Output streams live below.</p>
          </div>
        </div>
        <button
          type="button"
          className={[
            "wiki-admin-db-btn",
            state === "running" ? "loading" : "",
            state === "done"    ? "done"    : "",
            state === "error"   ? "export"  : "",
          ].filter(Boolean).join(" ")}
          disabled={state === "running"}
          onClick={() => void handleRebuild()}
        >
          {state === "running" && <span className="wiki-admin-spinner" aria-hidden="true" />}
          {btnLabel}
        </button>
      </div>

      {lines.length > 0 && (
        <div
          ref={logRef}
          style={{
            marginTop: "0.75rem",
            background: "#0f172a",
            color: state === "error" ? "#f87171" : state === "done" ? "#4ade80" : "#e2e8f0",
            borderRadius: "10px",
            padding: "0.9rem 1rem",
            fontFamily: "monospace",
            fontSize: "0.78rem",
            lineHeight: 1.6,
            maxHeight: "420px",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
