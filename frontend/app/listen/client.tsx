"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { TopBar } from "@/app/components/top-bar";
import { useLanguage } from "@/app/components/language-provider";
import { searchEntries, type Entry } from "@/app/lib/entries";
import {
  addItemToProject,
  createProject,
  deleteProject,
  removeItemFromProject,
  renameProject,
  renumberProject,
  updateItem,
  useProject,
  useProjects,
  type ListItem,
  type Project,
} from "@/app/lib/lists";

/* ─── article search box (add articles to a project) ─────────────────────── */

function ArticleSearch({ project }: { project: Project }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    // When the box is empty the results are hidden by the render guard below,
    // so there's nothing to clear here — just skip searching.
    if (!q) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      setLoading(true);
      void searchEntries(q, 12)
        .then((r) => { if (!cancelled) setResults(r); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [query]);

  const inProject = useMemo(
    () => new Set(project.items.map((i) => i.entryId)),
    [project.items],
  );

  return (
    <div className="wiki-list-add">
      <input
        type="search"
        className="wiki-list-add-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t.lists.searchPlaceholder}
        aria-label={t.lists.addArticle}
        autoComplete="off"
      />
      {query.trim() && (
        <div className="wiki-list-add-results">
          {loading ? (
            <p className="wiki-muted wiki-list-add-status">{t.lists.searching}</p>
          ) : results.length === 0 ? (
            <p className="wiki-muted wiki-list-add-status">{t.lists.noResults}</p>
          ) : (
            results.map((entry) => {
              const already = inProject.has(entry.documentId);
              return (
                <div key={entry.documentId} className="wiki-list-add-result">
                  <span className="wiki-list-add-result-text">
                    <strong>{entry.title}</strong>
                    <span className="wiki-muted">
                      {entry.artNr ? `ArtNr: ${entry.artNr}` : entry.documentId}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="wiki-button small"
                    disabled={already}
                    onClick={() =>
                      addItemToProject(project.id, {
                        entryId: entry.documentId,
                        title: entry.title,
                        artNr: entry.artNr,
                      })
                    }
                  >
                    {already ? t.lists.added : t.lists.add}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/* ─── single article row (editable position + amount) ────────────────────── */

// Rendered with a key that embeds position+amount, so any external change
// (renumber, add-again bumping the amount) remounts the row and re-seeds these
// inputs from props — no syncing effect required.
function ItemRow({ projectId, item }: { projectId: string; item: ListItem }) {
  const { t } = useLanguage();
  const [pos, setPos] = useState(String(item.position));
  const [amt, setAmt] = useState(String(item.amount));

  function commitPos() {
    const n = Number(pos);
    if (Number.isFinite(n)) updateItem(projectId, item.entryId, { position: n });
    else setPos(String(item.position));
  }

  function commitAmt() {
    const n = Math.round(Number(amt));
    if (Number.isFinite(n) && n > 0) updateItem(projectId, item.entryId, { amount: n });
    else setAmt(String(item.amount));
  }

  return (
    <tr className="wiki-list-row">
      <td className="wiki-list-cell-pos">
        <input
          type="number"
          className="wiki-list-num"
          value={pos}
          onChange={(e) => setPos(e.target.value)}
          onBlur={commitPos}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          aria-label={t.lists.colPosition}
        />
      </td>
      <td className="wiki-list-cell-article">
        <Link href={`/products/${item.entryId}?from=/listen`} className="wiki-list-article-link">
          <strong>{item.title}</strong>
          {item.artNr && <span className="wiki-muted"> · {item.artNr}</span>}
        </Link>
      </td>
      <td className="wiki-list-cell-amount">
        <input
          type="number"
          min={1}
          step={1}
          className="wiki-list-num"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          onBlur={commitAmt}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          aria-label={t.lists.colAmount}
        />
      </td>
      <td className="wiki-list-cell-actions">
        <button
          type="button"
          className="wiki-button small danger"
          onClick={() => removeItemFromProject(projectId, item.entryId)}
          title={t.lists.remove}
          aria-label={t.lists.remove}
        >
          ×
        </button>
      </td>
    </tr>
  );
}

/* ─── project detail (articles table) ────────────────────────────────────── */

function ProjectDetail({ projectId }: { projectId: string }) {
  const { t } = useLanguage();
  const project = useProject(projectId);

  const sortedItems = useMemo(
    () => (project ? [...project.items].sort((a, b) => a.position - b.position) : []),
    [project],
  );
  const totalAmount = useMemo(
    () => sortedItems.reduce((sum, i) => sum + i.amount, 0),
    [sortedItems],
  );

  if (!project) return null;

  return (
    <section className="wiki-card wiki-list-detail">
      <div className="wiki-list-detail-head">
        <h2>{project.name}</h2>
        <div className="wiki-list-detail-actions">
          <button
            type="button"
            className="wiki-button small"
            onClick={() => renumberProject(project.id)}
            disabled={project.items.length === 0}
          >
            {t.lists.renumber}
          </button>
        </div>
      </div>

      <ArticleSearch project={project} />

      {sortedItems.length === 0 ? (
        <p className="wiki-muted wiki-list-empty">{t.lists.emptyProject}</p>
      ) : (
        <>
          <div className="wiki-list-table-scroll">
            <table className="wiki-list-table">
              <thead>
                <tr>
                  <th className="wiki-list-cell-pos">{t.lists.colPosition}</th>
                  <th className="wiki-list-cell-article">{t.lists.colArticle}</th>
                  <th className="wiki-list-cell-amount">{t.lists.colAmount}</th>
                  <th className="wiki-list-cell-actions" aria-label={t.lists.remove} />
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <ItemRow
                    key={`${item.entryId}:${item.position}:${item.amount}`}
                    projectId={project.id}
                    item={item}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="wiki-muted wiki-list-totals">
            {sortedItems.length} {t.lists.totalItems} · {totalAmount} {t.lists.totalAmount}
          </p>
        </>
      )}
    </section>
  );
}

/* ─── project list + create form ─────────────────────────────────────────── */

function ProjectChip({
  project,
  active,
  onSelect,
}: {
  project: Project;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useLanguage();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  function saveRename(e: FormEvent) {
    e.preventDefault();
    renameProject(project.id, draft);
    setRenaming(false);
  }

  if (renaming) {
    return (
      <form className="wiki-list-chip wiki-list-chip--editing" onSubmit={saveRename}>
        <input
          ref={inputRef}
          className="wiki-list-chip-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setDraft(project.name); setRenaming(false); } }}
        />
        <button type="submit" className="wiki-button small">{t.lists.renameSave}</button>
        <button
          type="button"
          className="wiki-button small ghost"
          onClick={() => { setDraft(project.name); setRenaming(false); }}
        >
          {t.lists.renameCancel}
        </button>
      </form>
    );
  }

  return (
    <div className={`wiki-list-chip${active ? " active" : ""}`}>
      <button type="button" className="wiki-list-chip-main" onClick={onSelect}>
        <span className="wiki-list-chip-name">{project.name}</span>
        <span className="wiki-list-chip-count">
          {project.items.length > 0
            ? `${project.items.length} ${t.lists.items}`
            : t.lists.empty}
        </span>
      </button>
      <button
        type="button"
        className="wiki-list-chip-icon"
        onClick={() => { setDraft(project.name); setRenaming(true); }}
        title={t.lists.rename}
        aria-label={t.lists.rename}
      >
        ✎
      </button>
      <button
        type="button"
        className="wiki-list-chip-icon danger"
        onClick={() => { if (window.confirm(t.lists.deleteConfirm)) deleteProject(project.id); }}
        title={t.lists.deleteProject}
        aria-label={t.lists.deleteProject}
      >
        ×
      </button>
    </div>
  );
}

export function ListsClient() {
  const { t } = useLanguage();
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  // Derive the effective selection instead of storing it in an effect: fall
  // back to the first project, or nothing when the chosen project is gone.
  const effectiveSelectedId = useMemo(() => {
    if (projects.length === 0) return null;
    if (selectedId && projects.some((p) => p.id === selectedId)) return selectedId;
    return projects[0]!.id;
  }, [projects, selectedId]);

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    const project = createProject(newName);
    setNewName("");
    setSelectedId(project.id);
  }

  return (
    <main className="wiki-shell">
      <Suspense fallback={null}>
        <TopBar
          actions={[
            { href: "/", label: t.nav.home },
            { href: "/products/all", label: t.nav.allProducts },
          ]}
        />
      </Suspense>

      <header className="wiki-header">
        <div className="wiki-title-row">
          <h1>{t.lists.title}</h1>
          <p>{t.lists.subtitle}</p>
        </div>
      </header>

      <section className="wiki-card">
        <p className="wiki-home-section-label">{t.lists.projectsHeading}</p>

        <form className="wiki-list-create" onSubmit={handleCreate}>
          <input
            type="text"
            className="wiki-list-create-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t.lists.newProjectPlaceholder}
            aria-label={t.lists.createProject}
          />
          <button type="submit" className="wiki-button primary" disabled={!newName.trim()}>
            {t.lists.createProject}
          </button>
        </form>

        {projects.length === 0 ? (
          <p className="wiki-muted wiki-list-empty">{t.lists.noProjects}</p>
        ) : (
          <div className="wiki-list-chips">
            {projects.map((project) => (
              <ProjectChip
                key={project.id}
                project={project}
                active={project.id === effectiveSelectedId}
                onSelect={() => setSelectedId(project.id)}
              />
            ))}
          </div>
        )}
      </section>

      {effectiveSelectedId ? (
        <ProjectDetail projectId={effectiveSelectedId} />
      ) : projects.length > 0 ? (
        <p className="wiki-muted wiki-list-hint">{t.lists.selectProject}</p>
      ) : null}
    </main>
  );
}
