// Interfaz de los paneles de Claude Code (/usage, /status, /config, /mcp, /hooks, /memory, /permissions…):
// las filas de texto de la terminal se clasifican en bloques (título, barra de uso, dato, elemento de lista,
// buscador…) para dibujarlos como interfaz. Cada bloque conserva su fila (`row`, dentro de panel.lines) para
// que un clic mueva el cursor del panel ahí, como en la terminal.

export type ItemIcon = 'ok' | 'warn' | 'error' | 'pending' | 'link' | null

export type Block =
  | { kind: 'heading'; row: number; text: string; note?: string }
  | { kind: 'text'; row: number; text: string; muted: boolean }
  | { kind: 'pair'; row: number; left: string; right: string }
  | { kind: 'kv'; row: number; key: string; value: string }
  | { kind: 'bar'; row: number; label: string; pct: number; text: string; note?: string }
  | { kind: 'item'; row: number; cursor: boolean; icon: ItemIcon; name: string; value: string; on?: boolean }
  | { kind: 'search'; row: number; text: string }
  | { kind: 'more'; row: number; text: string }
  | { kind: 'art'; row: number; lines: string[] }
  | { kind: 'gap'; row: number }

// Partes de la barra de Claude Code: bloques llenos y fracciones (█▉▊▋▌▍▎▏).
const BAR = /^\s*([█▉▊▋▌▍▎▏]*)\s*(\d{1,3})% used\s*$/
const KV = /^\s{1,3}([A-Za-z][^:]{0,38}):\s{2,}(\S.*)$/
const ICONS: Record<string, ItemIcon> = { '✔': 'ok', '✓': 'ok', '⚠': 'warn', '✘': 'error', '✗': 'error', '…': 'pending', '→': 'link', '›': 'link' }
// Gráficos hechos con caracteres (el calendario de /stats).
const ART = /[░▒▓█·]{6,}/
const isArt = (l: string) => ART.test(l) && !/[A-Za-z]{3,}.*[A-Za-z]{3,}/.test(l.replace(/^\s*(Mon|Wed|Fri)\s/, ''))
// Último bloque (sin contar los espacios) si es de ese tipo.
function lastOfKind<K extends Block['kind']>(out: Block[], kind: K): Extract<Block, { kind: K }> | null {
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].kind === 'gap') continue
    return out[i].kind === kind ? (out[i] as Extract<Block, { kind: K }>) : null
  }
  return null
}
const MORE = /^\s*[↓↑] \d+ more\s*$/

const indentOf = (l: string) => /^ */.exec(l)![0].length
// Ayuda de teclas al pie ("←/→ to switch · Esc to close"); algunas no las reconoce el parser de diálogos.
const HINT_LINE = /\b(Esc|Enter) to \w+/

// Ayuda de teclas del panel: la que encontró el parser o la última fila si es una ayuda.
export function panelHint(lines: string[], hint: string): string {
  if (hint) return hint
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  const last = lines[end - 1]?.trim() ?? ''
  return HINT_LINE.test(last) && last.includes('·') ? last : ''
}
// Columnas separadas por 2 o más espacios.
const split2 = (s: string) => s.trim().split(/\s{2,}/)

