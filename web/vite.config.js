import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const base = process.env.VITE_BASE_PATH || "/projects/ebookavplayer/";

export default defineConfig({
  base,
  plugins: [react()],
  server: { host: true, port: 5173 },
});
