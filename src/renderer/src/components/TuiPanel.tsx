import { useEffect, useRef, useState } from 'react'
import { hintKeys, KEYS, type Panel } from '../menu-parser'
import { moveToRow, switchTab } from '../panel-nav'
import { cursorRow, nextWrite, onScreen, screenRuns, type Run } from '../term-registry'

const api = window.clawhip

// Panel de un comando con interfaz (/usage, /config, /mcp, /plugin…), copiado de la pantalla con sus colores.
// Clic en una fila: lleva el cursor ahí. Doble clic: además la elige (Enter). Clic en una pestaña: cambia a esa.
// El teclado lo maneja la caja de abajo, que reenvía las teclas al panel.
export function TuiPanel({ id, panel, onFocusKeys }: { id: string; panel: Panel; onFocusKeys(): void }) {
  const rows = useRuns(id, panel.top, panel.top + panel.lines.length)
  const [cursor, setCursor] = useState<number | null>(null)
  const chain = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    const read = () => setCursor(cursorRow(id))
    read()
    return onScreen(id, read)
  }, [id])

  const io = {
    cursor: () => cursorRow(id),
    send: (k: string) => api.input(id, k),
    wait: () => nextWrite(id)
  }

  // Una acción por vez y en orden: cada una parte de donde dejó el cursor la anterior (un doble clic son dos
  // clics y después el doble clic).
  const run = (fn: () => Promise<unknown>) => {
    chain.current = chain.current.then(fn).catch(() => {}).finally(onFocusKeys)
  }

  const activeTab = () => {
    const tabs = panel.tabs
    if (!tabs.length) return -1
    const runs = screenRuns(id, panel.top + tabs[0].row, panel.top + tabs[0].row + 1)[0] ?? []
    // La pestaña activa se dibuja con fondo (o en video inverso).
    let x = 0
    for (const r of runs) {
      const from = x
      x += r.text.length
      if (!(r.bg || r.inverse) || !r.text.trim()) continue
      const i = tabs.findIndex((t) => t.col < x && t.col + t.label.length > from)
      if (i >= 0) return i
    }
    return -1
  }

  const clickRow = (row: number, e: React.MouseEvent) => {
    const tab = panel.tabs.findIndex((t) => t.row === row && hitCol(e, t.col, t.label.length))
    if (tab >= 0) {
      run(() => switchTab({ active: activeTab, send: io.send, wait: io.wait }, tab, panel.tabs.length))
      return
    }
    run(() => moveToRow(io, panel.top + row))
  }

  const pick = (row: number) =>
    run(async () => {
      if (await moveToRow(io, panel.top + row)) api.input(id, KEYS.enter)
    })

  const extra = hintKeys(panel.hint)

  return (
    <div className="menu-panel tui-panel">
      <div className="menu-eyebrow">
        <span className="menu-badge">Claude Code panel</span>
        <span className="tui-tip">Click a row to move · double-click to select · keys below go to the panel</span>
      </div>
      <pre className="tui-screen" role="listbox">
        {rows.map((runs, i) => (
          <div
            key={i}
            className={`tui-row ${cursor === panel.top + i ? 'on' : ''}`}
            onClick={(e) => clickRow(i, e)}
            onDoubleClick={() => pick(i)}
          >
            {runs.length ? runs.map((r, j) => <span key={j} style={runStyle(r)}>{r.text}</span>) : ' '}
          </div>
        ))}
      </pre>
      <div className="menu-keys">
        <button className="key" onClick={() => api.input(id, KEYS.up)} title="Up">↑</button>
        <button className="key" onClick={() => api.input(id, KEYS.down)} title="Down">↓</button>
        <button className="key" onClick={() => api.input(id, KEYS.left)} title="Left">←</button>
        <button className="key" onClick={() => api.input(id, KEYS.right)} title="Right">→</button>
        <button className="key" onClick={() => api.input(id, KEYS.tab)} title="Tab">Tab</button>
        {extra
          .filter((k) => !['←', '→', 'Tab'].includes(k.label))
          .map((k) => (
            <button key={k.label + k.title} className="key wide" title={k.title} onClick={() => k.keys.forEach((s) => api.input(id, s))}>
              <kbd>{k.label}</kbd> {k.title}
            </button>
          ))}
        <span style={{ flex: 1 }} />
        <button className="btn-sm ghost" onClick={() => api.input(id, KEYS.esc)}>Close</button>
        <button className="btn-sm primary" onClick={() => api.input(id, KEYS.enter)}>Enter</button>
      </div>
    </div>
  )
}

// Columna de terminal bajo el mouse: el panel usa una fuente monoespaciada, así que alcanza con el ancho de un
// carácter medido en la fila.
function hitCol(e: React.MouseEvent, col: number, len: number): boolean {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
  const probe = document.createElement('span')
  probe.textContent = 'M'.repeat(10)
  el.appendChild(probe)
  const w = probe.getBoundingClientRect().width / 10
  el.removeChild(probe)
  const x = Math.floor((e.clientX - rect.left - pad) / w)
  return x >= col - 1 && x <= col + len
}

function runStyle(r: Run): React.CSSProperties {
  const st: React.CSSProperties = {}
  let fg = r.fg
  let bg = r.bg
  if (r.inverse) {
    ;[fg, bg] = [bg ?? 'var(--tui-bg)', fg ?? 'var(--text)']
  }
  if (fg) st.color = fg
  if (bg) st.background = bg
  if (r.bold) st.fontWeight = 600
  if (r.dim) st.opacity = 0.6
  if (r.italic) st.fontStyle = 'italic'
  if (r.underline) st.textDecoration = 'underline'
  return st
}

function useRuns(id: string, y0: number, y1: number): Run[][] {
  const [rows, setRows] = useState<Run[][]>(() => screenRuns(id, y0, y1))
  useEffect(() => {
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setRows(screenRuns(id, y0, y1)))
    }
    read()
    const off = onScreen(id, read)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [id, y0, y1])
  return rows
}
