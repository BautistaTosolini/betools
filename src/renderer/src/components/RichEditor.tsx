import { useEffect, useRef } from 'react'
import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import { mergeMarkdown, richUnsupported, splitFrontMatter, type Canon } from '../md-merge'
import { makeRich, richExtensions } from '../rich-schema'

// Edición visual del .md sobre la vista renderizada (como Notion). Se carga con import() solo al editar.
// `base` es el Markdown que se carga; cada cambio se informa como Markdown completo, con los bloques no tocados
// idénticos al original (md-merge). Para recargar desde afuera (cambio en disco, cambio de modo), el componente
// se vuelve a montar con otra key.
export default function RichEditor({
  base,
  path,
  onChange,
  onUnsupported,
  flushRef
}: {
  base: string
  path: string
  onChange(md: string): void
  onUnsupported(reason: string): void
  // Aplica ya el último cambio pendiente (guardar, cambiar de modo, Done).
  flushRef: React.MutableRefObject<(() => void) | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Solo cuenta el valor con el que se montó: lo que se escribe vuelve como `base` y no debe recargar el editor.
  const initial = useRef(base).current
  const cb = useRef({ onChange, onUnsupported })
  cb.current = { onChange, onUnsupported }

  useEffect(() => {
    const extensions = richExtensions()
    const rich = makeRich(extensions)
    const canon = memo(rich.canon)
    const { front, body } = splitFrontMatter(initial)
    const reason = richUnsupported(path, body, canon)
    if (reason) {
      cb.current.onUnsupported(reason)
      return
    }
    const editor = new Editor({
      element: ref.current!,
      extensions: [...extensions, Markdown],
      content: rich.parse(body),
      editorProps: { attributes: { class: 'md rich-md', spellcheck: 'false', 'aria-label': 'Markdown document' } },
      onUpdate: () => {
        // Combinar el documento entero en cada tecla cuesta ~25 ms en archivos grandes: se hace al dejar de escribir.
        pending = true
        clearTimeout(timer)
        timer = setTimeout(flush, 150)
      }
    })
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      clearTimeout(timer)
      if (!pending) return
      pending = false
      cb.current.onChange(front + mergeMarkdown(body, editor.getMarkdown(), canon))
    }
    flushRef.current = flush
    // El foco va al principio del documento, como al abrirlo.
    editor.commands.focus('start')
    return () => {
      flush()
      if (flushRef.current === flush) flushRef.current = null
      editor.destroy()
    }
  }, [initial, path, flushRef])

  return <div ref={ref} className="rich-editor" />
}

// Los bloques del original se normalizan una sola vez aunque el documento se vuelva a combinar en cada tecla.
function memo(canon: Canon): Canon {
  const m = new Map<string, string>()
  return (md) => {
    let v = m.get(md)
    if (v === undefined) m.set(md, (v = canon(md)))
    return v
  }
}
