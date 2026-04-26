import { Mail, MessageCircle, Phone } from "lucide-react";

export default function SupportPage() {
  return (
    <div className="page visible">
      <div className="page-head">
        <h2>Destek</h2>
        <p>QRPaydot teknik destek ekibine ulaşmanın yolları</p>
      </div>

      <div className="panel">
        <h3>Bize ulaşın</h3>
        <p>
          Herhangi bir sorun yaşadığınızda veya yardım ihtiyacınız olduğunda aşağıdaki kanallardan
          bize ulaşabilirsiniz.
        </p>

        <div style={{ marginTop: "0.85rem" }}>
          <a href="mailto:info@qrpaydot.com" className="contact-card">
            <div className="cc-icon">
              <Mail width={18} height={18} strokeWidth={2} />
            </div>
            <div className="cc-text">
              <strong>E-posta</strong>
              <span>info@qrpaydot.com</span>
            </div>
          </a>

          <a href="tel:+905464800986" className="contact-card">
            <div className="cc-icon">
              <Phone width={18} height={18} strokeWidth={2} />
            </div>
            <div className="cc-text">
              <strong>Telefon</strong>
              <span>0 546 480 09 86</span>
            </div>
          </a>

          <a
            href="https://wa.me/905464800986"
            target="_blank"
            rel="noopener noreferrer"
            className="contact-card"
          >
            <div className="cc-icon">
              <MessageCircle width={18} height={18} strokeWidth={2} />
            </div>
            <div className="cc-text">
              <strong>WhatsApp</strong>
              <span>0 546 480 09 86</span>
            </div>
          </a>
        </div>
      </div>

      <div className="panel roadmap-panel">
        <span className="badge-soon">Planlanan</span>
        <h3>Uzaktan destek</h3>
        <p>
          İleride bu bölümden QRPaydot teknik ekibinin, izniniz dahilinde bilgisayarınıza uzaktan
          bağlantı kurarak sorununuzu doğrudan çözmesi planlanmaktadır.
        </p>
        <table className="kv-table" style={{ marginTop: "0.65rem" }}>
          <tbody>
            <tr>
              <td>Durum</td>
              <td>Geliştirme aşamasında</td>
            </tr>
            <tr>
              <td>Güvenlik</td>
              <td>Yalnızca sizin onayınızla bağlantı kurulur</td>
            </tr>
            <tr>
              <td>Kullanım</td>
              <td>Tek tıkla oturum başlat, işlem bitince otomatik kapanır</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
