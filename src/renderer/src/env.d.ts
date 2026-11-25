/// <reference types="vite/client" />
import type { ClawhipApi } from '../../preload'
declare global {
  const __APP_VERSION__: string
  interface Window { clawhip: ClawhipApi }
}
