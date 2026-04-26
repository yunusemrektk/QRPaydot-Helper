/**
 * Teknik servis modu — gizli kısayol + PIN.
 *
 * Üretimde mutlaka `VITE_SERVICE_PIN` ile güçlü bir PIN belirleyin (panel Vite build sırasında gömülür).
 * Örnek: `print-bridge/panel/.env` → VITE_SERVICE_PIN=...
 */
export const SERVICE_MODE_STORAGE_KEY = "qrpaydot-helper-service-mode";

/** Ctrl+Shift+F12 (macOS: ⌘+Shift+F12) */
export function serviceModeShortcutMatch(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  return mod && e.shiftKey && e.key === "F12";
}

export function getServicePin(): string {
  const v = import.meta.env.VITE_SERVICE_PIN;
  /* Boş string = servis modu kasıtlı kapalı (kısayol devre dışı) */
  if (v === "") return "";
  if (typeof v === "string" && v.length > 0) return v;
  /* Yerel geliştirme; üretim build'de VITE_SERVICE_PIN kullanın */
  return "424242";
}

export function isServicePinConfigured(): boolean {
  return getServicePin().length > 0;
}
