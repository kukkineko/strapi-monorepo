"use client";

import { FormEvent, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  TOPBAR_LOGO_HEIGHT,
  TOPBAR_LOGO_WIDTH,
} from "@/app/lib/topbar-icons";
import type { AuthUser } from "@/app/lib/auth-types";
import { useLanguage } from "@/app/components/language-provider";
import type { Language } from "@/app/lib/i18n";
import { Footer } from "@/app/components/footer";
import { CookieBanner } from "@/app/components/cookie-banner";

type GateState = "loading" | "unauthenticated" | "unconfirmed" | "blocked" | "ok";

/* ── Language selector (bottom-right corner) ──────────────────────────────── */

function GateLangSelector() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div className="wiki-gate-lang-selector">
      <button
        type="button"
        className={`wiki-gate-lang-btn${language === "de" ? " active" : ""}`}
        onClick={() => setLanguage("de" as Language)}
        aria-label={t.language.german}
      >
        DE
      </button>
      <span className="wiki-gate-lang-sep" aria-hidden="true">|</span>
      <button
        type="button"
        className={`wiki-gate-lang-btn${language === "en" ? " active" : ""}`}
        onClick={() => setLanguage("en" as Language)}
        aria-label={t.language.english}
      >
        EN
      </button>
    </div>
  );
}

/* ── Landing page ─────────────────────────────────────────────────────────── */

function LandingPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<"login" | "register">("login");

  const logo = (
    <div className="wiki-gate-logo">
      <Image
        src="/logo.png"
        alt="Logo"
        width={TOPBAR_LOGO_WIDTH}
        height={TOPBAR_LOGO_HEIGHT}
        style={{ width: "auto", height: "auto", maxWidth: "200px", maxHeight: "64px" }}
        priority
      />
    </div>
  );

  const legal = (
    <nav className="wiki-gate-legal-links">
      <Link href="/impressum">Impressum</Link>
      <span aria-hidden="true">·</span>
      <Link href="/datenschutz">Datenschutz</Link>
    </nav>
  );

  return (
    <div className="wiki-gate-landing">
      <div className="wiki-gate-card">
        {mode === "login" ? (
          <LoginForm logo={logo} legal={legal} onLogin={onLogin} onRegister={() => setMode("register")} />
        ) : (
          <RegisterForm logo={logo} legal={legal} onLogin={onLogin} onBack={() => setMode("login")} />
        )}
      </div>
      <GateLangSelector />
    </div>
  );
}

function LoginForm({
  logo,
  legal,
  onLogin,
  onRegister,
}: {
  logo: React.ReactNode;
  legal: React.ReactNode;
  onLogin: (user: AuthUser) => void;
  onRegister: () => void;
}) {
  const { t } = useLanguage();
  const [identifier, setIdentifier] = useState("");
  const [password,   setPassword]   = useState("");
  const [error,      setError]      = useState("");
  const [loading,    setLoading]    = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ identifier: identifier.trim(), password }),
      });
      const data = (await res.json()) as { user?: AuthUser; error?: string };
      if (!res.ok || !data.user) {
        setError(data.error ?? t.gate.errorLoginFailed);
      } else {
        onLogin(data.user);
      }
    } catch {
      setError(t.gate.errorNetwork);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {logo}
      <h1 className="wiki-gate-title">{t.gate.welcome}</h1>
      <p className="wiki-gate-subtitle">{t.gate.subtitle}</p>

      <form onSubmit={handleSubmit} className="wiki-login-form" style={{ width: "100%", marginTop: "0.25rem" }}>
        <label>
          <span>{t.gate.emailOrUsername}</span>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t.gate.emailPlaceholder}
            autoComplete="username"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            required
          />
        </label>
        <label>
          <span>{t.gate.password}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t.gate.passwordPlaceholder}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="wiki-error" style={{ margin: 0 }}>{error}</p>}
        <button
          type="submit"
          className="wiki-button primary"
          disabled={loading}
          style={{ marginTop: "0.25rem", width: "100%", justifyContent: "center" }}
        >
          {loading ? t.gate.signingIn : t.gate.signIn}
        </button>
      </form>

      <button
        type="button"
        className="wiki-gate-switch-btn"
        onClick={onRegister}
      >
        {t.gate.registerLink}
      </button>

      {legal}
    </>
  );
}

