import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

// Markdown → HTML saneado con DOMPurify (Rendered y visor de documentos); los bloques ```html se muestran además como vista previa en un iframe aislado
// (sandbox sin scripts) para que sus estilos no afecten a la app.

const md = new Marked({ gfm: true, breaks: false })
md.use({
  renderer: {
    code(token) {
      if ((token.lang ?? '').toLowerCase() !== 'html' || !token.text.trim()) return false
      const src = encodeURIComponent(token.text)
      const code = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<div class="html-preview" data-src="${src}"></div><details class="html-source"><summary>HTML source</summary><pre><code>${code}</code></pre></details>`
    }
  }
})

function toHtml(markdown: string): string {
  const raw = md.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(raw, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'], ADD_ATTR: ['data-src'] })
}

// Monta las vistas previas HTML dentro de iframes aislados y ajusta su alto al contenido.
function mountPreviews(root: HTMLElement): void {
  root.querySelectorAll<HTMLDivElement>('.html-preview[data-src]').forEach((el) => {
    if (el.querySelector('iframe')) return
    const frame = document.createElement('iframe')
    // allow-same-origin sin allow-scripts: el HTML no puede ejecutar nada, pero se puede medir su alto.
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.srcdoc =
      // Tema oscuro forzado (fondos y textos) para que todo combine con la app, aunque el HTML traiga los suyos.
      // El <style> va al final para ganarle a los estilos del propio HTML.
      '<!doctype html><meta charset="utf-8">' +
      decodeURIComponent(el.dataset.src ?? '') +
      '<style>:root{color-scheme:dark}html,body{background:#0f0f11!important;overflow:hidden}' +
      'body{margin:8px;font:13px system-ui,sans-serif}' +
      '*{background-color:transparent!important;color:#e9ebed!important;border-color:#414141!important;box-shadow:none!important}' +
      'a,a *{color:#42b4ff!important}th,thead td{background-color:#242424!important}' +
      'table{border-collapse:collapse}td,th{border:1px solid #414141;padding:4px 8px}</style>'
    frame.onload = () => {
      // Con alto 0 el scrollHeight es el del contenido (si no, nunca baja del alto actual del iframe).
      frame.style.height = '0px'
      const h = frame.contentDocument?.documentElement.scrollHeight ?? 200
      frame.style.height = Math.min(Math.max(h, 40), 900) + 'px'
    }
    el.appendChild(frame)
  })
}

// Aparición en cascada (como en la CLI): el texto se revela de a palabras. Los mensajes cortos van a ritmo
// fijo; los largos se aceleran para terminar en ~2 s. Si el texto crece (otro bloque de la misma respuesta),
// sigue desde donde iba. Sin animación con "reducir movimiento".
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const TICK = 20
function useReveal(text: string, on: boolean): string {
  const parts = useMemo(() => text.split(/(\s+)/), [text])
  const [n, setN] = useState(on && !REDUCED ? 0 : Infinity)
  useEffect(() => {
    if (n >= parts.length) return
    const step = Math.max(1, Math.ceil(parts.length / (2000 / TICK)))
    const t = setTimeout(() => setN((v) => Math.min(parts.length, v + step)), TICK)
    return () => clearTimeout(t)
  }, [n, parts.length])
  return n >= parts.length ? text : parts.slice(0, n).join('')
}

export const Markdown = memo(function Markdown({ text, stream = false }: { text: string; stream?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const shown = useReveal(text, stream)
  const done = shown === text
  const html = useMemo(() => toHtml(shown), [shown])
  // Las vistas previas HTML se montan al terminar (con el bloque completo).
  useLayoutEffect(() => {
    if (ref.current && done) mountPreviews(ref.current)
  }, [html, done])
  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />
})

