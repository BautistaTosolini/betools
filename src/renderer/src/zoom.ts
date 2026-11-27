import { useEffect, useState } from 'react'

// Zoom global (toda la ventana, con webFrame) y zoom del chat (columna central: Rendered y terminales).
// Se recuerda por equipo en localStorage (conveniencia; si falla, se arranca en el zoom por defecto).
export const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5]
export type ZoomKind = 'app' | 'chat'
// Por defecto: la ventana al 110 % y el chat al 90 % (lo que vuelve con Ctrl+0).
export const DEFAULT_ZOOM: Record<ZoomKind, number> = { app: 1.1, chat: 0.9 }

function load(key: string, def: number): number {
  try {
    const raw = localStorage.getItem(key)
    const v = Number(raw)
    return raw !== null && STEPS.includes(v) ? v : def
  } catch {
    return def
  }
}

const state: Record<ZoomKind, number> = { app: load('zoomApp', DEFAULT_ZOOM.app), chat: load('zoomChat', DEFAULT_ZOOM.chat) }
const listeners = new Set<() => void>()

function apply(): void {
  ;(window.clawhip as { setZoomFactor?: (f: number) => void }).setZoomFactor?.(state.app)
}
apply()

export function getZoom(kind: ZoomKind): number {
  return state[kind]
}

export function setZoom(kind: ZoomKind, value: number): void {
  if (state[kind] === value) return
  state[kind] = value
  try {
    localStorage.setItem(kind === 'app' ? 'zoomApp' : 'zoomChat', String(value))
  } catch {
    // sin storage: el zoom dura hasta cerrar la app
  }
  if (kind === 'app') apply()
  listeners.forEach((cb) => cb())
}

export function stepZoom(kind: ZoomKind, dir: -1 | 0 | 1): void {
  if (dir === 0) return setZoom(kind, DEFAULT_ZOOM[kind])
  const i = STEPS.indexOf(state[kind])
  setZoom(kind, STEPS[Math.min(STEPS.length - 1, Math.max(0, i + dir))])
}

export function useZoom(kind: ZoomKind): number {
  const [v, setV] = useState(state[kind])
  useEffect(() => {
    const cb = () => setV(state[kind])
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }, [kind])
  return v
}

// Atajo de zoom a partir de una tecla: +1, -1, 0 (reset) o null. Se mira la tecla física (e.code) y el
// carácter, para que funcione con distintas distribuciones de teclado.
export function zoomKeyDir(e: KeyboardEvent): -1 | 0 | 1 | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null
  if (['Equal', 'NumpadAdd'].includes(e.code) || ['+', '=', '*'].includes(e.key)) return 1
  if (['Minus', 'NumpadSubtract'].includes(e.code) || ['-', '_'].includes(e.key)) return -1
  if (['Digit0', 'Numpad0'].includes(e.code)) return 0
  return null
}