// `bold[i]`: la fila i está en negrita en la terminal (los títulos de sección).
export function panelBlocks(lines: string[], o: { tabsRow?: number; hint?: string; bold?: boolean[] } = {}): Block[] {
  const out: Block[] = []
  const bold = o.bold ?? []
  // El último renglón con la ayuda de teclas se muestra aparte (botones).
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  const hint = panelHint(lines, o.hint ?? '')
  if (hint && end > 0 && lines[end - 1].trim() === hint) end--

  for (let row = 0; row < end; row++) {
    const line = lines[row]
    if (row === o.tabsRow) continue
    if (!line.trim()) {
      if (out.length && out[out.length - 1].kind !== 'gap') out.push({ kind: 'gap', row })
      continue
    }
    // Caja del buscador: ╭──╮ │ ⌕ Search… │ ╰──╯
    if (/^\s*[╭╰]─/.test(line)) continue
    const box = /^\s*│\s?(.*?)\s*│\s*$/.exec(line)
    if (box) {
      out.push({ kind: 'search', row, text: box[1].replace(/^⌕\s*/, '') })
      continue
    }
    // Indicador de scroll suelto (una flecha a la derecha).
    if (/^\s*[↓↑]\s*$/.test(line)) continue
    if (MORE.test(line)) {
      out.push({ kind: 'more', row, text: line.trim() })
      continue
    }
    const bar = BAR.exec(line)
    if (bar) {
      // El título va en la fila anterior y el reinicio ("Resets …"), en la siguiente.
      const prev = out[out.length - 1]
      const label = prev && prev.kind === 'heading' && prev.row === row - 1 ? (out.pop() as { text: string }).text : ''
      const next = lines[row + 1]?.trim() ?? ''
      const note = /^Resets\b/.test(next) ? next : undefined
      out.push({ kind: 'bar', row, label, pct: Math.min(100, Number(bar[2])), text: `${bar[2]}% used`, note })
      if (note) row++
      continue
    }
    // Gráfico hecho con caracteres (/stats), con su encabezado (meses) y su leyenda ("Less ░ ▒ ▓ █ More").
    const lastArt = lastOfKind(out, 'art')
    const legend = !!lastArt && /[░▒▓]/.test(line) && !isArt(line)
    if (isArt(line) || legend || (isArt(lines[row + 1] ?? '') && indentOf(line) >= 4 && !/[❯│]/.test(line))) {
      const text = line.replace(/\s+$/, '')
      if (lastArt) {
        while (out[out.length - 1].kind === 'gap') out.pop()
        lastArt.lines.push(...(legend ? ['', text] : [text]))
      } else out.push({ kind: 'art', row, lines: [text] })
      continue
    }
    const ind = indentOf(line)
    const cursor = /^\s*❯ /.test(line)
    // Continuación de una fila larga que la terminal partió en dos: se une a la anterior.
    const last = out[out.length - 1]
    if (!cursor && ind >= 5 && last && (last.kind === 'pair' || last.kind === 'text') && last.row === row - 1) {
      if (last.kind === 'pair') last.right += ' ' + line.trim()
      else last.text += ' ' + line.trim()
      last.row = row
      continue
    }
    // Elemento de lista: con el cursor (❯) o con más sangría que el texto del panel.
    if (cursor || ind >= 4) {
      let rest = line.replace(/^\s*(❯ )?/, '')
      const icon = ICONS[rest[0]] ?? null
      if (icon) rest = rest.slice(1).trimStart()
      const [name, ...vals] = split2(rest)
      const value = vals.join('  ')
      const item: Block = { kind: 'item', row, cursor, icon, name, value }
      if (value === 'on' || value === 'off') item.on = value === 'on'
      // Continuación de un valor largo (p. ej. una ruta que sigue en la fila siguiente): se une al dato.
      const prev = out[out.length - 1]
      if (!cursor && prev?.kind === 'kv' && prev.row === row - 1 && ind > 20) {
        prev.value += line.trim()
        continue
      }
      out.push(item)
      continue
    }
    const kv = KV.exec(line)
    if (kv) {
      out.push({ kind: 'kv', row, key: kv[1].trim(), value: kv[2].trim() })
      continue
    }
    const cols = split2(line)
    if (bold[row] || isHeading(lines, row, cols)) {
      out.push({ kind: 'heading', row, text: cols[0], note: cols.slice(1).join('  ') || undefined })
      continue
    }
    if (cols.length >= 2 && cols[0].length < 60) {
      out.push({ kind: 'pair', row, left: cols[0], right: cols.slice(1).join('  ') })
      continue
    }
    // Texto que sigue en la fila siguiente (más sangría): se une al anterior.
    const prev = out[out.length - 1]
    if (prev?.kind === 'text' && prev.row === row - 1 && ind > 2) {
      prev.text += ' ' + line.trim()
      prev.row = row
      continue
    }
    out.push({ kind: 'text', row, text: line.trim(), muted: /^(Learn more|Approximate|Docs:)/.test(line.trim()) })
  }
  while (out.length && out[out.length - 1].kind === 'gap') out.pop()
  return out
}

// Título de sección: una frase corta sin punto final, seguida de una barra, datos o una lista.
function isHeading(lines: string[], row: number, cols: string[]): boolean {
  const t = cols[0]
  if (cols.length > 2 || t.length > 48 || /[.:]$/.test(t) || /^\d/.test(t)) return false
  let n = row + 1
  while (n < lines.length && !lines[n].trim()) n++
  const next = lines[n] ?? ''
  if (BAR.test(next)) return true
  // Título del panel: primera fila de texto, antes de una descripción o lista.
  const before = lines.slice(0, row).filter((l) => l.trim()).length
  return before <= 1 && /^[A-Z]/.test(t) && cols.length === 1
}
