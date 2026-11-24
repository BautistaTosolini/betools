import type { Terminal } from '@xterm/xterm'

// Terminales de xterm por clave de pty, para que la pestaña Rendered pueda leer la pantalla de Claude
// (menús de permisos, preguntas, selectores) y mostrarla como botones.
const terms = new Map<string, Terminal>()
const listeners = new Map<string, Set<() => void>>()

function notify(id: string): void {
  listeners.get(id)?.forEach((cb) => cb())
}

export function registerTerm(id: string, term: Terminal): () => void {
  terms.set(id, term)
  const sub = term.onWriteParsed(() => notify(id))
  notify(id)
  return () => {
    sub.dispose()
    if (terms.get(id) === term) terms.delete(id)
  }
}

// Líneas visibles de la pantalla (el renderer de pantalla completa de Claude dibuja todo en el viewport).
export function screenLines(id: string): string[] {
  const term = terms.get(id)
  if (!term) return []
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < term.rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
  return out
}

export function onScreen(id: string, cb: () => void): () => void {
  let set = listeners.get(id)
  if (!set) listeners.set(id, (set = new Set()))
  set.add(cb)
  return () => set!.delete(cb)
}
