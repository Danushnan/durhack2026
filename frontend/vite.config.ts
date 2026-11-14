import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// KUBEVERSE_API lets a second dev server point at a second backend (e.g. for isolated testing).
const api = process.env.KUBEVERSE_API ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
})
