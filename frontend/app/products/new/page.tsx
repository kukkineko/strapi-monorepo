"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { TopBar } from "@/app/components/top-bar";
import { useLanguage } from "@/app/components/language-provider";
import type { Entry } from "@/app/lib/entries";
import { IGS_DEFAULT_TEMPLATE } from "@/app/lib/igs";
import type { AuthUser } from "@/app/lib/auth-types";

export default function NewProductPage() {
  const router = useRouter();
  const { t } = useLanguage();

  const [title, setTitle] = useState("");
  const [artNr, setArtNr] = useState("");
  const [ean, setEan] = useState("");
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");
  const [docs, setDocs] = useState("");
  const [links, setLinks] = useState("");
  const [issues, setIssues] = useState("");
  const [tickets, setTickets] = useState("");
  const [igs, setIgs] = useState(IGS_DEFAULT_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ── Trusted check ────────────────────────────────────────────────────── */
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me");
        if (!res.ok) {
          setAuthLoading(false);
          return;
        }
        const data = (await res.json()) as { user: AuthUser | null };
        setAuthUser(data.user);
      } catch {
        /* network error – treated as not authenticated */
      } finally {
        setAuthLoading(false);
      }
    }
    void checkAuth();
  }, []);

  const isTrusted = authUser?.trusted === true;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!title.trim()) {
      setError(t.form.titleRequired);
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const payload = {
        title: title.trim(),
        artNr: artNr.trim() || undefined,
        EAN: ean.trim() || undefined,
        desc: desc.trim() || undefined,
        tags: tags.trim() || undefined,
        docs: docs.trim() || undefined,
        links: links.trim() || undefined,
        issues: issues.trim() || undefined,
        tickets: tickets.trim() || undefined,
        igs: igs.trim() || undefined,
      };

      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? t.form.failedToCreatePage);
      }

      const created = (await res.json()) as Entry;
      router.push(`/products/${created.documentId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : t.form.failedToCreatePage;
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  /* ── Loading state ─────────────────────────────────────────────────────── */
  if (authLoading) {
    return (
      <main className="wiki-shell">
        <TopBar actions={[{ href: "/", label: t.nav.home }]} />
        <section className="wiki-card">
          <p className="wiki-muted">Loading...</p>
        </section>
      </main>
    );
  }

  /* ── Permission denied ─────────────────────────────────────────────────── */
  if (!isTrusted) {
    return (
      <main className="wiki-shell">
        <TopBar actions={[{ href: "/", label: t.nav.home }]} />
        <section className="wiki-card">
          <h1>{t.form.createTitle}</h1>
          <p className="wiki-error">
            {authUser
              ? "Permission denied. Only trusted users can create new entries. Contact an administrator to request trusted access."
              : "You must be logged in as a trusted user to create new entries."}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="wiki-shell">
      <TopBar actions={[{ href: "/", label: t.nav.home }]} />

      <section className="wiki-card">
        <h1>{t.form.createTitle}</h1>

        <form className="wiki-form" onSubmit={onSubmit}>
          <label>
            {t.form.title}
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </label>

          <label>
            {t.form.artNr}
            <input
              type="text"
              value={artNr}
              onChange={(event) => setArtNr(event.target.value)}
            />
          </label>

          <label>
            {t.form.ean}
            <input
              type="text"
              value={ean}
              onChange={(event) => setEan(event.target.value)}
            />
          </label>

          <label>
            {t.form.description}
            <textarea
              value={desc}
              onChange={(event) => setDesc(event.target.value)}
              rows={5}
            />
          </label>

          <label>
            {t.form.tags}
            <textarea
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              rows={3}
            />
          </label>

          <label>
            {t.form.links}
            <textarea
              value={links}
              onChange={(event) => setLinks(event.target.value)}
              rows={3}
            />
          </label>

          <label>
            {t.form.docs}
            <textarea
              value={docs}
              onChange={(event) => setDocs(event.target.value)}
              rows={3}
            />
          </label>

          <label>
            {t.form.issues}
            <textarea
              value={issues}
              onChange={(event) => setIssues(event.target.value)}
              rows={3}
            />
          </label>

          <label>
            {t.form.tickets}
            <textarea
              value={tickets}
              onChange={(event) => setTickets(event.target.value)}
              rows={3}
            />
          </label>

          <label>
            IGS
            <textarea
              value={igs}
              onChange={(event) => setIgs(event.target.value)}
              rows={10}
            />
          </label>

          {error && <p className="wiki-error">{error}</p>}

          <div className="wiki-actions">
            <button type="submit" className="wiki-button primary" disabled={saving}>
              {saving ? t.form.creating : t.form.createPage}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
