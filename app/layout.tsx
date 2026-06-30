import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { LanguageProvider } from "@/app/components/language-provider";
import { AuthGate } from "@/app/components/auth-gate";
import { CompareProvider } from "@/app/components/compare-context";
import { TabBar } from "@/app/components/tab-bar";
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
      <body className="min-h-full flex flex-col">
        <LanguageProvider>
          <CompareProvider>
            <Suspense><AuthGate>{children}</AuthGate></Suspense>
            <TabBar />
          </CompareProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
