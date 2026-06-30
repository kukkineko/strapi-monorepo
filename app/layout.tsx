import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { LanguageProvider } from "@/app/components/language-provider";
import { AuthGate } from "@/app/components/auth-gate";
import { CompareProvider } from "@/app/components/compare-context";
import { SplitPanes } from "@/app/components/tab-bar";
import { translations } from "@/app/lib/i18n";

export const metadata: Metadata = {
  title: translations.en.home.title,
  description: translations.en.home.subtitle,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body style={{ display: "flex", flexDirection: "column", height: "100%" }}>
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
      </body>
    </html>
  );
}
