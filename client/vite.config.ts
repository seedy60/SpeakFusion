import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      // Locale resolution order (first hit wins): a stored choice from the
      // language picker, then the browser's preferred language, then English.
      // A ?lang= URL override is applied imperatively in src/lib/i18n.ts.
      strategy: ["localStorage", "preferredLanguage", "baseLocale"],
    }),
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing third-party code out of the app
        // bundle. mediasoup-client is the largest dependency, so it gets its
        // own chunk; everything else from node_modules shares a vendor chunk.
        // Beyond silencing the 500 kB chunk-size warning, this matters for our
        // deploy model: client redeploys are frequent (`pnpm build` only), but
        // these chunks rarely change, so returning users keep them cached.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("mediasoup-client")) return "mediasoup";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/socket.io": {
        target: "http://localhost:3100",
        ws: true,
      },
      // Recording download endpoint lives on the backend.
      "/api": {
        target: "http://localhost:3100",
      },
    },
  },
});
