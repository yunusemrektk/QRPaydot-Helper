import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

type JustUpdatedInfo = {
  from: string | null;
  to: string | null;
};

export default function UpdatedModal() {
  const [info, setInfo] = useState<JustUpdatedInfo | null>(null);

  useEffect(() => {
    fetch("/v1/update/just-updated", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { justUpdated?: boolean; from?: string; to?: string }) => {
        if (j.justUpdated) {
          setInfo({ from: j.from ?? null, to: j.to ?? null });
        }
      })
      .catch(() => {});
  }, []);

  if (!info) return null;

  return (
    <div className="updated-modal-backdrop" onClick={() => setInfo(null)}>
      <div className="updated-modal" onClick={(e) => e.stopPropagation()}>
        <div className="updated-modal-icon">
          <CheckCircle2 size={32} />
        </div>
        <h2 className="updated-modal-title">Güncelleme tamamlandı</h2>
        <p className="updated-modal-desc">
          QRPaydot Helper başarıyla güncellendi.
        </p>
        <div className="updated-modal-versions">
          {info.from && (
            <div className="updated-modal-ver">
              <span className="updated-modal-ver-label">Önceki</span>
              <span className="updated-modal-ver-value old">v{info.from}</span>
            </div>
          )}
          <div className="updated-modal-arrow" aria-hidden>→</div>
          {info.to && (
            <div className="updated-modal-ver">
              <span className="updated-modal-ver-label">Yeni</span>
              <span className="updated-modal-ver-value new">v{info.to}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          className="updated-modal-btn"
          onClick={() => setInfo(null)}
        >
          Tamam
        </button>
      </div>
    </div>
  );
}
