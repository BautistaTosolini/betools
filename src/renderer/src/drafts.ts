import { useEffect, useState } from 'react'

// Borrador de la caja de respuesta de Rendered, por sesión. Vive fuera del componente para no perderse al
// cambiar de pestaña o de sesión, y se guarda en localStorage para sobrevivir a un reinicio.
const KEY = 'drafts'
let drafts: Record<string, string> = {}
try {
  drafts = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
} catch {
  drafts = {}
}
const listeners = new Set<() => void>()
let saveTimer = 0

export function getDraft(id: string): string {
  return drafts[id] ?? ''
}

export function setDraft(id: string, text: string): void {
  if ((drafts[id] ?? '') === text) return
  if (text) drafts = { ...drafts, [id]: text }
  else {
    const { [id]: _, ...rest } = drafts
    drafts = rest
  }
  listeners.forEach((cb) => cb())
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(drafts))
    } catch {
      // sin storage: el borrador dura hasta cerrar la app
    }
  }, 300)
}

export function useDraft(id: string): [string, (t: string) => void] {
  const [v, setV] = useState(getDraft(id))
  useEffect(() => {
    setV(getDraft(id))
    const cb = () => setV(getDraft(id))
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }, [id])
  return [v, (t: string) => setDraft(id, t)]
}
