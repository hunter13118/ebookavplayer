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
