import { Suspense } from "react";
import { CompareClient } from "./client";

export default function ComparePage() {
  return (
    <Suspense fallback={<div className="wiki-shell"><p className="wiki-muted" style={{ padding: "2rem" }}>Loading…</p></div>}>
      <CompareClient />
    </Suspense>
  );
}
