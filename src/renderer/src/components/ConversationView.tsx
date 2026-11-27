import { applySlash, slashAt } from '../slash-token'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import type { ConversationItem, SessionStatus, SlashCommand, ToolCall } from '../../../shared/types'
import { onScreen, screenLines } from '../term-registry'
import { hintKeys, KEYS, parseDialog, textAnswerKeys, type Dialog, type Form, type Menu } from '../menu-parser'
import { keyToTerm } from '../panel-nav'
import { TuiPanel } from './TuiPanel'
import { FindBar } from './FindBar'
import { useFindKey } from '../find-key'
import { useZoom } from '../zoom'
import { useDraft } from '../drafts'
import { readActivity, readCliInput, readLive, readQueued, type Activity, type CliInput, type Live } from '../term-registry'

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

// Diálogo que Claude muestra en la terminal (leído de la pantalla), actualizado en cada escritura: un menú o
// formulario conocido, o el panel de un comando (/usage, /config…).
function useDialog(id: string): Dialog | null {
  const [dialog, setDialog] = useState<Dialog | null>(null)
  useEffect(() => {
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const next = parseDialog(screenLines(id))
        setDialog((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      })
    }
    read()
    const off = onScreen(id, read)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [id])
  return dialog
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
// busyUntil: hasta cuándo hay teclas en camino (más el redibujo), para que lo siguiente parta de la pantalla nueva.
const busyUntil = new Map<string, number>()
function sendKeys(id: string, keys: string[], gap = 35): void {
  keys.forEach((k, i) => setTimeout(() => api.input(id, k), i * gap))
  busyUntil.set(id, Math.max(busyUntil.get(id) ?? 0, Date.now() + keys.length * gap + 150))
}

// 'text': era la opción de escribir ("Type something."): solo se lleva el cursor ahí, sin Enter (con Enter y vacía,
// Claude Code rechaza la pregunta), y la respuesta se escribe en la caja.
export function chooseOption(id: string, menu: Menu, n: number): boolean | 'text' {
  const target = menu.options.findIndex((o) => o.n === n)
  const cur = menu.options.findIndex((o) => o.selected)
  if (target < 0) return false
  const opt = menu.options[target]
  const isText = menu.input?.kind === 'type' && menu.input.n === n
  const confirm = opt.checked !== null ? KEYS.space : KEYS.enter
  if (cur < 0) {
    if (isText) return 'text'
    sendKeys(id, [String(n)])
    return true
  }
  const d = target - cur
  const moves = Array(Math.abs(d)).fill(d > 0 ? KEYS.down : KEYS.up)
  sendKeys(id, isText ? moves : [...moves, confirm])
  return isText ? 'text' : true
}

// Respuesta escrita: en la opción de texto (o como "No, and tell Claude…" en un permiso). false si el diálogo no
// acepta texto: así nunca se confirma otra opción por accidente.
async function answerWithText(id: string, text: string): Promise<boolean> {
  // Si recién se eligió algo (p. ej. con el número), se espera a que la pantalla muestre dónde quedó el cursor.
  const wait = (busyUntil.get(id) ?? 0) - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  const d = parseDialog(screenLines(id))
  const keys = d?.kind === 'menu' ? textAnswerKeys(d.menu, text) : null
  if (!keys) return false
  // El texto va de una vez; el Enter, con un respiro para que la TUI lo tome.
  const head = keys.slice(0, -1)
  sendKeys(id, head, 60)
  setTimeout(() => api.input(id, KEYS.enter), head.length * 60 + 150)
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

// Teclas para llevar el foco del formulario al campo `target` (fields.length = fila Accept/Decline). Un campo
// desplegado se cierra antes con ←, porque ahí ↑/↓ recorren sus opciones.
function formMove(form: Form, target: number): string[] {
  const i = form.fields.findIndex((f) => f.focused)
  const cur = form.button ? form.fields.length : i
  if (cur < 0) return []
  const keys: string[] = form.fields[cur]?.expanded ? [KEYS.left] : []
  const d = target - cur
  return [...keys, ...Array(Math.abs(d)).fill(d > 0 ? KEYS.down : KEYS.up)]
}

const FORM_MARK = { required: '*', done: '✓', error: '!', '': '' } as const

// Formulario de un servidor MCP: cada campo es una fila; el enfocado muestra sus opciones. Accept/Decline
// recorren los campos hasta los botones de la TUI (al bajar del último campo el foco cae en Accept).
function FormPanel({ id, menu, form }: { id: string; menu: Menu; form: Form }) {
  const key = (k: string) => api.input(id, k)
  const [locked, take] = useMenuLock(menu)
  const run = (keys: string[]) => {
    if (keys.length && take()) sendKeys(id, keys)
  }
  const clickField = (i: number) => {
    const f = form.fields[i]
    if (!f.focused || form.button) return run(formMove(form, i))
    if (f.kind === 'choice' && !f.expanded) run([KEYS.right])
    else if (f.kind === 'bool') run([KEYS.space])
    else if (f.kind === 'text') document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
  }
  const clickChoice = (j: number, choices: Form['fields'][number]['choices']) => {
    const d = j - choices.findIndex((c) => c.cursor)
    run([...Array(Math.abs(d)).fill(d > 0 ? KEYS.down : KEYS.up), KEYS.space])
  }
  const answer = (b: 'accept' | 'decline') => {
    const keys = form.button ? [] : formMove(form, form.fields.length)
    const at = form.button ?? 'accept'
    if (at !== b) keys.push(b === 'decline' ? KEYS.right : KEYS.left)
    run([...keys, KEYS.enter])
  }
  return (
    <div className="menu-panel">
      <div className="menu-eyebrow">
        <span className="menu-badge">Needs your input</span>
      </div>
      {menu.header.filter((l) => l.trim()).map((l, i) =>
        i === 0 ? (
          <h3 key={i} className="menu-question">{l.trim()}</h3>
        ) : (
          <p key={i} className="menu-label">{l.trim()}</p>
        )
      )}
      <div className={`menu-options ${locked ? 'locked' : ''}`} role="listbox">
        {form.fields.map((f, i) => (
          <div key={i} className="form-field">
            <button
              role="option"
              aria-selected={f.focused && !form.button}
              className={`menu-option ${f.focused && !form.button ? 'on' : ''}`}
              disabled={locked}
              onClick={() => clickField(i)}
            >
              <span className={`form-mark ${f.status}`}>{FORM_MARK[f.status]}</span>
              <span className="menu-option-text">
                <span>
                  {f.label}
                  <span className={`form-value ${f.value ? '' : 'empty'}`}>
                    {f.kind === 'bool' ? (f.value === '☒' ? 'Yes' : 'No') : f.value || (f.kind === 'text' && f.focused ? 'type below' : 'not set')}
                  </span>
                </span>
                {f.desc.length > 0 && <small>{f.desc.join(' ')}</small>}
              </span>
              {f.focused && !form.button && f.kind === 'choice' && !f.expanded && <span className="menu-enter">choose ▸</span>}
              {f.focused && !form.button && f.kind === 'bool' && <span className="menu-enter">toggle</span>}
            </button>
            {f.expanded && f.choices.length > 0 && (
              <div className="form-choices">
                {f.choices.map((c, j) => (
                  <button
                    key={j}
                    className={`menu-option ${c.cursor ? 'on' : ''}`}
                    disabled={locked}
                    onClick={() => clickChoice(j, f.choices)}
                  >
                    <span className={`menu-check ${c.on ? 'on' : ''}`} />
                    <span className="menu-option-text"><span>{c.label}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="menu-keys">
        <button className="key" onClick={() => key(KEYS.up)} title="Up">↑</button>
        <button className="key" onClick={() => key(KEYS.down)} title="Down">↓</button>
        <span style={{ flex: 1 }} />
        <button className="btn-sm ghost" onClick={() => key(KEYS.esc)} title="Esc">Cancel</button>
        <button className={`btn-sm ${form.button === 'decline' ? 'primary' : ''}`} disabled={locked} onClick={() => answer('decline')}>Decline</button>
        <button className={`btn-sm ${form.button === 'decline' ? '' : 'primary'}`} disabled={locked} onClick={() => answer('accept')}>Accept</button>
      </div>
    </div>
  )
}

function MenuPanel({ id, menu, onText }: { id: string; menu: Menu; onText(): void }) {
  if (menu.form) return <FormPanel id={id} menu={menu} form={menu.form} />
  return <ChoicePanel id={id} menu={menu} onText={onText} />
}

function ChoicePanel({ id, menu, onText }: { id: string; menu: Menu; onText(): void }) {
  const key = (k: string) => api.input(id, k)
  const [locked, take] = useMenuLock(menu)
  const choose = (n: number) => {
    if (menu.input?.kind === 'type' && menu.input.n === n) {
      // Sin bloquear: solo mueve el cursor; la respuesta se escribe en la caja.
      chooseOption(id, menu, n)
      onText()
      return
    }
    if (take()) chooseOption(id, menu, n)
  }
  // Atajos de la línea de ayuda ("s to use this session only", "Tab to amend") y de líneas como
  // "◐ Medium effort (default) ←/→ to adjust" (/model).
  const extra = hintKeys([menu.hint, ...menu.header.filter((l) => l.includes('←/→')).map((l) => l.trim().replace(/^.*?(←\/→ to)/, '$1'))].join(' · '))
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
              {menu.input?.kind === 'type' && menu.input.n === o.n ? (
                <span className="menu-enter">write below ✎</span>
              ) : (
                o.selected && <span className="menu-enter">↵</span>
              )}
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
        {extra
          .filter((k) => !(k.label === 'Space' && menu.options.some((o) => o.checked !== null)))
          .map((k) => (
            <button key={k.label + k.title} className="key wide" title={k.title} onClick={() => k.keys.forEach((s) => key(s))}>
              <kbd>{k.label}</kbd> {k.title}
            </button>
          ))}
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

// Lista de comandos por sesión. Se precarga al abrir la sesión: primero la rápida (disco y lista fija, al
// instante) y después la completa (init de Claude Code, unos segundos la primera vez por carpeta).
const slashCache = new Map<string, { list: SlashCommand[] | null; full: boolean; at: number; subs: Set<(l: SlashCommand[]) => void> }>()
function watchSlash(id: string, cb: (l: SlashCommand[]) => void): () => void {
  let e = slashCache.get(id)
  // Se vuelve a pedir pasados 10 minutos (skills nuevas, plugins); la lista vieja sirve mientras tanto.
  if (!e || Date.now() - e.at > 10 * 60_000) {
    const entry = { list: e?.list ?? null, full: false, at: Date.now(), subs: e?.subs ?? new Set<(l: SlashCommand[]) => void>() }
    slashCache.set(id, (e = entry))
    const set = (l: SlashCommand[], full: boolean) => {
      if (entry.full && !full) return
      entry.list = l
      entry.full = full
      entry.subs.forEach((f) => f(l))
    }
    api.listSlashCommands(id, true).then((l) => set(l, false), () => {})
    api.listSlashCommands(id).then((l) => set(l, true), () => {})
  }
  e.subs.add(cb)
  if (e.list) cb(e.list)
  const subs = e.subs
  return () => void subs.delete(cb)
}

function rank(list: SlashCommand[], q: string): SlashCommand[] {
  const query = q.toLowerCase()
  // Sin filtro, en orden alfabético como la CLI (si no, quedaban primero las skills, en el orden del init).
  if (!query) return [...list].sort((a, b) => a.name.localeCompare(b.name))
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
  // Autocompletado de "/": en la palabra "/algo" donde está el cursor, en cualquier parte del mensaje.
  const [caret, setCaret] = useState(text.length)
  const slashTok = useMemo(() => slashAt(text, Math.min(caret, text.length)), [text, caret])
  const slashQuery = slashTok?.query ?? null
  const [commands, setCommands] = useState<SlashCommand[] | null>(null)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(() => {
    setCommands(null)
    return watchSlash(id, setCommands)
  }, [id])
  const matches = useMemo(() => (slashQuery !== null && commands ? rank(commands, slashQuery).slice(0, 50) : []), [slashQuery, commands])
  const showSlash = slashQuery !== null && dismissed !== text
  useEffect(() => setPick(0), [slashQuery])
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [pick])
  const accept = (c: SlashCommand) => {
    const next = slashTok ? applySlash(text, slashTok, c.name) : { text: `/${c.name} `, caret: c.name.length + 2 }
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }
  const ref = useRef<HTMLTextAreaElement>(null)
  const dialog = useDialog(id)
  const menu = dialog?.kind === 'menu' ? dialog.menu : null
  const panel = dialog?.kind === 'panel' ? dialog.panel : null
  // Menú sin respuesta escrita (p. ej. un permiso viejo o /model): la caja no manda texto, para no confirmar
  // una opción por accidente.
  const noText = !!menu && !menu.form && !menu.input
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => setFlash(null), [!!menu, !!panel])
  const lastEsc = useRef(0)
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
    if (menu || panel) ref.current?.focus()
  }, [!!menu, !!panel])

  // Esc detiene a Claude (o cierra el menú) desde cualquier parte de Rendered, no solo con el foco en la caja.
  // Ctrl+C queda para copiar. Se ignora si el foco está en otro campo o diálogo, o si el autocompletado está abierto
  // (ahí Esc lo cierra).
  const keys = useRef({ working, menu: !!(menu || panel), slash: showSlash })
  keys.current = { working, menu: !!(menu || panel), slash: showSlash }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.repeat) return
      const k = keys.current
      if (k.slash || !(k.working || k.menu)) return
      const t = e.target as HTMLElement | null
      // Esc en el buscador lo cierra (no detiene a Claude).
      if (t?.closest?.('.find-bar')) return
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
    if (menu?.form) {
      // Formulario MCP: el texto va al campo de texto enfocado.
      api.input(id, t)
      setTimeout(() => api.input(id, '\r'), 120)
    } else if (menu) {
      // Pregunta con "Type something." o permiso ("No, and tell Claude what to do differently"): el texto va ahí.
      if (!menu.input) {
        setFlash('This dialog has no text answer: choose an option above.')
        return
      }
      void answerWithText(id, t)
    } else sendPrompt(id, t)
    setText('')
  }

  return (
    <div className={`composer ${menu || panel ? 'with-menu' : ''}`}>
      {menu && <MenuPanel id={id} menu={menu} onText={() => requestAnimationFrame(() => ref.current?.focus())} />}
      {panel && <TuiPanel id={id} panel={panel} onFocusKeys={() => ref.current?.focus()} />}
      {flash && <div className="composer-flash">{flash}</div>}
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
      {!menu && !panel && cli?.text && (
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
            : panel
              ? 'Keys go to the panel: type to search, ↑/↓ to move, Enter to select, Esc to close'
              : menu?.input?.kind === 'type'
                ? 'Choose a number, or write your own answer and press Enter…'
                : menu?.input?.kind === 'amend'
                  ? 'Choose a number, or write what Claude should do instead (answers No) and press Enter…'
                  : noText
                    ? 'Choose an option with a number or the arrows…'
                    : menu
                      ? 'Type a number, use the arrows, or write an answer…'
              : working
                ? 'Claude is working. Your message is queued…'
                : 'Reply to Claude…  (/ for commands and skills)'
        }
        onChange={(e) => {
          if (panel) return
          setText(e.target.value)
          setCaret(e.target.selectionStart)
          setFlash(null)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          // En un panel lo pegado va directo (p. ej. al buscador).
          if (!panel) return
          e.preventDefault()
          api.input(id, e.clipboardData.getData('text'))
        }}
        onKeyDown={(e) => {
          if (panel) {
            const k = keyToTerm(e)
            if (k !== null) {
              e.preventDefault()
              api.input(id, k)
            }
            return
          }
          // Shift+Tab cambia el modo de permisos, como en la CLI.
          if (e.key === 'Tab' && e.shiftKey && !menu) {
            e.preventDefault()
            api.input(id, '\x1b[Z')
            return
          }
          // Esc Esc con la caja vacía y Claude quieto: rewind (volver a un mensaje anterior), como en la CLI.
          if (e.key === 'Escape' && !text && !menu && !working && !showSlash) {
            const now = Date.now()
            if (now - lastEsc.current < 600) {
              e.preventDefault()
              lastEsc.current = 0
              api.input(id, KEYS.esc)
              setTimeout(() => api.input(id, KEYS.esc), 50)
              return
            }
            lastEsc.current = now
          }
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
            // En un formulario los números se escriben (campos de texto); no eligen opciones.
            if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !menu.form) {
              e.preventDefault()
              if (!e.repeat) chooseOption(id, menu, Number(e.key))
              return
            }
            // Tab en un permiso: abre "No/Yes, and tell Claude…" en la opción con el cursor, como en la CLI.
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
          {panel ? (
            <>
              Keys go to the panel · <kbd>Esc</kbd> close
            </>
          ) : menu?.form ? (
            <>
              <kbd>↑</kbd><kbd>↓</kbd> field · <kbd>→</kbd> options · <kbd>Space</kbd> pick · <kbd>Esc</kbd> cancel
            </>
          ) : menu ? (
            <>
              <kbd>1-9</kbd> choose · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel
            </>
          ) : (
            <>
              <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>Shift</kbd>+<kbd>Tab</kbd> mode
              {working ? <> · <kbd>Esc</kbd> stop</> : <> · <kbd>Esc</kbd><kbd>Esc</kbd> rewind</>}
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <button className="primary btn-sm" disabled={!text.trim() || off || !!panel} onClick={send}>
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

// Zona en vivo y barra de estado de la CLI (ver readLive).
function useLive(id: string): Live | null {
  const [v, setV] = useState<Live | null>(null)
  useEffect(() => {
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const next = readLive(id)
        setV((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
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

// Herramientas seguidas: plegadas en una línea (la última y el total); abiertas mientras alguna corre.
function ToolGroup({ items }: { items: ConversationItem[] }) {
  const running = items.some((t) => t.tool && !t.tool.done)
  const errors = items.filter((t) => t.tool?.error).length
  const last = items[items.length - 1]
  const [open, setOpen] = useState(running)
  useEffect(() => {
    if (running) setOpen(true)
  }, [running])
  return (
    <details className="msg tools" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        {running ? <span className="tool-state running" /> : '⚙'} {last.text}
        {items.length > 1 && <span className="muted"> (+{items.length - 1} more)</span>}
        {errors > 0 && <span className="tool-errors"> · {errors} failed</span>}
      </summary>
      <ul>
        {items.map((t, i) => (
          <ToolRow key={i} item={t} />
        ))}
      </ul>
    </details>
  )
}

// Una herramienta: ícono de estado, resumen, y al desplegar la entrada completa, los cambios y el resultado.
function ToolRow({ item }: { item: ConversationItem }) {
  const t = item.tool
  if (!t) return <li className="tool-row legacy">{item.text}</li>
  const state = !t.done ? 'running' : t.error ? 'error' : 'ok'
  return (
    <li className={`tool-row ${state}`}>
      <details>
        <summary>
          <span className={`tool-state ${state}`} />
          <span className="tool-text">{item.text}</span>
          {t.done && t.result && !t.error && <span className="tool-lines">{lineCount(t.result)}</span>}
        </summary>
        <div className="tool-body">
          {t.edits ? (
            <>
              <div className="tool-label">{t.input}</div>
              {t.edits.map((e, i) => (
                <pre key={i} className="tool-diff">
                  {e.old && e.old.split('\n').map((l, j) => <span key={'o' + j} className="del">- {l}{'\n'}</span>)}
                  {e.new.split('\n').map((l, j) => <span key={'n' + j} className="add">+ {l}{'\n'}</span>)}
                </pre>
              ))}
            </>
          ) : (
            <pre className="tool-input">{t.input}</pre>
          )}
          {t.done ? (
            t.result ? <pre className={`tool-result ${t.error ? 'error' : ''}`}>{t.result}</pre> : <div className="tool-label">(no output)</div>
          ) : (
            <div className="tool-label">Running…</div>
          )}
        </div>
      </details>
    </li>
  )
}

function lineCount(s: string): string {
  const n = s.split('\n').length
  return n === 1 ? '1 line' : `${n} lines`
}

const NOTICE_ICON = { info: 'ℹ', warn: '⚠', error: '✗', done: '✓' } as const

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
  const live = useLive(id)

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

  // Si estabas abajo, se sigue el final cuando cambia cualquier alto: el texto que aparece, una vista previa que
  // termina de cargar, o el área visible que se achica porque aparece el menú o la línea de actividad (al volver
  // de otra pestaña pasaba eso y la conversación quedaba arriba).
  const innerRef = useRef<HTMLDivElement>(null)
  // Buscador (Ctrl+F) sobre la conversación cargada; se cierra al salir de Rendered (el resaltado es global).
  const [find, setFind] = useState(0)
  useFindKey(visible, () => setFind((n) => n + 1))
  useEffect(() => {
    if (!visible) setFind(0)
  }, [visible])
  useLayoutEffect(() => {
    const el = scrollRef.current
    const inner = innerRef.current
    if (!el || !inner || !visible) return
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight
    }
    follow()
    const ro = new ResizeObserver(follow)
    ro.observe(el)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [visible])

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
      {find > 0 && <FindBar focusKey={find} root={() => innerRef.current} onClose={() => setFind(0)} />}
      <div className="conversation" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
        <div className="conversation-inner" ref={innerRef}>
        {items === null && <p className="muted pad">Loading…</p>}
        {items?.length === 0 && <p className="muted pad">No messages yet. Write your first prompt below.</p>}
        {from > 0 && (
          <button className="btn-sm earlier" onClick={() => setShown((n) => n + PAGE)}>
            Show earlier messages ({from})
          </button>
        )}
        {blocks.map((b) =>
          b.kind === 'tools' ? (
            <ToolGroup key={b.key} items={b.items} />
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
          ) : b.item.kind === 'thinking' ? (
            <details key={b.key} className="msg thinking">
              <summary>✻ Thinking</summary>
              <Markdown text={b.item.text} />
            </details>
          ) : b.item.kind === 'notice' ? (
            <div key={b.key} className={`msg notice ${b.item.level ?? 'info'}`}>
              <span className="notice-icon">{NOTICE_ICON[b.item.level ?? 'info']}</span>
              <span>{b.item.text}</span>
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
      </div>
      {activity && (
        <div className="activity">
          <span className="activity-dot" />
          <span className="activity-label">{activity.label}</span>
          {activity.detail && <span className="activity-detail">{activity.detail}</span>}
          {activity.tip && <span className="activity-tip">{activity.tip}</span>}
        </div>
      )}
      {live && live.lines.length > 0 && <pre className="live-pane">{live.lines.join('\n')}</pre>}
      {live && live.footer.length > 0 && (
        <div className="cli-footer">
          {live.footer.map((f, i) => (
            <span key={i}>
              {i > 0 && '  ·  '}
              {/shift\+tab to cycle|\bmode on\b/i.test(f) ? (
                // Modo de permisos: clic para pasar al siguiente (Shift+Tab en la CLI).
                <button className="cli-mode" title="Cycle permission mode (Shift+Tab)" onClick={() => api.input(id, '\x1b[Z')}>
                  {f}
                </button>
              ) : (
                f
              )}
            </span>
          ))}
        </div>
      )}
      <Composer id={id} status={status} onOpenCli={onReply} />
    </div>
  )
}
