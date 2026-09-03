"use client";

import { createPortal } from "react-dom";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  displayName as formatDisplayName,
  displayUsername,
  displayCompany,
  type AuthUser,
} from "@/app/lib/auth-types";
import { getEntryById, type Entry } from "@/app/lib/entries";
import { useProjects } from "@/app/lib/lists";
import { useLanguage } from "@/app/components/language-provider";
import {
  AdminPanelContent,
  AuditLogContent,
  DBBackupContent,
  DBStatsContent,
  ImportDataContent,
  LinkConfidenceContent,
  AssignDocsContent,
  ServerContent,
} from "@/app/components/admin-panel";

/* ─── avatar helpers ─────────────────────────────────────────────────────── */

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

/* ─── types ──────────────────────────────────────────────────────────────── */

type Tab = "profile" | "favourites" | "lists" | "admin";

/* ─── ChangePasswordForm ─────────────────────────────────────────────────── */

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const { t } = useLanguage();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword,     setNewPassword]     = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error,           setError]           = useState("");
  const [loading,         setLoading]         = useState(false);
  const [success,         setSuccess]         = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword.length < 6) { setError(t.userPanel.cpTooShort); return; }
    if (newPassword !== confirmPassword) { setError(t.userPanel.cpMismatch); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/password", {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ currentPassword, newPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? t.userPanel.cpFailed);
      } else {
        setSuccess(true);
      }
    } catch {
      setError(t.gate.errorNetwork);
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="wiki-user-profile-subpanel">
        <p className="wiki-user-profile-success">{t.userPanel.cpSuccess}</p>
        <button type="button" className="wiki-button" onClick={onDone}>{t.userPanel.cpBack}</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="wiki-login-form wiki-user-profile-subpanel">
      <label>
        <span>{t.userPanel.cpCurrentPassword}</span>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label>
        <span>{t.userPanel.cpNewPassword}</span>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <label>
        <span>{t.userPanel.cpConfirmNewPassword}</span>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      {error && <p className="wiki-error" style={{ margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="submit" className="wiki-button primary" disabled={loading}>
          {loading ? t.userPanel.cpSaving : t.userPanel.cpSave}
        </button>
        <button type="button" className="wiki-button" onClick={onDone} disabled={loading}>
          {t.userPanel.cpCancel}
        </button>
      </div>
    </form>
  );
}

/* ─── DeleteAccountForm ──────────────────────────────────────────────────── */

function DeleteAccountForm({
  onDone,
  onDeleted,
}: {
  onDone:    () => void;
  onDeleted: () => void;
}) {
  const { t } = useLanguage();
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (confirmText.trim().toUpperCase() !== t.userPanel.daConfirmWord) {
      setError(t.userPanel.daConfirmError);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/delete-account", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? t.userPanel.daFailed);
        setLoading(false);
        return;
      }
      onDeleted();
    } catch {
      setError(t.gate.errorNetwork);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="wiki-login-form wiki-user-profile-subpanel">
      <p className="wiki-error" style={{ margin: 0 }}>
        {t.userPanel.daWarning}
      </p>
      <label>
        <span>{t.userPanel.daPassword}</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label>
        <span>{t.userPanel.daConfirmLabel}</span>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          autoComplete="off"
          required
        />
      </label>
      {error && <p className="wiki-error" style={{ margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="submit"
          className="wiki-button"
          style={{ background: "#dc2626", color: "#fff", borderColor: "#dc2626" }}
          disabled={loading}
        >
          {loading ? t.userPanel.daDeleting : t.userPanel.daSubmit}
        </button>
        <button type="button" className="wiki-button" onClick={onDone} disabled={loading}>
          {t.userPanel.daCancel}
        </button>
      </div>
    </form>
  );
}

/* ─── ProfileTab ─────────────────────────────────────────────────────────── */

function ProfileTab({
  user,
  onLogout,
}: {
  user:     AuthUser;
  onLogout: () => void;
}) {
  const { t } = useLanguage();
  const [view, setView] = useState<"main" | "password" | "delete">("main");

  const displayedName =
    formatDisplayName(user.name) ||
    displayUsername(user.username) ||
    user.email.split("@")[0];
  const username = displayUsername(user.username);
  const company = displayCompany(user.company);

  if (view === "password") {
    return <ChangePasswordForm onDone={() => setView("main")} />;
  }

  if (view === "delete") {
    return <DeleteAccountForm onDone={() => setView("main")} onDeleted={onLogout} />;
  }

  return (
    <div>
      {/* ── Info fields ── */}
      <div className="wiki-user-profile-fields">
        <div className="wiki-user-profile-field">
          <span className="wiki-user-profile-label">{t.userPanel.fieldName}</span>
          <span className="wiki-user-profile-value">{displayedName}</span>
        </div>

        {username && (
          <div className="wiki-user-profile-field">
            <span className="wiki-user-profile-label">{t.userPanel.fieldUsername}</span>
            <span className="wiki-user-profile-value">{username}</span>
          </div>
        )}

        <div className="wiki-user-profile-field">
          <span className="wiki-user-profile-label">{t.userPanel.fieldEmail}</span>
          <span className="wiki-user-profile-value">{user.email}</span>
        </div>

        {company && (
          <div className="wiki-user-profile-field">
            <span className="wiki-user-profile-label">{t.userPanel.fieldCompany}</span>
            <span className="wiki-user-profile-value">{company}</span>
          </div>
        )}
      </div>

      {/* ── Role badges ── */}
      <div className="wiki-user-profile-roles">
        {user.administrator && (
          <span className="wiki-user-role-badge admin">{t.userPanel.roleAdmin}</span>
        )}
        {user.employee && (
          <span className="wiki-user-role-badge employee">{t.userPanel.roleEmployee}</span>
        )}
        {user.trusted && (
          <span className="wiki-user-role-badge trusted">{t.userPanel.roleTrusted}</span>
        )}
        {user.confirmed && (
          <span className="wiki-user-role-badge confirmed">{t.userPanel.roleConfirmed}</span>
        )}
      </div>

      {/* ── Sign out (left) + account actions (right), same row ── */}
      <div className="wiki-user-profile-actions-row">
        <button
          type="button"
          className="wiki-user-signout-btn"
          onClick={onLogout}
        >
          {t.gate.signOut}
        </button>

        <div className="wiki-user-profile-actions">
          <button type="button" className="wiki-button" onClick={() => setView("password")}>
            {t.userPanel.changePassword}
          </button>
          <button
            type="button"
            className="wiki-button"
            style={{ color: "#dc2626", borderColor: "#fecdd3" }}
            onClick={() => setView("delete")}
          >
            {t.userPanel.deleteAccount}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── FavouritesTab ──────────────────────────────────────────────────────── */

function FavouritesTab() {
  const { t } = useLanguage();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [query,   setQuery]   = useState("");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/auth/favorites");
        if (!res.ok) { setError(t.userPanel.favLoadFailed); return; }
        const data = (await res.json()) as { favorites: string[] };
        const ids  = data.favorites ?? [];
        if (ids.length === 0) { setEntries([]); return; }
        const loaded = await Promise.all(
          ids.map((id) => getEntryById(id).catch(() => null))
        );
        setEntries(loaded.filter((e): e is Entry => e !== null));
      } catch {
        setError(t.userPanel.favNetworkError);
      } finally {
        setLoading(false);
      }
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        (e.title  ?? "").toLowerCase().includes(q) ||
        (e.artNr  ?? "").toLowerCase().includes(q)
    );
  }, [entries, query]);

  async function unfavourite(entryId: string) {
    const res = await fetch("/api/auth/favorites", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ entryId, star: false }),
    });
    if (res.ok) {
      setEntries((prev) => prev.filter((e) => e.documentId !== entryId));
    }
  }

  if (loading) {
    return (
      <div className="wiki-user-panel-loading">
        <span className="wiki-admin-spinner" aria-hidden="true" />
        {t.userPanel.favLoading}
      </div>
    );
  }

  if (error) return <p className="wiki-error">{error}</p>;

  return (
    <>
      {/* ── Search bar (only shown when there are items to search) ── */}
      {entries.length > 0 && (
        <div className="wiki-admin-search-row">
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
              placeholder={t.userPanel.favSearchPlaceholder}
              aria-label={t.userPanel.favSearchLabel}
            />
          </div>
          {query.trim() && (
            <span className="wiki-admin-search-count">
              {filteredEntries.length} / {entries.length}
            </span>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {entries.length === 0 && (
        <p className="wiki-user-panel-empty">
          {t.userPanel.favEmpty}
        </p>
      )}

      {/* ── No search results ── */}
      {entries.length > 0 && filteredEntries.length === 0 && (
        <p className="wiki-user-panel-empty">{t.userPanel.favNoMatch}</p>
      )}

      {/* ── Favourites list ── */}
      {filteredEntries.length > 0 && (
        <div className="wiki-user-fav-list">
          {filteredEntries.map((entry) => {
            const thumb = entry.pictureUrls?.[0];
            return (
              <div key={entry.documentId} className="wiki-user-fav-item">
                <Link
                  href={`/products/${entry.documentId}`}
                  className="wiki-user-fav-link"
                >
                  <span className="wiki-user-fav-thumb">
                    {thumb ? (
                      <img src={thumb} alt="" width={48} height={48} loading="lazy" />
                    ) : (
                      <span aria-hidden="true" style={{ fontSize: "1.1rem", color: "var(--muted)" }}>?</span>
                    )}
                  </span>
                  <span className="wiki-user-fav-text">
                    <strong>{entry.title}</strong>
                    {entry.artNr && <span>{t.userPanel.favArtNrPrefix}: {entry.artNr}</span>}
                  </span>
                </Link>
                <button
                  type="button"
                  className="wiki-user-fav-remove"
                  title={t.userPanel.favRemoveTitle}
                  aria-label={`${t.userPanel.favRemoveAria} ${entry.title}`}
                  onClick={() => void unfavourite(entry.documentId)}
                >
                  ★
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ─── ListsTab ───────────────────────────────────────────────────────────── */
/*                                                                            */
/* Read-only view of the user's "Liste erstellen" projects. Data comes from   */
/* the shared store (server-synced + localStorage cache); full editing —       */
/* positions, amounts, add/remove — lives on the /listen page.                */

function ListsTab({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const projects = useProjects();

  if (projects.length === 0) {
    return (
      <div className="wiki-user-lists-empty">
        <p className="wiki-user-panel-empty">
          {t.userPanel.listsEmpty}
        </p>
        <Link href="/listen" className="wiki-button primary" onClick={onClose}>
          {t.userPanel.listsOpen}
        </Link>
      </div>
    );
  }

  return (
    <div className="wiki-user-lists">
      <div className="wiki-user-lists-head">
        <span className="wiki-muted">
          {projects.length} {projects.length === 1 ? t.userPanel.listsProject : t.userPanel.listsProjects}
        </span>
        <Link href="/listen" className="wiki-button small" onClick={onClose}>
          {t.userPanel.listsOpenEditor}
        </Link>
      </div>

      {projects.map((project) => {
        const items = [...project.items].sort((a, b) => a.position - b.position);
        const totalAmount = items.reduce((sum, i) => sum + i.amount, 0);
        return (
          <section key={project.id} className="wiki-user-list-card">
            <div className="wiki-user-list-card-head">
              <strong>
                {project.name}
                {project.shareCode && (
                  <span className="wiki-list-chip-shared" title={t.lists.shareTitle} aria-label={t.lists.shareTitle}>
                    🔗
                  </span>
                )}
              </strong>
              <span className="wiki-muted">
                {items.length} {items.length === 1 ? t.userPanel.listsArticle : t.userPanel.listsArticles}
                {items.length > 0 && ` · ${totalAmount} ${t.userPanel.listsTotal}`}
              </span>
            </div>

            {items.length === 0 ? (
              <p className="wiki-muted wiki-user-list-empty-row">{t.userPanel.listsNoArticles}</p>
            ) : (
              <div className="wiki-list-table-scroll">
                <table className="wiki-list-table">
                  <thead>
                    <tr>
                      <th className="wiki-list-cell-pos">{t.lists.colPosition}</th>
                      <th className="wiki-list-cell-article">{t.lists.colArticle}</th>
                      <th className="wiki-list-cell-amount">{t.lists.colAmount}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.entryId}>
                        <td className="wiki-list-cell-pos">{item.position}</td>
                        <td className="wiki-list-cell-article">
                          <Link
                            href={`/products/${item.entryId}?from=/listen`}
                            className="wiki-list-article-link"
                            onClick={onClose}
                          >
                            <strong>{item.title}</strong>
                            {item.artNr && <span className="wiki-muted"> · {item.artNr}</span>}
                          </Link>
                        </td>
                        <td className="wiki-list-cell-amount">{item.amount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ─── AdminTab ───────────────────────────────────────────────────────────── */

type AdminView = null | "users" | "db" | "stats" | "audit" | "import" | "confidence" | "assigndocs" | "server";

const ADMIN_SECTIONS: Array<{
  id:        "users" | "db" | "stats" | "audit" | "import" | "confidence" | "assigndocs" | "server";
  icon:      string;
  titleKey:  "adminUsersTitle" | "adminAuditTitle" | "adminDbTitle" | "adminStatsTitle" | "adminImportTitle" | "adminConfidenceTitle" | "adminAssignDocsTitle" | "adminServerTitle";
  descKey:   "adminUsersDesc" | "adminAuditDesc" | "adminDbDesc" | "adminStatsDesc" | "adminImportDesc" | "adminConfidenceDesc" | "adminAssignDocsDesc" | "adminServerDesc";
  color:     string;
  bg:        string;
  border:    string;
}> = [
  {
    id:       "users",
    icon:     "👥",
    titleKey: "adminUsersTitle",
    descKey:  "adminUsersDesc",
    color:    "#1e40af",
    bg:       "#eff6ff",
    border:   "#bfdbfe",
  },
  {
    id:       "audit",
    icon:     "📋",
    titleKey: "adminAuditTitle",
    descKey:  "adminAuditDesc",
    color:    "#b45309",
    bg:       "#fffbeb",
    border:   "#fde68a",
  },
  {
    id:       "db",
    icon:     "💾",
    titleKey: "adminDbTitle",
    descKey:  "adminDbDesc",
    color:    "#7c3aed",
    bg:       "#f5f3ff",
    border:   "#ddd6fe",
  },
  {
    id:       "stats",
    icon:     "📊",
    titleKey: "adminStatsTitle",
    descKey:  "adminStatsDesc",
    color:    "#0891b2",
    bg:       "#ecfeff",
    border:   "#a5f3fc",
  },
  {
    id:       "import",
    icon:     "📥",
    titleKey: "adminImportTitle",
    descKey:  "adminImportDesc",
    color:    "#059669",
    bg:       "#ecfdf5",
    border:   "#a7f3d0",
  },
  {
    id:       "confidence",
    icon:     "🔗",
    titleKey: "adminConfidenceTitle",
    descKey:  "adminConfidenceDesc",
    color:    "#7c3aed",
    bg:       "#faf5ff",
    border:   "#e9d5ff",
  },
  {
    id:       "assigndocs",
    icon:     "📂",
    titleKey: "adminAssignDocsTitle",
    descKey:  "adminAssignDocsDesc",
    color:    "#0369a1",
    bg:       "#f0f9ff",
    border:   "#bae6fd",
  },
  {
    id:       "server",
    icon:     "🔄",
    titleKey: "adminServerTitle",
    descKey:  "adminServerDesc",
    color:    "#b91c1c",
    bg:       "#fff1f2",
    border:   "#fecdd3",
  },
];

function AdminTab({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const [view, setView] = useState<AdminView>(null);

  /* ── Hub (section picker) ── */
  if (view === null) {
    return (
      <div className="wiki-admin-hub">
        <p className="wiki-admin-hub-hint">{t.userPanel.adminHint}</p>
        <div className="wiki-admin-hub-grid">
          {ADMIN_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="wiki-admin-hub-card"
              style={{
                /* Set directly so Tailwind's button reset cannot override */
                background:      s.bg,
                border:          `1.5px solid ${s.border}`,
                /* Also expose as custom properties for hover effects in CSS */
                "--card-color":  s.color,
                "--card-bg":     s.bg,
                "--card-border": s.border,
              } as React.CSSProperties}
              onClick={() => setView(s.id)}
            >
              <span className="wiki-admin-hub-card-icon" aria-hidden="true">{s.icon}</span>
              <span className="wiki-admin-hub-card-title" style={{ color: s.color }}>{t.userPanel[s.titleKey]}</span>
              <span className="wiki-admin-hub-card-desc">{t.userPanel[s.descKey]}</span>
              <span className="wiki-admin-hub-card-arrow" style={{ color: s.color }} aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* ── Sub-page ── */
  const section = ADMIN_SECTIONS.find((s) => s.id === view)!;

  return (
    <div className="wiki-admin-subpage">
      {/* Sub-page header with back button */}
      <div className="wiki-admin-subpage-header">
        <button
          type="button"
          className="wiki-admin-subpage-back"
          onClick={() => setView(null)}
          aria-label={t.userPanel.adminBack}
        >
          ←
        </button>
        <span className="wiki-admin-subpage-icon" aria-hidden="true">{section.icon}</span>
        <h2 className="wiki-admin-subpage-title">{t.userPanel[section.titleKey]}</h2>
      </div>

      {view === "users"      && <AdminPanelContent />}
      {view === "audit"      && <AuditLogContent />}
      {view === "db"         && <DBBackupContent />}
      {view === "stats"      && <DBStatsContent onClose={onClose} />}
      {view === "import"     && <ImportDataContent />}
      {view === "confidence" && <LinkConfidenceContent />}
      {view === "assigndocs" && <AssignDocsContent />}
      {view === "server"     && <ServerContent />}
    </div>
  );
}

/* ─── UserPanel ──────────────────────────────────────────────────────────── */
/*                                                                            */
/* Rendered via a React portal into document.body so that position:fixed on  */
/* the overlay is always relative to the viewport — not to any transformed   */
/* or backdrop-filtered ancestor (e.g. the sticky wiki-topbar).              */

export function UserPanel({
  user,
  onClose,
  onLogout,
}: {
  user:     AuthUser;
  onClose:  () => void;
  onLogout: () => void;
}) {
  const { t } = useLanguage();
  const [tab,     setTab]     = useState<Tab>("profile");
  const [mounted, setMounted] = useState(false);

  /* Only render the portal after the component mounts on the client. */
  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  /* Lock the underlying page's scroll while the panel is open.
   *
   * The panel is portal-rendered at document.body with `position: fixed`,
   * so any wheel event that doesn't land on a scrollable descendant
   * (e.g. over the canvas in DB Statistics, or over content that fits in
   * the panel body without overflowing) bubbles up to <html> and scrolls
   * the underlying page. From the user's perspective the modal stays
   * pinned but everything beneath it slides — which they described as
   * "the whole page scrolls back up" when accumulated wheel deltas pushed
   * the underlying scroll all the way to the top.
   *
   * Locking `documentElement.overflow` (rather than `body.overflow`) is
   * what actually stops the scroll in every modern browser; we also lock
   * body to be safe, and restore both on unmount. */
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const prevHtml = root.style.overflow;
    const prevBody = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      root.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, []);

  /* Close on Escape key — but NEVER while the admin tab is active.
     Admin import work is easy to lose accidentally and is persisted to
     localStorage anyway; we'd rather force the explicit × click. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && tab !== "admin") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, tab]);

  /* Backdrop click handler — same rule: admin tab is sticky. */
  function handleBackdropClick() {
    if (tab === "admin") return;
    onClose();
  }

  const avatarColor   = getAvatarColor(user);
  const initials      = getUserInitials(user);
  const username      = displayUsername(user.username) || user.email.split("@")[0];
  const fullName      = formatDisplayName(user.name);
  const company = displayCompany(user.company);

  const panel = (
    /* Dark overlay — clicking outside closes the panel */
    <div
      style={{
        position:       "fixed",
        inset:          0,
        background:     "rgba(0,0,0,0.72)",
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        zIndex:         99999,
        padding:        "1rem",
        boxSizing:      "border-box",
      }}
      onClick={handleBackdropClick}
    >
      {/* Panel — stop click propagation so it doesn't close.
          On the admin tab we expand to near full-screen so admins can
          review long replacement lists efficiently. */}
      <div
        style={{
          width:          tab === "admin" ? "min(1680px, 98vw)" : "min(920px, 100%)",
          maxHeight:      tab === "admin" ? "min(96vh, 1400px)" : "min(90vh, 880px)",
          minHeight:      "420px",
          display:        "flex",
          flexDirection:  "column",
          borderRadius:   "18px",
          background:     "linear-gradient(145deg, var(--surface), var(--stage-bg))",
          boxShadow:      "0 20px 60px rgba(15,23,42,0.35)",
          overflow:       "hidden",
          border:         "1px solid var(--line)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="wiki-user-panel-header">
          <div className="wiki-user-panel-identity">
            {/* Avatar circle */}
            <div
              style={{
                flexShrink:     0,
                width:          "44px",
                height:         "44px",
                borderRadius:   "50%",
                background:     avatarColor,
                display:        "inline-flex",
                alignItems:     "center",
                justifyContent: "center",
                color:          "#fff",
                fontSize:       "0.9rem",
                fontWeight:     800,
                userSelect:     "none",
              }}
              aria-hidden="true"
            >
              {initials}
            </div>
            {/* Username / full name / email / company */}
            <div style={{ display: "grid", gap: "0.1rem", minWidth: 0 }}>
              <strong style={{ fontSize: "0.96rem", fontWeight: 800, color: "var(--foreground)" }}>
                {username}
              </strong>
              {fullName && (
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--muted)" }}>{fullName}</span>
              )}
              <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>{user.email}</span>
              {company && (
                <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{company}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="wiki-modal-close"
            onClick={onClose}
            aria-label={t.userPanel.close}
          >
            ×
          </button>
        </div>

        {/* ── Tab bar ── */}
        <div className="wiki-user-panel-tabs" role="tablist">
          <button
            type="button" role="tab"
            aria-selected={tab === "profile"}
            className={`wiki-user-panel-tab-btn${tab === "profile" ? " active" : ""}`}
            onClick={() => setTab("profile")}
          >
            {t.userPanel.tabProfile}
          </button>
          <button
            type="button" role="tab"
            aria-selected={tab === "favourites"}
            className={`wiki-user-panel-tab-btn${tab === "favourites" ? " active" : ""}`}
            onClick={() => setTab("favourites")}
          >
            {t.userPanel.tabFavourites}
          </button>
          <button
            type="button" role="tab"
            aria-selected={tab === "lists"}
            className={`wiki-user-panel-tab-btn${tab === "lists" ? " active" : ""}`}
            onClick={() => setTab("lists")}
          >
            {t.userPanel.tabLists}
          </button>
          {user.administrator && (
            <button
              type="button" role="tab"
              aria-selected={tab === "admin"}
              className={`wiki-user-panel-tab-btn admin${tab === "admin" ? " active" : ""}`}
              onClick={() => setTab("admin")}
            >
              ⚙ {t.userPanel.tabAdmin}
            </button>
          )}
        </div>

        {/* ── Scrollable body ── */}
        <div className="wiki-user-panel-body">
          {tab === "profile"    && <ProfileTab user={user} onLogout={onLogout} />}
          {tab === "favourites" && <FavouritesTab />}
          {tab === "lists"      && <ListsTab onClose={onClose} />}
          {tab === "admin"      && user.administrator && <AdminTab onClose={onClose} />}
        </div>
      </div>
    </div>
  );

  if (!mounted) return null;
  return createPortal(panel, document.body);
}
