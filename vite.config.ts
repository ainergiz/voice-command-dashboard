import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: "src/dashboard",
  build: {
    outDir: path.resolve(__dirname, "dist/assets"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/agents": {
        target: "http://localhost:8787",
        ws: true,
      },
      "/api": {
        target: "http://localhost:8787",
      },
    },
  },
});
