"use client";

import { createPortal } from "react-dom";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  displayName as formatDisplayName,
  displayUsername,
  displayCompany,
  type AuthUser,
} from "@/app/lib/auth-types";
import { getEntryById, type Entry } from "@/app/lib/entries";
import {
  AdminPanelContent,
  AuditLogContent,
  DBBackupContent,
  DBStatsContent,
  ImportDataContent,
  LinkConfidenceContent,
  AssignDocsContent,
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

type Tab = "profile" | "favourites" | "admin";

/* ─── ProfileTab ─────────────────────────────────────────────────────────── */

function ProfileTab({
  user,
  onLogout,
}: {
  user:     AuthUser;
  onLogout: () => void;
}) {
  const displayedName =
    formatDisplayName(user.name) ||
    displayUsername(user.username) ||
    user.email.split("@")[0];
  const company = displayCompany(user.company);

  return (
    <div>
      {/* ── Info fields ── */}
      <div className="wiki-user-profile-fields">
        <div className="wiki-user-profile-field">
          <span className="wiki-user-profile-label">Name</span>
          <span className="wiki-user-profile-value">{displayedName}</span>
        </div>

        <div className="wiki-user-profile-field">
          <span className="wiki-user-profile-label">Email</span>
          <span className="wiki-user-profile-value">{user.email}</span>
        </div>

        {company && (
          <div className="wiki-user-profile-field">
            <span className="wiki-user-profile-label">Company</span>
            <span className="wiki-user-profile-value">{company}</span>
          </div>
        )}
      </div>

      {/* ── Role badges ── */}
      <div className="wiki-user-profile-roles">
        {user.administrator && (
          <span className="wiki-user-role-badge admin">Administrator</span>
        )}
        {user.employee && (
          <span className="wiki-user-role-badge employee">Employee</span>
        )}
        {user.trusted && (
          <span className="wiki-user-role-badge trusted">Trusted</span>
        )}
        {user.confirmed && (
          <span className="wiki-user-role-badge confirmed">Confirmed</span>
        )}
      </div>

      {/* ── Sign out ── */}
      <button
        type="button"
        className="wiki-user-signout-btn"
        onClick={onLogout}
      >
        Sign out
      </button>
    </div>
  );
}

/* ─── FavouritesTab ──────────────────────────────────────────────────────── */

function FavouritesTab() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [query,   setQuery]   = useState("");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/auth/favorites");
        if (!res.ok) { setError("Failed to load favourites."); return; }
        const data = (await res.json()) as { favorites: string[] };
        const ids  = data.favorites ?? [];
        if (ids.length === 0) { setEntries([]); return; }
        const loaded = await Promise.all(
          ids.map((id) => getEntryById(id).catch(() => null))
        );
        setEntries(loaded.filter((e): e is Entry => e !== null));
      } catch {
        setError("Network error loading favourites.");
      } finally {
        setLoading(false);
      }
    }
    void load();
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
        Loading favourites…
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
              placeholder="Search favourites by name or ArtNr…"
              aria-label="Search favourites"
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
          No favourites yet. Star items on product pages to save them here.
        </p>
      )}

      {/* ── No search results ── */}
      {entries.length > 0 && filteredEntries.length === 0 && (
        <p className="wiki-user-panel-empty">No favourites match your search.</p>
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
                      <span aria-hidden="true" style={{ fontSize: "1.1rem", color: "#94a3b8" }}>?</span>
                    )}
                  </span>
                  <span className="wiki-user-fav-text">
                    <strong>{entry.title}</strong>
                    {entry.artNr && <span>ArtNr: {entry.artNr}</span>}
                  </span>
                </Link>
                <button
                  type="button"
                  className="wiki-user-fav-remove"
                  title="Remove from favourites"
                  aria-label={`Remove ${entry.title} from favourites`}
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

/* ─── AdminTab ───────────────────────────────────────────────────────────── */

type AdminView = null | "users" | "db" | "stats" | "audit" | "import" | "confidence" | "assigndocs";

