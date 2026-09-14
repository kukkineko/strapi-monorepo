"use client";

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  isLanguage,
  STORAGE_LANGUAGE_KEY,
  translations,
  type Language,
} from "@/app/lib/i18n";

type LanguageContextType = {
  language: Language;
  setLanguage: (value: Language) => void;
  t: (typeof translations)[Language];
};

const LanguageContext = createContext<LanguageContextType | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>("de");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_LANGUAGE_KEY);
      if (isLanguage(stored)) {
        setLanguage(stored);
      }
    } catch {
      // Ignore storage access errors and keep the default language.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_LANGUAGE_KEY, language);
    } catch {
      // Ignore storage errors.
    }

    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo(
    () => ({ language, setLanguage, t: translations[language] }),
    [language]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used inside LanguageProvider.");
  }
  return context;
}
