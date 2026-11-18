/// <reference types="vite/client" />
import type { ClawhipApi } from '../../preload'
declare global {
  interface Window { clawhip: ClawhipApi }
}
