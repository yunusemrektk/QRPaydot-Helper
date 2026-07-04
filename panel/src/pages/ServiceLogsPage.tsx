import { Calendar, Copy, Pause, Play, RefreshCw, ScrollText, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServicePin } from "../config/serviceMode";
import { useServiceMode } from "../context/ServiceModeContext";

function localYmd(d = new Date()) {
  return d.toLocaleDateString("en-CA");
}

function ymdLabel(ymd: string, today: string) {
  if (ymd === today) return "Bugün";
  const a = new Date(`${today}T12:00:00`);
  const b = new Date(`${ymd}T12:00:00`);
  const diff = Math.round((a.getTime() - b.getTime()) / 86400000);
  if (diff === 1) return "Dün";
  return ymd;
}

type LogsPayload = {
  ok?: boolean;
  lines?: string[];
  truncated?: boolean;
  fileExists?: boolean;
  lineCount?: number;
  date?: string;
  error?: string;
};

type LogDaysPayload = {
  ok?: boolean;
  dates?: string[];
  files?: Record<string, { path?: string; size?: number; legacy?: boolean } | null>;
  retentionDays?: number;
};

const PIN_HEADER = "X-QRPaydot-Service-Pin";

const LOG_LINE_RE = /^\[([^\]]+)\]\s*(?:\[pid:(\d+)\]\s*)?(.*)$/;

function parseLogLine(line: string): { ts: string; pid?: string; msg: string } | null {
  const m = line.match(LOG_LINE_RE);
  if (!m) return null;
  return { ts: m[1], pid: m[2], msg: m[3] };
}

function msgToneClass(msg: string): string {
  const u = msg.toUpperCase();
  if (
    msg.includes("FETCH_ERR") ||
    msg.includes("AUTH_ERROR") ||
    msg.includes("uncaughtException") ||
    msg.includes("unhandledRejection") ||
    u.includes(" POS_PAYMENT_JOB FAILED") ||
    u.includes("PRINT_JOB FAILED")
  ) {
    return "log-msg-err";
  }
  if (u.includes("WARNING:") || u.includes("SECURITY")) return "log-msg-warn";
  if (msg.includes("[hugin-proxy]")) return "log-msg-hugin";
  if (msg.includes("[backend-ws]") || msg.includes("[boot]")) return "log-msg-ws";
  if (msg.includes("[credentials]")) return "log-msg-cred";
  return "";
}

