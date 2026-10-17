import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Paths the Worker owns; the service worker must never answer them from cache.
const WORKER_PATHS = [/^\/api\//, /^\/mcp/, /^\/authorize/, /^\/callback/, /^\/login/, /^\/logout/, /^\/token/, /^\/register/, /^\/\.well-known\//, /^\/healthz/];

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "macro-cache",
        short_name: "macro-cache",
        description: "Claude-native macro tracker on your own Cloudflare instance.",
        theme_color: "#0b0f14",
        background_color: "#0b0f14",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: WORKER_PATHS,
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    // `npm run dev -w apps/dashboard` proxies to `wrangler dev` on 8788.
    proxy: Object.fromEntries(["/api", "/login", "/logout", "/callback"].map((p) => [p, "http://localhost:8788"])),
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
