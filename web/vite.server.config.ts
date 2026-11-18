import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Servidor web: un solo archivo ESM para Node; node-pty y ws quedan como dependencias de runtime.
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'server/index.ts'),
    outDir: resolve(import.meta.dirname, '../web-dist'),
    emptyOutDir: false,
    target: 'node22',
    rollupOptions: { external: ['node-pty', 'ws'], output: { entryFileNames: 'server.mjs', format: 'es' } }
  }
})
