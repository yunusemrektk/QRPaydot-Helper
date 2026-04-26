import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  getServicePin,
  isServicePinConfigured,
  SERVICE_MODE_STORAGE_KEY,
  serviceModeShortcutMatch,
} from "../config/serviceMode";

type ModalMode = "unlock" | "lock" | null;

type ServiceModeContextValue = {
  /** Teknik servis bölümleri açık mı */
  serviceUnlocked: boolean;
  /** PIN modalını aç (ör. ileride menüden) */
  openServicePinModal: (mode: "unlock" | "lock") => void;
};

const ServiceModeContext = createContext<ServiceModeContextValue | null>(null);

export function useServiceMode(): ServiceModeContextValue {
  const ctx = useContext(ServiceModeContext);
  if (!ctx) throw new Error("useServiceMode must be used within ServiceModeProvider");
  return ctx;
}

export function ServiceModeProvider({ children }: { children: ReactNode }) {
  const [serviceUnlocked, setServiceUnlocked] = useState(
    () => sessionStorage.getItem(SERVICE_MODE_STORAGE_KEY) === "1",
  );
  const [modal, setModal] = useState<ModalMode>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const persistUnlocked = useCallback((on: boolean) => {
    setServiceUnlocked(on);
    if (on) sessionStorage.setItem(SERVICE_MODE_STORAGE_KEY, "1");
    else sessionStorage.removeItem(SERVICE_MODE_STORAGE_KEY);
  }, []);

  const openServicePinModal = useCallback((mode: "unlock" | "lock") => {
    setModal(mode);
    setPin("");
    setError(null);
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
    setPin("");
    setError(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!serviceModeShortcutMatch(e)) return;
      if (!isServicePinConfigured()) return;
      e.preventDefault();
      openServicePinModal(serviceUnlocked ? "lock" : "unlock");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [serviceUnlocked, openServicePinModal]);

  useEffect(() => {
    if (!modal) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeModal();
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [modal, closeModal]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!modal) return;
    if (!isServicePinConfigured()) {
      setError("PIN yapılandırılmamış.");
      return;
    }
    if (pin !== getServicePin()) {
      setError("PIN hatalı.");
      return;
    }
    if (modal === "unlock") persistUnlocked(true);
    else persistUnlocked(false);
    closeModal();
  };

  const title =
    modal === "unlock"
      ? "Servis modu"
      : modal === "lock"
        ? "Müşteri moduna dön"
        : "";

  const description =
    modal === "unlock"
      ? "Teknik ayarları göstermek için PIN girin. (Kısayol: Ctrl+Shift+F12)"
      : "Gelişmiş bölümleri gizlemek için aynı PIN'i girin.";

  return (
    <ServiceModeContext.Provider value={{ serviceUnlocked, openServicePinModal }}>
      {children}
      {modal ? (
        <div
          className="service-modal-backdrop"
          role="presentation"
          onMouseDown={(ev) => {
            if (ev.target === ev.currentTarget) closeModal();
          }}
        >
          <div
            className="service-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="service-modal-title"
          >
            <h2 id="service-modal-title" className="service-modal-title">
              {title}
            </h2>
            <p className="service-modal-desc">{description}</p>
            <form onSubmit={submit}>
              <label className="fl" htmlFor="service-pin">
                PIN
              </label>
              <input
                ref={inputRef}
                id="service-pin"
                type="password"
                autoComplete="off"
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value);
                  setError(null);
                }}
                className="service-modal-input"
              />
              {error ? (
                <p className="service-modal-err" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="service-modal-actions">
                <button type="button" className="btn" onClick={closeModal}>
                  Vazgeç
                </button>
                <button type="submit" className="btn primary">
                  {modal === "unlock" ? "Aç" : "Kilitle"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </ServiceModeContext.Provider>
  );
}
