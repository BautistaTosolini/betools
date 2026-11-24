import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import type { ConversationItem, SessionStatus, SlashCommand } from '../../../shared/types'
import { onScreen, screenLines } from '../term-registry'
import { KEYS, parseMenu, type Menu } from '../menu-parser'
import { useZoom } from '../zoom'
import { useDraft } from '../drafts'
import { readActivity, readCliInput, readQueued, type Activity, type CliInput } from '../term-registry'

const api = window.clawhip

// Vista de la conversación (leída del transcript) con caja de respuesta y menús de Claude.

// Claude Code guarda lo que pegás envuelto en <pasted_content id="…">…</pasted_content>: se muestra como un
// bloque desplegable en vez de las etiquetas.
const PASTE_RE = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g

function UserText({ text }: { text: string }) {
  const parts: { kind: 'text' | 'paste'; text: string }[] = []
  let last = 0
  for (const m of text.matchAll(PASTE_RE)) {
    const before = text.slice(last, m.index).trim()
    if (before) parts.push({ kind: 'text', text: before })
    parts.push({ kind: 'paste', text: m[2] })
    last = (m.index ?? 0) + m[0].length
  }
  const after = text.slice(last).trim()
  if (after) parts.push({ kind: 'text', text: after })
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <div key={i} className="msg-text">
            {p.text}
          </div>
        ) : (
          <details key={i} className="paste">
            <summary>
              Pasted text <span className="muted">· {p.text.split('\n').length} lines</span>
              <span className="paste-preview">{p.text.split('\n')[0].slice(0, 90)}</span>
            </summary>
            <pre>{p.text}</pre>
          </details>
        )
      )}
    </>
  )
}

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

// Elegir una opción moviendo el cursor con flechas y confirmando, en vez de mandar el número: en algunos
// menús (p. ej. la opción "Type something" de AskUserQuestion) el número se escribía como texto y se acumulaba.
// Las teclas van de a una (la TUI no siempre separa varias secuencias llegadas juntas).
function sendKeys(id: string, keys: string[], gap = 35): void {
  keys.forEach((k, i) => setTimeout(() => api.input(id, k), i * gap))
}

export function chooseOption(id: string, menu: Menu, n: number): boolean {
  const target = menu.options.findIndex((o) => o.n === n)
  const cur = menu.options.findIndex((o) => o.selected)
  if (target < 0) return false
  const opt = menu.options[target]
  const confirm = opt.checked !== null ? KEYS.space : KEYS.enter
  if (cur < 0) {
    sendKeys(id, [String(n)])
    return true
  }
  const d = target - cur
  sendKeys(id, [...Array(Math.abs(d)).fill(d > 0 ? KEYS.down : KEYS.up), confirm])
  return true
}

// Tras elegir, las opciones quedan bloqueadas hasta que el menú cambie (o 1,5 s): un doble clic no
// manda dos selecciones.
// El ref bloquea al instante (dos clics en el mismo frame); el estado solo atenúa las opciones.
function useMenuLock(menu: Menu): [boolean, () => boolean] {
  const [locked, setLocked] = useState(false)
  const ref = useRef(false)
  const sig = JSON.stringify(menu)
  useEffect(() => {
    ref.current = false
    setLocked(false)
  }, [sig])
  useEffect(() => {
    if (!locked) return
    const t = setTimeout(() => {
      ref.current = false
      setLocked(false)
    }, 1500)
    return () => clearTimeout(t)
  }, [locked])
  const take = () => {
    if (ref.current) return false
    ref.current = true
    setLocked(true)
    return true
  }
  return [locked, take]
}

