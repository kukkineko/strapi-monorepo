"use client";

import { useParams, useRouter } from "next/navigation";
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { TopBar } from "@/app/components/top-bar";
import { useLanguage } from "@/app/components/language-provider";
import { getEntryById, searchEntries, uploadMedia } from "@/app/lib/entries";
import type { Entry, EntryPayload } from "@/app/lib/entries";
import {
  appendItemImages,
  getItemImages,
  removeItemImage,
} from "@/app/lib/item-images";
import type { AuthUser } from "@/app/lib/auth-types";

type SectionType = "issues" | "docs" | "links" | "tickets";

type TextEntry = {
  title: string;
  description: string;
  link?: string;
  attachments?: string[];
};

const IGS_REQUIRED_KEYS = ["C", "D", "IR", "IS", "HC", "HD", "BY", "P", "R"] as const;

const IGS_LEGACY_TO_API: Record<string, (typeof IGS_REQUIRED_KEYS)[number]> = {
  "Bezeichnung 1": "C",
  "Bezeichnung 2": "D",
  "Bezeichnung 3": "IR",
  "Bezeichnung 4": "IS",
  "Matchcode 1": "HC",
  "Matchcode 2": "HD",
  Kurztext: "BY",
  Ursprungsland: "P",
  Auslaufart: "R",
};

const IGS_DEFAULT_TEMPLATE = JSON.stringify(
  {
    C: "",
    D: "",
    IR: "",
    IS: "",
    HC: "",
    HD: "",
    BY: "",
    P: "",
    R: "",
  },
  null,
  2
);

function ensureIgsTemplate(value?: string): string {
  const base: Record<string, unknown> = {
    C: "",
    D: "",
    IR: "",
    IS: "",
    HC: "",
    HD: "",
    BY: "",
    P: "",
    R: "",
  };

  const raw = value?.trim();
  if (!raw) {
    return JSON.stringify(base, null, 2);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return raw;
    }

    const next = { ...base, ...(parsed as Record<string, unknown>) };

    for (const [legacyKey, apiKey] of Object.entries(IGS_LEGACY_TO_API)) {
      if ((next[apiKey] === undefined || next[apiKey] === null || next[apiKey] === "") && next[legacyKey] !== undefined) {
        next[apiKey] = next[legacyKey];
      }
      delete next[legacyKey];
    }

    for (const key of IGS_REQUIRED_KEYS) {
      const currentValue = next[key];
      if (currentValue === undefined || currentValue === null) {
        next[key] = "";
      }
    }

    return JSON.stringify(next, null, 2);
  } catch {
    return raw;
  }
}

function parseTextEntries(value?: string): TextEntry[] {
  if (!value?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        title: (item as TextEntry).title || "",
        description: (item as TextEntry).description || "",
        link: (item as TextEntry).link,
        attachments: (item as TextEntry).attachments || [],
      }));
    }
  } catch {
    // Backward compatibility with legacy text format.
  }

  return value
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const titleLine = lines[0]?.trim() || "";
      const entry: TextEntry = {
        title: titleLine,
        description: "",
        attachments: [],
      };

      const descLines: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith("link:")) {
          entry.link = line.slice(5).trim();
        } else {
          descLines.push(line);
        }
      }

      entry.description = descLines.join("\n").trim();
      return entry;
    });
}

function serializeTextEntries(entries: TextEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      title: entry.title.trim(),
      description: entry.description?.trim() || "",
      ...(entry.link ? { link: entry.link.trim() } : {}),
      ...(entry.attachments?.length ? { attachments: entry.attachments.filter(Boolean) } : {}),
    }))
  );
}

function parseLinkEntries(value?: string): string[] {
  if (!value?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item)).filter(Boolean);
    }
  } catch {
    // Backward compatibility with newline format.
  }

  return value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeLinkEntries(values: string[]): string {
  return JSON.stringify(values.map((value) => value.trim()).filter(Boolean));
}

