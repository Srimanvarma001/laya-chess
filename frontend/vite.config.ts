import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 1: dev server only. The API base URL is read from .env (VITE_API_BASE_URL)
// so switching from the local Laya server to a tunnel or future hosted API
// later does not require touching this file.
//
// laya-serve 0.3.20 ships no CORSMiddleware, so a browser page on :5173 calling
// :8000 directly fails CORS preflight (OPTIONS /v1/systemone -> 405). Proxying
// same-origin /api -> :8000 avoids preflight entirely; the proxy runs
// server-side in Node, where CORS does not apply.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
