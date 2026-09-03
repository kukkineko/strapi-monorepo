"use client";

import { useTheme } from "@/app/components/theme-provider";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={`wiki-theme-toggle${isDark ? " dark" : ""}`}
      onClick={toggleTheme}
    >
      <span className="wiki-theme-toggle-icon sun" aria-hidden="true">☀</span>
      <span className="wiki-theme-toggle-icon moon" aria-hidden="true">☾</span>
      <span className="wiki-theme-toggle-knob" aria-hidden="true" />
    </button>
  );
}