const ADMIN_SECTIONS: Array<{
  id:     "users" | "db" | "stats" | "audit" | "import" | "confidence" | "assigndocs";
  icon:   string;
  title:  string;
  desc:   string;
  color:  string;
  bg:     string;
  border: string;
}> = [
  {
    id:     "users",
    icon:   "👥",
    title:  "Users",
    desc:   "Manage user accounts, roles and permissions",
    color:  "#1e40af",
    bg:     "#eff6ff",
    border: "#bfdbfe",
  },
  {
    id:     "audit",
    icon:   "📋",
    title:  "Audit Log",
    desc:   "View a log of all content changes by all users",
    color:  "#b45309",
    bg:     "#fffbeb",
    border: "#fde68a",
  },
  {
    id:     "db",
    icon:   "💾",
    title:  "DB Backup",
    desc:   "Export or import a full database backup",
    color:  "#7c3aed",
    bg:     "#f5f3ff",
    border: "#ddd6fe",
  },
  {
    id:     "stats",
    icon:   "📊",
    title:  "DB Statistics",
    desc:   "Entry counts, categories and cross-link graph",
    color:  "#0891b2",
    bg:     "#ecfeff",
    border: "#a5f3fc",
  },
  {
    id:     "import",
    icon:   "📥",
    title:  "Import Data",
    desc:   "Upload documents to AI and link replacement parts",
    color:  "#059669",
    bg:     "#ecfdf5",
    border: "#a7f3d0",
  },
  {
    id:     "confidence",
    icon:   "🔗",
    title:  "Link Confidence",
    desc:   "Edit confidence scores and metadata for product relations",
    color:  "#7c3aed",
    bg:     "#faf5ff",
    border: "#e9d5ff",
  },
  {
    id:     "assigndocs",
    icon:   "📂",
    title:  "Assign Documents",
    desc:   "Scan a folder and auto-assign PDFs to articles by article number",
    color:  "#0369a1",
    bg:     "#f0f9ff",
    border: "#bae6fd",
  },
];

function AdminTab({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<AdminView>(null);

  /* ── Hub (section picker) ── */
  if (view === null) {
    return (
      <div className="wiki-admin-hub">
        <p className="wiki-admin-hub-hint">Select a section</p>
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
              <span className="wiki-admin-hub-card-title" style={{ color: s.color }}>{s.title}</span>
              <span className="wiki-admin-hub-card-desc">{s.desc}</span>
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
          aria-label="Back to admin overview"
        >
          ←
        </button>
        <span className="wiki-admin-subpage-icon" aria-hidden="true">{section.icon}</span>
        <h2 className="wiki-admin-subpage-title">{section.title}</h2>
      </div>

      {view === "users"      && <AdminPanelContent />}
      {view === "audit"      && <AuditLogContent />}
      {view === "db"         && <DBBackupContent />}
      {view === "stats"      && <DBStatsContent />}
      {view === "import"     && <ImportDataContent />}
      {view === "confidence" && <LinkConfidenceContent />}
      {view === "assigndocs" && <AssignDocsContent />}
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
  const displayedName =
    formatDisplayName(user.name) ||
    displayUsername(user.username) ||
    user.email.split("@")[0];
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
          background:     "linear-gradient(145deg,#ffffff,#f8fbff)",
          boxShadow:      "0 20px 60px rgba(15,23,42,0.35)",
          overflow:       "hidden",
          border:         "1px solid rgba(200,210,230,0.6)",
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
            {/* Name / email / company */}
            <div style={{ display: "grid", gap: "0.1rem", minWidth: 0 }}>
              <strong style={{ fontSize: "0.96rem", fontWeight: 800, color: "#0f172a" }}>
                {displayedName}
              </strong>
              <span style={{ fontSize: "0.78rem", color: "#64748b" }}>{user.email}</span>
              {company && (
                <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>{company}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="wiki-modal-close"
            onClick={onClose}
            aria-label="Close"
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
            Profile
          </button>
          <button
            type="button" role="tab"
            aria-selected={tab === "favourites"}
            className={`wiki-user-panel-tab-btn${tab === "favourites" ? " active" : ""}`}
            onClick={() => setTab("favourites")}
          >
            Favourites
          </button>
          {user.administrator && (
            <button
              type="button" role="tab"
              aria-selected={tab === "admin"}
              className={`wiki-user-panel-tab-btn admin${tab === "admin" ? " active" : ""}`}
              onClick={() => setTab("admin")}
            >
              ⚙ Admin
            </button>
          )}
        </div>

        {/* ── Scrollable body ── */}
        <div className="wiki-user-panel-body">
          {tab === "profile"    && <ProfileTab user={user} onLogout={onLogout} />}
          {tab === "favourites" && <FavouritesTab />}
          {tab === "admin"      && user.administrator && <AdminTab onClose={onClose} />}
        </div>
      </div>
    </div>
  );

  if (!mounted) return null;
  return createPortal(panel, document.body);
}
