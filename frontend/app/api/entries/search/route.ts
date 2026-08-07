import { type NextRequest, NextResponse } from "next/server";
import { searchEntries } from "@/app/lib/entries";
import { getSessionJwt, loadUserContextCached } from "@/app/lib/auth-server";
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

  const jwt = await getSessionJwt();
  if (!jwt) return NextResponse.json([], { status: 401 });

  // Run auth and the search concurrently instead of serially. The search runs
  // speculatively but its results are only released after auth passes below,
  // so an unauthorized caller still gets nothing — we just don't pay for the
  // two Strapi round-trips one after the other.
  const [context, entries] = await Promise.all([
    loadUserContextCached(jwt),
    searchEntries(q, limit),
  ]);

  if (!context?.user) return NextResponse.json([], { status: 401 });
  if (context.user.blocked) return NextResponse.json([], { status: 403 });

  const isEmployee = context.user.employee === true;

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
