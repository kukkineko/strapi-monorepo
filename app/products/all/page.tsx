import { listEntriesForList } from "@/app/lib/entries";
import { getSessionJwt, loadUserContext } from "@/app/lib/auth-server";
import { AllProductsClient } from "./client";

export default async function AllProductsPage() {
  const [entries, jwt] = await Promise.all([
    listEntriesForList(),
    getSessionJwt(),
  ]);

  /* Determine employee status server-side so no employee-only field ever
     reaches a non-employee browser — not even in the RSC payload. */
  let isEmployee = false;
  if (jwt) {
    try {
      const ctx = await loadUserContext(jwt);
      isEmployee = ctx?.user?.employee === true;
    } catch { /* treat as non-employee on error */ }
  }

  /* Strip `igs` for non-employees. The field is used by the hover preview
     (matchcodes) and the search index — neither should be visible to them. */
  const safeEntries = isEmployee
    ? entries
    : entries.map((e) => ({ ...e, igs: undefined }));

  return <AllProductsClient initialEntries={safeEntries} />;
}
