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

// Celdas atenuadas (dim) de una línea: Claude Code dibuja así el texto de ejemplo del prompt vacío.
export function dimMask(id: string, y: number): boolean[] {
  const term = terms.get(id)
  if (!term) return []
  const line = term.buffer.active.getLine(term.buffer.active.viewportY + y)
  if (!line) return []
  const out: boolean[] = []
  const cell = term.buffer.active.getNullCell()
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell)
    out.push(!!cell.isDim())
  }
  return out
}

// Texto que hay en el prompt de Claude (la caja entre las dos líneas divisorias de abajo).
// collapsed: tiene marcadores como "[Pasted text #1 +20 lines]" o "[Image #1]", que no se pueden recuperar como texto.
export interface CliInput {
  text: string
  lines: number
  collapsed: boolean
}

const RULE = /^\s*─{8,}/

export function readCliInput(id: string): CliInput | null {
  const lines = screenLines(id)
  let p = -1
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].startsWith('❯') && RULE.test(lines[i - 1])) {
      p = i
      break
    }
  }
  if (p < 0) return null
  const out: string[] = []
  for (let i = p; i < lines.length && !RULE.test(lines[i]); i++) out.push(lines[i].slice(2))
  // Texto de ejemplo del prompt vacío: se dibuja atenuado.
  const dim = dimMask(id, p)
  const first = lines[p]
  let anyBright = false
  for (let x = 2; x < first.length; x++) if (first[x] !== ' ' && !dim[x]) anyBright = true
  if (!anyBright && out.length === 1) return { text: '', lines: 1, collapsed: false }
  const text = out.join('\n').replace(/\s+$/, '')
  return { text, lines: out.length, collapsed: /\[(Pasted text|Image) #\d+/.test(text) }
}

// Mensajes que mandaste mientras Claude trabajaba: la TUI los muestra como "❯ texto" seguido de
// "⎿  Queued · …" hasta que los toma.
export function readQueued(id: string): string[] {
  const lines = screenLines(id)
  const out: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!/^\s*⎿\s+Queued\b/.test(lines[i])) continue
    let start = i - 1
    while (start > 0 && !lines[start].startsWith('❯')) start--
    if (!lines[start].startsWith('❯')) continue
    out.push(lines.slice(start, i).map((l, k) => (k === 0 ? l.slice(2) : l.replace(/^ {2}/, ''))).join('\n').trimEnd())
  }
  return out
}

// Estado en curso que muestra la TUI mientras Claude trabaja, p. ej.
// "✶ Harmonizing… (11m 26s · ↓ 57.5k tokens)" y debajo "⎿  Tip: …".
export interface Activity {
  label: string
  detail: string
  tip: string
}

export function readActivity(id: string): Activity | null {
  const lines = screenLines(id)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^([^\s\w❯⎿─│])\s+(\S[^(]*?…)\s*(?:\((.*)\))?\s*$/.exec(lines[i])
    if (!m) continue
    const tip = /^\s*⎿\s+(Tip:.*)$/.exec(lines[i + 1] ?? '')?.[1] ?? ''
    return { label: m[2], detail: m[3] ?? '', tip }
  }
  return null
}

// Todo lo que la CLI dibuja en vivo y no está en el transcript:
// - lines: lo que hay entre la línea de actividad y la caja del prompt (lista de tareas, subagentes, tareas en
//   segundo plano, progreso de herramientas), sin el tip ni los mensajes encolados.
// - footer: la barra de estado debajo del prompt (modo de permisos, tareas en segundo plano, avisos).
export interface Live {
  lines: string[]
  footer: string[]
}

const ACTIVITY = /^([^\s\w❯⎿─│])\s+(\S[^(]*?…)\s*(?:\((.*)\))?\s*$/

export function readLive(id: string): Live | null {
  const lines = screenLines(id)
  let p = -1
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].startsWith('❯') && RULE.test(lines[i - 1])) {
      p = i
      break
    }
  }
  if (p < 0) return null
  // Barra de estado: después de la línea que cierra la caja del prompt.
  let close = p + 1
  while (close < lines.length && !RULE.test(lines[close])) close++
  const footer = lines
    .slice(close + 1)
    .map((l) => l.trim())
    .filter((l) => l && !/^\? for shortcuts$/.test(l))
  // Zona en vivo: desde la línea de actividad hasta la caja del prompt.
  let a = -1
  for (let i = p - 2; i >= 0; i--) {
    if (ACTIVITY.test(lines[i])) {
      a = i
      break
    }
  }
  const out: string[] = []
  if (a >= 0) {
    const region = lines.slice(a + 1, p - 1)
    for (let i = 0; i < region.length; i++) {
      const l = region[i]
      if (/^\s*⎿\s+Tip:/.test(l)) continue
      // Mensaje encolado: "❯ texto" (más líneas) seguido de "⎿ Queued"; ya se muestra aparte.
      if (l.startsWith('❯')) {
        let j = i + 1
        while (j < region.length && !/^\s*⎿\s+Queued\b/.test(region[j]) && !region[j].startsWith('❯')) j++
        if (j < region.length && /^\s*⎿\s+Queued\b/.test(region[j])) {
          i = j
          continue
        }
      }
      out.push(l.trimEnd())
    }
    while (out.length && !out[0].trim()) out.shift()
    while (out.length && !out[out.length - 1].trim()) out.pop()
    const pad = Math.min(...out.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99)
    if (pad && pad < 99) for (let i = 0; i < out.length; i++) out[i] = out[i].slice(pad)
  }
  return { lines: out, footer }
}
