import { Check, Clock, ExternalLink, Globe, Printer, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHealth } from "../context/HealthContext";
import { usePrinters } from "../context/PrintersContext";

type EventRow = { t: string; m: string };

/** Sayfa açılışından beri geçen süre — saniye yok; dk → sa → gün. */
function elapsedStr(startTs: number) {
  const s = Math.floor((Date.now() - startTs) / 1000);
  const totalMin = Math.floor(s / 60);
  if (totalMin < 60) return `${totalMin} dk`;

  const h = Math.floor(s / 3600);
  const minInHour = Math.floor((s % 3600) / 60);
  if (s < 86400) {
    return minInHour === 0 ? `${h} sa` : `${h} sa ${minInHour} dk`;
  }

  const d = Math.floor(s / 86400);
  const hInDay = Math.floor((s % 86400) / 3600);
  return hInDay === 0 ? `${d} gün` : `${d} gün ${hInDay} sa`;
}

type CkState = "ok" | "fail" | "dim";

function ChecklistIcon({ state, icon: Icon }: { state: CkState; icon: LucideIcon }) {
  if (state === "ok")
    return (
      <span className="ck-icon ck-ok">
        <Check strokeWidth={2.5} />
      </span>
    );
  if (state === "fail")
    return (
      <span className="ck-icon ck-fail">
        <X strokeWidth={2.5} />
      </span>
    );
  return (
    <span className="ck-icon ck-dim">
      <Icon strokeWidth={2.5} />
    </span>
  );
}