function RegisterForm({
  logo,
  legal,
  onLogin,
  onBack,
}: {
  logo: React.ReactNode;
  legal: React.ReactNode;
  onLogin: (user: AuthUser) => void;
  onBack: () => void;
}) {
  const { t } = useLanguage();
  const [firstName,       setFirstName]       = useState("");
  const [lastName,        setLastName]        = useState("");
  const [email,           setEmail]           = useState("");
  const [company,         setCompany]         = useState("");
  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error,           setError]           = useState("");
  const [loading,         setLoading]         = useState(false);
  const [success,         setSuccess]         = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 6) { setError(t.gate.errorPasswordTooShort); return; }
    if (password !== confirmPassword) { setError(t.gate.errorPasswordMismatch); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name: firstName, surname: lastName, email, company, password }),
      });
      const data = (await res.json()) as { user?: AuthUser; error?: string };
      if (!res.ok) {
        setError(data.error ?? t.gate.errorNetwork);
      } else if (data.user) {
        onLogin(data.user);
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
      <>
        {logo}
        <div className="wiki-gate-pending-icon" aria-hidden="true">✓</div>
        <h1 className="wiki-gate-title">{t.gate.registerTitle}</h1>
        <p className="wiki-gate-subtitle" style={{ textAlign: "center" }}>{t.gate.registerSuccess}</p>
        <button type="button" className="wiki-gate-switch-btn" onClick={onBack}>
          {t.gate.backToLogin}
        </button>
        {legal}
      </>
    );
  }

  return (
    <>
      {logo}
      <h1 className="wiki-gate-title">{t.gate.registerTitle}</h1>
      <p className="wiki-gate-subtitle">{t.gate.registerSubtitle}</p>

      <form onSubmit={handleSubmit} className="wiki-login-form" style={{ width: "100%", marginTop: "0.25rem" }}>
        <div className="wiki-gate-name-row">
          <label>
            <span>{t.gate.firstName}</span>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="given-name"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              required
            />
          </label>
          <label>
            <span>{t.gate.lastName}</span>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="family-name"
              required
            />
          </label>
        </div>
        <label>
          <span>{t.gate.email}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.gate.emailPlaceholder}
            autoComplete="email"
            required
          />
        </label>
        <label>
          <span>{t.gate.company}</span>
          <input
            type="text"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="organization"
          />
        </label>
        <label>
          <span>{t.gate.password}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t.gate.passwordPlaceholder}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          <span>{t.gate.confirmPassword}</span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t.gate.passwordPlaceholder}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <p className="wiki-error" style={{ margin: 0 }}>{error}</p>}
        <button
          type="submit"
          className="wiki-button primary"
          disabled={loading}
          style={{ marginTop: "0.25rem", width: "100%", justifyContent: "center" }}
        >
          {loading ? t.gate.registering : t.gate.register}
        </button>
      </form>

      <button type="button" className="wiki-gate-switch-btn" onClick={onBack}>
        {t.gate.backToLogin}
      </button>

      {legal}
    </>
  );
}

/* ── Pending approval page ────────────────────────────────────────────────── */

