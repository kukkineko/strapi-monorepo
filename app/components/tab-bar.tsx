"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCompare } from "@/app/components/compare-context";

export function TabBar() {
  const { tabs, layout, removeTab, setLayout, activeTabIndex, setActiveTabIndex } = useCompare();
  const pathname = usePathname();
  const router   = useRouter();

  if (tabs.length === 0) return null;

  const compareUrl = `/compare?ids=${tabs.map((t) => t.id).join(",")}`;

  function handleTabClick(index: number, id: string) {
    setActiveTabIndex(index);
    if (pathname.startsWith("/compare")) {
      // already on compare page — just update index, no nav needed
      return;
    }
    void router.push(`/products/${id}`);
  }

  return (
    <div className="wiki-tab-bar" role="navigation" aria-label="Compare tabs">
      {/* Tab pills */}
      <div className="wiki-tab-bar-tabs">
        {tabs.map((tab, index) => {
          const isActive = index === activeTabIndex;
          return (
            <div
              key={tab.id}
              className={`wiki-tab-pill${isActive ? " active" : ""}`}
            >
              <button
                type="button"
                className="wiki-tab-pill-label"
                onClick={() => handleTabClick(index, tab.id)}
                title={tab.title ?? tab.id}
              >
                {tab.title ?? tab.id}
              </button>
              <button
                type="button"
                className="wiki-tab-pill-close"
                onClick={() => removeTab(tab.id)}
                aria-label={`Remove ${tab.title ?? tab.id} from compare`}
                title="Remove"
              >
                ×
              </button>
            </div>
          );
        })}

        {tabs.length < 4 && (
          <span className="wiki-tab-bar-hint">
            {tabs.length === 1 ? "Add up to 3 more to compare" : `${tabs.length}/4`}
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="wiki-tab-bar-controls">
        {/* Layout toggle */}
        <div className="wiki-tab-layout-toggle" role="group" aria-label="Layout">
          <button
            type="button"
            className={`wiki-tab-layout-btn${layout === "1x1" ? " active" : ""}`}
            onClick={() => setLayout("1x1")}
            title="Single view"
            aria-pressed={layout === "1x1"}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="14" height="14" rx="1.5" />
            </svg>
            1×1
          </button>
          <button
            type="button"
            className={`wiki-tab-layout-btn${layout === "2x2" ? " active" : ""}`}
            onClick={() => setLayout("2x2")}
            title="Grid view"
            aria-pressed={layout === "2x2"}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="2" y="2" width="7" height="7" rx="1" />
              <rect x="11" y="2" width="7" height="7" rx="1" />
              <rect x="2" y="11" width="7" height="7" rx="1" />
              <rect x="11" y="11" width="7" height="7" rx="1" />
            </svg>
            2×2
          </button>
        </div>

        {/* Compare view link */}
        <Link href={compareUrl} className="wiki-tab-compare-btn">
          Compare
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M5 10h10M12 7l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