export default function StatusPage() {
  const startTs = useRef(Date.now());
  const { reachable, data } = useHealth();
  const { printers, loaded: printersLoaded } = usePrinters();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [uptimeLabel, setUptimeLabel] = useState("—");
  const prevReachable = useRef<boolean | null>(null);

  const addEvent = useCallback((text: string) => {
    const t = new Date().toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setEvents((prev) => {
      const next = [{ t, m: text }, ...prev];
      return next.slice(0, 20);
    });
  }, []);

  useEffect(() => {
    addEvent("QRPaydot Helper paneli açıldı");
  }, [addEvent]);

  useEffect(() => {
    const pr = prevReachable.current;
    if (reachable === true && pr === false) addEvent("Servis tekrar erişilebilir");
    if (reachable === false && pr === true) addEvent("Servis yanıt vermiyor");
    prevReachable.current = reachable;
  }, [reachable, addEvent]);

  useEffect(() => {
    if (!reachable) {
      setUptimeLabel("—");
      return;
    }
    setUptimeLabel(elapsedStr(startTs.current));
    const id = setInterval(() => {
      setUptimeLabel(elapsedStr(startTs.current));
    }, 60_000);
    return () => clearInterval(id);
  }, [reachable]);

  const merchantDash = data?.merchantDash ?? null;
  const version = data?.version ?? "—";

  const serviceTone =
    reachable === null ? "pending" : reachable ? "ok" : "bad";
  const serviceTitle =
    reachable === null
      ? "Kontrol ediliyor…"
      : reachable
        ? "Çalışıyor"
        : "Yanıt yok";
  const serviceSub =
    reachable === false
      ? "Süreç kapalı veya port meşgul"
      : `Sürüm ${version}`;

  const printerCount = printers.length;
  let printerCk: CkState = "dim";
  let printerBadge = "Bekleniyor";
  let printerSub = "Ağdaki yazıcı taranmadı";
  if (printersLoaded) {
    if (printerCount === 0) {
      printerCk = "fail";
      printerBadge = "Bulunamadı";
      printerSub = "Ağda port 9100 açık cihaz yok";
    } else {
      printerCk = "ok";
      printerBadge = `${printerCount} yazıcı`;
      printerSub = `${printerCount} yazıcı ağda bulundu`;
    }
  }

  const dashCk: CkState =
    reachable && merchantDash ? "ok" : reachable === false ? "fail" : "dim";
  const dashBadge =
    reachable && merchantDash ? "Bağlı" : reachable === false ? "Kapalı" : "Bekleniyor";
  const dashSub =
    merchantDash ?? "Merchant dashboard URL'si";

  const openDash = () => {
    if (merchantDash) window.open(merchantDash, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="page visible">
      <div className="page-head">
        <h2>İşletme durumu</h2>
        <p>QRPaydot Helper servisinin ve bağlı modüllerin anlık durumu</p>
      </div>

      <div className="dash-promo" role="region" aria-labelledby="dashPromoTitle">
        <div className="dash-promo-inner">
          <div className="dash-promo-copy">
            <span className="dash-promo-badge" aria-hidden="true">
              Önerilen adım
            </span>
            <h3 className="dash-promo-title" id="dashPromoTitle">
              İşletme panelinizi tarayıcıda açın
            </h3>
            <p className="dash-promo-desc">
              Siparişler, menü, masalar, ayarlar ve raporlar web üzerinden yönetilir. Bu pencere
              yazdırma ve yerel Helper görevleri içindir; günlük operasyon için aşağıdaki düğmeyle
              merchant-dash panelini kullanın.
            </p>
          </div>
          <div className="dash-promo-action">
            <button type="button" className="btn-cta" onClick={openDash}>
              İşletme panelini aç
              <ExternalLink size={16} strokeWidth={2.3} aria-hidden />
            </button>
            <p className="dash-promo-url-hint">Panel adresi</p>
            {merchantDash ? (
              <a
                className="dash-promo-url"
                href={merchantDash}
                target="_blank"
                rel="noopener noreferrer"
              >
                {merchantDash}
              </a>
            ) : (
              <p className="dash-promo-url">—</p>
            )}
          </div>
        </div>
      </div>

      <div className="metrics">
        <div className="metric" data-tone={serviceTone}>
          <div className="metric-label">Servis</div>
          <div className="metric-value">{serviceTitle}</div>
          <div className="metric-sub">{serviceSub}</div>
        </div>
        <div className="metric" data-tone="accent">
          <div className="metric-label">Uç nokta</div>
          <div className="metric-value" style={{ fontSize: "0.78rem", fontWeight: 500 }}>
            <code className="c" style={{ wordBreak: "break-all" }}>
              {typeof window !== "undefined" ? window.location.origin : ""}
            </code>
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <CopyUrlButton />
          </div>
        </div>
        <div className="metric" data-tone={reachable ? "ok" : "pending"}>
          <div className="metric-label">Çalışma süresi</div>
          <div className="metric-value">{uptimeLabel}</div>
          <div className="metric-sub">Sayfa açıldığından beri</div>
        </div>
      </div>

      <div className="grid-2c">
        <div className="panel">
          <h3>Sistem kontrol listesi</h3>
          <ul className="checklist">
            <li>
              <ChecklistIcon
                state={reachable ? "ok" : reachable === false ? "fail" : "dim"}
                icon={Clock}
              />
              <div className="ck-label">
                <strong>Helper servisi</strong>
                <span>Yerel HTTP süreci çalışma durumu</span>
              </div>
              <span
                className={`ck-status ${
                  reachable ? "ck-status-ok" : reachable === false ? "ck-status-fail" : "ck-status-soon"
                }`}
              >
                {reachable ? "Çalışıyor" : reachable === false ? "Kapalı" : "Kontrol ediliyor"}
              </span>
            </li>
            <li>
              <ChecklistIcon state={printerCk} icon={Printer} />
              <div className="ck-label">
                <strong>Yazıcı bağlantısı</strong>
                <span>{printerSub}</span>
              </div>
              <span
                className={`ck-status ${
                  printerCk === "ok"
                    ? "ck-status-ok"
                    : printerCk === "fail"
                      ? "ck-status-fail"
                      : "ck-status-soon"
                }`}
              >
                {printerBadge}
              </span>
            </li>
            <li>
              <ChecklistIcon state={dashCk} icon={Globe} />
              <div className="ck-label">
                <strong>İşletme paneli</strong>
                <span>{dashSub}</span>
              </div>
              <span
                className={`ck-status ${
                  dashCk === "ok"
                    ? "ck-status-ok"
                    : dashCk === "fail"
                      ? "ck-status-fail"
                      : "ck-status-soon"
                }`}
              >
                {dashBadge}
              </span>
            </li>
          </ul>
        </div>

        <div className="panel">
          <h3>Son olaylar</h3>
          <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", minHeight: 60 }}>
            {events.length === 0 ? (
              "Henüz bir olay kaydedilmedi."
            ) : (
              events.map((e, i) => (
                <div key={`${e.t}-${i}`} className="event-item">
                  <span className="event-time">{e.t}</span>
                  <span className="event-text">{e.m}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyUrlButton() {
  const [done, setDone] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const copy = () => {
    void navigator.clipboard.writeText(origin).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    });
  };

  return (
    <button type="button" className="btn" onClick={copy}>
      {done ? (
        <>
          <Check width={12} height={12} strokeWidth={2.5} /> Kopyalandı
        </>
      ) : (
        <>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            aria-hidden
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          Panoya kopyala
        </>
      )}
    </button>
  );
}
