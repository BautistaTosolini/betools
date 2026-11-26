/// <reference types="vite/client" />
import type { ClawhipApi } from '../../preload'
declare global {
  const __APP_VERSION__: string
  // writeDoc solo existe en la versión Rust (Tauri): la interfaz muestra la edición si está.
  interface Window {
    clawhip: ClawhipApi & { writeDoc?: (path: string, text: string, mtime: number | null) => Promise<{ text: string; mtime: number }> }
  }
}
