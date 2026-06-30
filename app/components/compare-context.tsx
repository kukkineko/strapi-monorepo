"use client";

import { createContext, useCallback, useContext, useState } from "react";

type Pane = { id: string };

type SplitContextValue = {
  panes: Pane[];
  addPane: () => void;
  removePane: (id: string) => void;
};

const SplitContext = createContext<SplitContextValue | null>(null);

let counter = 1;

export function CompareProvider({ children }: { children: React.ReactNode }) {
  const [panes, setPanes] = useState<Pane[]>([]);

  const addPane = useCallback(() => {
    setPanes((prev) => [...prev, { id: String(counter++) }]);
  }, []);

  const removePane = useCallback((id: string) => {
    setPanes((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return (
    <SplitContext.Provider value={{ panes, addPane, removePane }}>
      {children}
    </SplitContext.Provider>
  );
}

export function useSplit() {
  const ctx = useContext(SplitContext);
  if (!ctx) throw new Error("useSplit must be used within CompareProvider");
  return ctx;
}
