import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ConversationItem, SessionStatus } from '../../../shared/types'
import { onScreen, screenLines } from '../term-registry'
import { KEYS, parseMenu, type Menu } from '../menu-parser'
import { useZoom } from '../zoom'

const api = window.clawhip

// Vista de solo lectura de la conversación (leída del transcript). El Markdown se pasa a HTML y se
// sanea con DOMPurify; los bloques ```html se muestran además como vista previa en un iframe aislado
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

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => toHtml(text), [text])
  useLayoutEffect(() => {
    if (ref.current) mountPreviews(ref.current)
  }, [html])
  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />
})

const time = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

type Block = { kind: 'item'; item: ConversationItem; key: number } | { kind: 'tools'; items: ConversationItem[]; key: number }

// Herramientas consecutivas se agrupan en una sola línea desplegable.
function toBlocks(items: ConversationItem[], offset: number): Block[] {
  const out: Block[] = []
  items.forEach((item, i) => {
    const last = out[out.length - 1]
    if (item.kind === 'tool') {
      if (last?.kind === 'tools') last.items.push(item)
      else out.push({ kind: 'tools', items: [item], key: offset + i })
    } else out.push({ kind: 'item', item, key: offset + i })
  })
  return out
}

const PAGE = 200

// Escribe en el mismo proceso de Claude que la pestaña CLI. Varias líneas van como pegado (bracketed paste)
// para que Claude no tome cada salto como Enter; el Enter final va aparte, después de que procese el texto.
function sendPrompt(id: string, text: string): void {
  api.input(id, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text)
  setTimeout(() => api.input(id, '\r'), 120)
}

// Diálogo que Claude muestra en la terminal (leído de la pantalla), actualizado en cada escritura.
function useMenu(id: string): Menu | null {
  const [menu, setMenu] = useState<Menu | null>(null)
  useEffect(() => {
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const next = parseMenu(screenLines(id))
        setMenu((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      })
    }
    read()
    const off = onScreen(id, read)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [id])
  return menu
}

// Encabezado del diálogo: pestañas de AskUserQuestion (☐ Color), líneas de código (comando a aprobar,
// sangradas) y texto. La última línea de texto es la pregunta y va como título.
function headerParts(lines: string[]) {
  const tabs: string[] = []
  const rest: { kind: 'code' | 'text' | 'bullet'; text: string }[] = []
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) continue
    // Línea de pestañas: "← ☐ Región  ☐ Entorno  ✔ Submit →" (las flechas indican que hay varias preguntas).
    const bare = t.replace(/^←\s*/, '').replace(/\s*→$/, '')
    if (/^[☐☒✔✓□■]/.test(bare)) tabs.push(...bare.split(/(?=[☐☒✔✓□■])/).map((x) => x.trim()).filter(Boolean))
    // Resumen de respuestas: "● pregunta" / "→ respuesta".
    else if (/^[●•]\s/.test(t)) rest.push({ kind: 'bullet', text: t.replace(/^[●•]\s*/, '') })
    else if (/^→\s/.test(t)) rest.push({ kind: 'bullet', text: t })
    else if (/^\s{2,}/.test(raw)) rest.push({ kind: 'code', text: t })
    else rest.push({ kind: 'text', text: t })
  }
  let qi = -1
  for (let i = rest.length - 1; i >= 0; i--) if (rest[i].kind === 'text') { qi = i; break }
  return { tabs, rest, qi }
}

