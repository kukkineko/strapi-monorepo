import { type NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";

/**
 * Lets an administrator paste in `STRAPI_TOKEN` from the browser instead of
 * needing shell access to the host. Exists for the case where `.env.local`
 * was deliberately left out of a restored deployment (see
 * scripts/db-backup.sh in the backend monorepo — the export/import zip never
 * contains .env files) and the app has no working Strapi API token yet.
 *
 * Scope is intentionally narrow: this only ever reads/writes the single
 * STRAPI_TOKEN=... line. It never touches any other variable, and it never
 * creates/reads a full .env template — a missing `.env.local` is created
 * from scratch containing just that one line.
 */

const PROJECT_ROOT = path.resolve(process.cwd());
const ENV_LOCAL_PATH = path.join(PROJECT_ROOT, ".env.local");
const STRAPI_BASE_URL = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/$/, "");

const TOKEN_LINE_RE = /^STRAPI_TOKEN=.*$/m;

async function requireAdmin() {
  const jwt = await getSessionJwt();
  if (!jwt) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }
  return { error: null };
}

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 4) return "…";
  return `…${trimmed.slice(-4)}`;
}

/** GET — report whether STRAPI_TOKEN is currently configured (never returns the value itself). */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const current = process.env.STRAPI_TOKEN ?? "";
  return NextResponse.json({
    configured: current.trim().length > 0,
    hint: current.trim() ? maskToken(current) : null,
  });
}

/** POST — write a new STRAPI_TOKEN into .env.local (creating the file if it doesn't exist yet). */
export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";

  if (!token) {
    return NextResponse.json({ error: "Token is required." }, { status: 400 });
  }
  if (/[\r\n]/.test(token)) {
    return NextResponse.json({ error: "Token cannot contain line breaks." }, { status: 400 });
  }

  /* Best-effort sanity check against the live Strapi instance. Only reject
     on a definitive "this token doesn't work" response — if Strapi can't be
     reached at all (e.g. it isn't up yet during initial setup), don't block
     saving on that. */
  try {
    const probe = await fetch(`${STRAPI_BASE_URL}/api/entries?pagination[pageSize]=1`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (probe.status === 401 || probe.status === 403) {
      return NextResponse.json(
        { error: `Strapi rejected this token (HTTP ${probe.status}). Double-check it was copied correctly.` },
        { status: 400 },
      );
    }
  } catch {
    // Strapi unreachable / timed out — proceed anyway, see comment above.
  }

  let existing = "";
  try {
    existing = await fs.readFile(ENV_LOCAL_PATH, "utf8");
  } catch {
    // .env.local doesn't exist yet — start from an empty file.
  }

  const newLine = `STRAPI_TOKEN=${token}`;
  let updated: string;
  if (TOKEN_LINE_RE.test(existing)) {
    updated = existing.replace(TOKEN_LINE_RE, newLine);
  } else if (existing.length === 0) {
    updated = `${newLine}\n`;
  } else {
    updated = existing.endsWith("\n") ? `${existing}${newLine}\n` : `${existing}\n${newLine}\n`;
  }

  try {
    await fs.writeFile(ENV_LOCAL_PATH, updated, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to write .env.local";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    hint: maskToken(token),
    message: "Saved to .env.local. Restart the server (below) for it to take effect.",
  });
}
