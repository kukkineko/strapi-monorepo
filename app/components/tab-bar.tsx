"use client";

import { useSplit } from "@/app/components/compare-context";

export function SplitPanes() {
  const { panes, removePane } = useSplit();

  if (panes.length === 0) return null;

  return (
    <>
      {panes.map((pane) => (
        <div key={pane.id} className="wiki-split-pane">
          <div className="wiki-split-pane-bar">
            <button
              type="button"
              className="wiki-split-pane-close"
              onClick={() => removePane(pane.id)}
              aria-label="Close pane"
              title="Close"
            >
              ×
            </button>
          </div>
          <iframe
            src="/"
            className="wiki-split-pane-frame"
            title={`Tab ${pane.id}`}
          />
        </div>
      ))}
    </>
  );
}
