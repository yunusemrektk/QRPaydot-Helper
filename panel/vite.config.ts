import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: "../public/panel",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    port: 5179,
    strictPort: true,
    proxy: {
      "/health": "http://127.0.0.1:17888",
      "/v1": "http://127.0.0.1:17888",
    },
  },
});
