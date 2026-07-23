import { defineConfig } from "vite";

import react from "@vitejs/plugin-react";

import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ command }) => {
  const base = process.env.VITE_BASE_PATH || "/projects/ebookavplayer/";
  const disablePwa = process.env.VITE_DISABLE_PWA === "true";

  return {
    base,

    plugins: [
      react(),

      ...(!disablePwa ? [VitePWA({
        registerType: "autoUpdate",
        devOptions: { enabled: false },
        includeAssets: ["icon-192.png", "icon-512.png"],
        manifest: {
          name: "Visual Audiobook Engine",
          short_name: "VAE",
          description: "EPUB to game-style voiced visual reading",
          theme_color: "#1a1d29",
          background_color: "#1a1d29",
          display: "standalone",
          start_url: base,
          scope: base,
          icons: [
            { src: `${base}icon-192.png`, sizes: "192x192", type: "image/png" },
            { src: `${base}icon-512.png`, sizes: "512x512", type: "image/png" },
            { src: `${base}icon-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,png,ico,webmanifest}"],
          navigateFallback: "index.html",
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith("/media/"),
              handler: "CacheFirst",
              options: {
                cacheName: "vae-media-fallback",
                expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
              },
            },
          ],
        },
      })] : []),
    ],

    server: {
      host: true,
      port: process.env.PORT ? Number(process.env.PORT) : 5173,
      proxy: {
        "/projects/ebookavplayer/api": { target: "http://127.0.0.1:8600", timeout: 0 },
        "/books": { target: "http://127.0.0.1:8600", timeout: 0 },
        "/ingest": { target: "http://127.0.0.1:8600", timeout: 0 },
        "/tts": { target: "http://127.0.0.1:8600", timeout: 0 },
        "/voices": { target: "http://127.0.0.1:8600", timeout: 0 },
        "/media": { target: "http://127.0.0.1:8600", timeout: 0 },
        "/pipeline": { target: "http://127.0.0.1:8600", timeout: 0 },
        // Local align server (scripts/local-align-server/) — a separate
        // Python process on :7861, not the Worker. Proxying it through Vite
        // (same trick as the routes above) means a phone/LAN device only
        // ever needs to reach Vite, which is already macOS-firewall-allowed
        // and proven LAN-reachable — no need for the align server's OWN
        // process to be firewall-allowed or even LAN-bound. See
        // docs/M4B_FIRST_FLOW.md's "Reaching it from a phone" section.
        //
        // Namespaced under /align-proxy (not bare /align, /transcribe,
        // /health) on purpose: bare /health is ALREADY claimed by the routes
        // above (proxied to the Worker, :8600) for the "Cloud" connection's
        // own health check. If the align-server "connection" used the bare
        // app origin as its baseUrl, ITS /health check would silently hit
        // the WORKER's health instead of the align server's — reporting
        // green/online even if the align server itself were down, and (as
        // hit in practice) red/offline here because bare /health wasn't
        // proxied to anything at all. rewrite strips the prefix so the
        // align server itself never sees it.
        "/align-proxy": {
          target: "http://127.0.0.1:7861",
          timeout: 0,
          rewrite: (path) => path.replace(/^\/align-proxy/, ""),
        },
        // Local BookNLP server (scripts/local-booknlp-server/) — same
        // reasoning as /align-proxy above (LAN reachability via Vite,
        // /health namespace collision with the Worker's own).
        "/booknlp-proxy": {
          target: "http://127.0.0.1:7862",
          timeout: 0,
          rewrite: (path) => path.replace(/^\/booknlp-proxy/, ""),
        },
      },
    },

    test: {
      environment: "jsdom",
      setupFiles: ["tests/setup.js"],
      globals: true,
      include: ["src/**/*.test.js"],
    },
  };
});
