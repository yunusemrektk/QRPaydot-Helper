import {
  ArrowDownToLine,
  BarChart3,
  Headphones,
  Info,
  Printer,
  WifiOff,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useHealth } from "../context/HealthContext";
import { useServiceMode } from "../context/ServiceModeContext";

const titles: Record<string, string> = {
  "/status": "Durum",
  "/printer": "Yazıcı ayarları",
  "/offline": "Çevrimdışı mod",
  "/update": "Güncelleme",
  "/support": "Destek",
  "/about": "Hakkında",
};

function navClass({ isActive }: { isActive: boolean }) {
  return `nav-item${isActive ? " active" : ""}`;
}

export default function AppLayout() {
  const { pathname } = useLocation();
  const { reachable, data, lastCheckLabel } = useHealth();
  const { serviceUnlocked } = useServiceMode();

  const path = pathname.replace(/\/$/, "") || "/status";
  const title = titles[path] ?? "Helper";
  const ver = data?.version ?? "—";

  const pillClass =
    reachable === null ? "pill-pending" : reachable ? "pill-ok" : "pill-bad";
  const pillText =
    reachable === null
      ? "Kontrol ediliyor"
      : reachable
        ? "Aktif"
        : "Bağlantı yok";

  return (
    <>
      <a className="skip" href="#content">
        İçeriğe geç
      </a>
      <div className="dash">
        <aside className="sidebar" aria-label="Ana menü">
          <div className="sidebar-brand">
            <div className="logo">
              <div className="logo-mark" aria-hidden="true">
                <img src="/app-icon.png" alt="" width={36} height={36} />
              </div>
              <div>
                <strong>QRPaydot Helper</strong>
                <span>Yerel yardımcı</span>
              </div>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label="Sayfalar">
            <div className="nav-label">Ana</div>
            <NavLink to="/status" className={navClass} end>
              <BarChart3 strokeWidth={2} />
              Durum
            </NavLink>

            <div className="nav-label">Modüller</div>
            <NavLink to="/printer" className={navClass}>
              <Printer strokeWidth={2} />
              Yazıcı ayarları
            </NavLink>
            <NavLink to="/offline" className={navClass}>
              <WifiOff strokeWidth={2} />
              Çevrimdışı mod
              <span className="badge-pill">Yakında</span>
            </NavLink>

            <div className="nav-label">Sistem</div>
            <NavLink to="/update" className={navClass}>
              <ArrowDownToLine strokeWidth={2} />
              Güncelleme
            </NavLink>

            <div className="nav-label">Yardım</div>
            <NavLink to="/support" className={navClass}>
              <Headphones strokeWidth={2} />
              Destek
            </NavLink>
            <NavLink to="/about" className={navClass}>
              <Info strokeWidth={2} />
              Hakkında
            </NavLink>
          </nav>

          <div className="sidebar-foot">
            QRPaydot · <span className="foot-ver">{ver === "—" ? "—" : `v${ver}`}</span>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div className="topbar-left">
              <h1>{title}</h1>
              <span className={`pill ${pillClass}`}>
                <span className="pill-dot" aria-hidden="true" />
                {pillText}
              </span>
              {serviceUnlocked ? (
                <span className="pill pill-service" title="Servis modu açık (Ctrl+Shift+F12 ile PIN girerek kapatabilirsiniz)">
                  <span className="pill-dot" aria-hidden="true" />
                  Servis
                </span>
              ) : null}
            </div>
            <div className="topbar-time" aria-live="polite">
              {lastCheckLabel || "—"}
            </div>
          </header>

          <div id="content" className="content">
            <div className="content-inner">
              <Outlet />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