function MenuPanel({ id, menu }: { id: string; menu: Menu }) {
  const key = (k: string) => api.input(id, k)
  const { tabs, rest, qi } = headerParts(menu.header)
  const multiTab = tabs.length > 1
  return (
    <div className="menu-panel">
      <div className="menu-eyebrow">
        <span className="menu-badge">Needs your input</span>
        {tabs.map((t, i) => (
          <span key={i} className={`menu-tab ${/^[☒✔✓■]/.test(t) ? 'done' : ''}`}>
            {t.replace(/^[☐☒✔✓□■]\s*/, '')}
          </span>
        ))}
      </div>
      {rest.map((r, i) =>
        r.kind === 'bullet' ? (
          <p key={i} className={`menu-bullet ${r.text.startsWith('→') ? 'answer' : ''}`}>{r.text}</p>
        ) : r.kind === 'code' ? (
          <code key={i} className="menu-code">{r.text}</code>
        ) : i === qi ? (
          <h3 key={i} className="menu-question">{r.text}</h3>
        ) : (
          <p key={i} className="menu-label">{r.text}</p>
        )
      )}
      {menu.options.length > 0 && (
        <div className="menu-options" role="listbox">
          {menu.options.map((o) => (
            <button
              key={o.n}
              role="option"
              aria-selected={o.selected}
              className={`menu-option ${o.selected ? 'on' : ''}`}
              onClick={() => key(String(o.n))}
            >
              <kbd>{o.n}</kbd>
              {o.checked !== null && <span className={`menu-check ${o.checked ? 'on' : ''}`} />}
              <span className="menu-option-text">
                <span>{o.label}</span>
                {o.detail.length > 0 && <small>{o.detail.join(' · ')}</small>}
              </span>
              {o.selected && <span className="menu-enter">↵</span>}
            </button>
          ))}
        </div>
      )}
      <div className="menu-keys">
        {multiTab && (
          <>
            <button className="key" onClick={() => key(KEYS.left)} title="Previous question">←</button>
            <button className="key" onClick={() => key(KEYS.right)} title="Next question">→</button>
          </>
        )}
        <button className="key" onClick={() => key(KEYS.up)} title="Up">↑</button>
        <button className="key" onClick={() => key(KEYS.down)} title="Down">↓</button>
        {menu.options.some((o) => o.checked !== null) && (
          <button className="key" onClick={() => key(KEYS.space)} title="Toggle">Space</button>
        )}
        {/Tab to/i.test(menu.hint) && (
          <button className="key" onClick={() => key(KEYS.tab)} title={menu.hint}>Tab</button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn-sm ghost" onClick={() => key(KEYS.esc)}>Cancel</button>
        <button className="btn-sm primary" onClick={() => key(KEYS.enter)}>Confirm</button>
      </div>
    </div>
  )
}

// Teclas que, con un menú abierto y la caja vacía, van directo al menú.
const MENU_KEYS: Record<string, string> = {
  ArrowUp: KEYS.up,
  ArrowDown: KEYS.down,
  ArrowLeft: KEYS.left,
  ArrowRight: KEYS.right,
  Enter: KEYS.enter,
  Escape: KEYS.esc,
  Tab: KEYS.tab,
  ' ': KEYS.space
}

function Composer({ id, status, onOpenCli }: { id: string; status: SessionStatus; onOpenCli(): void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const menu = useMenu(id)
  const working = status === 'working'
  const off = status === 'stopped' || status === 'exited'

  // Alto automático hasta 10 líneas.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  // Al aparecer un menú, el foco va a la caja para poder usar el teclado (números, flechas, Enter, Esc).
  useEffect(() => {
    if (menu) ref.current?.focus()
  }, [!!menu])

  const send = () => {
    const t = text.trim()
    if (!t || off) return
    // Con un menú abierto (p. ej. "Type something" o "tell Claude what to do"), el texto va como tecleo.
    if (menu) {
      api.input(id, t)
      setTimeout(() => api.input(id, '\r'), 120)
    } else sendPrompt(id, t)
    setText('')
  }

  return (
    <div className={`composer ${menu ? 'with-menu' : ''}`}>
      {menu && <MenuPanel id={id} menu={menu} />}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={off}
        spellCheck={false}
        placeholder={
          off
            ? 'Session not running.'
            : menu
              ? 'Type a number, use the arrows, or write an answer…'
              : working
                ? 'Claude is working. Your message is queued…'
                : 'Reply to Claude…'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (menu && !text) {
            if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
              e.preventDefault()
              return api.input(id, e.key)
            }
            const k = MENU_KEYS[e.key]
            if (k && !e.ctrlKey && !e.altKey && !(e.key === 'Enter' && e.shiftKey)) {
              e.preventDefault()
              return api.input(id, k)
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            const el = e.currentTarget
            const at = el.selectionStart
            setText(text.slice(0, at) + '\n' + text.slice(el.selectionEnd))
            requestAnimationFrame(() => el.setSelectionRange(at + 1, at + 1))
          }
          if (e.key === 'Escape' && working && !text) {
            e.preventDefault()
            api.input(id, KEYS.esc)
          }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">
          {menu ? (
            <>
              <kbd>1-9</kbd> choose · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel
            </>
          ) : (
            <>
              <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line{working && <> · <kbd>Esc</kbd> stop</>}
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {working && !menu && (
          <button className="btn-sm" title="Interrupt Claude (Esc)" onClick={() => api.input(id, KEYS.esc)}>
            Stop
          </button>
        )}
        <button className="btn-sm ghost" onClick={onOpenCli} title="Open the raw terminal">
          CLI
        </button>
        <button className="primary btn-sm" disabled={!text.trim() || off} onClick={send}>
          Send
        </button>
      </div>
    </div>
  )
}

export function ConversationView({
  id,
  visible,
  active,
  status,
  onReply
}: {
  id: string
  visible: boolean
  active: boolean
  status: SessionStatus
  onReply(): void
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null)
  const [shown, setShown] = useState(PAGE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const chatZoom = useZoom('chat')

  useEffect(() => {
    if (!active || items !== null) return
    api.getConversation(id).then(setItems)
  }, [active, id, items])

  useEffect(
    () =>
      api.onConversation((sid, start, add) => {
        if (sid !== id) return
        setItems((prev) => (prev === null ? prev : [...prev.slice(0, start), ...add]))
      }),
    [id]
  )

  // Si estabas al final, se sigue el final cuando llegan mensajes nuevos.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && visible && stick.current) el.scrollTop = el.scrollHeight
  }, [items, visible])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  // Links: nunca navegan la ventana; http(s) se abre en el navegador.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) api.openExternal(href)
  }

  const from = Math.max(0, (items?.length ?? 0) - shown)
  const blocks = useMemo(() => (items ? toBlocks(items.slice(from), from) : []), [items, from])

  if (!visible) return null
  return (
    <div className="conversation-wrap" style={{ zoom: chatZoom }}>
      <div className="conversation" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
        {items === null && <p className="muted pad">Loading…</p>}
        {items?.length === 0 && <p className="muted pad">No messages yet. Write your first prompt below.</p>}
        {from > 0 && (
          <button className="btn-sm earlier" onClick={() => setShown((n) => n + PAGE)}>
            Show earlier messages ({from})
          </button>
        )}
        {blocks.map((b) =>
          b.kind === 'tools' ? (
            <details key={b.key} className="msg tools">
              <summary>
                ⚙ {b.items[b.items.length - 1].text}
                {b.items.length > 1 && <span className="muted"> (+{b.items.length - 1} more)</span>}
              </summary>
              <ul>
                {b.items.map((t, i) => (
                  <li key={i}>{t.text}</li>
                ))}
              </ul>
            </details>
          ) : b.item.kind === 'user' ? (
            <div key={b.key} className="msg user">
              <div className="msg-head">
                You <span className="muted">{time(b.item.at)}</span>
              </div>
              <div className="msg-text">{b.item.text}</div>
            </div>
          ) : b.item.kind === 'assistant' ? (
            <div key={b.key} className="msg assistant">
              <Markdown text={b.item.text} />
            </div>
          ) : b.item.kind === 'command' ? (
            <div key={b.key} className="msg command">
              <code>{b.item.text}</code>
            </div>
          ) : (
            <div key={b.key} className="msg summary">
              — {b.item.text} —
            </div>
          )
        )}
      </div>
      <Composer id={id} status={status} onOpenCli={onReply} />
    </div>
  )
}
