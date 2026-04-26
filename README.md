# QRPaydot Helper (yerel yardımcı)

> **Public dağıtım:** Kaynak ve indirme için hedef repo: **`QRPaydot-Helper`** (GitHub’da public).  
> Bu `merchant-dash/print-bridge/` kopyası geliştirme sırasında monorepo içinde kalabilir; sürüm ve müşteri kurulumu public repodan takip edilir.  
> Merchant panelde varsayılan indirme: GitHub Release **Setup.exe** (`QRPaydot.Helper.Setup.1.0.1.exe`); override: `VITE_PRINT_BRIDGE_DOWNLOAD_URL`. Kaynak ZIP yedek: `VITE_PRINT_BRIDGE_SOURCE_ZIP_URL` / `main` branch arşivi.

## Bu ne: masaüstü .exe mi, backend mi?

İkisi de değil, tam arada:

- **Bulut backend’i değil** — Railway/MySQL gibi uzakta çalışmaz; **sadece kasa PC’de** çalışan küçük bir **Node.js süreci**.
- **Klasik “yazıcı sürücüsü” değil** — QRPaydot için **bu PC’de çalışan yerel yardımcı**dır; şu an başlıca rolü **fiş metnini LAN’daki ham yazıcıya iletmek**tir, ileride **çevrimdışı kuyruk / senkron** gibi özellikler aynı sürece eklenebilir.
- Kontrol için tarayıcıdan **`http://127.0.0.1:17888`** veya geliştiricide **`npm run desktop`** ile **Helper arayüzü** (durum, yerel hizmet özeti, yol haritası, ham yazıcı testi) açılır.

Özet: **Yerel mini sunucu + Helper paneli (tarayıcı veya Electron).** Merchant-Dash (`EXTERNAL` mod) fişi buraya HTTP ile iletir; köprü metni **RAW TCP (JetDirect, çoğu cihazda 9100)** ile yazıcıya yollar.

Offline sipariş kuyruğu **henüz yok**; aynı process’e sonradan eklenecek şekilde tasarlandı.

## Repoda nerede durmalı?

| Seçenek | Artı | Eksi |
|--------|------|------|
| **A) `merchant-dash/print-bridge/` (bu konum)** | Panel ile aynı monorepo’da geliştirme. | Private ise müşteri ZIP indiremez; public **`QRPaydot-Helper`** ile eşlenmeli. |
| **B) Public `QRPaydot-Helper` repo** | Herkese açık kaynak ZIP; sürüm ve müşteri kurulumu net. | API değişince monorepo + helper senkronize tutulmalı. |

**Öneri:** Kodu geliştirirken **A**’da tutup, yayın ve indirme adresini **B (public)** yapın; değişiklikleri iki yere aktarın veya tek yön (sadece Helper public, monorepo’dan kopyala) seçin.

## Gereksinimler

- Node.js **18+**
- Yazıcı aynı LAN’de, **RAW/JetDirect** portu açık (genelde **9100**)
- Köprü varsayılan olarak yalnızca **`127.0.0.1`** dinler — tarayıcı ile aynı PC’de çalışmalıdır.

## Kurulum — son kullanıcı (Windows, önerilen)

1. **`QRPaydotHelper-Setup-x.y.z.exe`** dosyasını indirin (GitHub **Releases** veya kendi hosting’iniz; Merchant-Dash build’inde `VITE_PRINT_BRIDGE_DOWNLOAD_URL` bu adrese işaret etmeli).
2. Kurulum sihirbazında hedef klasörü seçin; isteğe bağlı **masaüstü kısayolu** ve **Windows açılışında çalıştır**.
3. Kurulum bitince köprü başlar ve tarayıcıda **kontrol paneli** (`http://127.0.0.1:17888/`) açılır. Node veya `npm` gerekmez.

Tek dosya isteyenler: `QRPaydotHelper.exe` doğrudan çalıştırılabilir (kurulum menüsü / Kaldır yok).

## Kurulum — geliştirici (kaynak)

