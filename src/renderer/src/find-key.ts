import { useEffect, useRef } from 'react'

// Ctrl+F abre el buscador de la vista visible (Rendered o un .md). En las pestañas Terminal y CLI no hay ninguna
// visible, así que Ctrl+F sigue llegando al proceso.
export function useFindKey(visible: boolean, open: () => void): void {
  const cb = useRef(open)
  cb.current = open
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
      // Un diálogo abierto (variables, carpetas…) tiene sus propios campos.
      if (document.querySelector('.modal, [role="dialog"]')) return
      e.preventDefault()
      e.stopPropagation()
      cb.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible])
}
