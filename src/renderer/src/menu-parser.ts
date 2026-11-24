// Detecta en la pantalla de Claude Code un diálogo interactivo (permiso, AskUserQuestion, selectores de
// slash commands, plan mode…) para mostrarlo como botones en la pestaña Rendered. El formato es el de la
// TUI de Claude Code y puede cambiar: si no se reconoce, se muestra el texto del diálogo con teclas genéricas.

export interface MenuOption {
  n: number
  label: string
  detail: string[]
  selected: boolean
  checked: boolean | null // multiselección: [x] / [ ]
}

export interface Menu {
  header: string[]
  options: MenuOption[]
  hint: string
}

const RULE = /^\s*[─━═]{8,}/
const HINT = /(Enter to (select|confirm|submit|continue)|Esc to (cancel|exit|go back)|↑\/↓|to navigate)/i
const OPTION = /^(\s*)(?:([❯›>])\s*)?(?:\[([ x✓✔])\]\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/
// Fin del diálogo hacia arriba: tu prompt, una respuesta o herramienta de Claude, o la marca de "terminó".
const ABOVE = /^(❯\s(?!\s*\d{1,2}[.)]\s)|[●⏺✻✶✳✢·]\s)/

export function parseMenu(lines: string[]): Menu | null {
  let end = lines.length - 1
  while (end >= 0 && !lines[end].trim()) end--
  let hintIdx = -1
  for (let i = end; i >= Math.max(0, end - 6); i--) {
    if (HINT.test(lines[i])) {
      hintIdx = i
      break
    }
  }
  let hint = hintIdx >= 0 ? lines[hintIdx].trim() : ''
  if (hintIdx < 0) {
    // Sin línea de ayuda (p. ej. "Review your answers" de AskUserQuestion): alcanza con un cursor "❯ N."
    // entre las últimas líneas y al menos dos opciones.
    let last = end
    while (last >= 0 && (!lines[last].trim() || RULE.test(lines[last]))) last--
    const tail = lines.slice(Math.max(0, last - 14), last + 1)
    const opts = tail.filter((l) => OPTION.test(l))
    if (opts.length < 2 || !opts.some((l) => OPTION.exec(l)?.[2])) return null
    hintIdx = last + 1
    hint = ''
  }

  let start = hintIdx - 1
  while (start >= 0 && !ABOVE.test(lines[start])) start--
  const region = lines.slice(start + 1, hintIdx)

  const header: string[] = []
  const options: MenuOption[] = []
  let optIndent = -1
  for (const line of region) {
    if (RULE.test(line)) {
      // Lo que está arriba de la primera línea divisoria es la conversación, no el diálogo.
      if (!options.length) header.length = 0
      continue
    }
    const m = OPTION.exec(line)
    if (m) {
      optIndent = m[1].length + (m[2] ? 2 : 0)
      options.push({
        n: Number(m[4]),
        label: m[5],
        detail: [],
        selected: !!m[2],
        checked: m[3] === undefined ? null : m[3] !== ' '
      })
      continue
    }
    if (!line.trim()) continue
    const last = options[options.length - 1]
    // Descripción de la opción anterior: más indentada que el número.
    if (last && line.length - line.trimStart().length > optIndent) last.detail.push(line.trim())
    else if (!options.length) header.push(line.trimEnd())
  }
  if (!options.length && !header.length) return null
  // Se recorta la sangría común del encabezado.
  const pad = Math.min(...header.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99)
  return { header: header.map((l) => l.slice(pad === 99 ? 0 : pad)), options, hint }
}

export const KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  space: ' '
} as const