```bash
# Monorepo içindeyken:
cd print-bridge
npm install
npm run panel:install
npm run panel:build
npm start
```

Panel **Vite + React** (`print-bridge/panel/`) ile üretilir; çıktı `public/panel/`. Köprü `GET /` ile bu dosyaları sunar. Sadece `npm start` öncesi mutlaka `npm run panel:build` (veya ilk kurulumda yukarıdaki sıra) çalıştırın.

**Panel UI geliştirme (HMR):** köprü açıkken (`npm start`, port 17888) ikinci terminal:

```bash
npm run panel:dev
```

→ `http://localhost:5179` (`vite.config.ts` içinde `/health` ve `/v1/*` → 17888’e proxy).

- **Kontrol paneli (UI):** `http://127.0.0.1:17888/`  
- **Sağlık (API):** `http://127.0.0.1:17888/health`

## Windows kurulum paketi (.exe) üretmek

Önkoşul: [Inno Setup 6](https://jrsoftware.org/isdl.php) (ücretsiz). `ISCC.exe` PATH’te değilse `INNO_SETUP_ISCC` ortam değişkeni ile tam yol verin.

```bash
npm install
npm run panel:install
npm run build:win       # önce panel:build → dist/electron/...
npm run build:installer # → NSIS kurulum
```

`build:installer`, `package.json` içindeki `version` ile sihirbaz dosya adını eşler. Yayınladığınız **Setup.exe** URL’sini panelde `VITE_PRINT_BRIDGE_DOWNLOAD_URL` olarak kullanın; kullanıcılar ZIP / `npm` görmez.

Chrome’da panel adresini **“Uygulama olarak yükle”** ile sabitlemek mümkün.

### Masaüstü penceresi (Electron)

Tarayıcı sekmesi yerine küçük bir uygulama penceresi isteyenler (geliştirme ortamında):

```bash
npm install
npm run panel:build
npm run desktop
```

Bu komut köprü sunucusunu başlatır ve paneli **Electron** penceresinde açar. Başlangıçta işletme paneli otomatik olarak harici tarayıcıda açılmaz; **Durum** sayfasındaki **İşletme panelini aç** ile açarsınız.

`npm run build:win` / `build:installer` çalıştırmadan önce **`npm run panel:build`** otomatik tetiklenir (`public/panel/` pakete dahildir).

## Yeni sürüm yayınlama (auto-update)

Helper, **electron-updater** ile GitHub Releases üzerinden otomatik güncelleme destekler. Kullanıcıların manuel indirme yapmasına gerek yoktur.

### Ön hazırlık (bir kez)

1. GitHub'da **Classic Personal Access Token** oluşturun (scope: `repo`).
2. `print-bridge/.env` dosyasına ekleyin:
   ```
   GH_TOKEN=ghp_xxxxxxxxxxxxx
   ```

### Yeni sürüm yayınlama

```bash
# 1. package.json'da version'ı artırın (ör. 1.0.3 → 1.0.4)

# 2. Publish komutunu çalıştırın
npm run publish:win
```

Bu tek komut sırasıyla:
- Panel'i build eder
- NSIS installer oluşturur (`QRPaydot.Helper.Setup.exe`)
- `latest.yml` (auto-update manifest) üretir
- GitHub'da Release oluşturur ve dosyaları yükler

### Alternatif: manuel upload

`GH_TOKEN` olmadan da çalışabilir:

```bash
npm run build:installer
```

Build sonrası `dist/electron/` altında oluşan **`QRPaydot.Helper.Setup.exe`** ve **`latest.yml`** dosyalarını GitHub'da "Draft a new release" ile birlikte yükleyin. Her ikisi de gereklidir.

### Güncelleme akışı (kullanıcı tarafı)

1. Uygulama açılışta ve düzenli aralıklarla GitHub'dan yeni sürüm kontrol eder
2. Güncelleme varsa arka planda sessizce indirir
3. İndirme tamamlanınca uygulama otomatik restart eder ve yeni sürüm yüklenir
4. Yeniden açılışta "Güncelleme tamamlandı" modal'ı gösterilir

Kullanıcıdan onay istenmez — tüm süreç sessiz ve otomatiktir. Helper panelindeki **Güncelleme** sayfasından manuel kontrol ve yükleme de yapılabilir.

### Download URL

Merchant-Dash'teki "Setup.exe indir" butonu şu URL'yi kullanır:

```
https://github.com/yunusemrektk/QRPaydot-Helper/releases/latest/download/QRPaydot.Helper.Setup.exe
```

`/releases/latest/download/` her zaman son release'e yönlendirir — sürüm artırınca URL değişmez.

## Ortam değişkenleri

Helper, **merchant-dash ile aynı** kök `.env` dosyasını okur (`merchant-dash/.env`), ardından varsa `print-bridge/.env` ile üzerine yazar. (`src/loadEnv.js`, `dotenv`)

**İşletme paneli URL’si** (`/health` içindeki `merchantDash`, “İşletme panelini aç”):

1. `MERCHANT_DASH_URL` — her zaman en yüksek öncelik.  
2. **Paketli** (`pkg` / **Setup.exe**) veya **`npm run desktop` (Electron)** → `https://merchant.qrpaydot.com` (`.env` içindeki `VITE_*` panel adresine **bakılmaz**).  
3. **Yalnızca** `node src/index.js` (Electron yok) **veya** `print-bridge/.env` içinde `HELPER_MERCHANT_DASH_FROM_VITE=1` → `VITE_MERCHANT_DASH_URL` / `VITE_API_BASE_URL` türevi / `http://<LAN>:8080`.

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `PRINT_BRIDGE_PORT` | `17888` | HTTP dinleme portu |
| `PRINT_BRIDGE_BIND` | `127.0.0.1` | **LAN’a açmayın** (yetkisiz yazdırma riski). |
| `PRINT_BRIDGE_OPEN_BROWSER` | `0` (kapalı) | `1` = başlangıçta sistem tarayıcısında Helper panel sekmesi aç; `0` veya boş = açma. |
| `MERCHANT_DASH_URL` | — | İşletme paneli için tam URL (en yüksek öncelik). |
| `HELPER_MERCHANT_DASH_FROM_VITE` | — | `1` = Electron’da bile `VITE_*` ile LAN panel adresini kullan (yerel merchant-dash). |
| `VITE_MERCHANT_DASH_URL` | — | `node src/index.js` veya yukarıdaki `=1` iken panel URL’si. |
| `VITE_MERCHANT_DASH_PORT` | `8080` | `VITE_API_BASE_URL` üzerinden türetirken Vite portu. |
| `VITE_API_BASE_URL` | — | `node` veya `HELPER_MERCHANT_DASH_FROM_VITE=1` iken LAN host türevi. |
| `MERCHANT_DASH_OPEN` | `1` (açık) | `0` = merchant panelini tarayıcıda otomatik açma. |

## Diğer dağıtım seçenekleri

- **Geliştirici / sunucu benzeri PC:** kaynak veya `npm ci --omit=dev` + `node src/index.js`; Görev Zamanlayıcı ile oturum açılışında çalıştırılabilir.
- **Windows hizmeti:** [NSSM](https://nssm.cc/) veya benzeri ile `QRPaydotHelper.exe` veya `node src/index.js` servis yapılabilir.
- **macOS / Linux:** şimdilik kaynak + Node; ileride aynı mantıkla paketlenebilir.

Paketleme altyapısı: [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) (`npm run build:win`).

## HTTPS (production Merchant-Dash) ve mixed content

Tarayıcıda panel **https://** ise, sayfa **`http://127.0.0.1:17888`** adresine istek atarken bazı ortamlarda **karma içerik / güvenlik** engeline takılabilir (tarayıcı ve sürüme bağlı).

Pratik yollar:

- **Geliştirme:** Panel `http://localhost:8080` vb. ise genelde sorunsuz.
- **Üretim:**  
  - Kasada **Electron/Tauri** ile sarılı panel (localhost güvenilir); veya  
  - Ağ içi **HTTP** ile erişilen panel (`http://192.168.x.x`); veya  
  - Köprüye **yerel HTTPS** (ör. `mkcert` ile `127.0.0.1` sertifikası) — kurulum adımı artar.

README’de bu başlığı müşteri dokümantasyonunda mutlaka belirtin.

## Sorun giderme

### `Unknown encoding: turkish1252` (konsol / `500` yanıtı)

Bu metin **Node.js**’in `Buffer.from(metin, encoding)` hatasıdır: Node yalnızca `utf8`, `latin1`, `hex` gibi birkaç sabit adı kabul eder; `turkish1252` veya `windows-1252` **geçerli bir Buffer kodlaması değildir**.

**Eski** paketlenmiş `QRPaydotHelper.exe` sürümleri bazen bu hatayı verir; güncel kaynakta metin **`iconv-lite`** ile `windows-1252` / `CP857` baytlarına çevrilir.

**Ne yapmalı:** Eski süreci kapatıp bu klasörden **`npm run build:win`** ile yeni `.exe` üretin (public repoya da aynı sürümü yayınlayın) veya geçici olarak **`npm start`** / **`node src/index.js`** ile güncel kodu çalıştırın. `/health` yanıtındaki `version`, `package.json` ile eşleşmeli.

## API

### `GET /health`

```json
{
  "ok": true,
  "service": "qrpaydot-helper",
  "version": "1.0.4",
  "bind": "127.0.0.1:17888",
  "update": { "status": "idle", "availableVersion": null }
}
```

### `GET /v1/update/status`

Güncelleme durumu. `status`: `idle` | `checking` | `available` | `downloading` | `downloaded` | `error`.

### `POST /v1/update/check`

Hemen güncelleme kontrolü tetikler. Yanıt: `{ "ok": true, "updateAvailable": true, "version": "1.0.5" }`.

### `POST /v1/update/install`

İndirilen güncellemeyi yüklemek için uygulamayı restart eder. Yalnızca `status: "downloaded"` iken çalışır.

### `GET /v1/update/just-updated`

Güncelleme sonrası ilk açılışta `{ "justUpdated": true, "from": "1.0.3", "to": "1.0.4" }` döner (tek seferlik). Sonraki çağrılarda `{ "justUpdated": false }`.

### `POST /v1/print`

`Content-Type: application/json`

```json
{
  "target": { "host": "192.168.1.114", "port": 9100 },
  "text": "fiş metni...\n",
  "cut": true,
  "encoding": "utf8"
}
```

Yanıt: `{ "ok": true }` veya `500` + `{ "error": "..." }`.

## Güvenlik

- Varsayılan **loopback** bağlayıcısı: yalnızca aynı makinedeki uygulamalar erişir.  
- `PRINT_BRIDGE_BIND=0.0.0.0` yapmayın — ağdaki herkes yazıcıya ham gönderim yapabilir.  
- İleride: paylaşımlı PC’ler için **paylaşılan sır** (header token) eklenebilir.

## Türkçe karakterler

`POST /v1/print` gövdesinde `encoding` alanı: varsayılan **`ascii`** (ASCII + CP437 + ESC `t` 0; fiş v1.0.1), ayrıca **`turkish857`**, **`turkish1252`**, **`windows1252`**, **`utf8`** vb. Ayrıntılar: `normalizePrintEncoding` / `buildEscPosPayload`. `printers.json` içinde `printDefaults.encoding` ile kalıcı varsayılan.

## Offline sipariş (gelecek)

Bu süreçte:

- Yerel **SQLite** + sunucu ile **senkron kuyruk** eklenebilir.
- Merchant-Dash yalnızca “köprüye yaz / kuyruğa at” diye konuşur; bridge **tek süreç**te hem yazdırır hem (sonra) eşitler.

Şu anki sürüm yalnızca **anında yazdırma** yapar.
