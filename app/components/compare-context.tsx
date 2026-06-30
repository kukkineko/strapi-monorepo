"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type TabEntry = {
  id: string;
  title?: string;
};

type TabsContextValue = {
  tabs: TabEntry[];
  addTab: (id: string, title?: string) => void;
  removeTab: (id: string) => void;
  updateTabTitle: (id: string, title: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);
const STORAGE_KEY = "wiki-tabs";
const MAX_TABS = 8;

export function CompareProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<TabEntry[]>([]);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) setTabs(JSON.parse(saved) as TabEntry[]);
    } catch {}
  }, []);

  const persist = (next: TabEntry[]) => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  };

  const addTab = useCallback((id: string, title?: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      const next = [...prev, { id, title }].slice(-MAX_TABS);
      persist(next);
      return next;
    });
  }, []);

  const removeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      persist(next);
      return next;
    });
  }, []);

  const updateTabTitle = useCallback((id: string, title: string) => {
    setTabs((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, title } : t));
      persist(next);
      return next;
    });
  }, []);

  return (
    <TabsContext.Provider value={{ tabs, addTab, removeTab, updateTabTitle }}>
      {children}
    </TabsContext.Provider>
  );
}

export function useCompare() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("useCompare must be used within CompareProvider");
  return ctx;
}
