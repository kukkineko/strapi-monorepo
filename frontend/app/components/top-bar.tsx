"use client";

import Link from "next/link";
import Image from "next/image";
import { CSSProperties, FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LanguageToggle } from "@/app/components/language-toggle";
import { ThemeToggle } from "@/app/components/theme-toggle";
import { useLanguage } from "@/app/components/language-provider";
import { MimirLogo } from "@/app/components/mimir-logo";
import { UserPanel } from "@/app/components/user-panel";
import { searchEntries, type Entry } from "@/app/lib/entries";
import { HoverPreview, useHoverPreview } from "@/app/components/hover-preview";
import { useSplit } from "@/app/components/compare-context";
import {
  displayName as formatDisplayName,
  displayUsername,
  type AuthUser,
} from "@/app/lib/auth-types";
import {
  TOPBAR_ICON_ALL,
  TOPBAR_ICON_ALL_SIZE,
  TOPBAR_ICON_BACK,
  TOPBAR_ICON_BACK_SIZE,
  TOPBAR_ICON_CREATE,
  TOPBAR_ICON_CREATE_SIZE,
  TOPBAR_ICON_EDIT,
  TOPBAR_ICON_EDIT_SIZE,
  TOPBAR_ICON_FALLBACK,
  TOPBAR_ICON_FALLBACK_SIZE,
  TOPBAR_ICON_HOME,
  TOPBAR_ICON_HOME_SIZE,
  TOPBAR_ICON_LOGIN,
  TOPBAR_ICON_LOGIN_SIZE,
  TOPBAR_LOGO_SLOT_WIDTH,
} from "@/app/lib/topbar-icons";

type TopBarAction = {
  href: string;
  label: string;
  primary?: boolean;
  adminOnly?: boolean;
  /** Set explicitly by callers that mean "the back button" — used instead of
   *  matching on `label`/`href` text so a locale swap or a `from=` query
   *  value can never silently change which action gets intercepted (see
   *  onBackItemClick below: interception is what keeps an untrusted `href`
   *  from ever being followed as a raw anchor navigation). */
  isBack?: boolean;
};
type TopBarProps = { actions: TopBarAction[] };

const SEARCH_HISTORY_KEY = "wiki-search-history";

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function isTrackableItemPath(pathname: string): boolean {
  return /^\/products\/[^/]+$/.test(pathname);
}

function actionIconSrc(action: TopBarAction): string {
  const label = action.label.toLowerCase();
  const href  = action.href.toLowerCase();
  if (action.isBack || label.includes("back") || label.includes("zuruck"))         return TOPBAR_ICON_BACK;
  if (label.includes("home") || href === "/")                                        return TOPBAR_ICON_HOME;
  if (label.includes("edit") || href.includes("/edit"))                              return TOPBAR_ICON_EDIT;
  if (label.includes("create") || label.includes("new") || href.includes("/new"))   return TOPBAR_ICON_CREATE;
  if (label.includes("all") || href.includes("/all"))                                return TOPBAR_ICON_ALL;
  return TOPBAR_ICON_FALLBACK;
}

function actionIconSize(action: TopBarAction): number {
  const label = action.label.toLowerCase();
  const href  = action.href.toLowerCase();
  if (action.isBack || label.includes("back") || label.includes("zuruck"))         return TOPBAR_ICON_BACK_SIZE;
  if (label.includes("home") || href === "/")                                        return TOPBAR_ICON_HOME_SIZE;
  if (label.includes("edit") || href.includes("/edit"))                              return TOPBAR_ICON_EDIT_SIZE;
  if (label.includes("create") || label.includes("new") || href.includes("/new"))   return TOPBAR_ICON_CREATE_SIZE;
  if (label.includes("all") || href.includes("/all"))                                return TOPBAR_ICON_ALL_SIZE;
  return TOPBAR_ICON_FALLBACK_SIZE;
}

