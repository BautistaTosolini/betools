import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Interfaz sola para Tauri (sin Electron). La interfaz es la misma de electron.vite.config.ts.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// El CSP de index.html es `default-src 'self'`: bloquearía el IPC de Tauri (ipc://localhost, o
// http://ipc.localhost) y el websocket de HMR. Se amplía solo en este build; index.html no cambia.
const tauriCsp = (): Plugin => ({
  name: 'tauri-csp',
  transformIndexHtml: (html) =>
    html.replace(
      "default-src 'self';",
      "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420;"
    )
})

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  // Rutas relativas: la app carga desde tauri://localhost, pero así también sirve desde cualquier base.
  base: './',
  plugins: [react(), tauriCsp()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: 'localhost' },
  build: { outDir: fileURLToPath(new URL('./out/tauri', import.meta.url)), emptyOutDir: true, target: 'safari15' }
})
