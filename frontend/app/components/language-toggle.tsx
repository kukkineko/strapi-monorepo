"use client";

import { useLanguage } from "@/app/components/language-provider";

export function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div className="wiki-language-toggle" role="group" aria-label={t.language.label}>
      <button
        type="button"
        className={`wiki-language-option ${language === "en" ? "active" : ""}`}
        onClick={() => setLanguage("en")}
      >
        EN
      </button>
      <button
        type="button"
        className={`wiki-language-option ${language === "de" ? "active" : ""}`}
        onClick={() => setLanguage("de")}
      >
        DE
      </button>
    </div>
  );
}
