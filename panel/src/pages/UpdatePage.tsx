import { useCallback, useEffect, useState } from "react";
import { useHealth } from "../context/HealthContext";
import {
  ArrowDownToLine,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  RotateCw,
  XCircle,
} from "lucide-react";

type UpdateStatus = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  currentVersion: string | null;
  availableVersion: string | null;
  progress: number;
  error: string | null;
};

export default function UpdatePage() {
  const { data } = useHealth();
  const currentVersion = data?.version ?? "—";

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [lastCheck, setLastCheck] = useState<string | null>(null);

  const fetchStatus = useCallback(() => {
    fetch("/v1/update/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: UpdateStatus & { ok?: boolean }) => {
        if (j.ok !== false) setUpdateStatus(j);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const r = await fetch("/v1/update/check", { method: "POST" });
      const j = await r.json();
      if (j.updateAvailable) {
        setLastCheck(`v${j.version} bulundu`);
      } else if (j.error) {
        setLastCheck("Kontrol edilemedi — tekrar denenecek");
      } else {
        setLastCheck("Güncel — yeni sürüm yok");
      }
      fetchStatus();
    } catch {
      setLastCheck("Bağlantı hatası");
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await fetch("/v1/update/install", { method: "POST" });
    } catch {
      setInstalling(false);
    }
  };

  const status = updateStatus?.status ?? "idle";
  const availableVersion = updateStatus?.availableVersion;
  const progress = updateStatus?.progress ?? 0;

  const friendlyError = (() => {
    const raw = updateStatus?.error ?? "";
    if (!raw) return "Güncelleme sunucusuna bağlanılamadı. Kısa süre sonra tekrar denenecek.";
    const l = raw.toLowerCase();
    if (l.includes("net::") || l.includes("enotfound") || l.includes("etimedout") || l.includes("network"))
      return "İnternet bağlantısı kurulamadı. Bağlantınızı kontrol edin, otomatik olarak tekrar denenecek.";
    if (l.includes("404") || l.includes("no published versions"))
      return "Sunucuda yayınlanmış bir güncelleme bulunamadı.";
    if (l.includes("403") || l.includes("forbidden"))
      return "Güncelleme sunucusuna erişim engellendi.";
    if (l.includes("sha512") || l.includes("checksum") || l.includes("signature"))
      return "İndirilen dosya doğrulanamadı. Tekrar denenecek.";
    return "Güncelleme kontrol edilirken bir sorun oluştu. Kısa süre sonra tekrar denenecek.";
  })();

  return (
    <div className="page visible">
      <div className="page-head">
        <h2>Güncelleme</h2>
        <p>Yeni sürüm kontrolü ve manuel güncelleme</p>
      </div>

      {/* Current version */}
      <div className="metrics" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="metric" data-tone="accent">
          <div className="metric-label">Mevcut sürüm</div>
          <div className="metric-value">v{currentVersion}</div>
          <div className="metric-sub">Şu an yüklü olan sürüm</div>
        </div>
        <div
          className="metric"
          data-tone={
            status === "downloaded"
              ? "ok"
              : status === "available" || status === "downloading" || status === "error"
                ? "pending"
                : undefined
          }
        >
          <div className="metric-label">Güncelleme durumu</div>
          <div className="metric-value">
            {status === "idle" && "Güncel"}
            {status === "checking" && "Kontrol ediliyor…"}
            {status === "available" && `v${availableVersion} mevcut`}
            {status === "downloading" && `İndiriliyor — %${progress}`}
            {status === "downloaded" && `v${availableVersion} hazır`}
            {status === "error" && "Tekrar denenecek"}
          </div>
          <div className="metric-sub">
            {status === "idle" && "Yeni sürüm bulunamadı"}
            {status === "checking" && "GitHub kontrol ediliyor…"}
            {status === "available" && "İndirme başlıyor…"}
            {status === "downloading" && "Arka planda indiriliyor"}
            {status === "downloaded" && "Yüklemeye hazır"}
            {status === "error" && "Kısa süre sonra otomatik tekrar denenecek"}
          </div>
        </div>
      </div>

      {/* Update available / downloaded banner */}
      {(status === "available" || status === "downloading") && (
        <div className="update-banner update-banner--downloading">
          <div className="update-banner-icon">
            <ArrowDownToLine size={22} />
          </div>
          <div className="update-banner-body">
            <strong>v{availableVersion} indiriliyor</strong>
            <span>İndirme tamamlandığında uygulama otomatik güncellenecek</span>
            {status === "downloading" && (
              <div className="update-progress-bar">
                <div className="update-progress-fill" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {status === "downloaded" && (
        <div className="update-banner update-banner--ready">
          <div className="update-banner-icon">
            <CheckCircle2 size={22} />
          </div>
          <div className="update-banner-body">
            <strong>v{availableVersion} yüklemeye hazır</strong>
            <span>Uygulama kapandığında otomatik yüklenecek veya hemen yükleyebilirsiniz</span>
          </div>
          <button
            className="btn update-install-btn"
            disabled={installing}
            onClick={handleInstall}
          >
            {installing ? <Loader2 size={14} className="spin-icon" /> : <RotateCw size={14} />}
            Şimdi yükle
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="update-banner update-banner--error">
          <div className="update-banner-icon">
            <XCircle size={22} />
          </div>
          <div className="update-banner-body">
            <strong>Güncelleme kontrol edilemedi</strong>
            <span>{friendlyError}</span>
          </div>
          <button className="btn" onClick={handleCheck} disabled={checking}>
            {checking ? <Loader2 size={14} className="spin-icon" /> : <RefreshCw size={14} />}
            Tekrar dene
          </button>
        </div>
      )}

      {/* Actions */}
      <div className="panel" style={{ marginTop: "1rem" }}>
        <h3>Manuel kontrol</h3>
        <p>
          Uygulama açıldığında ve belirli aralıklarla otomatik olarak güncelleme kontrolü yapar.
          Hemen kontrol etmek isterseniz aşağıdaki butonu kullanın.
        </p>
        <div style={{ display: "flex", gap: ".6rem", marginTop: ".85rem", flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" disabled={checking} onClick={handleCheck}>
            {checking ? <Loader2 size={14} className="spin-icon" /> : <RefreshCw size={14} />}
            Güncelleme kontrol et
          </button>
          {status === "downloaded" && (
            <button
              className="btn"
              style={{ borderColor: "var(--success-border)", color: "var(--success)" }}
              disabled={installing}
              onClick={handleInstall}
            >
              {installing ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
              Yeniden başlat ve yükle
            </button>
          )}
          {lastCheck && (
            <span style={{ fontSize: ".75rem", color: "var(--text-dim)" }}>{lastCheck}</span>
          )}
        </div>
      </div>

      {/* How it works */}
      <div className="panel">
        <h3>Nasıl çalışır?</h3>
        <ul className="info-list">
          <li>
            <div className="il-ic"><RefreshCw size={15} /></div>
            <div>
              <strong>Otomatik kontrol</strong>
              Uygulama açıldığında ve düzenli aralıklarla GitHub&apos;dan yeni sürüm kontrol edilir
            </div>
          </li>
          <li>
            <div className="il-ic"><ArrowDownToLine size={15} /></div>
            <div>
              <strong>Arka planda indirme</strong>
              Yeni sürüm bulunduğunda dosya arka planda sessizce indirilir
            </div>
          </li>
          <li>
            <div className="il-ic"><RotateCw size={15} /></div>
            <div>
              <strong>Otomatik yükleme</strong>
              İndirme tamamlandığında uygulama yeniden başlatılıp güncellenir
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}
