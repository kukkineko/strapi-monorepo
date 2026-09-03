"use client";

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Theme = "light" | "dark";

export const STORAGE_THEME_KEY = "wiki-theme";

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

type ThemeContextType = {
  theme: Theme;
  setTheme: (value: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextType | null>(null);

/**
 * Light/dark mode, mirroring LanguageProvider's shape (localStorage-persisted,
 * applied as a DOM attribute so CSS just switches on [data-theme]).
 *
 * The initial value comes from localStorage, falling back to the OS/browser
 * preference (prefers-color-scheme) when nothing was chosen yet. A small
 * blocking script in layout.tsx sets the same attribute before first paint —
 * see there for why: without it this component's own useEffect would apply
 * the theme one frame late and every load would flash the default.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_THEME_KEY);
      if (isTheme(stored)) {
        setThemeState(stored);
        return;
      }
      const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
      setThemeState(prefersLight ? "light" : "dark");
    } catch {
      // Ignore storage/matchMedia access errors and keep the default theme.
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_THEME_KEY, theme);
    } catch {
      // Ignore storage errors.
    }
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      setTheme: setThemeState,
      toggleTheme: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }
  return context;
}
