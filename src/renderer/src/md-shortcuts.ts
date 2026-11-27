// Atajos de formato del editor de fuente (Source), los mismos que tiene el modo Visual (TipTap):
//   Ctrl+B negrita · Ctrl+I cursiva · Ctrl+E código · Ctrl+Shift+X tachado · Ctrl+K link.
// Si la selección ya tiene ese formato (las marcas adentro o justo afuera), se lo saca.

export interface Edit {
  // Rango del texto que se reemplaza y por qué.
  from: number
  to: number
  insert: string
  // Selección después del cambio.
  selStart: number
  selEnd: number
}

const MARKS: Record<string, string> = { b: '**', i: '*', e: '`', x: '~~' }

export function shortcutFor(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): string | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (e.shiftKey) return k === 'x' ? 'x' : null
  return k === 'b' || k === 'i' || k === 'e' || k === 'k' ? k : null
}

export function applyShortcut(kind: string, text: string, start: number, end: number): Edit | null {
  const sel = text.slice(start, end)
  if (kind === 'k') {
    // [texto](url) con "url" seleccionado para escribirla; si lo seleccionado ya es una URL, va de destino.
    if (/^https?:\/\/\S+$/.test(sel)) {
      const insert = `[](${sel})`
      return { from: start, to: end, insert, selStart: start + 1, selEnd: start + 1 }
    }
    const label = sel || 'text'
    const insert = `[${label}](url)`
    const u = start + label.length + 3
    return { from: start, to: end, insert, selStart: sel ? u : start + 1, selEnd: sel ? u + 3 : start + 1 + label.length }
  }
  const m = MARKS[kind]
  if (!m) return null
  // Ya tiene el formato: las marcas rodean la selección por fuera…
  if (text.slice(start - m.length, start) === m && text.slice(end, end + m.length) === m && !(m === '*' && text.slice(start - 2, start) === '**' && text.slice(start - 3, start) !== '***')) {
    return { from: start - m.length, to: end + m.length, insert: sel, selStart: start - m.length, selEnd: end - m.length }
  }
  // …o están dentro de ella.
  if (sel.length >= 2 * m.length && sel.startsWith(m) && sel.endsWith(m) && !(m === '*' && sel.startsWith('**') && !sel.startsWith('***'))) {
    const inner = sel.slice(m.length, sel.length - m.length)
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length }
  }
  const insert = m + sel + m
  return { from: start, to: end, insert, selStart: start + m.length, selEnd: start + m.length + sel.length }
}
