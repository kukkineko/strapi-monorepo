"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLanguage } from "@/app/components/language-provider";
import { addItemToProject, createProject, useProjects } from "@/app/lib/lists";

/**
 * Compact "add this article to a project list" control for the product page.
 * Open to everybody — lists are stored per-browser (see app/lib/lists.ts), so
 * no auth is required. Opens a small popover to pick an existing project or
 * spin up a new one, then drops the current article into it.
 */
export function AddToListButton({
  entryId,
  title,
  artNr,
}: {
  entryId: string;
  title: string;
  artNr?: string;
}) {
  const { t } = useLanguage();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [addedTo, setAddedTo] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  function flashAdded(id: string) {
    setAddedTo(id);
    window.setTimeout(() => setAddedTo((cur) => (cur === id ? null : cur)), 1200);
  }

  function addTo(projectId: string) {
    addItemToProject(projectId, { entryId, title, artNr });
    flashAdded(projectId);
  }

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    const project = createProject(newName);
    setNewName("");
    addItemToProject(project.id, { entryId, title, artNr });
    flashAdded(project.id);
  }

  return (
    <div className="wiki-addlist-wrap" ref={wrapRef}>
      <button
        type="button"
        className="wiki-addlist-button"
        onClick={() => setOpen((o) => !o)}
        title={t.lists.addArticle}
        aria-label={t.lists.addArticle}
        aria-expanded={open}
      >
        <span className="wiki-addlist-plus" aria-hidden="true">＋</span>
        <span className="wiki-addlist-label">{t.nav.lists}</span>
      </button>

      {open && (
        <div className="wiki-addlist-pop">
          {projects.length > 0 && (
            <div className="wiki-addlist-projects">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="wiki-addlist-project"
                  onClick={() => addTo(project.id)}
                >
                  <span className="wiki-addlist-project-name">{project.name}</span>
                  <span className="wiki-addlist-project-hint">
                    {addedTo === project.id ? `✓ ${t.lists.added}` : t.lists.add}
                  </span>
                </button>
              ))}
            </div>
          )}
          <form className="wiki-addlist-create" onSubmit={handleCreate}>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t.lists.newProjectPlaceholder}
              aria-label={t.lists.createProject}
            />
            <button type="submit" className="wiki-button small primary" disabled={!newName.trim()}>
              {t.lists.createProject}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
