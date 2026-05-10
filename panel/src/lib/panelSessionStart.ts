const WIN_KEY = "__qrpaydotHelperPanelSessionStartMs";

/**
 * Elektron / Vite paneli için tek açılış zamanı (tarayıcı sekmesi veya gömülü webview).
 * Modül yeniden değerlendirilse veya Durum sayfası tekrar mount olsa bile aynı değer kalır.
 */
export function getPanelSessionStartMs(): number {
  if (typeof window === "undefined") return Date.now();

  const w = window as Window & Record<string, unknown>;
  const cur = w[WIN_KEY];
  if (typeof cur === "number" && cur > 0 && Number.isFinite(cur)) return cur;

  const now = Date.now();
  w[WIN_KEY] = now;
  return now;
}
