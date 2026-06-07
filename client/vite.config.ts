import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite config for the OpenClaw Gateway dashboard.
// In dev, /api is proxied to the Flask backend on :5000 so the
// React app and the server share the same origin (avoids CORS
// during development). In production the same paths are served by
// the nginx container that fronts both.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
});
