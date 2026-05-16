import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

import { cloudflare } from "@cloudflare/vite-plugin";

const workerTarget =
  process.env.VITE_WORKER_ORIGIN ?? "https://gtd-worker.snerh6.workers.dev";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), cloudflare()],
  server: {
    proxy: {
      "/api": {
        target: workerTarget,
        changeOrigin: true,
      },
    },
  },
})
