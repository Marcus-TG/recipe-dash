import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      // Recipe photos live behind the API too — without this they 404 in dev
      // and every card falls back to the placeholder.
      '/uploads': 'http://localhost:3000',
    },
  },
})
