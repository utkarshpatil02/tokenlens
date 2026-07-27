import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api to the FastAPI backend so the app always uses same-origin relative
// URLs. Dev and a deployed build then behave identically, with no
// environment-specific base URL to configure or get wrong.
// GitHub Pages serves a project site from /<repo>/, so assets need that prefix.
// Local dev and any root-domain host stay at '/'.
const base = process.env.GITHUB_PAGES === 'true' ? '/tokenlens/' : '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