function formatSearchPreviewMeta(entry: Entry): string {
  let matchcode1 = "-";
  let matchcode2 = "-";
  if (entry.igs) {
    try {
      const parsed = JSON.parse(entry.igs) as Record<string, unknown>;
      const first  = parsed.HC ?? parsed["Matchcode 1"];
      const second = parsed.HD ?? parsed["Matchcode 2"];
      if (typeof first  === "string" && first.trim())  matchcode1 = first.trim();
      if (typeof second === "string" && second.trim()) matchcode2 = second.trim();
    } catch {}
  }
  return `ArtNr: ${entry.artNr ?? "-"} - EAN: ${entry.EAN ?? "-"} - ${matchcode1}, ${matchcode2}`;
}

function getUserDisplayLabel(user: AuthUser): string {
  const uname = displayUsername(user.username);
  if (uname)  return uname;
  const name  = formatDisplayName(user.name);
  if (name)   return name.split(" ")[0];
  return user.email.split("@")[0];
}

/* ─── Login Modal ──────────────────────────────────────────────────────────── */

function LoginModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (user: AuthUser) => void;
}) {
  const [identifier, setIdentifier] = useState("");
  const [password,   setPassword]   = useState("");
  const [error,      setError]      = useState("");
  const [loading,    setLoading]    = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res  = await fetch("/api/auth/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ identifier: identifier.trim(), password }),
      });
      const data = (await res.json()) as { user?: AuthUser; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Login failed.");
      } else if (data.user) {
        onSuccess(data.user);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="wiki-modal" onClick={onClose}>
      <div className="wiki-modal-dialog wiki-login-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wiki-modal-header">
          <div>
            <h2>Sign In</h2>
            <p>Enter your credentials to continue</p>
          </div>
          <button type="button" className="wiki-modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="wiki-login-form">
          <label>
            <span>Email or username</span>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="your@email.com"
              autoComplete="username"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p className="wiki-error">{error}</p>}
          <div className="wiki-modal-footer">
            <button type="button" className="wiki-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="wiki-button primary" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── TopBar ───────────────────────────────────────────────────────────────── */

