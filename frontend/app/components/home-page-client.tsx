"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/app/components/top-bar";
import { useLanguage } from "@/app/components/language-provider";

const RUBRIK_NAMES: Record<number, string> = {
  1: "Gegenschwimm-, Massage- und Luftsprudelanlagen",
  2: "Portable Whirlpools und Einbauteile",
  3: "Einbauteile aus Rotguss und Edelstahl V4A",
  4: "Einbauteile aus Kunststoff",
  5: "Filterpumpen",
  6: "Filteranlagen aus Kunststoff und Polyester",
  7: "Filter-Solar- und Rückspülsteuerungen",
  8: "Sauna, Dampfbad und Zubehör",
  9: "Wärmetauscher, Entfeuchtungsgeräte, Wärmepumpen und Solaranlagen",
  10: "Edelstahlleitern und Brausen, Solarduschen",
  11: "Reinigungsgeräte, Rinnensteine und Auskleidefolien",
  12: "Mess-, Regel- und Dosiertechnik",
  13: "Schwimmbadabdecksysteme manuell und automatisch",
  14: "Schwimmbadpflegemittel",
  15: "PVC-Kugelhähne, Fittinge, Rohre, Kleber und Klebeschläuche",
};

function rubrikSectionValue(rubrikNumber: number): string {
  return `rubrik-r${String(rubrikNumber).padStart(2, "0")}`;
}

function rubrikLabel(rubrikNumber: number): string {
  return `R${String(rubrikNumber).padStart(2, "0")}`;
}

export function HomePageClient() {
  const { t }  = useLanguage();
  const router = useRouter();
  const [query, setQuery] = useState("");

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    const url = q
      ? `/products/all?q=${encodeURIComponent(q)}&sort=artnr&section=all`
      : "/products/all";
    void router.push(url);
  }

  return (
    <main className="wiki-shell">
      <Suspense fallback={null}>
        <TopBar
          actions={[
            { href: "/products/new", label: t.nav.createNewPage, primary: true, adminOnly: true },
            { href: "/products/all", label: t.nav.allProducts },
            { href: "/listen", label: t.nav.lists },
          ]}
        />
      </Suspense>

      <header className="wiki-header">
        <div className="wiki-title-row">
          <h1>{t.home.title}</h1>
          <p>{t.home.subtitle}</p>
        </div>
      </header>

      <section className="wiki-card wiki-home-card">
        {/* ── Hero search bar ── */}
        <form onSubmit={handleSearch} className="wiki-home-search">
          <input
            type="search"
            className="wiki-home-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.home.globalSearchPlaceholder}
            aria-label={t.home.globalSearchLabel}
            autoComplete="off"
          />
          <button type="submit" className="wiki-home-search-btn" aria-label={t.home.globalSearchLabel}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
              <path d="M16.65 16.65L21 21" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </form>

        <div className="wiki-home-divider" />

        <p className="wiki-home-section-label">{t.home.groupedPagesTitle}</p>

        <div className="wiki-square-grid">
          {Array.from({ length: 15 }, (_, i) => i + 1).map((rubrikNumber) => (
            <Link
              key={rubrikNumber}
              href={`/products/all?section=${rubrikSectionValue(rubrikNumber)}`}
              className="wiki-square-button"
            >
              <h3>{rubrikLabel(rubrikNumber)}</h3>
              <span className="wiki-square-button-name">{RUBRIK_NAMES[rubrikNumber]}</span>
            </Link>
          ))}

          <Link href="/products/all?section=replacements" className="wiki-square-button">
            <h3>{t.home.replacements}</h3>
          </Link>

          <Link href="/products/all?section=extra" className="wiki-square-button wiki-square-button--extra">
            <h3>{t.home.extra}</h3>
            <span className="wiki-square-button-name">{t.home.extraDesc}</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
