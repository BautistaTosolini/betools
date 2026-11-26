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

// Formulario de un servidor MCP (elicitation): campos que se recorren con ↑/↓ y botones Accept/Decline.
export interface FormChoice {
  label: string
  cursor: boolean
  on: boolean
}

export interface FormField {
  label: string
  value: string // '' si no tiene valor
  status: 'required' | 'done' | 'error' | ''
  focused: boolean
  expanded: boolean
  kind: 'choice' | 'bool' | 'text' | 'unknown' // solo se sabe con certeza en el campo enfocado
  desc: string[]
  choices: FormChoice[]
}

export interface Form {
  fields: FormField[]
  button: 'accept' | 'decline' | null // botón enfocado; null si el foco está en un campo
}

export interface Menu {
  header: string[]
  options: MenuOption[]
  hint: string
  form?: Form
}

const RULE = /^\s*[─━═]{8,}/
const HINT = /(Enter to (select|confirm|submit|continue)|Esc to (cancel|exit|go back)|↑\/↓|to navigate)/i
// "❯ 1. texto", con la casilla de selección múltiple antes ("[x] 1.") o después ("1. [x]") del número.
const OPTION = /^(\s*)(?:([❯›>])\s*)?(?:\[([ x✓✔])\]\s*)?(\d{1,2})[.)]\s+(?:\[([ x✓✔])\]\s*)?(.*\S)\s*$/
// Fin del diálogo hacia arriba: tu prompt, una respuesta o herramienta de Claude, o la marca de "terminó".
const ABOVE = /^(❯\s(?!\s*\d{1,2}[.)]\s)|[●⏺✻✶✳✢·]\s)/

const BUTTONS = /^(\s*)(❯\s+)?Accept\s+(❯\s+)?Decline\s*$/
// Campo, relativo a la sangría del diálogo: "❯ * Decision: ▸ not set" (cursor, estado, título, valor).
const FIELD = /^([❯ ]) ([*✔✓⚠ ]) (\S.*?):(?: (.*))?$/
const UNNUMBERED = /^\s*❯ \S/
const CHOICE = /^\s*([❯ ]) ([◯◉☐☒]) (.*)$/
const EMPTY = /^(not set|Type something…)$/

// Formato de la TUI (Claude Code 2.1.x):
//   ❯ * Decision: ▾                       ← campo enfocado y desplegado
//         ❯ ◯ Approve                     ← opciones (◯/◉ única, ☐/☒ múltiple)
//         Approve or reject this…         ← descripción
//     ✔ Confirm: ☒
//     Accept    Decline                   ← "❯ Accept" cuando el foco está en los botones
function parseForm(region: string[]): { header: string[]; form: Form } | null {
  const bi = region.findIndex((l) => BUTTONS.test(l))
  if (bi < 0) return null
  const bm = BUTTONS.exec(region[bi])!
  const ind = bm[2] ? bm[1].length : Math.max(0, bm[1].length - 2)
  const isField = (l: string) => !l.slice(0, ind).trim() && FIELD.test(l.slice(ind))
  let first = region.findIndex((l, i) => i < bi && isField(l))
  if (first < 0) first = bi
  let header = region.slice(0, first)
  const rule = header.map((l) => RULE.test(l)).lastIndexOf(true)
  header = header.slice(rule + 1)

  const fields: FormField[] = []
  for (const line of region.slice(first, bi)) {
    if (!line.trim()) continue
    const c = CHOICE.exec(line)
    const cur = fields[fields.length - 1]
    if (c && cur) {
      cur.choices.push({ label: c[3].trim(), cursor: c[1] === '❯', on: c[2] === '◉' || c[2] === '☒' })
      continue
    }
    if (isField(line)) {
      const m = FIELD.exec(line.slice(ind))!
      const raw = (m[4] ?? '').trim()
      const focused = m[1] === '❯'
      const arrow = /^[▸▾]/.test(raw)
      const value = raw.replace(/^[▸▾]\s*/, '')
      fields.push({
        label: m[3],
        value: EMPTY.test(value) ? '' : value,
        status: m[2] === '*' ? 'required' : m[2] === '⚠' ? 'error' : m[2] === ' ' ? '' : 'done',
        focused,
        expanded: raw.startsWith('▾'),
        kind: arrow ? 'choice' : /^[☐☒]$/.test(value) ? 'bool' : focused ? 'text' : 'unknown',
        desc: [],
        choices: []
      })
      continue
    }
    // Indicadores de desplazamiento ("↑ 3 more") y descripciones.
    if (cur && !/^\s*[↑↓]\s/.test(line)) cur.desc.push(line.trim())
  }
  if (!fields.length) return null
  const button = bm[2] ? 'accept' : bm[3] ? 'decline' : null
  const pad = Math.min(...header.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99)
  return { header: header.map((l) => l.slice(pad === 99 ? 0 : pad).trimEnd()), form: { fields, button } }
}

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
  const f = parseForm(region)
  if (f) return { header: f.header, options: [], hint, form: f.form }
  // Lo que está arriba de la última línea divisoria que tiene opciones debajo es conversación (p. ej. un mensaje
  // tuyo que empieza con "1."), no el diálogo.
  for (let r = region.length - 1; r >= 0; r--) {
    if (RULE.test(region[r]) && region.slice(r + 1).some((l) => OPTION.test(l))) {
      region.splice(0, r + 1)
      break
    }
  }

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
        label: m[6],
        detail: [],
        selected: !!m[2],
        checked: (m[3] ?? m[5]) === undefined ? null : (m[3] ?? m[5]) !== ' '
      })
      continue
    }
    if (!line.trim()) continue
    const last = options[options.length - 1]
    // Descripción de la opción anterior: más indentada que el número.
    if (last && line.length - line.trimStart().length > optIndent) last.detail.push(line.trim())
    else if (!options.length) header.push(line.trimEnd())
  }
  // Opciones sin número (p. ej. "New MCP server found"): la línea con el cursor "❯" y las vecinas que empiezan en
  // la misma columna de texto.
  if (!options.length) {
    const ci = region.findIndex((l) => UNNUMBERED.test(l))
    if (ci >= 0) {
      const col = region[ci].indexOf('❯') + 2
      const at = (l: string) => l.length > col && !l.slice(0, col).replace('❯', ' ').trim() && l[col] !== ' '
      let a = ci
      while (a > 0 && at(region[a - 1])) a--
      let b = ci
      while (b + 1 < region.length && at(region[b + 1])) b++
      if (b > a) {
        const list = region.slice(a, b + 1)
        list.forEach((l, i) => options.push({ n: i + 1, label: l.slice(col).trim(), detail: [], selected: l.includes('❯'), checked: null }))
        // El encabezado es lo que está antes de la lista (sin la conversación, cortada por la línea divisoria).
        header.length = 0
        for (const l of region.slice(0, a)) {
          if (RULE.test(l)) header.length = 0
          else if (l.trim()) header.push(l.trimEnd())
        }
      }
    }
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