export function TopBar({ actions }: TopBarProps) {
  const { t }    = useLanguage();
  const router   = useRouter();
  const pathname = usePathname();
  const { addPane } = useSplit();

  /* auth */
  const [authUser,     setAuthUser]     = useState<AuthUser | null>(null);
  const [authLoading,  setAuthLoading]  = useState(true);
  const [loginOpen,      setLoginOpen]      = useState(false);
  const [userPanelOpen,  setUserPanelOpen]  = useState(false);

  /* hover preview */
  const { target: hoverTarget, showPreview, hidePreview } = useHoverPreview();

  /* search */
  const [currentSearchParams,   setCurrentSearchParams]   = useState("");
  const [searchValue,           setSearchValue]           = useState("");
  const [searchSuggestions,     setSearchSuggestions]     = useState<string[]>([]);
  const [searchPreview,         setSearchPreview]         = useState<Entry[]>([]);
  const [searchPreviewLoading,  setSearchPreviewLoading]  = useState(false);
  const [searchFocused,         setSearchFocused]         = useState(false);

  const urlQuery = useMemo(
    () => new URLSearchParams(currentSearchParams).get("q") ?? "",
    [currentSearchParams]
  );

  /* ── eagerly prefetch action routes on mount (works in dev + prod) ── */
  useEffect(() => {
    for (const action of actions) {
      if (action.href && action.href !== pathname) {
        router.prefetch(action.href);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── fetch auth on mount ── */
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me");
        if (res.ok) {
          const data = (await res.json()) as { user: AuthUser | null };
          setAuthUser(data.user ?? null);
        }
      } catch {
        /* not logged in */
      } finally {
        setAuthLoading(false);
      }
    }
    void checkAuth();
  }, []);

  /* ── sync search value from URL ── */
  useEffect(() => setSearchValue(urlQuery), [urlQuery]);

  /* ── sync search params from URL on navigation ── */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw    = window.location.search;
    const params = raw.startsWith("?") ? raw.slice(1) : raw;
    setCurrentSearchParams(params);
  }, [pathname]);

  /* ── load search history ── */
  useEffect(() => {
    try {
      const raw    = window.localStorage.getItem(SEARCH_HISTORY_KEY);
      const parsed = raw ? (JSON.parse(raw) as string[]) : [];
      setSearchSuggestions(
        Array.isArray(parsed)
          ? parsed.filter((s) => typeof s === "string" && s.trim())
          : []
      );
    } catch {
      setSearchSuggestions([]);
    }
  }, []);

  /* ── live search preview ── */
  useEffect(() => {
    const q = searchValue.trim();
    if (!q) {
      setSearchPreview([]);
      setSearchPreviewLoading(false);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      setSearchPreviewLoading(true);
      void searchEntries(q, 6)
        .then((r)  => { if (!cancelled) setSearchPreview(r);  })
        .catch(()  => { if (!cancelled) setSearchPreview([]); })
        .finally(() => { if (!cancelled) setSearchPreviewLoading(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [searchValue]);

  const visibleSuggestions = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    if (!q) return searchSuggestions.slice(0, 8);
    return searchSuggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
  }, [searchSuggestions, searchValue]);

  const searchPreviewVisible =
    searchFocused && (searchValue.trim().length > 0 || visibleSuggestions.length > 0);

  /* ── handlers ── */
  function onBackItemClick(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    router.back();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const params  = new URLSearchParams(currentSearchParams);
    params.set("sort", "artnr");
    const trimmed = searchValue.trim();
    if (trimmed) {
      params.set("q", trimmed);
      try {
        const next = [
          trimmed,
          ...searchSuggestions.filter((s) => s.toLowerCase() !== trimmed.toLowerCase()),
        ].slice(0, 12);
        window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
        setSearchSuggestions(next);
      } catch {}
    } else {
      params.delete("q");
    }
    void router.push(`/products/all?${params.toString()}`);
  }

  async function handleLogout() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    setAuthUser(null);
    setUserPanelOpen(false);
  }

  /* ── derived ── */
  const topbarStyle = { "--topbar-logo-slot-width": `${TOPBAR_LOGO_SLOT_WIDTH}px` } as CSSProperties;
  const userLabel   = authUser ? getUserDisplayLabel(authUser) : null;

  /* ─────────────────────────────────────────────────────────────────────────── */
  return (
    <>
      <nav className="wiki-topbar has-search" aria-label="Page actions" style={topbarStyle}>

        {/* Logo */}
        <div className="wiki-topbar-logo" aria-label="Logo area">
          <MimirLogo size="sm" />
        </div>

        {/* Action icons */}
        <div className="wiki-topbar-actions">
          {actions
            .filter((action) => !action.adminOnly || authUser?.administrator)
            .map((action) => (
            <Link
              key={`${action.href}-${action.label}`}
              href={action.href}
              className={`wiki-topbar-icon ${action.primary ? "primary" : ""}`}
              aria-label={action.label}
              data-tooltip={action.label}
              title={action.label}
              onClick={
                action.isBack || action.label.toLowerCase().includes("back")
                  ? onBackItemClick
                  : undefined
              }
            >
              <Image
                src={actionIconSrc(action)}
                alt=""
                aria-hidden="true"
                width={actionIconSize(action)}
                height={actionIconSize(action)}
                className="wiki-topbar-icon-image"
              />
            </Link>
          ))}

          {/* Split / new tab button */}
          <button
            type="button"
            className="wiki-topbar-icon wiki-topbar-split-btn"
            onClick={addPane}
            aria-label="Open new tab"
            title="Open new tab"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="8" height="18" rx="1.5" />
              <rect x="13" y="3" width="8" height="18" rx="1.5" />
              <path d="M16 9h2M16 12h2M16 15h2" />
            </svg>
          </button>
        </div>

        {/* Search bar */}
        <div className="wiki-topbar-search">
          <div
            className="wiki-topbar-search-shell"
            onBlurCapture={(ev) => {
              if (!ev.currentTarget.contains(ev.relatedTarget as Node | null))
                setSearchFocused(false);
            }}
          >
            <form className="wiki-topbar-search-form" onSubmit={onSubmit}>
              <input
                name="q"
                type="search"
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                placeholder={t.home.globalSearchPlaceholder}
                aria-label={t.home.globalSearchLabel}
                aria-expanded={searchPreviewVisible}
                aria-controls="wiki-topbar-search-preview"
                autoComplete="off"
              />

              <button
                type="submit"
                className="wiki-topbar-search-submit"
                aria-label={t.home.globalSearchLabel}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="M16.65 16.65L21 21" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
              </button>
            </form>

            {/* Search preview dropdown */}
            {searchPreviewVisible && (
              <div
                className="wiki-topbar-search-preview"
                id="wiki-topbar-search-preview"
              >
                {searchPreviewLoading ? (
                  <p className="wiki-topbar-search-preview-status">Searching…</p>
                ) : searchPreview.length > 0 ? (
                  <div className="wiki-topbar-search-preview-list">
                    {searchPreview.map((entry) => {
                      const target = `/products/${entry.documentId}`;
                      const thumb  = entry.pictureUrls?.[0];
                      return (
                        <Link
                          key={entry.documentId}
                          href={target}
                          className="wiki-topbar-search-preview-item"
                          onClick={() => setSearchFocused(false)}
                          onMouseEnter={(e) => showPreview(entry, e.currentTarget)}
                          onMouseLeave={hidePreview}
                        >
                          <span className="wiki-topbar-search-preview-thumb">
                            {thumb
                              ? <img src={thumb} alt="" width={44} height={44} loading="lazy" />
                              : <span>no image</span>}
                          </span>
                          <span className="wiki-topbar-search-preview-text">
                            <strong>{entry.title}</strong>
                            <span>{formatSearchPreviewMeta(entry)}</span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                ) : searchValue.trim() ? (
                  <p className="wiki-topbar-search-preview-status">
                    {t.home.globalSearchNoResults}
                  </p>
                ) : visibleSuggestions.length > 0 ? (
                  <div className="wiki-topbar-search-preview-list history">
                    {visibleSuggestions.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className="wiki-topbar-search-preview-item history"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setSearchValue(item); setSearchFocused(true); }}
                      >
                        <span className="wiki-topbar-search-preview-text single">
                          <strong>{item}</strong>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {/* Right side: login chip + language toggle */}
        <div className="wiki-topbar-right">

          {/* ── Loading state ── */}
          {authLoading && (
            <div className="wiki-login-chip wiki-login-chip-loading" aria-busy="true">
              <Image
                src={TOPBAR_ICON_LOGIN}
                alt=""
                aria-hidden="true"
                width={TOPBAR_ICON_LOGIN_SIZE}
                height={TOPBAR_ICON_LOGIN_SIZE}
                className="wiki-login-icon"
              />
            </div>
          )}

          {/* ── Logged-in user chip → opens UserPanel ── */}
          {!authLoading && authUser && (
            <button
              type="button"
              className="wiki-login-chip wiki-login-chip-active"
              onClick={() => setUserPanelOpen(true)}
              title={authUser.email}
            >
              <Image
                src={TOPBAR_ICON_LOGIN}
                alt=""
                aria-hidden="true"
                width={TOPBAR_ICON_LOGIN_SIZE}
                height={TOPBAR_ICON_LOGIN_SIZE}
                className="wiki-login-icon"
              />
              <span>{userLabel}</span>
              {authUser.administrator && (
                <span className="wiki-admin-badge">Admin</span>
              )}
            </button>
          )}

          {/* ── Logged-out login button ── */}
          {!authLoading && !authUser && (
            <button
              type="button"
              className="wiki-login-chip"
              title="Sign in"
              onClick={() => setLoginOpen(true)}
            >
              <Image
                src={TOPBAR_ICON_LOGIN}
                alt=""
                aria-hidden="true"
                width={TOPBAR_ICON_LOGIN_SIZE}
                height={TOPBAR_ICON_LOGIN_SIZE}
                className="wiki-login-icon"
              />
              <span>Login</span>
            </button>
          )}

          <ThemeToggle />
          <LanguageToggle />
        </div>
      </nav>

      {/* ── Modals (rendered outside <nav> to avoid stacking context issues) ── */}
      {loginOpen && (
        <LoginModal
          onClose={() => setLoginOpen(false)}
          onSuccess={(user) => { setAuthUser(user); setLoginOpen(false); }}
        />
      )}

      {userPanelOpen && authUser && (
        <UserPanel
          user={authUser}
          onClose={() => setUserPanelOpen(false)}
          onLogout={() => void handleLogout()}
        />
      )}

      <HoverPreview target={hoverTarget} />
    </>
  );
}
