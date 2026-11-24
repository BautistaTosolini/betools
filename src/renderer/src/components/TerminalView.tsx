import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { onReset, subscribe } from '../pty-bus'
import { registerTerm } from '../term-registry'
import { getZoom, useZoom } from '../zoom'

const api = window.clawhip

interface Props {
  // Clave del pty: el id de la sesión (Claude) o "shell:<id>" (terminal).
  id: string
  visible: boolean
  // Sesión seleccionada aunque la pestaña no se vea (p. ej. está en Rendered): el proceso se lanza igual
  // y la terminal se mantiene medida (oculta con visibility) para lanzarlo con el tamaño correcto.
  active?: boolean
}

// Una terminal por sesión. Se crea una vez y se oculta (no se destruye) al cambiar de sesión.
// El pty se lanza recién la primera vez que la sesión se selecciona (arranque lazy).
export function TerminalView({ id, visible, active = visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const attachedRef = useRef(false)
  const [exitCode, setExitCode] = useState<number | null>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", "DejaVu Sans Mono", monospace',
      fontSize: Math.round(13 * getZoom('chat')),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: { background: '#0f0f11' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current!)
    termRef.current = { term, fit }

    // Ctrl+Shift+C / Ctrl+Shift+V para copiar y pegar; el resto de las teclas va a Claude.
    term.attachCustomKeyEventHandler((e) => {
      // Salto de línea en el prompt de Claude: la terminal no distingue Ctrl/Shift+Enter de Enter
      // (los tres mandan "\r" = enviar). Se manda "\n" (Ctrl+J), que Claude Code toma como nueva línea.
      // Se corta en todos los tipos de evento para que xterm no mande además el "\r".
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey) && !e.altKey && !e.metaKey && !id.startsWith('shell:')) {
        if (e.type === 'keydown') api.input(id, '\n')
        return false
      }
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true
      const key = e.key.toLowerCase()
      if (key === 'c') {
        const sel = term.getSelection()
        if (sel) void api.writeClipboard(sel)
        return false
      }
      if (key === 'v') {
        // Versión web sin HTTPS: no hay acceso al portapapeles; se deja pasar el pegado nativo del navegador.
        if ((api as { nativePaste?: boolean }).nativePaste) return true
        api.readClipboard().then((text) => term.paste(text))
        return false
      }
      return true
    })

    const unregister = registerTerm(id, term)
    const unsub = subscribe(
      id,
      (data) => term.write(data),
      (code) => setExitCode(code)
    )
    const inputSub = term.onData((d) => api.input(id, d))
    const offReset = onReset(id, () => {
      setExitCode(null)
      term.reset()
    })

    // Redimensiona al cambiar el tamaño del contenedor, agrupando eventos por frame
    // y avisando al pty solo si cambió la grilla (cada resize hace que Claude redibuje).
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const el = containerRef.current
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
        const { cols, rows } = term
        fit.fit()
        if (attachedRef.current && (term.cols !== cols || term.rows !== rows)) api.resize(id, term.cols, term.rows)
      })
    })
    ro.observe(containerRef.current!)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      unsub()
      unregister()
      offReset()
      inputSub.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [id])

  // Zoom del chat: cambia el tamaño de letra y se reacomoda la grilla (Claude redibuja con el tamaño nuevo).
  const chatZoom = useZoom('chat')
  useEffect(() => {
    const t = termRef.current
    const size = Math.round(13 * chatZoom)
    if (!t || t.term.options.fontSize === size) return
    t.term.options.fontSize = size
    const el = containerRef.current
    if (!el || el.clientWidth === 0) return
    const { cols, rows } = t.term
    t.fit.fit()
    if (attachedRef.current && (t.term.cols !== cols || t.term.rows !== rows)) api.resize(id, t.term.cols, t.term.rows)
  }, [chatZoom, id])

  useEffect(() => {
    if (!active && !visible) return
    const raf = requestAnimationFrame(() => {
      const t = termRef.current
      if (!t) return
      t.fit.fit()
      if (!attachedRef.current) {
        attachedRef.current = true
        api.attach(id, t.term.cols, t.term.rows)
      } else {
        api.resize(id, t.term.cols, t.term.rows)
      }
      if (visible) t.term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, active, id])

  const restart = () => {
    const t = termRef.current
    if (!t) return
    setExitCode(null)
    t.term.reset()
    api.restart(id, t.term.cols, t.term.rows)
    t.term.focus()
  }

  return (
    <div
      className="terminal-wrap"
      style={visible ? { display: 'flex' } : active ? { display: 'flex', visibility: 'hidden', pointerEvents: 'none' } : { display: 'none' }}
    >
      <div className="terminal" ref={containerRef} />
      {exitCode !== null && (
        <div className="exit-banner">
          {id.startsWith('shell:') ? (
            <span>The terminal closed (code {exitCode}).</span>
          ) : (
            <span>Claude exited (code {exitCode}). The session is still saved.</span>
          )}
          <button onClick={restart}>{id.startsWith('shell:') ? 'Open again' : 'Resume'}</button>
        </div>
      )}
    </div>
  )
}