function PendingPage({
  user,
  onLogout,
}: {
  user:     AuthUser;
  onLogout: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="wiki-gate-landing">
      <div className="wiki-gate-card">
        <div className="wiki-gate-logo">
          <Image
            src="/logo.png"
            alt="Logo"
            width={TOPBAR_LOGO_WIDTH}
            height={TOPBAR_LOGO_HEIGHT}
            style={{ width: "auto", height: "auto", maxWidth: "200px", maxHeight: "64px" }}
            priority
          />
        </div>

        <div className="wiki-gate-pending-icon" aria-hidden="true">⏳</div>
        <h1 className="wiki-gate-title">{t.gate.pendingTitle}</h1>
        <p className="wiki-gate-subtitle">
          {t.gate.pendingSignedInAs} <strong>{user.email}</strong>
        </p>
        <p className="wiki-gate-note" style={{ maxWidth: "320px" }}>
          {t.gate.pendingNote}
        </p>

        <button
          type="button"
          className="wiki-button"
          onClick={onLogout}
          style={{ marginTop: "0.5rem" }}
        >
          {t.gate.signOut}
        </button>
      </div>

      <GateLangSelector />
    </div>
  );
}

/* ── Blocked page ─────────────────────────────────────────────────────────── */

function BlockedPage({
  user,
  onLogout,
}: {
  user:     AuthUser;
  onLogout: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="wiki-gate-landing">
      <div className="wiki-gate-card">
        <div className="wiki-gate-logo">
          <Image
            src="/logo.png"
            alt="Logo"
            width={TOPBAR_LOGO_WIDTH}
            height={TOPBAR_LOGO_HEIGHT}
            style={{ width: "auto", height: "auto", maxWidth: "200px", maxHeight: "64px" }}
            priority
          />
        </div>

        <div className="wiki-gate-pending-icon" aria-hidden="true">🚫</div>
        <h1 className="wiki-gate-title">{t.gate.blockedTitle}</h1>
        <p className="wiki-gate-subtitle">
          {t.gate.pendingSignedInAs} <strong>{user.email}</strong>
        </p>
        <p className="wiki-gate-note" style={{ maxWidth: "320px" }}>
          {t.gate.blockedNote}
        </p>

        <button
          type="button"
          className="wiki-button"
          onClick={onLogout}
          style={{ marginTop: "0.5rem" }}
        >
          {t.gate.signOut}
        </button>
      </div>

      <GateLangSelector />
    </div>
  );
}

/* ── AuthGate ─────────────────────────────────────────────────────────────── */

const LEGAL_PATHS = new Set(["/impressum", "/datenschutz"]);

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (LEGAL_PATHS.has(pathname)) return <>{children}</>;
  return <AuthGateInner>{children}</AuthGateInner>;
}

function AuthGateInner({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>("loading");
  const [user,  setUser]  = useState<AuthUser | null>(null);

  useEffect(() => { void checkAuth(); }, []);

  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/me");
      if (!res.ok) { setState("unauthenticated"); return; }
      const data = (await res.json()) as { user: AuthUser | null };
      const u = data.user;
      if (!u) { setState("unauthenticated"); return; }
      setUser(u);
      if (u.blocked) { setState("blocked"); return; }
      setState(u.confirmed ? "ok" : "unconfirmed");
    } catch {
      setState("unauthenticated");
    }
  }

  function handleLogin(u: AuthUser) {
    setUser(u);
    if (u.blocked) { setState("blocked"); return; }
    setState(u.confirmed ? "ok" : "unconfirmed");
  }

  async function handleLogout() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    setUser(null);
    setState("unauthenticated");
  }

  if (state === "loading") {
    return (
      <div className="wiki-gate-loading">
        <span
          className="wiki-admin-spinner"
          style={{ width: "2.5rem", height: "2.5rem", borderWidth: "3px" }}
          aria-hidden="true"
        />
      </div>
    );
  }

  if (state === "unauthenticated") {
    return <LandingPage onLogin={handleLogin} />;
  }

  if (state === "unconfirmed") {
    return <PendingPage user={user!} onLogout={handleLogout} />;
  }

  if (state === "blocked") {
    return <BlockedPage user={user!} onLogout={handleLogout} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <div style={{ flex: 1 }}>{children}</div>
      <Footer />
      <CookieBanner />
    </div>
  );
}
