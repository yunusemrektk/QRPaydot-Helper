import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type DiscoveredPrinter = {
  host: string;
  port: number;
  ms?: number;
  iface?: string;
};

type PrintersContextValue = {
  printers: DiscoveredPrinter[];
  loaded: boolean;
  refresh: () => void;
};

const Ctx = createContext<PrintersContextValue | null>(null);

export function PrintersProvider({ children }: { children: ReactNode }) {
  const [printers, setPrinters] = useState<DiscoveredPrinter[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    fetch("/v1/printers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok?: boolean; printers?: DiscoveredPrinter[] }) => {
        if (j.ok && Array.isArray(j.printers)) setPrinters(j.printers);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ printers, loaded, refresh }),
    [printers, loaded, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrinters() {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePrinters must be used within PrintersProvider");
  return c;
}
