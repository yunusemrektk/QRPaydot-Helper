export default function OfflinePage() {
  return (
    <div className="page visible">
      <div className="page-head">
        <h2>Çevrimdışı mod</h2>
        <p>İnternet kesintisinde işletmenin çalışmaya devam edebilmesi için planlanan özellikler</p>
      </div>

      <div className="grid-2c">
        <div className="panel roadmap-panel">
          <span className="badge-soon">Planlanan</span>
          <h3>Sipariş kuyruğu</h3>
          <p>
            İnternet kesildiğinde gelen siparişler bu Helper&apos;da yerel olarak sıraya alınacak.
            Bağlantı geri geldiğinde otomatik senkron ile bulut sunucusuna iletilecek.
          </p>
        </div>
        <div className="panel roadmap-panel">
          <span className="badge-soon">Planlanan</span>
          <h3>Fiş yedekleme</h3>
          <p>
            Yazdırılan fişlerin kopyaları bu bilgisayarda saklanacak. İnternet olmasa bile gün sonu
            raporu veya tekrar basım yapılabilecek.
          </p>
        </div>
      </div>

      <div className="panel roadmap-panel">
        <span className="badge-soon">Planlanan</span>
        <h3>Otomatik senkron</h3>
        <p>
          Bağlantı kesintisi sırasında biriken veriler, internet döndüğünde bulut sunucusuyla otomatik
          olarak eşleştirilecek.
        </p>
        <table className="kv-table" style={{ marginTop: "0.65rem" }}>
          <tbody>
            <tr>
              <td>Durum</td>
              <td>Geliştirme aşamasında</td>
            </tr>
            <tr>
              <td>Önkoşul</td>
              <td>QRPaydot Helper bu PC&apos;de çalışıyor olmalı</td>
            </tr>
            <tr>
              <td>Etki</td>
              <td>Sipariş alma ve fiş basımı internetsiz sürer</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
