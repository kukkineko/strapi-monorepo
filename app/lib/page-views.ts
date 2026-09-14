import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Item-page view tracking store.
 *
 * Persists a small JSON file on the frontend server recording how many times
 * each entry's product page has been opened. Read by the admin "Page Views"
 * tab in DB Statistics; written by POST /api/entries/[id]/view.
 *
 * WHAT'S STORED
 * ─────────────
 *   - `totals`  documentId → all-time counted views.
 *   - `last`    documentId → ISO of the most recent counted view.
 *   - `seen`    documentId → userId → epoch ms of that user's last COUNTED
 *               view. Drives the "once per user per 24h per item" rule below.
 *   - `events`  a flat log of `{ d: documentId, t: epochMs }` for every counted
 *               view, so the stats route can compute rolling-window counts
 *               (day / week / month / year). Pruned to `RETAIN_MS`.
 *
 * DEDUP: a view is only counted if this user hasn't already been counted for
 * this item within the last 24h — so refreshing an article repeatedly does not
 * inflate the number.
 *
 * WHY A FILE (and not Strapi): counting a hit on every page load is a
 * high-frequency, low-value write. Pushing each into Strapi would pollute the
 * audit log, bump `updatedAt` on real content and add a round-trip per view. A
 * tiny JSON file on the same host is cheaper and self-contained.
 *
 * CONCURRENCY: production runs a PM2 cluster (see pm2.config.js). Within a
 * process, writes are serialised through `writeChain`; across processes we
 * read-modify-write with an atomic temp-file rename so the file is never seen
 * half-written. Two processes counting in the same millisecond can rarely lose
 * one increment — acceptable for a ~50-user internal metric.
 *
 * The data directory defaults to `<cwd>/data`, override with VIEW_DATA_DIR to
 * keep the counter outside a code-only redeploy tree.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long individual view events are retained (covers the "year" window). */
const RETAIN_MS = 370 * DAY_MS;

export type ViewEvent = { d: string; t: number };

export type ViewStore = {
  version: 2;
  /** documentId → all-time counted views */
  totals: Record<string, number>;
  /** documentId → ISO timestamp of the most recent counted view */
  last: Record<string, string>;
  /** documentId → userId → epoch ms of that user's last counted view */
  seen: Record<string, Record<string, number>>;
  /** flat log of counted views for rolling-window aggregation */
  events: ViewEvent[];
  /** ISO timestamp of the last write */
  updatedAt: string;
};

const DATA_DIR = process.env.VIEW_DATA_DIR
  ? path.resolve(process.env.VIEW_DATA_DIR)
  : path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "page-views.json");

/**
 * `documentId`/`userId` values flow into these stores as plain-object keys
 * (`store.seen[id]`, `store.totals[id]`, …). A key of "__proto__" on an
 * ordinary `{}` doesn't create an own property — it resolves through the
 * `Object.prototype.__proto__` accessor, so `store.seen[id] ?? (store.seen[id]
 * = {})` can return the live `Object.prototype` object itself, and the next
 * assignment into it pollutes every plain object in the process. Null-
 * prototype objects have no such accessor, so the same bracket access is
 * always a safe own-property lookup regardless of what key reaches it.
 */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyStore(): ViewStore {
  return {
    version: 2,
    totals: emptyRecord(),
    last: emptyRecord(),
    seen: emptyRecord(),
    events: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function asRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyRecord();
  // Copy onto a null-prototype target so a previously-persisted "__proto__"/
  // "constructor" key (from before this fix) can't resurrect the pollution
  // path on read either.
  return Object.assign(emptyRecord<T>(), value as Record<string, T>);
}

/** Read + parse the store, migrating the old v1 shape and tolerating corruption. */
export async function readViewStore(): Promise<ViewStore> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed && (parsed as { version?: unknown }).version === 2) {
      const events = Array.isArray(parsed.events)
        ? (parsed.events as unknown[]).filter(
            (e): e is ViewEvent =>
              !!e && typeof (e as ViewEvent).d === "string" && typeof (e as ViewEvent).t === "number",
          )
        : [];
      return {
        version: 2,
        totals: asRecord<number>(parsed.totals),
        last: asRecord<string>(parsed.last),
        seen: asRecord<Record<string, number>>(parsed.seen),
        events,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      };
    }

    // v1 → v2 migration: { counts, last, updatedAt }. Old totals are preserved
    // as all-time counts; per-window history starts empty (timestamps unknown).
    if (parsed && parsed.counts && typeof parsed.counts === "object") {
      return {
        version: 2,
        totals: asRecord<number>(parsed.counts),
        last: asRecord<string>(parsed.last),
        seen: emptyRecord(),
        events: [],
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      };
    }
  } catch {
    // Missing file (first run) or unparseable content → start fresh.
  }
  return emptyStore();
}

async function writeStoreAtomic(store: ViewStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(store), "utf8");
  // rename is atomic on the same filesystem — readers never see a partial file.
  await fs.rename(tmp, DATA_FILE);
}

/* Serialise writes within this process so concurrent recordView() calls can't
   clobber each other's read-modify-write. */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Record a view of `documentId` by `userId`, applying the once-per-user-per-24h
 * rule. Resolves to `true` if the view was counted, `false` if it was
 * suppressed as a duplicate. The caller's route swallows errors so a failed
 * write never breaks the page.
 */
export function recordView(documentId: string, userId: string): Promise<boolean> {
  const id = documentId.trim();
  const uid = (userId || "").trim() || "anon";
  if (!id) return Promise.resolve(false);

  const next = writeChain.then(async () => {
    const store = await readViewStore();
    const now = Date.now();

    const seenForItem = store.seen[id] ?? (store.seen[id] = emptyRecord<number>());
    const lastCounted = seenForItem[uid];
    if (typeof lastCounted === "number" && now - lastCounted < DAY_MS) {
      // This user already counted for this item within the last 24h.
      return false;
    }

    seenForItem[uid] = now;
    store.totals[id] = (store.totals[id] ?? 0) + 1;
    store.last[id] = new Date(now).toISOString();
    store.events.push({ d: id, t: now });

    // Prune events beyond the retention window (bounds file growth).
    const retainCutoff = now - RETAIN_MS;
    if (store.events.length > 0 && store.events[0]!.t < retainCutoff) {
      store.events = store.events.filter((e) => e.t >= retainCutoff);
    }
    // Prune seen entries older than 24h — they no longer block a new count.
    for (const docId of Object.keys(store.seen)) {
      const perUser = store.seen[docId]!;
      for (const u of Object.keys(perUser)) {
        if (now - perUser[u]! >= DAY_MS) delete perUser[u];
      }
      if (Object.keys(perUser).length === 0) delete store.seen[docId];
    }

    store.updatedAt = store.last[id];
    await writeStoreAtomic(store);
    return true;
  });

  writeChain = next.catch(() => {});
  return next;
}
