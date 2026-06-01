import { listEntriesLight, parseRubrikNumber } from "@/app/lib/entries";
import type { Entry } from "@/app/lib/entries";
import { HomePageClient, type GroupedCounts } from "@/app/components/home-page-client";

function computeGroupedCounts(entries: Entry[]): GroupedCounts {
  const rubrikenCounts: Record<number, number> = {};
  for (let i = 1; i <= 15; i++) {
    rubrikenCounts[i] = 0;
  }
  let replacementsCount = 0;
  let extraCount = 0;

  for (const entry of entries) {
    const parsed = parseRubrikNumber(entry.rubrik);
    const key = String(entry.rubrik ?? "").trim().toLowerCase();

    if (key === "replacement" || key === "replacements") {
      replacementsCount++;
      continue;
    }
    if (key === "extra" || key === "extras") {
      extraCount++;
      continue;
    }
    if (parsed !== null && parsed >= 1 && parsed <= 15) {
      rubrikenCounts[parsed] = (rubrikenCounts[parsed] ?? 0) + 1;
      continue;
    }
    // Unassigned falls into Extra so nothing is silently lost.
    extraCount++;
  }

  return { rubrikenCounts, replacementsCount, extraCount };
}

export default async function HomePage() {
  const entries = await listEntriesLight();
  const grouped = computeGroupedCounts(entries);
  return <HomePageClient grouped={grouped} />;
}
