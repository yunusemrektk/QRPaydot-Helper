/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Panel build sırasında gömülür; boş string = servis modu kapalı */
  readonly VITE_SERVICE_PIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
