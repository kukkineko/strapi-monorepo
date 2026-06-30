"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type Layout = "1x1" | "2x2";

export type CompareTab = {
  id: string;
  title?: string;
};

type CompareContextValue = {
  tabs: CompareTab[];
  layout: Layout;
  addTab: (id: string, title?: string) => void;
  removeTab: (id: string) => void;
  setLayout: (layout: Layout) => void;
  isInCompare: (id: string) => boolean;
  activeTabIndex: number;
  setActiveTabIndex: (index: number) => void;
};

const CompareContext = createContext<CompareContextValue | null>(null);

const STORAGE_TABS   = "compare-tabs";
const STORAGE_LAYOUT = "compare-layout";
const MAX_TABS = 4;

export function CompareProvider({ children }: { children: React.ReactNode }) {
  const [tabs,           setTabs]           = useState<CompareTab[]>([]);
  const [layout,         setLayoutState]    = useState<Layout>("1x1");
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  useEffect(() => {
    try {
      const savedTabs = sessionStorage.getItem(STORAGE_TABS);
      if (savedTabs) setTabs(JSON.parse(savedTabs) as CompareTab[]);
      const savedLayout = sessionStorage.getItem(STORAGE_LAYOUT) as Layout | null;
      if (savedLayout === "1x1" || savedLayout === "2x2") setLayoutState(savedLayout);
    } catch {}
  }, []);

  const persist = (next: CompareTab[]) => {
    try { sessionStorage.setItem(STORAGE_TABS, JSON.stringify(next)); } catch {}
  };

  const addTab = useCallback((id: string, title?: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      if (prev.length >= MAX_TABS) return prev;
      const next = [...prev, { id, title }];
      persist(next);
      return next;
    });
  }, []);

  const removeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      persist(next);
      setActiveTabIndex((i) => Math.min(i, Math.max(next.length - 1, 0)));
      return next;
    });
  }, []);

  const setLayout = useCallback((l: Layout) => {
    setLayoutState(l);
    try { sessionStorage.setItem(STORAGE_LAYOUT, l); } catch {}
  }, []);

  const isInCompare = useCallback((id: string) => tabs.some((t) => t.id === id), [tabs]);

  return (
    <CompareContext.Provider
      value={{ tabs, layout, addTab, removeTab, setLayout, isInCompare, activeTabIndex, setActiveTabIndex }}
    >
      {children}
    </CompareContext.Provider>
  );
}

export function useCompare() {
  const ctx = useContext(CompareContext);
  if (!ctx) throw new Error("useCompare must be used within CompareProvider");
  return ctx;
}