export default function ServiceLogsPage() {
  const { serviceUnlocked, openServicePinModal } = useServiceMode();
  const [lines, setLines] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [fileExists, setFileExists] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [lastFetch, setLastFetch] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState(() => localYmd());
  const [dayIndex, setDayIndex] = useState<LogDaysPayload | null>(null);
  const [filterQ, setFilterQ] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottom = useRef(true);
  const tabVisibleRef = useRef(typeof document !== "undefined" && document.visibilityState === "visible");

  const todayYmd = localYmd();
  const isViewingToday = selectedDate === todayYmd;

  const fetchDayIndex = useCallback(async () => {
    if (!serviceUnlocked) return;
    try {
      const pin = getServicePin();
      const r = await fetch("/v1/service/logs/days", {
        cache: "no-store",
        headers: pin ? { [PIN_HEADER]: pin } : {},
      });
      const j = (await r.json()) as LogDaysPayload;
      if (r.ok && j.ok && Array.isArray(j.dates)) {
        setDayIndex(j);
        setSelectedDate((prev) => (j.dates!.includes(prev) ? prev : j.dates![0]));
      }
    } catch {
      /* ignore */
    }
  }, [serviceUnlocked]);

  const fetchLogs = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!serviceUnlocked) return;
      const silent = Boolean(opts?.silent);
      if (!silent) setLoading(true);
      setError(null);
      try {
        const pin = getServicePin();
        const qs = new URLSearchParams({
          lines: "1500",
          maxBytes: "350000",
          date: selectedDate,
        });
        const r = await fetch(`/v1/service/logs?${qs}`, {
          cache: "no-store",
          headers: pin ? { [PIN_HEADER]: pin } : {},
        });
        const j = (await r.json()) as LogsPayload;
        if (r.status === 401) {
          setError(
            "Servis PIN doğrulanamadı. Panel ile aynı VITE_SERVICE_PIN / PRINT_BRIDGE_SERVICE_PIN değerini kullanın.",
          );
          setLines([]);
          return;
        }
        if (!r.ok || !j.ok) {
          setError(j.error || `HTTP ${r.status}`);
          return;
        }
        setLines(Array.isArray(j.lines) ? j.lines : []);
        setTruncated(Boolean(j.truncated));
        setFileExists(j.fileExists !== false);
        setLastFetch(
          new Date().toLocaleTimeString("tr-TR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        );
      } catch {
        setError("Loglar alınamadı (ağ veya Helper kapalı)");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [serviceUnlocked, selectedDate],
  );

  useEffect(() => {
    if (!serviceUnlocked) return;
    void fetchDayIndex();
  }, [serviceUnlocked, fetchDayIndex]);

  useEffect(() => {
    if (!serviceUnlocked) return;
    void fetchLogs({ silent: false });
  }, [serviceUnlocked, selectedDate, fetchLogs]);

  useEffect(() => {
    const onVis = () => {
      tabVisibleRef.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!serviceUnlocked || paused || !isViewingToday) return;
    let timeoutId = 0;
    let cancelled = false;

    const loop = () => {
      if (cancelled) return;
      void fetchLogs({ silent: true });
      const ms = tabVisibleRef.current ? 750 : 5000;
      timeoutId = window.setTimeout(loop, ms);
    };

    timeoutId = window.setTimeout(loop, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [serviceUnlocked, paused, fetchLogs, isViewingToday]);

  const filteredLines = useMemo(() => {
    const q = filterQ.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((ln) => ln.toLowerCase().includes(q));
  }, [lines, filterQ]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filteredLines]);

  const onScrollBox = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
    stickBottom.current = nearBottom;
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = true;
    el.scrollTop = el.scrollHeight;
  };

  const copyVisible = () => {
    void navigator.clipboard.writeText(filteredLines.join("\n")).then(() => {
      /* toast optional */
    });
  };

  const datesForChips = dayIndex?.dates?.length ? dayIndex.dates : [todayYmd];

  if (!serviceUnlocked) {
    return (
      <div className="page visible">
        <div className="page-head">
          <h2>Servis günlükleri</h2>
          <p>Günlük dosyaları — en fazla 7 gün saklanır; yalnızca servis modunda.</p>
        </div>
        <div className="panel panel-narrow">
          <p className="panel-lead">
            Bu bölüm teknik destek içindir. Görmek için servis modunu açın:{" "}
            <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Shift</kbd>+<kbd className="kbd">F12</kbd>{" "}
            (macOS: <kbd className="kbd">⌘</kbd> ile aynı kısayol).
          </p>
          <button type="button" className="primary" onClick={() => openServicePinModal("unlock")}>
            Servis modunu aç…
          </button>
        </div>
      </div>
    );
  }

  const retention = dayIndex?.retentionDays ?? 7;
  const fileMeta = dayIndex?.files?.[selectedDate];
  const sizeStr =
    fileMeta && typeof fileMeta.size === "number"
      ? `${(fileMeta.size / 1024).toFixed(fileMeta.size >= 10240 ? 0 : 1)} KB`
      : "—";

  return (
    <div className="page visible">
      <div className="page-head">
        <h2>Servis günlükleri</h2>
        <p>
          <code className="c">%APPDATA%\\QRPaydotHelper\\logs\\service-YYYY-MM-DD.log</code> — PC&apos;de en fazla{" "}
          <strong>{retention}</strong> gün tutulur; eski dosyalar otomatik silinir. Her satırda zaman ve süreç{" "}
          <code className="c">pid</code> vardır.
        </p>
      </div>

      <div className="panel log-unified-panel">
        <div className="log-unified-top">
          <div className="log-unified-brand">
            <ScrollText size={20} aria-hidden className="log-toolbar-icon" />
            <div className="log-unified-brand-text">
              <span className="log-unified-title">Günlük kayıtları</span>
              <span className="log-unified-sub">
                Son <strong>{retention}</strong> gün saklanır · <code className="c">logs\service-*.log</code>
              </span>
            </div>
          </div>
          {typeof fileMeta?.legacy === "boolean" && fileMeta.legacy ? (
            <span className="log-legacy-badge">Eski service.log taşındı</span>
          ) : null}
        </div>

        <div className="log-unified-days">
          <span className="log-unified-days-label" id="log-days-label">
            <Calendar size={15} aria-hidden />
            Gün
          </span>
          <div className="log-day-strip" role="tablist" aria-labelledby="log-days-label">
            {datesForChips.map((ymd) => (
              <button
                key={ymd}
                type="button"
                role="tab"
                aria-selected={selectedDate === ymd}
                className={`log-day-pill ${selectedDate === ymd ? "active" : ""}`}
                onClick={() => {
                  setSelectedDate(ymd);
                  stickBottom.current = true;
                }}
              >
                <span className="log-day-pill-label">{ymdLabel(ymd, todayYmd)}</span>
                <span className="log-day-pill-date">{ymd}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="log-unified-search">
          <Search size={16} className="log-unified-search-icon" aria-hidden />
          <input
            id="log-filter-q"
            type="search"
            className="log-unified-input"
            placeholder="Satırlarda ara… (hugin-proxy, backend-ws, AUTH_ERROR…)"
            value={filterQ}
            onChange={(e) => setFilterQ(e.target.value)}
            autoComplete="off"
            aria-label="Günlük satırlarında ara"
          />
        </div>

        <div className="log-unified-foot">
          <div className="log-meta-block log-unified-meta">
            <span className="log-meta">
              {fileExists === false ? (
                <span className="log-meta-warn">Bu gün için dosya yok.</span>
              ) : (
                <>
                  <strong>{filteredLines.length}</strong>
                  {filterQ.trim() ? (
                    <>
                      {" "}
                      / {lines.length} satır (süzülü)
                    </>
                  ) : (
                    " satır"
                  )}
                  {truncated ? " · üst kesildi" : ""}
                  {" · "}
                  {sizeStr}
                </>
              )}
            </span>
            {lastFetch ? <span className="log-meta-sub">Son çekim: {lastFetch}</span> : null}
            {isViewingToday ? (
              <span className="log-meta-sub log-meta-live">{paused ? "Canlı duraklatıldı" : "Canlı izleme açık"}</span>
            ) : (
              <span className="log-meta-sub">Arşiv — yalnızca yenile</span>
            )}
          </div>
          <div className="log-toolbar-actions log-unified-actions">
            {isViewingToday ? (
              <button
                type="button"
                className={`btn ${paused ? "primary" : ""}`}
                onClick={() => setPaused((p) => !p)}
                aria-pressed={paused}
              >
                {paused ? (
                  <>
                    <Play size={14} aria-hidden /> Canlı
                  </>
                ) : (
                  <>
                    <Pause size={14} aria-hidden /> Duraklat
                  </>
                )}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => void fetchLogs({ silent: false })} disabled={loading}>
              <RefreshCw size={14} className={loading ? "spin-icon" : ""} aria-hidden /> Yenile
            </button>
            <button type="button" className="btn" onClick={scrollToBottom}>
              En alta
            </button>
            <button type="button" className="btn" onClick={copyVisible} disabled={filteredLines.length === 0}>
              <Copy size={14} aria-hidden /> Kopyala
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <p className="log-err" role="alert">
          {error}
        </p>
      ) : null}

      <div className="panel log-panel log-panel-table">
        <div ref={scrollRef} className="log-line-scroll" onScroll={onScrollBox}>
          {filteredLines.length === 0 && !loading ? (
            <p className="log-empty">Bu görünüm için kayıt yok.</p>
          ) : (
            <table className="log-table">
              <thead>
                <tr>
                  <th className="log-th-time">Zaman</th>
                  <th className="log-th-pid">PID</th>
                  <th className="log-th-msg">Mesaj</th>
                </tr>
              </thead>
              <tbody>
                {filteredLines.map((line, i) => {
                  const p = parseLogLine(line);
                  if (!p) {
                    return (
                      <tr key={`raw-${i}`} className="log-tr">
                        <td colSpan={3} className="log-td log-td-raw">
                          {line}
                        </td>
                      </tr>
                    );
                  }
                  let localLabel = p.ts;
                  try {
                    const d = new Date(p.ts);
                    if (!Number.isNaN(d.getTime())) {
                      localLabel = d.toLocaleString("tr-TR", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      });
                    }
                  } catch {
                    /* ignore */
                  }
                  const tone = msgToneClass(p.msg);
                  return (
                    <tr key={`L${i}`} className={`log-tr ${tone ? "log-tr-tone" : ""}`}>
                      <td className="log-td log-td-time">{localLabel}</td>
                      <td className="log-td log-td-pid">{p.pid ?? "—"}</td>
                      <td className={`log-td log-td-msg ${tone}`}>{p.msg}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
