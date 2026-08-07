/**
 * Server-only module — do NOT import this from any "use client" file.
 *
 * Provides getCachedEntries(), a 'use cache'-annotated wrapper around
 * listEntries(). Next.js 16 requires that 'use cache' functions live in a
 * file that is never imported by client components. entries.ts is shared
 * (client components import it for parseRubrikNumber, displayValue, etc.) so
 * the cache function lives here instead.
 */
import { cacheLife, cacheTag } from "next/cache";
import { listEntries, type Entry } from "./entries";

export async function getCachedEntries(): Promise<Entry[]> {
  "use cache";
  cacheLife({ revalidate: 300, expire: 86400 });
  cacheTag("entries");
  return listEntries();
}
