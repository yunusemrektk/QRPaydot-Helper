import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type HealthPayload = {
  ok?: boolean;
  service?: string;
  version?: string;
  bind?: string;
  merchantDash?: string;
};

type HealthContextValue = {
  reachable: boolean | null;
  data: HealthPayload | null;
  lastCheckLabel: string;
  refresh: () => void;
};

const HealthContext = createContext<HealthContextValue | null>(null);

function timeStr() {
  try {
    return new Date().toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function HealthProvider({ children }: { children: ReactNode }) {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [data, setData] = useState<HealthPayload | null>(null);
  const [lastCheckLabel, setLastCheckLabel] = useState("");

  const refresh = useCallback(() => {
    fetch("/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: HealthPayload) => {
        if (j.ok) {
          setReachable(true);
          setData(j);
        } else {
          throw new Error("bad");
        }
      })
      .catch(() => {
        setReachable(false);
        setData(null);
      })
      .finally(() => {
        setLastCheckLabel(`Son kontrol: ${timeStr()}`);
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  const value = useMemo(
    () => ({ reachable, data, lastCheckLabel, refresh }),
    [reachable, data, lastCheckLabel, refresh],
  );

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}

export function useHealth() {
  const ctx = useContext(HealthContext);
  if (!ctx) throw new Error("useHealth must be used within HealthProvider");
  return ctx;
}
