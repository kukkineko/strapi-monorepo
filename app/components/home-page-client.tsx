"use client";

import Link from "next/link";
import { Suspense } from "react";
import { TopBar } from "@/app/components/top-bar";
import { useLanguage } from "@/app/components/language-provider";

export type GroupedCounts = {
  rubrikenCounts: Record<number, number>;
  replacementsCount: number;
  extraCount: number;
};

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

export function HomePageClient({ grouped }: { grouped: GroupedCounts }) {
  const { t } = useLanguage();

  return (
    <main className="wiki-shell">
      <Suspense fallback={null}>
        <TopBar
          actions={[
            { href: "/products/new", label: t.nav.createNewPage, primary: true },
            { href: "/products/all", label: t.nav.allProducts },
          ]}
        />
      </Suspense>

      <header className="wiki-header">
        <h1>{t.home.title}</h1>
        <p>{t.home.subtitle}</p>
      </header>

      <section className="wiki-card">
        <h2>{t.home.groupedPagesTitle}</h2>
        <p className="wiki-muted">{t.home.groupedPagesSubtitle}</p>

        <div className="wiki-square-grid">

          {/* ── All items ── */}
          <Link href="/products/all" className="wiki-square-button wiki-square-button--all">
            <div className="wiki-square-button--all-label">
              <h3>{t.listing.allSections}</h3>
              <span>{t.home.groupedPagesTitle}</span>
            </div>
          </Link>

          {/* ── R01 – R15 ── */}
          {Array.from({ length: 15 }, (_, index) => index + 1).map((rubrikNumber) => {
            const count = grouped.rubrikenCounts[rubrikNumber] ?? 0;
            return (
              <Link
                key={rubrikNumber}
                href={`/products/all?section=${rubrikSectionValue(rubrikNumber)}`}
                className="wiki-square-button"
              >
                <h3>{rubrikLabel(rubrikNumber)}</h3>
                <span className="wiki-square-button-name">
                  {RUBRIK_NAMES[rubrikNumber]}
                </span>
              </Link>
            );
          })}

          {/* ── Replacements ── */}
          <Link href="/products/all?section=replacements" className="wiki-square-button">
            <h3>{t.home.replacements}</h3>
          </Link>

          {/* ── Extra ── */}
          <Link href="/products/all?section=extra" className="wiki-square-button">
            <h3>{t.home.extra}</h3>
          </Link>

        </div>
      </section>
    </main>
  );
}