function normalizeExternalLink(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed.replace(/^\/+/, "")}`;
}

export default function EditProductPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const params = useParams<{ id: string | string[] }>();
  const rawId = params.id;

  const entryId = useMemo(() => {
    const value = Array.isArray(rawId) ? rawId[0] : rawId;
    return value?.trim() ? value : null;
  }, [rawId]);

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
  const [catalogEntries, setCatalogEntries] = useState<Entry[]>([]);
  const [linkedEntriesLookup, setLinkedEntriesLookup] = useState<Map<string, Entry>>(new Map());
  const [linkSearchResults, setLinkSearchResults] = useState<Entry[]>([]);
  const [linkSearchLoading, setLinkSearchLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionType | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [sectionTitle, setSectionTitle] = useState("");
  const [sectionDescription, setSectionDescription] = useState("");
  const [sectionLink, setSectionLink] = useState("");
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [miscFileIds, setMiscFileIds] = useState<number[]>([]);
  const [itemImages, setItemImages] = useState<string[]>([]);
  const [imagesVersion, setImagesVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ── Trusted check ────────────────────────────────────────────────────── */
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me");
        if (!res.ok) { setAuthLoading(false); return; }
        const data = (await res.json()) as { user: AuthUser | null };
        setAuthUser(data.user);
      } catch { /* not logged in */ }
      finally { setAuthLoading(false); }
    }
    void checkAuth();
  }, []);

  const isTrusted = authUser?.trusted === true;

  const issuesEntries = useMemo(() => parseTextEntries(issues), [issues]);
  const docsEntries = useMemo(() => parseTextEntries(docs), [docs]);
  const ticketsEntries = useMemo(() => parseTextEntries(tickets), [tickets]);
  const linkEntries = useMemo(() => parseLinkEntries(links), [links]);

  useEffect(() => {
    async function loadImages() {
      if (!entryId) {
        setItemImages([]);
        return;
      }

      const images = await getItemImages(entryId);
      setItemImages(images);
    }

    void loadImages();
  }, [entryId, imagesVersion]);

  useEffect(() => {
    async function loadLinkedEntries() {
      if (linkEntries.length === 0) {
        setLinkedEntriesLookup(new Map());
        return;
      }

      const uniqueIds = Array.from(new Set(linkEntries));
      const resolved = await Promise.all(uniqueIds.map((id) => getEntryById(id)));
      const lookup = new Map<string, Entry>();

      for (let i = 0; i < uniqueIds.length; i++) {
        const requestedId = uniqueIds[i]!;
        const linkedEntry = resolved[i];
        if (!linkedEntry) {
          continue;
        }

        lookup.set(requestedId, linkedEntry);
        lookup.set(linkedEntry.documentId, linkedEntry);
        lookup.set(String(linkedEntry.id), linkedEntry);
      }

      setLinkedEntriesLookup(lookup);
    }

    void loadLinkedEntries();
  }, [linkEntries]);

  useEffect(() => {
    if (activeSection !== "links") {
      setLinkSearchResults([]);
      setLinkSearchLoading(false);
      return;
    }

    const query = linkQuery.trim();
    if (!query) {
      setLinkSearchResults([]);
      setLinkSearchLoading(false);
      return;
    }

    let cancelled = false;
    setLinkSearchLoading(true);

    void searchEntries(query, 24)
      .then((results) => {
        if (cancelled) {
          return;
        }

        const filtered = entryId
          ? results.filter((catalogEntry) => catalogEntry.documentId !== entryId)
          : results;
        setLinkSearchResults(filtered);
      })
      .catch(() => {
        if (!cancelled) {
          setLinkSearchResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLinkSearchLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, entryId, linkQuery]);

  const linkResults = useMemo(() => {
    const query = linkQuery.trim().toLowerCase();
    const source = query ? linkSearchResults : catalogEntries;
    return source
      .filter((catalogEntry) => catalogEntry.documentId !== entryId)
      .filter((catalogEntry) => {
        if (!query) {
          return true;
        }

        const text = `${catalogEntry.title} ${catalogEntry.artNr ?? ""} ${catalogEntry.EAN ?? ""} ${catalogEntry.documentId}`.toLowerCase();
        return text.includes(query);
      })
      .slice(0, 12);
  }, [catalogEntries, entryId, linkQuery, linkSearchResults]);

  function closeSectionEditor() {
    setActiveSection(null);
    setEditingIndex(null);
    setSectionTitle("");
    setSectionDescription("");
    setSectionLink("");
    setSelectedLinkId(null);
    setLinkQuery("");
    setAttachmentFiles([]);
  }

  function openSectionEditor(section: SectionType, index: number | null = null) {
    setActiveSection(section);
    setEditingIndex(index);

    if (section === "links") {
      setSelectedLinkId(index !== null ? linkEntries[index] ?? null : null);
      setSectionTitle("");
      setSectionDescription("");
      setSectionLink("");
      setAttachmentFiles([]);
      return;
    }

    const entries =
      section === "issues" ? issuesEntries : section === "docs" ? docsEntries : ticketsEntries;
    const current = index !== null ? entries[index] : null;
    setSectionTitle(current?.title ?? "");
    setSectionDescription(current?.description ?? "");
    setSectionLink(current?.link ?? "");
    setSelectedLinkId(null);
    setAttachmentFiles([]);
  }

  function buildPayload(overrides: Partial<{
    docs: string;
    links: string;
    issues: string;
    tickets: string;
    igs: string;
    miscFile: number[];
  }> = {}) {
    const clean = (value: string) => value.trim() || undefined;

    return {
      title: title.trim(),
      artNr: clean(artNr),
      EAN: clean(ean),
      desc: clean(desc),
      tags: clean(tags),
      docs: overrides.docs ?? clean(docs),
      links: overrides.links ?? clean(links),
      issues: overrides.issues ?? clean(issues),
      tickets: overrides.tickets ?? clean(tickets),
      igs: overrides.igs ?? clean(igs),
      miscFile: overrides.miscFile ?? miscFileIds,
    };
  }

  async function removeSectionEntry(section: SectionType, index: number) {
    let nextDocs = docs;
    let nextLinks = links;
    let nextIssues = issues;
    let nextTickets = tickets;

    if (section === "links") {
      nextLinks = serializeLinkEntries(linkEntries.filter((_, i) => i !== index));
      setLinks(nextLinks);
    } else if (section === "issues") {
      nextIssues = serializeTextEntries(issuesEntries.filter((_, i) => i !== index));
      setIssues(nextIssues);
    } else if (section === "docs") {
      nextDocs = serializeTextEntries(docsEntries.filter((_, i) => i !== index));
      setDocs(nextDocs);
    } else {
      nextTickets = serializeTextEntries(ticketsEntries.filter((_, i) => i !== index));
      setTickets(nextTickets);
    }

    if (!entryId || !title.trim()) {
      return;
    }

    try {
      const payload = buildPayload({
        docs: nextDocs,
        links: nextLinks,
        issues: nextIssues,
        tickets: nextTickets,
      });

      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, _auditSection: section, _auditAction: "delete" }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? t.form.failedToSavePage);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t.form.failedToSavePage;
      setError(message);
    }
  }

  async function saveSectionEntry() {

    if (!activeSection) {
      return;
    }

    if (activeSection === "links") {
      if (!selectedLinkId) {
        setError("Select a linked product first.");
        return;
      }

      const nextLinks = [...linkEntries];
      if (editingIndex !== null) {
        nextLinks[editingIndex] = selectedLinkId;
      } else {
        nextLinks.push(selectedLinkId);
      }

      setLinks(serializeLinkEntries(Array.from(new Set(nextLinks))));
      closeSectionEditor();
      return;
    }

    if (!sectionTitle.trim()) {
      setError(t.form.titleRequired);
      return;
    }

    const source =
      activeSection === "issues"
        ? issuesEntries
        : activeSection === "docs"
          ? docsEntries
          : ticketsEntries;

    const nextEntry: TextEntry = {
      title: sectionTitle.trim(),
      description: sectionDescription.trim(),
      link:
        activeSection === "docs" || activeSection === "tickets"
          ? sectionLink.trim() || undefined
          : undefined,
      attachments:
        editingIndex !== null
          ? (source[editingIndex]?.attachments ?? []).map((item) => String(item))
          : [],
    };

    if (attachmentFiles.length > 0) {
      try {
        const uploadedIds = await uploadMedia(attachmentFiles);
        const merged = Array.from(
          new Set([
            ...(nextEntry.attachments ?? []).map((value) => String(value)),
            ...uploadedIds.map((id) => String(id)),
          ])
        );
        nextEntry.attachments = merged;
        setMiscFileIds((current) => Array.from(new Set([...current, ...uploadedIds])));
      } catch (err) {
        const message = err instanceof Error ? err.message : t.form.failedToUploadImages;
        setError(message);
        return;
      }
    }

    const next =
      editingIndex !== null
        ? source.map((item, index) => (index === editingIndex ? nextEntry : item))
        : [...source, nextEntry];

    if (activeSection === "issues") {
      setIssues(serializeTextEntries(next));
    } else if (activeSection === "docs") {
      setDocs(serializeTextEntries(next));
    } else {
      setTickets(serializeTextEntries(next));
    }

    closeSectionEditor();
  }

  useEffect(() => {
    async function loadEntry() {
      if (!entryId) {
        setError(t.form.invalidPageId);
        setLoading(false);
        return;
      }

      try {
        setError(null);
        const entry = await getEntryById(entryId);

        if (!entry) {
          setError(t.form.pageNotFound);
          return;
        }

        setTitle(entry.title);
        setArtNr(entry.artNr ?? "");
        setEan(entry.EAN ?? "");
        setDesc(entry.desc ?? "");
        setTags(entry.tags ?? "");
        setDocs(entry.docs ?? "");
        setLinks(entry.links ?? "");
        setIssues(entry.issues ?? "");
        setTickets(entry.tickets ?? "");
        setIgs(ensureIgsTemplate(entry.igs));
        setMiscFileIds((entry.miscFiles ?? []).map((item) => item.id));
      } catch (err) {
        const message = err instanceof Error ? err.message : t.form.failedToLoadPage;
        setError(message);
      } finally {
        setLoading(false);
      }
    }

    void loadEntry();
  }, [entryId, t.form.failedToLoadPage, t.form.invalidPageId, t.form.pageNotFound]);

  async function onImageUpload(event: ChangeEvent<HTMLInputElement>) {
    if (!entryId) {
      setError(t.form.invalidPageId);
      return;
    }

    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    try {
      await appendItemImages(entryId, files);
      setImagesVersion((current) => current + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : t.form.failedToUploadImages;
      setError(message);
    } finally {
      event.target.value = "";
    }
  }

  async function onRemoveImage(index: number) {
    if (!entryId) {
      return;
    }

    try {
      await removeItemImage(entryId, index);
      setImagesVersion((current) => current + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : t.form.failedToUploadImages;
      setError(message);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!entryId) {
      setError(t.form.invalidPageId);
      return;
    }

    if (!title.trim()) {
      setError(t.form.titleRequired);
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const payload = buildPayload();
      const res = await fetch(`/api/entries/${encodeURIComponent(entryId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, _auditSection: "entry" }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? t.form.failedToSavePage);
      }

      router.push(`/products/${entryId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : t.form.failedToSavePage;
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  /* ── Auth loading ───────────────────────────────────────────────────── */
  if (authLoading) {
    return (
      <main className="wiki-shell">
        <TopBar actions={[{ href: entryId ? `/products/${entryId}` : "/", label: t.nav.back }]} />
        <section className="wiki-card">
          <p className="wiki-muted">Loading...</p>
        </section>
      </main>
    );
  }

  /* ── Permission denied ─────────────────────────────────────────────── */
  if (!isTrusted) {
    return (
      <main className="wiki-shell">
        <TopBar actions={[{ href: entryId ? `/products/${entryId}` : "/", label: t.nav.back }]} />
        <section className="wiki-card">
          <h1>Edit Product Page</h1>
          <p className="wiki-error">
            {authUser
              ? "Permission denied. Only trusted users can edit entries. Contact an administrator to request trusted access."
              : "You must be logged in as a trusted user to edit entries."}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="wiki-shell">
      <TopBar
        actions={[{ href: entryId ? `/products/${entryId}` : "/", label: t.nav.back }]}
      />

      <section className="wiki-card">
        <h1>Edit Product Page</h1>

        {loading ? (
          <p className="wiki-muted">{t.form.loadingPage}</p>
        ) : (
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
              IGS
              <textarea
                value={igs}
                onChange={(event) => setIgs(event.target.value)}
                rows={10}
              />
            </label>

            <div className="wiki-image-manager">
              <h2>Item Images</h2>
              <label className="wiki-upload-dropzone">
                <span className="wiki-upload-title">Choose images to upload</span>
                <span className="wiki-upload-hint">PNG, JPG, WebP, TIFF, etc.</span>
                <input
                  type="file"
                  multiple
                  accept="image/*"
                  onChange={onImageUpload}
                  className="wiki-upload-input"
                />
              </label>
              {itemImages.length > 0 && (
                <div className="wiki-upload-grid">
                  {itemImages.map((imageUrl, index) => (
                    <div key={index} className="wiki-upload-card">
                      <img
                        src={imageUrl}
                        alt={`Item ${index + 1}`}
                        className="wiki-upload-thumb"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.3"; }}
                      />
                      <button
                        type="button"
                        className="wiki-button-small"
                        onClick={() => void onRemoveImage(index)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {itemImages.length === 0 && (
                <p className="wiki-muted" style={{ textAlign: "center", marginTop: "0.5rem" }}>No images uploaded yet</p>
              )}
            </div>

            <div className="wiki-edit-sections">
              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2>{t.page.issues}</h2>
                  <button type="button" className="wiki-section-trigger" onClick={() => openSectionEditor("issues")}>
                    +
                  </button>
                </div>
                <div className="wiki-list-cards issues">
                  {issuesEntries.length > 0 ? (
                    issuesEntries.map((item, index) => (
                      <article key={`${item.title}-${index}`} className="wiki-note-card">
                        <strong>{item.title}</strong>
                        {item.description ? <p>{item.description}</p> : null}
                        <div className="wiki-card-actions">
                          <button type="button" className="wiki-button-small" onClick={() => openSectionEditor("issues", index)}>
                            Edit
                          </button>
                          <button type="button" className="wiki-button-small" onClick={() => removeSectionEntry("issues", index)}>
                            Delete
                          </button>
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="wiki-muted">{t.page.noIssues}</p>
                  )}
                </div>
              </section>

              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2>{t.page.docs}</h2>
                  <button type="button" className="wiki-section-trigger" onClick={() => openSectionEditor("docs")}>
                    +
                  </button>
                </div>
                <div className="wiki-list-cards docs">
                  {docsEntries.length > 0 ? (
                    docsEntries.map((item, index) => {
                      const href = normalizeExternalLink(item.link);
                      return (
                        <article key={`${item.title}-${index}`} className="wiki-note-card">
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="wiki-doc-card-link">
                              <strong>{item.title}</strong>
                              {item.description ? <p>{item.description}</p> : null}
                              <span className="wiki-card-link">{item.link}</span>
                            </a>
                          ) : (
                            <>
                              <strong>{item.title}</strong>
                              {item.description ? <p>{item.description}</p> : null}
                            </>
                          )}
                          <div className="wiki-card-actions">
                            <button type="button" className="wiki-button-small" onClick={() => openSectionEditor("docs", index)}>
                              Edit
                            </button>
                            <button type="button" className="wiki-button-small" onClick={() => removeSectionEntry("docs", index)}>
                              Delete
                            </button>
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <p className="wiki-muted">{t.page.noDocs}</p>
                  )}
                </div>
              </section>

              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2 className="wiki-links-heading">{t.page.links}</h2>
                  <button type="button" className="wiki-section-trigger" onClick={() => openSectionEditor("links")}>
                    +
                  </button>
                </div>
                <div className="wiki-list-cards links wiki-link-list">
                  {linkEntries.length > 0 ? (
                    linkEntries.map((value, index) => {
                      const linkedEntry =
                        linkedEntriesLookup.get(value) ??
                        catalogEntries.find(
                        (catalogEntry) =>
                          catalogEntry.documentId === value || String(catalogEntry.id) === value
                      );
                      const targetId = linkedEntry?.documentId ?? value;
                      const linkedImage = linkedEntry?.pictureUrls?.[0];

                      return (
                        <article key={`${value}-${index}`} className="wiki-note-card">
                          {linkedEntry ? (
                            <a href={`/products/${targetId}`} className="wiki-linked-entry">
                              {linkedImage ? (
                                <img src={linkedImage} alt={linkedEntry.title} className="wiki-link-thumbnail" />
                              ) : (
                                <div className="wiki-link-thumbnail wiki-link-placeholder">no image</div>
                              )}
                              <div className="wiki-link-text">
                                <strong>{linkedEntry.title}</strong>
                                <span>{linkedEntry.artNr ?? linkedEntry.documentId}</span>
                              </div>
                            </a>
                          ) : (
                            <strong>{value}</strong>
                          )}
                          <div className="wiki-card-actions">
                            <button type="button" className="wiki-button-small" onClick={() => openSectionEditor("links", index)}>
                              Edit
                            </button>
                            <button type="button" className="wiki-button-small" onClick={() => removeSectionEntry("links", index)}>
                              Delete
                            </button>
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <p className="wiki-muted">{t.page.noLinks}</p>
                  )}
                </div>
              </section>

              <section className="wiki-panel">
                <div className="wiki-section-header">
                  <h2>{t.page.tickets}</h2>
                  <button type="button" className="wiki-section-trigger" onClick={() => openSectionEditor("tickets")}>
                    +
                  </button>
                </div>
                <div className="wiki-list-cards tickets">
                  {ticketsEntries.length > 0 ? (
                    ticketsEntries.map((item, index) => {
                      const href = normalizeExternalLink(item.link);
                      return (
                        <article key={`${item.title}-${index}`} className="wiki-note-card">
                          <strong>{item.title}</strong>
                          {item.description ? <p>{item.description}</p> : null}
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="wiki-card-link">
                              {item.link}
                            </a>
                          ) : null}
                          <div className="wiki-card-actions">
                            <button type="button" className="wiki-button-small" onClick={() => openSectionEditor("tickets", index)}>
                              Edit
                            </button>
                            <button type="button" className="wiki-button-small" onClick={() => removeSectionEntry("tickets", index)}>
                              Delete
                            </button>
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <p className="wiki-muted">{t.page.noTickets}</p>
                  )}
                </div>
              </section>
            </div>

            {error && <p className="wiki-error">{error}</p>}

            {activeSection && (
              <div className="wiki-modal wiki-form-modal" onClick={closeSectionEditor}>
                <div className="wiki-modal-dialog" onClick={(event) => event.stopPropagation()}>
                  <div className="wiki-modal-header">
                    <h2>
                      {editingIndex !== null ? "Edit" : "Add"} {activeSection}
                    </h2>
                    <button type="button" className="wiki-modal-close" onClick={closeSectionEditor}>
                      ×
                    </button>
                  </div>

                  <div className="wiki-form wiki-issue-form">
                    {activeSection === "links" ? (
                      <>
                        <label>
                          {t.page.linkSearchPlaceholder}
                          <input
                            type="search"
                            value={linkQuery}
                            onChange={(event) => setLinkQuery(event.target.value)}
                            placeholder={t.page.linkSearchPlaceholder}
                            autoFocus
                          />
                        </label>

                        <div className="wiki-search-results">
                          {linkSearchLoading ? (
                            <p className="wiki-muted">Searching...</p>
                          ) : (
                            linkResults.map((catalogEntry) => (
                              <button
                                key={catalogEntry.documentId}
                                type="button"
                                className={`wiki-search-result ${selectedLinkId === catalogEntry.documentId ? "active" : ""}`}
                                onClick={() => setSelectedLinkId(catalogEntry.documentId)}
                              >
                                <strong>{catalogEntry.title}</strong>
                                <span>{catalogEntry.artNr ?? "-"} · {catalogEntry.documentId}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <label>
                          {t.form.title}
                          <input
                            type="text"
                            value={sectionTitle}
                            onChange={(event) => setSectionTitle(event.target.value)}
                            autoFocus
                          />
                        </label>

                        <label>
                          {t.form.description}
                          <textarea
                            value={sectionDescription}
                            onChange={(event) => setSectionDescription(event.target.value)}
                            rows={5}
                          />
                        </label>

                        {(activeSection === "docs" || activeSection === "tickets") && (
                          <label>
                            Link
                            <input
                              type="url"
                              value={sectionLink}
                              onChange={(event) => setSectionLink(event.target.value)}
                              placeholder="https://example.com"
                            />
                          </label>
                        )}

                        <label>
                          {t.page.attachFile}
                          <input
                            type="file"
                            multiple
                            onChange={(event) =>
                              setAttachmentFiles(Array.from(event.target.files || []))
                            }
                          />
                        </label>

                        {attachmentFiles.length > 0 && (
                          <div className="wiki-attachments-preview">
                            <p className="wiki-muted">{attachmentFiles.length} file(s) selected</p>
                            {attachmentFiles.map((file, idx) => (
                              <div key={idx} className="wiki-attachment-item">
                                <span>{file.name}</span>
                                <button
                                  type="button"
                                  className="wiki-button-small"
                                  onClick={() =>
                                    setAttachmentFiles(
                                      attachmentFiles.filter((_, i) => i !== idx)
                                    )
                                  }
                                >
                                  {t.page.removeAttachment}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    <div className="wiki-actions">
                      <button type="button" className="wiki-button secondary" onClick={closeSectionEditor}>
                        {t.page.closeIssueDialog}
                      </button>
                      <button type="button" className="wiki-button primary" onClick={() => void saveSectionEntry()}>
                        {t.form.saveChanges}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="wiki-actions">
              <button type="submit" className="wiki-button primary" disabled={saving}>
                {saving ? t.form.saving : t.form.saveChanges}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