function MenuPanel({ id, menu }: { id: string; menu: Menu }) {
  const key = (k: string) => api.input(id, k)
  const [locked, take] = useMenuLock(menu)
  const choose = (n: number) => {
    if (take()) chooseOption(id, menu, n)
  }
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
        <div className={`menu-options ${locked ? 'locked' : ''}`} role="listbox">
          {menu.options.map((o) => (
            <button
              key={o.n}
              role="option"
              aria-selected={o.selected}
              className={`menu-option ${o.selected ? 'on' : ''}`}
              disabled={locked}
              onClick={() => choose(o.n)}
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

// Texto sin enviar que quedó en el prompt de la CLI (p. ej. un pegado largo que no se puede traer como texto).
function useCliInput(id: string): CliInput | null {
  const [v, setV] = useState<CliInput | null>(null)
  useEffect(() => {
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const next = readCliInput(id)
        setV((prev) => (prev?.text === next?.text ? prev : next))
      })
    }
    read()
    const off = onScreen(id, read)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [id])
  return v
}

// Lista de comandos por sesión (se pide una vez; el proceso principal la cachea por carpeta).
const slashCache = new Map<string, Promise<SlashCommand[]>>()
function loadSlash(id: string): Promise<SlashCommand[]> {
  let p = slashCache.get(id)
  if (!p) {
    p = api.listSlashCommands(id).catch(() => [])
    slashCache.set(id, p)
    // Se vuelve a pedir pasados 10 minutos (skills nuevas, plugins).
    setTimeout(() => slashCache.delete(id), 10 * 60_000)
  }
  return p
}

function rank(list: SlashCommand[], q: string): SlashCommand[] {
  const query = q.toLowerCase()
  if (!query) return list
  const scored: [number, SlashCommand][] = []
  for (const c of list) {
    const n = c.name.toLowerCase()
    const short = n.includes(':') ? n.slice(n.indexOf(':') + 1) : n
    const score = n.startsWith(query) ? 0 : short.startsWith(query) ? 1 : n.includes(query) ? 2 : c.description.toLowerCase().includes(query) ? 3 : -1
    if (score >= 0) scored.push([score, c])
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map((x) => x[1])
}

const SOURCE_LABEL: Record<SlashCommand['source'], string> = { builtin: 'claude', user: 'skill', project: 'project', plugin: 'plugin' }

function Composer({ id, status, onOpenCli }: { id: string; status: SessionStatus; onOpenCli(): void }) {
  const [text, setText] = useDraft(id)
  const cli = useCliInput(id)
  // Autocompletado de "/": activo mientras el texto es solo "/algo" (sin espacios).
  const slashQuery = /^\/([^\s]*)$/.exec(text)?.[1] ?? null
  const [commands, setCommands] = useState<SlashCommand[] | null>(null)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(() => {
    if (slashQuery !== null && commands === null) loadSlash(id).then(setCommands)
  }, [slashQuery !== null, id])
  const matches = useMemo(() => (slashQuery !== null && commands ? rank(commands, slashQuery).slice(0, 50) : []), [slashQuery, commands])
  const showSlash = slashQuery !== null && dismissed !== text
  useEffect(() => setPick(0), [slashQuery])
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [pick])
  const accept = (c: SlashCommand) => {
    setText(`/${c.name} `)
    requestAnimationFrame(() => ref.current?.focus())
  }
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

  // Esc detiene a Claude (o cierra el menú) desde cualquier parte de Rendered, no solo con el foco en la caja.
  // Ctrl+C queda para copiar. Se ignora si el foco está en otro campo o diálogo, o si el autocompletado está abierto
  // (ahí Esc lo cierra).
  const keys = useRef({ working, menu: !!menu, slash: showSlash })
  keys.current = { working, menu: !!menu, slash: showSlash }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.repeat) return
      const k = keys.current
      if (k.slash || !(k.working || k.menu)) return
      const t = e.target as HTMLElement | null
      const inChat = !t || t === document.body || t === ref.current || !!t.closest?.('.conversation-wrap')
      if (!inChat || document.querySelector('[role="dialog"], .modal, .dialog')) return
      e.preventDefault()
      e.stopPropagation()
      api.input(id, KEYS.esc)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [id])

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
      {showSlash && (
        <div className="slash-pop" ref={listRef}>
          {commands === null && <div className="slash-empty">Loading commands…</div>}
          {commands !== null && matches.length === 0 && <div className="slash-empty">No command or skill matches “/{slashQuery}”.</div>}
          {matches.map((c, i) => (
            <button
              key={c.name}
              className={`slash-item ${i === pick ? 'on' : ''}`}
              onMouseEnter={() => setPick(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                accept(c)
              }}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc">{c.description}</span>
              <span className={`slash-src ${c.source}`}>{SOURCE_LABEL[c.source]}</span>
            </button>
          ))}
        </div>
      )}
      {!menu && cli?.text && (
        <div className="cli-pending">
          <span className="cli-pending-label">In the CLI prompt</span>
          <span className="cli-pending-text" title={cli.text}>
            {cli.text}
          </span>
          <span className="cli-pending-note">Sending from here adds your text after it.</span>
          <button className="btn-sm ghost" onClick={onOpenCli}>
            Open CLI
          </button>
          <button className="btn-sm" onClick={() => api.input(id, '\r')}>
            Send it
          </button>
        </div>
      )}
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
                : 'Reply to Claude…  (/ for commands and skills)'
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (showSlash && matches.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
              return
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey)) {
              const c = matches[pick]
              // Si ya está escrito completo, Enter lo envía en vez de volver a completarlo.
              if (!(e.key === 'Enter' && slashQuery === c.name)) {
                e.preventDefault()
                accept(c)
                return
              }
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setDismissed(text)
              return
            }
          }
          if (menu && !text) {
            if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
              e.preventDefault()
              if (!e.repeat) chooseOption(id, menu, Number(e.key))
              return
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

// Línea de estado de Claude mientras trabaja ("Harmonizing… (11m 26s · ↓ 57.5k tokens)").
function useActivity(id: string, working: boolean): Activity | null {
  const [a, setA] = useState<Activity | null>(null)
  useEffect(() => {
    if (!working) return setA(null)
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const next = readActivity(id)
        setA((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      })
    }
    read()
    const off = onScreen(id, read)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [id, working])
  return a
}

// Mensajes encolados (los que mandaste mientras Claude trabajaba), leídos de la pantalla de la CLI.
function useQueued(id: string): string[] {
  const [q, setQ] = useState<string[]>([])
  useEffect(() => {
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const next = readQueued(id)
        setQ((prev) => (prev.join('\u0000') === next.join('\u0000') ? prev : next))
      })
    }
    read()
    const off = onScreen(id, read)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [id])
  return q
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
  const queued = useQueued(id)
  const activity = useActivity(id, status === 'working')

  // Desde qué ítem se anima la aparición: solo lo que llega mientras mirás la conversación. El historial y lo
  // que llegó estando en otra pestaña se muestra de una (al volver no se re-anima).
  const streamFrom = useRef(Infinity)
  useEffect(() => {
    if (!active || items !== null) return
    api.getConversation(id).then((list) => {
      streamFrom.current = list.length
      setItems(list)
    })
  }, [active, id, items])
  useEffect(() => {
    if (!visible && items) streamFrom.current = items.length
  }, [visible, items])

  // Mientras el texto aparece, el alto crece sin que cambien los ítems: se sigue el final si estabas abajo.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !visible) return
    const mo = new MutationObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => mo.disconnect()
  }, [visible, items === null])

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
              <UserText text={b.item.text} />
            </div>
          ) : b.item.kind === 'assistant' ? (
            <div key={b.key} className="msg assistant">
              <Markdown text={b.item.text} stream={b.key >= streamFrom.current} />
            </div>
          ) : b.item.kind === 'answers' ? (
            <div key={b.key} className="msg answers">
              <div className="msg-head">You answered Claude's questions</div>
              {(JSON.parse(b.item.text) as { q: string; a: string }[]).map((x, i) => (
                <div key={i} className="answer">
                  <div className="answer-q">{x.q}</div>
                  <div className="answer-a">→ {x.a}</div>
                </div>
              ))}
            </div>
          ) : b.item.kind === 'command' ? (
            <div key={b.key} className="msg command">
              {b.item.text.includes('\u0000') ? (
                <details>
                  <summary>
                    <code>{b.item.text.split('\u0000')[0]}</code> <span className="muted">· output</span>
                  </summary>
                  <pre className="command-out">{b.item.text.split('\u0000')[1]}</pre>
                </details>
              ) : (
                <code>{b.item.text}</code>
              )}
            </div>
          ) : (
            <div key={b.key} className="msg summary">
              — {b.item.text} —
            </div>
          )
        )}
        {queued.map((q, i) => (
          <div key={'q' + i} className="msg user queued">
            <div className="msg-head">
              You <span className="queued-badge">Queued</span>
              <span className="muted"> · Claude reads it when it finishes the current step</span>
            </div>
            <UserText text={q} />
          </div>
        ))}
      </div>
      {activity && (
        <div className="activity">
          <span className="activity-dot" />
          <span className="activity-label">{activity.label}</span>
          {activity.detail && <span className="activity-detail">{activity.detail}</span>}
          {activity.tip && <span className="activity-tip">{activity.tip}</span>}
        </div>
      )}
      <Composer id={id} status={status} onOpenCli={onReply} />
    </div>
  )
}
