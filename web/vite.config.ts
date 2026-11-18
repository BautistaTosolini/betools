import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Cliente web: se compila a web-dist/public; el servidor lo sirve como archivos estáticos.
export default defineConfig({
  root: resolve(import.meta.dirname, 'client'),
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, '../web-dist/public'), emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } } }
})
