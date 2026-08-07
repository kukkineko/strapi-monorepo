import { connection } from "next/server";
import { listEntriesBySection } from "@/app/lib/entries";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import { AllProductsClient } from "./client";

export default async function AllProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  // Live Strapi data + the in-memory cache's Date.now() read mean this page
  // must render at request time rather than being prerendered at build.
  await connection();

  const jwt = await getSessionJwt();
  let isEmployee = false;
  let canEdit = false;

  if (jwt) {
    try {
      const ctx = await loadUserContext(jwt);
      // Don't send any Strapi data to unauthenticated, blocked, or unconfirmed users.
      if (!ctx?.user || ctx.user.blocked || !ctx.user.confirmed) {
        return <AllProductsClient initialEntries={[]} canEdit={false} />;
      }
      isEmployee = ctx.user.employee === true;
      canEdit = ctx.user.trusted === true;
    } catch { /* treat as non-employee on error */ }
  } else {
    return <AllProductsClient initialEntries={[]} canEdit={false} />;
  }

  const rawSection = (await searchParams).section;
  const section =
    (Array.isArray(rawSection) ? rawSection[0] : rawSection)?.toLowerCase() || "all";

  // Numbered rubrik sections (R01–R15) and replacements load in full so the
  // whole category is browseable; "all" and the ~13k "extra" bucket fall back
  // to the most-recent set inside listEntriesBySection().
  const entries = await listEntriesBySection(section);

  /* Strip `igs` for non-employees. The field is used by the hover preview
     (matchcodes) and the search index — neither should be visible to them. */
  const safeEntries = isEmployee
    ? entries
    : entries.map((e) => ({ ...e, igs: undefined }));

  return <AllProductsClient initialEntries={safeEntries} canEdit={canEdit} />;
}
