import { type NextRequest, NextResponse } from "next/server";
import { searchEntries } from "@/app/lib/entries";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import type { Entry } from "@/app/lib/entries";

/** Fields that must not reach non-employee browsers. */
const EMPLOYEE_ONLY_FIELDS: ReadonlyArray<keyof Entry> = ["igs", "issues", "tickets"];

/**
 * GET /api/entries/search?q=...&limit=...
 *
 * Server-side proxy for the global search so that:
 *   1. The Strapi token is never needed in the browser bundle for search.
 *   2. Employee-only fields (igs, issues, tickets) are stripped from the
 *      response for non-employee users before any data reaches the browser.
 */
export async function GET(req: NextRequest) {
  const q     = req.nextUrl.searchParams.get("q") ?? "";
  const limit = Math.max(1, Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") ?? "24", 10),
    100,
  ));

  if (!q.trim()) {
    return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  }

  const entries = await searchEntries(q, limit);

  let isEmployee = false;
  try {
    const jwt = await getSessionJwt();
    if (jwt) {
      const ctx  = await loadUserContext(jwt);
      isEmployee = ctx?.user?.employee === true;
    }
  } catch { /* fail safe — treat as non-employee */ }

  const safeEntries: Entry[] = isEmployee
    ? entries
    : entries.map((entry) =>
        Object.fromEntries(
          Object.entries(entry).filter(
            ([key]) => !EMPLOYEE_ONLY_FIELDS.includes(key as keyof Entry),
          ),
        ) as Entry,
      );

  return NextResponse.json(safeEntries, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
