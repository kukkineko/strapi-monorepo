"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  generateListId,
  sanitizeProjects,
  type ListItem,
  type Project,
} from "@/app/lib/list-types";

export type { ListItem, Project } from "@/app/lib/list-types";

/**
 * "Liste erstellen" — project lists for every logged-in user.
 *
 * The whole site sits behind the login gate, so "everybody" here means every
 * authenticated user, with no role restriction. Lists are persisted on the
 * user's Strapi `appuser` record (json `lists` field) via /api/auth/lists, so
 * they follow the user across devices — the server copy is the source of truth.
 *
 * localStorage is kept as an instant local cache: the UI renders from it
 * synchronously, mutations write through to it immediately, and a debounced
 * save mirrors the whole array up to the server. On first load we adopt the
 * server copy (or, if the server is empty but this browser still holds lists
 * from the earlier local-only version, migrate those up).
 */

const STORAGE_KEY = "wiki-lists-v1";
/** Broadcast within the same tab; `storage` events only fire in *other* tabs. */
const CHANGE_EVENT = "wiki-lists-change";
const API_URL = "/api/auth/lists";
const SAVE_DEBOUNCE_MS = 600;

/* ─── in-memory cache + subscriptions ───────────────────────────────────────
 * useSyncExternalStore compares snapshots with Object.is, so getSnapshot must
 * return the same reference until the data actually changes. We keep the parsed
 * array cached and only swap it for a fresh array on mutation / external change.
 */

let cache: Project[] | null = null;
const listeners = new Set<() => void>();
const SERVER_SNAPSHOT: Project[] = [];

function readFromStorage(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
}

function getSnapshot(): Project[] {
  if (cache === null) {
    cache = readFromStorage();
  }
  return cache;
}

function getServerSnapshot(): Project[] {
  return SERVER_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}

/** Update local cache + localStorage + notify subscribers (no server write). */
function setLocal(next: Project[]) {
  cache = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      /* quota or serialization failure — state stays in memory for this tab */
    }
  }
  emit();
}

/** Apply a user mutation: persist locally and schedule a server save. */
function commit(next: Project[]) {
  setLocal(next);
  scheduleServerSave();
}

/* ─── server sync ───────────────────────────────────────────────────────── */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleServerSave() {
  if (typeof window === "undefined") return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveToServer();
  }, SAVE_DEBOUNCE_MS);
}

async function saveToServer() {
  if (typeof window === "undefined") return;
  try {
    await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lists: cache ?? [] }),
    });
  } catch {
    /* offline / not authenticated — localStorage still holds the data */
  }
}

/**
 * Load the authoritative copy from the server once per session. The server
 * copy wins; but if the server has nothing yet and this browser still holds
 * lists locally, push them up so the earlier local-only data isn't lost.
 */
async function loadFromServer() {
  if (typeof window === "undefined") return;
  try {
    const res = await fetch(API_URL);
    if (!res.ok) return;
    const data = (await res.json()) as { lists?: unknown };
    const serverLists = sanitizeProjects(data.lists);
    const local = getSnapshot();
    if (serverLists.length > 0) {
      setLocal(serverLists);
    } else if (local.length > 0) {
      // Migrate pre-existing local-only lists to the server.
      scheduleServerSave();
    }
  } catch {
    /* keep whatever is in localStorage */
  }
}

/* ── keep every tab / split-pane in sync, and hydrate from the server ── */
if (typeof window !== "undefined") {
  const refresh = () => {
    cache = readFromStorage();
    emit();
  };
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) refresh();
  });
  window.addEventListener(CHANGE_EVENT, refresh);
  void loadFromServer();
}

/* ─── mutations ─────────────────────────────────────────────────────────── */

function withUpdatedProject(
  projects: Project[],
  projectId: string,
  update: (p: Project) => Project,
): Project[] {
  return projects.map((p) => (p.id === projectId ? { ...update(p), updatedAt: Date.now() } : p));
}

export function createProject(name: string): Project {
  const project: Project = {
    id: generateListId(),
    name: name.trim() || "Liste",
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  commit([...getSnapshot(), project]);
  return project;
}

export function renameProject(projectId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  commit(withUpdatedProject(getSnapshot(), projectId, (p) => ({ ...p, name: trimmed })));
}

export function deleteProject(projectId: string) {
  commit(getSnapshot().filter((p) => p.id !== projectId));
}

/**
 * Append an article to a project. If it is already present the amount is bumped
 * instead of adding a duplicate row. New rows get the next free position number.
 */
export function addItemToProject(
  projectId: string,
  item: { entryId: string; title: string; artNr?: string; amount?: number },
) {
  commit(
    withUpdatedProject(getSnapshot(), projectId, (p) => {
      const addAmount = item.amount && item.amount > 0 ? item.amount : 1;
      const existing = p.items.find((i) => i.entryId === item.entryId);
      if (existing) {
        return {
          ...p,
          items: p.items.map((i) =>
            i.entryId === item.entryId ? { ...i, amount: i.amount + addAmount } : i,
          ),
        };
      }
      const nextPosition =
        p.items.reduce((max, i) => Math.max(max, i.position), 0) + 1;
      return {
        ...p,
        items: [
          ...p.items,
          {
            entryId: item.entryId,
            title: item.title,
            artNr: item.artNr,
            position: nextPosition,
            amount: addAmount,
          },
        ],
      };
    }),
  );
}

export function removeItemFromProject(projectId: string, entryId: string) {
  commit(
    withUpdatedProject(getSnapshot(), projectId, (p) => ({
      ...p,
      items: p.items.filter((i) => i.entryId !== entryId),
    })),
  );
}

export function updateItem(
  projectId: string,
  entryId: string,
  patch: Partial<Pick<ListItem, "position" | "amount">>,
) {
  commit(
    withUpdatedProject(getSnapshot(), projectId, (p) => ({
      ...p,
      items: p.items.map((i) => (i.entryId === entryId ? { ...i, ...patch } : i)),
    })),
  );
}

/** Renumber positions to a clean 1..n sequence in the current display order. */
export function renumberProject(projectId: string) {
  commit(
    withUpdatedProject(getSnapshot(), projectId, (p) => {
      const ordered = [...p.items].sort((a, b) => a.position - b.position);
      return { ...p, items: ordered.map((i, idx) => ({ ...i, position: idx + 1 })) };
    }),
  );
}

/* ─── hooks ─────────────────────────────────────────────────────────────── */

/** Reactive list of all projects for the current user. */
export function useProjects(): Project[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Reactive single project (or null once it is deleted). */
export function useProject(projectId: string | null): Project | null {
  const projects = useProjects();
  const select = useCallback(
    () => (projectId ? projects.find((p) => p.id === projectId) ?? null : null),
    [projects, projectId],
  );
  return select();
}
