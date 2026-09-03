import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  SHARE_CODE_ALPHABET,
  SHARE_CODE_LENGTH,
  type ListItem,
} from "@/app/lib/list-types";

/**
 * Shared-list code store: lets a user hand another user a short code that
 * resolves to a read-only snapshot of one of their lists (see the "Liste
 * erstellen" feature in app/lib/lists.ts).
 *
 * WHY A FILE (and not Strapi): lists themselves already live as opaque JSON
 * on each owner's own appuser record — there's no collection any other user's
 * request could query across accounts. Minting a code and resolving it needs
 * a lookup that isn't scoped to one user's session, so it lives in a small
 * cross-user JSON file on the frontend server instead, same as the page-view
 * counter (see app/lib/page-views.ts, which this mirrors: atomic temp-file
 * rename + in-process write serialization for the PM2 cluster).
 *
 * WHAT'S STORED: a snapshot (name + items) per code, not a live reference —
 * app/api/auth/lists' POST handler re-upserts the snapshot for any project
 * that still carries a shareCode on every list save, so it stays close to
 * current without this module needing to know anything about appuser records.
 */

export type SharedListEntry = {
  code: string;
  /** appuser documentId of the sharer — lets us verify who may update/revoke a code. */
  ownerUserId: string;
  sourceProjectId: string;
  name: string;
  items: ListItem[];
  createdAt: number;
  updatedAt: number;
};

type SharedListStore = {
  version: 1;
  codes: Record<string, SharedListEntry>;
};

const DATA_DIR = process.env.VIEW_DATA_DIR
  ? path.resolve(process.env.VIEW_DATA_DIR)
  : path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "shared-lists.json");

/** See page-views.ts for why plain-object keys need a null prototype here. */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyStore(): SharedListStore {
  return { version: 1, codes: emptyRecord() };
}

async function readStore(): Promise<SharedListStore> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && parsed.version === 1 && parsed.codes && typeof parsed.codes === "object") {
      const store = emptyStore();
      for (const [code, value] of Object.entries(parsed.codes as Record<string, unknown>)) {
        const entry = value as Partial<SharedListEntry> | null;
        if (
          entry &&
          typeof entry.code === "string" &&
          typeof entry.ownerUserId === "string" &&
          typeof entry.sourceProjectId === "string" &&
          typeof entry.name === "string" &&
          Array.isArray(entry.items)
        ) {
          store.codes[code] = {
            code: entry.code,
            ownerUserId: entry.ownerUserId,
            sourceProjectId: entry.sourceProjectId,
            name: entry.name,
            items: entry.items as ListItem[],
            createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
            updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
          };
        }
      }
      return store;
    }
  } catch {
    // Missing file (first run) or unparseable content — start fresh.
  }
  return emptyStore();
}

async function writeStoreAtomic(store: SharedListStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(store), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

/* Serialise writes within this process — see page-views.ts for the same pattern. */
let writeChain: Promise<unknown> = Promise.resolve();

function withWriteChain<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn);
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    out += SHARE_CODE_ALPHABET[crypto.randomInt(SHARE_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Mint a brand-new code for `project` and record it as owned by `ownerUserId`.
 * Retries on the astronomically unlikely event of a collision.
 */
export async function createShareCode(
  ownerUserId: string,
  project: { id: string; name: string; items: ListItem[] },
): Promise<string> {
  return withWriteChain(async () => {
    const store = await readStore();
    let code = randomCode();
    let attempts = 0;
    while (store.codes[code] && attempts < 5) {
      code = randomCode();
      attempts += 1;
    }
    const now = Date.now();
    store.codes[code] = {
      code,
      ownerUserId,
      sourceProjectId: project.id,
      name: project.name,
      items: project.items,
      createdAt: now,
      updatedAt: now,
    };
    await writeStoreAtomic(store);
    return code;
  });
}

/**
 * Refresh the snapshot for an existing code — no-ops if `code` doesn't exist
 * or isn't owned by `ownerUserId`, so a save can never overwrite someone
 * else's share by coincidence of a locally-forged shareCode field.
 */
export async function upsertSharedList(
  ownerUserId: string,
  code: string,
  project: { id: string; name: string; items: ListItem[] },
): Promise<void> {
  return withWriteChain(async () => {
    const store = await readStore();
    const existing = store.codes[code];
    if (!existing || existing.ownerUserId !== ownerUserId) return;
    store.codes[code] = {
      ...existing,
      sourceProjectId: project.id,
      name: project.name,
      items: project.items,
      updatedAt: Date.now(),
    };
    await writeStoreAtomic(store);
  });
}

/** Revoke a code — no-ops if it isn't owned by `ownerUserId`. */
export async function removeSharedList(ownerUserId: string, code: string): Promise<void> {
  return withWriteChain(async () => {
    const store = await readStore();
    const existing = store.codes[code];
    if (!existing || existing.ownerUserId !== ownerUserId) return;
    delete store.codes[code];
    await writeStoreAtomic(store);
  });
}

/** Public read (no ownership check) for the redeem endpoint. */
export async function getSharedList(
  code: string,
): Promise<{ name: string; items: ListItem[]; updatedAt: number } | null> {
  const store = await readStore();
  const entry = store.codes[code];
  if (!entry) return null;
  return { name: entry.name, items: entry.items, updatedAt: entry.updatedAt };
}
