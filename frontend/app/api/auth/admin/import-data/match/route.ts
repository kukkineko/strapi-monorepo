import { type NextRequest, NextResponse } from "next/server";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import {
  findBestMatch,
  gatherCandidates,
  strapiFetchByDocumentId,
  type MatchEntry,
  type MatchConfidence,
} from "@/app/lib/strapi-search";

/* ── types ──────────────────────────────────────────────────────────────── */
/* Re-export the shared types for backwards compatibility with any importer
   that did `import type { MatchEntry } from ".../match/route"`. */
export type { MatchEntry, MatchConfidence };

type ReplacementId = {
  id: string[];
  /**
   * Optional pre-resolved Strapi documentId from the AI verdict stage. If
   * present and resolvable, the matcher skips its heuristic passes and
   * pins this row to that DB entry. Empty string = "AI looked and declined
   * to pick" — still falls through to heuristics for that row.
   */
  documentId?: string;
};

type MainPart = {
  id: string[];
  name: string;
  /** Same as ReplacementId.documentId — AI verdict hint. */
  documentId?: string;
};

type ReplacementGroup = {
  "Main part": MainPart;
  replacements: ReplacementId[];
};

type MatchRequest = {
  replacementParts: ReplacementGroup[];
};

type MatchedReplacement = {
  sourceIds: string[];
  matchedEntry: MatchEntry | null;
  confidence: MatchConfidence | null;
  matchField: string;
  matchValue: string;
};

type MatchedGroup = {
  mainPart: MainPart;
  mainPartMatch: MatchEntry | null;
  mainPartConfidence: MatchConfidence | null;
  mainPartField: string;
  mainPartValue: string;
  /**
   * Additional likely matches for the main part. Populated when the main
   * part's `name` resolves to MULTIPLE Strapi entries — e.g. two variants
   * of the same pump that share a title fragment. The admin can promote any
   * of these to the picked match with a single click; the primary entry
   * above is still the matcher's best guess. Includes the primary as
   * `candidates[0]` so the UI can render them as a single list.
   */
  mainPartCandidates: MatchEntry[];
  replacements: MatchedReplacement[];
};

/* ── verdict-aware resolver ─────────────────────────────────────────────── */

/**
 * Confidence we report when the row was pre-resolved by the AI verdict
 * stage. Reuses the existing `MatchConfidence` codes the UI already styles
 * so we don't have to teach every component about a new confidence band:
 * we report `exact-artNr` when the verdict entry has an artNr, otherwise
 * `exact-EAN`. Both are top-tier and render with the strongest badge.
 */
function confidenceForVerdict(entry: MatchEntry): MatchConfidence {
  if (entry.artNr) return "exact-artNr";
  if (entry.EAN) return "exact-EAN";
  return "exact-name";
}

/**
 * Resolve a row. If the AI verdict pinned a `documentId`, it is only trusted
 * when it's a member of the SAME candidate pool the server itself would
 * offer for these ids/name — re-derived here via `gatherCandidates` rather
 * than taking the client's word for it. The verdict stage's own JSON schema
 * types `documentId` as a bare string with no enum constraint, so without
 * this check a document that smuggles prompt-injection text into the import
 * pipeline (see app/lib/import-prompts.ts) could make the model assert an
 * arbitrary, unrelated documentId with full confidence — this closes that
 * off at the one place the result gets persisted. Falls back to the
 * heuristic matcher in `findBestMatch` whenever the verdict is absent,
 * unresolvable, or not an offered candidate.
 */
async function resolveRow(
  ids: string[],
  fallbackName: string | null,
  verdictDocumentId: string | undefined,
  allowNameFallback: boolean,
): Promise<{
  entry: MatchEntry | null;
  confidence: MatchConfidence | null;
  field: string;
  value: string;
  candidates: MatchEntry[];
}> {
  const trimmedVerdict = verdictDocumentId?.trim();
  if (trimmedVerdict) {
    const candidatePool = await gatherCandidates(ids, fallbackName, allowNameFallback);
    const isOfferedCandidate = candidatePool.some((c) => c.documentId === trimmedVerdict);
    if (isOfferedCandidate) {
      const fetched = await strapiFetchByDocumentId(trimmedVerdict);
      if (fetched) {
        return {
          entry: fetched,
          confidence: confidenceForVerdict(fetched),
          field: "ai-verdict",
          value: ids.join(", ") || fallbackName || "",
          candidates: [fetched],
        };
      }
    } else {
      console.warn(
        "[match] AI verdict documentId is not an offered candidate for this row, ignoring:",
        trimmedVerdict,
      );
    }
  }
  return findBestMatch(ids, fallbackName);
}

/* ── POST handler ───────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  const jwt = await getSessionJwt();
  if (!jwt) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const context = await loadUserContext(jwt);
  if (!context?.user?.administrator) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  try {
    const body = (await req.json()) as MatchRequest;
    const groups = body.replacementParts ?? [];

    const results: MatchedGroup[] = [];

    for (const group of groups) {
      const mainPart = group["Main part"];

      /* Main part: prefer AI verdict, else heuristics with name fallback. */
      const mainMatch = await resolveRow(
        mainPart.id ?? [],
        mainPart.name ?? null,
        mainPart.documentId,
        true,
      );

      /* Replacements: prefer AI verdict, else ID-only heuristics. No name
         fallback — their IDs are the only trustworthy signal. */
      const matchedReplacements: MatchedReplacement[] = [];
      for (const replacement of group.replacements ?? []) {
        const match = await resolveRow(
          replacement.id ?? [],
          null,
          replacement.documentId,
          false,
        );
        matchedReplacements.push({
          sourceIds: replacement.id ?? [],
          matchedEntry: match.entry,
          confidence: match.confidence,
          matchField: match.field,
          matchValue: match.value,
        });
      }

      results.push({
        mainPart,
        mainPartMatch: mainMatch.entry,
        mainPartConfidence: mainMatch.confidence,
        mainPartField: mainMatch.field,
        mainPartValue: mainMatch.value,
        mainPartCandidates: mainMatch.candidates,
        replacements: matchedReplacements,
      });
    }

    return NextResponse.json({ ok: true, groups: results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Matching failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
