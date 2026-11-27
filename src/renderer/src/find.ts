// Búsqueda de texto (Ctrl+F) dentro de una parte de la ventana: la conversación, la vista de un .md o el editor
// visual. Las coincidencias se pintan con la API de resaltado de CSS (CSS.highlights + ::highlight()), que no
// toca el DOM: no interfiere con React ni con ProseMirror.

// Textos que no se buscan: el propio buscador y los campos de texto (el editor de fuente se busca aparte).
const SKIP = '.find-bar, textarea, input, script, style'

// Rangos de cada coincidencia (sin distinguir mayúsculas). Una coincidencia puede cruzar elementos en línea
// (`código`, **negrita**). Solo cuenta lo que se ve: el texto dentro de un bloque plegado no tiene cajas.
export function findRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const nodes: Text[] = []
  const starts: number[] = []
  let all = ''
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    nodes.push(n)
    starts.push(all.length)
    all += n.data
  }
  const hay = all.toLowerCase()
  const q = query.toLowerCase()
  const out: Range[] = []
  // Nodo que contiene la posición `pos` (búsqueda binaria sobre los comienzos).
  const at = (pos: number, end: boolean) => {
    let lo = 0
    let hi = nodes.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] < pos || (!end && starts[mid] === pos)) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
    const a = at(i, false)
    const b = at(i + q.length, true)
    const r = document.createRange()
    r.setStart(nodes[a], i - starts[a])
    r.setEnd(nodes[b], i + q.length - starts[b])
    if (r.getClientRects().length) out.push(r)
  }
  return out
}

// Posiciones de cada coincidencia en un texto plano (el editor de fuente).
export function findInText(text: string, query: string): number[] {
  if (!query) return []
  const hay = text.toLowerCase()
  const q = query.toLowerCase()
  const out: number[] = []
  for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) out.push(i)
  return out
}

type Registry = { set(name: string, h: unknown): void; delete(name: string): void }
type HighlightCtor = new (...ranges: Range[]) => unknown
const registry = (): Registry | null => (globalThis.CSS as unknown as { highlights?: Registry }).highlights ?? null
const Highlight = (): HighlightCtor | null => (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight ?? null

// Pinta las coincidencias (`find-match`) y la actual (`find-current`). El registro es global: un solo buscador
// abierto a la vez.
export function paint(ranges: Range[], current: number): void {
  const reg = registry()
  const H = Highlight()
  if (!reg || !H) return
  reg.set('find-match', new H(...ranges))
  if (ranges[current]) reg.set('find-current', new H(ranges[current]))
  else reg.delete('find-current')
}

export function clearPaint(): void {
  const reg = registry()
  reg?.delete('find-match')
  reg?.delete('find-current')
}

// Lleva la coincidencia al centro de la parte visible de su contenedor con scroll.
export function scrollToRange(r: Range): void {
  const el = r.startContainer.parentElement
  if (!el) return
  let box: HTMLElement | null = el
  while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement
  if (!box) return
  const rect = r.getBoundingClientRect()
  const outer = box.getBoundingClientRect()
  box.scrollTop += rect.top - outer.top - box.clientHeight / 2 + rect.height / 2
}
