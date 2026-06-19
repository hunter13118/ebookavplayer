import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const base = process.env.VITE_BASE_PATH || "/projects/ebookavplayer/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Local dev: proxy API to FastAPI so the client never needs VITE_API_BASE.
    // (Without this, a missing env var makes fetch hit Vite's index.html as JSON.)
    proxy: {
      "/books": "http://127.0.0.1:8600",
      "/ingest": "http://127.0.0.1:8600",
      "/tts": "http://127.0.0.1:8600",
      "/voices": "http://127.0.0.1:8600",
      "/media": "http://127.0.0.1:8600",
    },
  },
});
