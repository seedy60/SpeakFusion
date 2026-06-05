import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
