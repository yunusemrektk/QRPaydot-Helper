import { useHealth } from "../context/HealthContext";

export default function AboutPage() {
  const { data } = useHealth();
  const version = data?.version ?? "—";
  const bind = data?.bind ?? "127.0.0.1:17888";

  return (
    <div className="page visible">
      <div className="page-head">
        <h2>Hakkında</h2>
        <p>QRPaydot Helper uygulaması hakkında genel bilgi</p>
      </div>

      <div className="grid-2c">
        <div className="panel">
          <h3>QRPaydot Helper nedir?</h3>
          <p>
            <strong style={{ color: "var(--text)" }}>QRPaydot Helper</strong>, işletmenize ait fiş
            yazıcıları, çevrimdışı işlemler ve diğer yerel ihtiyaçlar için tasarlanmış masaüstü
            yardımcı uygulamadır.
          </p>
          <p>
            Bulutta değil, <strong style={{ color: "var(--text)" }}>yalnızca bu bilgisayarda</strong>{" "}
            çalışır. Tarayıcınız ağdaki yazıcıya doğrudan bağlanamadığından, fiş iletimi gibi işlemler
            bu süreç üzerinden gerçekleştirilir.
          </p>
          <p>
            İlerleyen sürümlerde çevrimdışı sipariş kuyruğu ve otomatik senkron gibi özellikler aynı
            uygulama üzerinde sunulacaktır.
          </p>
        </div>
        <div className="panel">
          <h3>Teknik bilgiler</h3>
          <table className="kv-table">
            <tbody>
              <tr>
                <td>Uygulama</td>
                <td>QRPaydot Helper</td>
              </tr>
              <tr>
                <td>Sürüm</td>
                <td>{version}</td>
              </tr>
              <tr>
                <td>Dinleme adresi</td>
                <td>
                  <code className="c">{bind}</code>
                </td>
              </tr>
              <tr>
                <td>Güvenlik</td>
                <td>Yalnızca bu PC&apos;den erişilebilir</td>
              </tr>
              <tr>
                <td>Platform</td>
                <td>Windows</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
