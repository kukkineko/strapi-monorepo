import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { LanguageProvider } from "@/app/components/language-provider";
import { ThemeProvider, STORAGE_THEME_KEY } from "@/app/components/theme-provider";
import { AuthGate } from "@/app/components/auth-gate";
import { CompareProvider } from "@/app/components/compare-context";
import { SplitPanes } from "@/app/components/tab-bar";
import { translations } from "@/app/lib/i18n";

export const metadata: Metadata = {
  title: translations.en.home.title,
  description: translations.en.home.subtitle,
};

// Runs before React hydrates so the right theme is already applied at first
// paint — otherwise the page would flash the CSS default (dark) and then
// flip for anyone who chose light mode. Mirrors what ThemeProvider does on
// mount; kept as a plain inline script since it has to run before any
// component code.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(STORAGE_THEME_KEY)});
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
        />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <ThemeProvider>
          <LanguageProvider>
            <CompareProvider>
              <div className="wiki-split-row">
                <div className="wiki-split-main">
                  <Suspense><AuthGate>{children}</AuthGate></Suspense>
                </div>
                <SplitPanes />
              </div>
            </CompareProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
