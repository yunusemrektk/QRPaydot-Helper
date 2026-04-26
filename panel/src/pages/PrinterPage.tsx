import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { usePrinters } from "../context/PrintersContext";
import { useServiceMode } from "../context/ServiceModeContext";

const R48 = "0123456789".repeat(5).slice(0, 48);
const EQ48 = "=".repeat(48);
const HY48 = "-".repeat(48);

const DEFAULT_BODY = `${EQ48}
              QRPAYDOT HELPER
            CONNECTION TEST SLIP
${EQ48}
This is NOT a real sale.

Checks:
  - PC -> printer (TCP 9100)
  - Helper -> raw ESC/POS OK
  - Selected encoding on paper

48-column ruler (80mm typical):
${R48}

2x Demo line item                     7.00 TL
1x Demo line item                     3.50 TL
${HY48}
TOPLAM:                             10.50 TL
${HY48}
Clear text = link OK.
You may tear off this slip.`;

export default function PrinterPage() {
  const { printers, loaded, refresh } = usePrinters();
  const { serviceUnlocked } = useServiceMode();
  const [printerSelect, setPrinterSelect] = useState("");
  const [scanStatus, setScanStatus] = useState("");
  const [scanning, setScanning] = useState(false);
  const [host, setHost] = useState("192.168.1.114");
  const [port, setPort] = useState(9100);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [enc, setEnc] = useState("ascii");
  const [codePage, setCodePage] = useState("");
  const [fsdot, setFsdot] = useState(false);
  const [dbg, setDbg] = useState(false);
  const [logClass, setLogClass] = useState("log");
  const [logText, setLogText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (printers.length === 1) {
      const p = printers[0];
      setPrinterSelect(`${p.host}:${p.port}`);
      setHost(p.host);
      setPort(p.port);
    }
  }, [printers]);

  const onSelectPrinter = (val: string) => {
    setPrinterSelect(val);
    if (!val) return;
    const parts = val.split(":");
    setHost(parts[0] ?? "");
    if (parts[1]) setPort(parseInt(parts[1], 10) || 9100);
  };

  const runScan = () => {
    setScanning(true);
    setScanStatus("Yerel ağ taranıyor…");
    setPrinterSelect("");
    fetch("/v1/scan-printers", { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (j: {
          ok?: boolean;
          error?: string;
          printers?: { host: string; port: number }[];
          elapsed?: number;
          subnets?: string[];
        }) => {
          if (!j.ok) throw new Error(j.error || "scan failed");
          const sec = ((j.elapsed ?? 0) / 1000).toFixed(1);
          if (!j.printers?.length) {
            setScanStatus(
              `Tarama tamamlandı (${sec}s) — port 9100 açık cihaz bulunamadı.`,
            );
          } else {
            setScanStatus(
              `${j.printers.length} yazıcı bulundu (${sec}s) — ${(j.subnets ?? []).join(", ")}`,
            );
          }
          void refresh();
        },
      )
      .catch((e: Error) => {
        setScanStatus(`Hata: ${String(e.message || e)}`);
        setPrinterSelect("");
      })
      .finally(() => setScanning(false));
  };

  const sendPrint = () => {
    const h = host.trim();
    const p = port || 9100;
    setSending(true);
    setLogClass("log");
    setLogText("Gönderiliyor…");

    const payload: Record<string, unknown> = {
      target: { host: h, port: p },
      text: body,
      cut: true,
      encoding: enc,
    };
    if (codePage !== "") payload.codePage = parseInt(codePage, 10);
    if (fsdot) payload.cancelDoubleByte = true;
    if (dbg) payload.debug = true;

    fetch("/v1/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) =>
        r
          .json()
          .then((j) => ({ ok: r.ok, j }))
          .catch(() => ({ ok: r.ok, j: {} as Record<string, unknown> })),
      )
      .then(({ ok, j }) => {
        if (!ok) {
          setLogClass("log err");
          setLogText(`Hata: ${String((j as { error?: string }).error || "Bilinmeyen")}`);
        } else {
          setLogClass("log ok");
          let msg = `Başarılı — ${h}:${p} adresine iletildi.`;
          if ((j as { debug?: unknown }).debug) {
            try {
              msg += `\n\n${JSON.stringify((j as { debug: unknown }).debug, null, 2)}`;
            } catch {
              /* ignore */
            }
          }
          setLogText(msg);
        }
      })
      .catch((e: Error) => {
        setLogClass("log err");
        setLogText(String(e.message || e));
      })
      .finally(() => setSending(false));
  };

  return (
    <div className="page visible">
      <div className="page-head">
        <h2>Yazıcı ayarları</h2>
        <p>
          İşletmenize ait fiş yazıcılarını buradan yönetin. Ağ taraması ile yazıcılarınız otomatik
          bulunur.
        </p>
      </div>

      <div className="panel">
        <h3>Ağdaki yazıcılar</h3>
        <p>
          Helper, yerel ağınızdaki tüm fiş yazıcılarını otomatik olarak tarar. Aşağıdaki listeden
          yazıcı seçiniz veya <strong style={{ color: "var(--text)" }}>Ağı tara</strong> butonuna
          tıklayarak yeni tarama başlatın.
        </p>

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginBottom: "0.65rem",
            alignItems: "center",
            marginTop: "0.85rem",
          }}
        >
          <select
            value={printerSelect}
            onChange={(e) => onSelectPrinter(e.target.value)}
            style={{ flex: 1, marginBottom: 0 }}
            disabled={scanning}
          >
            {scanning ? (
              <option value="">Taranıyor…</option>
            ) : !loaded ? (
              <option value="">Yükleniyor…</option>
            ) : !printers.length ? (
              <option value="">Yazıcı bulunamadı</option>
            ) : (
              <>
                <option value="">Seçiniz ({printers.length} yazıcı)</option>
                {printers.map((p) => (
                  <option key={`${p.host}:${p.port}`} value={`${p.host}:${p.port}`}>
                    {p.host}:{p.port} ({p.ms}ms · {p.iface})
                  </option>
                ))}
              </>
            )}
          </select>
          <button
            type="button"
            className={`btn${scanning ? " btn-scanning" : ""}`}
            style={{ whiteSpace: "nowrap", padding: "0.55rem 0.9rem" }}
            disabled={scanning}
            onClick={runScan}
          >
            <RefreshCw width={13} height={13} strokeWidth={2.5} />
            Ağı tara
          </button>
        </div>
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--text-dim)",
            marginBottom: "0.65rem",
            minHeight: "1rem",
          }}
        >
          {scanStatus}
        </div>

        <div className="grid-form">
          <div>
            <label className="fl" htmlFor="host">
              Yazıcı IP adresi
            </label>
            <input
              id="host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.114"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="fl" htmlFor="port">
              Port
            </label>
            <input
              id="port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value, 10) || 9100)}
            />
          </div>
        </div>
        <p className="hint">
          Listeden seçim yaptığınızda IP ve port otomatik dolar. İsterseniz elle de değiştirebilirsiniz.
        </p>
      </div>

      <div className="panel">
        <h3>Bağlantı testi</h3>
        <p>
          Seçtiğiniz yazıcıya kısa bir test fişi göndererek yazıcı ve bağlantının doğru çalıştığını
          kontrol edin.
        </p>

        <label className="fl" htmlFor="body">
          Test metni
        </label>
        <textarea
          id="body"
          rows={24}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />

        <div
          style={{
            display: "flex",
            gap: "0.65rem",
            marginTop: "0.4rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="primary"
            style={{ width: "auto", padding: "0.6rem 1.5rem" }}
            disabled={sending}
            onClick={sendPrint}
          >
            Test fişi gönder
          </button>
        </div>
        <div className={logClass} role="log" aria-live="polite">
          {logText}
        </div>
      </div>

      {serviceUnlocked ? (
        <div className="panel" style={{ borderStyle: "dashed", borderColor: "var(--border)" }}>
          <h3>Gelişmiş ayarlar</h3>
          <p>
            Bu bölüm teknik destek ekibi veya geliştiriciler içindir. Normal kullanımda değiştirmenize
            gerek yoktur. Müşteri moduna dönmek için <strong>Ctrl+Shift+F12</strong> ile PIN girerek
            kilitleyin.
          </p>

          <label className="fl" htmlFor="enc">
            Karakter kodlaması
          </label>
          <select id="enc" value={enc} onChange={(e) => setEnc(e.target.value)}>
            <option value="ascii">Fiş (v1.0.1) · ASCII + PC437 + ESC t 0</option>
            <option value="turkish857">Türkçe · PC857 + ESC t 13 (çoğu SPRT)</option>
            <option value="turkish1252">Türkçe · WPC1252 + ESC t 16</option>
            <option value="windows1254">Windows-1254 (Epson 48)</option>
            <option value="windows1252">Windows-1252</option>
            <option value="iso88599">ISO-8859-9</option>
            <option value="cp857">IBM PC857</option>
            <option value="utf8">UTF-8</option>
            <option value="latin1">Latin-1</option>
          </select>

          <label className="fl" htmlFor="codePage">
            ESC t kod sayfası
          </label>
          <select id="codePage" value={codePage} onChange={(e) => setCodePage(e.target.value)}>
            <option value="">Otomatik (kodlamaya göre)</option>
            <option value="0">0 — PC437 USA (ASCII fiş)</option>
            <option value="48">48 — WPC1254 Türkçe</option>
            <option value="13">13 — PC857 Türkçe</option>
            <option value="16">16 — WPC1252</option>
            <option value="12">12 — PC853 Türkçe</option>
          </select>

          <label className="check-row">
            <input type="checkbox" checked={fsdot} onChange={(e) => setFsdot(e.target.checked)} />
            <span>
              <strong style={{ color: "var(--text)" }}>FS .</strong> (1C 2E) gönder — GBK varsayılan
              Xprinter&apos;larda gerekli.
            </span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={dbg} onChange={(e) => setDbg(e.target.checked)} />
            <span>Hata ayıklama özeti — yanıtta bayt detaylarını gösterir.</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
