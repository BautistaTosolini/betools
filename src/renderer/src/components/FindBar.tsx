import { useEffect, useRef, useState } from 'react'
import { clearPaint, findInText, findRanges, paint, scrollToRange } from '../find'

// Barra de búsqueda (Ctrl+F) de una vista: Enter siguiente, Shift+Enter anterior, Esc cierra.
// - root: lo que se busca (la conversación, la vista del .md o el editor visual).
// - source: en el modo Source, el editor de fuente. Las coincidencias se recorren ahí (pintadas en `mirror`, un
//   calco del textarea detrás de él) y en la vista previa (root) solo se marcan.
// Se vuelve a buscar cuando cambia el contenido (Claude escribiendo, ediciones), sin mover el scroll: el scroll
// solo se mueve al escribir la búsqueda o al pasar de coincidencia.
export function FindBar({
  root,
  source,
  mirror,
  onClose,
  focusKey,
  remember
}: {
  root: () => HTMLElement | null
  source?: () => HTMLTextAreaElement | null
  mirror?: () => HTMLDivElement | null
  onClose(): void
  // Cambia en cada Ctrl+F: vuelve a enfocar y seleccionar la búsqueda si la barra ya estaba abierta.
  focusKey: number
  // Guarda la búsqueda para la próxima barra de la misma vista (p. ej. al pasar de ver a editar).
  remember?: { current: string }
}) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(() => {
    const sel = window.getSelection()?.toString().trim() ?? ''
    return sel && !sel.includes('\n') ? sel : (remember?.current ?? '')
  })
  if (remember) remember.current = query
  const [count, setCount] = useState(0)
  const [cur, setCur] = useState(0)
  // Estado que leen los listeners sin volver a registrarse.
  const st = useRef({ ranges: [] as Range[], hits: [] as number[], cur: 0, query })
  st.current.query = query

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusKey])

  const ta = () => (source ? source() : null)

  // Busca de nuevo y pinta. `scroll`: llevar la actual a la vista.
  const run = (next: number | null, scroll: boolean) => {
    const s = st.current
    const r = root()
    const t = ta()
    s.ranges = r ? findRanges(r, s.query) : []
    s.hits = t ? findInText(t.value, s.query) : []
    const n = t ? s.hits.length : s.ranges.length
    s.cur = n === 0 ? 0 : Math.min(Math.max(next ?? s.cur, 0), n - 1)
    setCount(n)
    setCur(s.cur)
    if (t) {
      paint(s.ranges, -1)
      paintSource(t, mirror?.(), s.query, s.hits, s.cur, scroll)
    } else {
      paint(s.ranges, s.cur)
      if (scroll && s.ranges[s.cur]) scrollToRange(s.ranges[s.cur])
    }
  }

  // Al escribir la búsqueda: desde la primera coincidencia.
  useEffect(() => {
    run(0, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // El contenido cambia (mensajes nuevos, ediciones): se vuelve a buscar sin mover el scroll.
  useEffect(() => {
    const r = root()
    const t = ta()
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(() => run(null, false), 150)
    }
    const mo = new MutationObserver(later)
    if (r) mo.observe(r, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'class'] })
    // Desplegar un bloque (<details>) cambia qué se ve.
    r?.addEventListener('toggle', later, true)
    t?.addEventListener('input', later)
    const sync = () => {
      const m = mirror?.()
      if (m && t) m.scrollTop = t.scrollTop
    }
    t?.addEventListener('scroll', sync)
    return () => {
      clearTimeout(timer)
      mo.disconnect()
      r?.removeEventListener('toggle', later, true)
      t?.removeEventListener('input', later)
      t?.removeEventListener('scroll', sync)
      clearPaint()
      const m = mirror?.()
      if (m) m.innerHTML = ''
      t?.classList.remove('finding')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const step = (d: number) => {
    const n = count
    if (!n) return
    run((st.current.cur + d + n) % n, true)
  }

  const close = () => {
    // En el editor de fuente, la coincidencia actual queda seleccionada para seguir editando ahí.
    const t = ta()
    const s = st.current
    onClose()
    if (t && s.hits.length) {
      const at = s.hits[s.cur]
      t.focus()
      t.setSelectionRange(at, at + s.query.length)
    }
  }

  return (
    <div className="find-bar" role="search">
      <input
        ref={input}
        value={query}
        placeholder="Find"
        aria-label="Find"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      />
      <span className="find-count">{query ? (count ? `${cur + 1}/${count}` : 'No results') : ''}</span>
      <button className="icon-btn" title="Previous (Shift+Enter)" disabled={!count} onClick={() => step(-1)}>
        ↑
      </button>
      <button className="icon-btn" title="Next (Enter)" disabled={!count} onClick={() => step(1)}>
        ↓
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  )
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Pinta las coincidencias del editor de fuente en su calco (mismo texto, misma tipografía y ancho, detrás del
// textarea transparente) y lleva la actual al centro.
function paintSource(t: HTMLTextAreaElement, m: HTMLDivElement | null | undefined, q: string, hits: number[], cur: number, scroll: boolean) {
  if (!m) return
  t.classList.toggle('finding', hits.length > 0)
  let html = ''
  let last = 0
  hits.forEach((at, i) => {
    html += esc(t.value.slice(last, at)) + `<mark class="find-hit${i === cur ? ' cur' : ''}">${esc(t.value.slice(at, at + q.length))}</mark>`
    last = at + q.length
  })
  // Un salto al final para que la última línea vacía ocupe su lugar, como en el textarea.
  m.innerHTML = html + esc(t.value.slice(last)) + '\n'
  m.style.width = `${t.clientWidth}px`
  const mark = m.querySelector<HTMLElement>('mark.cur')
  if (scroll && mark) t.scrollTop = mark.offsetTop - t.clientHeight / 2
  m.scrollTop = t.scrollTop
}
