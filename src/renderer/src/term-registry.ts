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

// Fila de la pantalla con su estilo, para mostrar los paneles de Claude Code (/usage, /config…) con sus colores.
export interface Run {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

const ANSI16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']

function palette(i: number): string {
  if (i < 16) return ANSI16[i]
  if (i < 232) {
    const n = i - 16
    const c = (v: number) => (v ? 55 + v * 40 : 0)
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`
  }
  const g = 8 + (i - 232) * 10
  return `rgb(${g},${g},${g})`
}

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')

export function screenRuns(id: string, y0: number, y1: number): Run[][] {
  const term = terms.get(id)
  if (!term) return []
  const buf = term.buffer.active
  const cell = buf.getNullCell()
  const rows: Run[][] = []
  for (let y = y0; y < Math.min(y1, term.rows); y++) {
    const line = buf.getLine(buf.viewportY + y)
    const runs: Run[] = []
    if (line) {
      let cur: Run | null = null
      let key = ''
      for (let x = 0; x < line.length; x++) {
        line.getCell(x, cell)
        if (cell.getWidth() === 0) continue
        const fg = cell.isFgRGB() ? hex(cell.getFgColor()) : cell.isFgPalette() ? palette(cell.getFgColor()) : undefined
        const bg = cell.isBgRGB() ? hex(cell.getBgColor()) : cell.isBgPalette() ? palette(cell.getBgColor()) : undefined
        const st: Omit<Run, 'text'> = {}
        if (fg) st.fg = fg
        if (bg) st.bg = bg
        if (cell.isBold()) st.bold = true
        if (cell.isDim()) st.dim = true
        if (cell.isItalic()) st.italic = true
        if (cell.isUnderline()) st.underline = true
        if (cell.isInverse()) st.inverse = true
        const k = JSON.stringify(st)
        const ch = cell.getChars() || ' '
        if (cur && k === key) cur.text += ch
        else {
          cur = { text: ch, ...st }
          key = k
          runs.push(cur)
        }
      }
      // Sin el relleno de espacios sin estilo del final.
      while (runs.length && !runs[runs.length - 1].bg && !runs[runs.length - 1].inverse && !runs[runs.length - 1].text.trim()) runs.pop()
      if (runs.length && !runs[runs.length - 1].bg && !runs[runs.length - 1].inverse) runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd()
    }
    rows.push(runs)
  }
  return rows
}

// Fila donde está el cursor de la terminal. En los paneles, Claude Code lo deja en el elemento enfocado (la fila
// con "❯" o el buscador), así que sirve para saber dónde está la selección.
export function cursorRow(id: string): number | null {
  const term = terms.get(id)
  if (!term) return null
  return term.buffer.active.cursorY
}

// Espera la próxima escritura en la pantalla (o el tiempo máximo).
export function nextWrite(id: string, ms = 250): Promise<void> {
  return new Promise((resolve) => {
    let off = () => {}
    const t = setTimeout(() => {
      off()
      resolve()
    }, ms)
    off = onScreen(id, () => {
      clearTimeout(t)
      off()
      // Un frame de Claude Code puede llegar en varias escrituras.
      setTimeout(resolve, 30)
    })
  })
}
