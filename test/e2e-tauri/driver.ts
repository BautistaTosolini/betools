import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import assert from 'node:assert/strict'

// Cliente WebDriver mínimo (W3C) contra tauri-driver + WebKitWebDriver, con la API justa para portar las pruebas
// de Playwright: localizadores con espera, aserciones con reintento y teclado/mouse reales (Actions).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const EXPECT_TIMEOUT = 10_000

// Reintenta una aserción hasta que pasa o vence el plazo (como expect.poll / expect(locator) de Playwright).
export async function eventually<T>(fn: () => T | Promise<T>, timeout = EXPECT_TIMEOUT): Promise<T> {
  const end = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      last = e
    }
    if (Date.now() > end) throw last
    await sleep(100)
  }
}

// expect.poll(() => v).toBe(x) y compañía.
export const poll = <T>(fn: () => T | Promise<T>, timeout = EXPECT_TIMEOUT) => ({
  toBe: (x: unknown) => eventually(async () => assert.strictEqual(await fn(), x), timeout),
  toEqual: (x: unknown) => eventually(async () => assert.deepStrictEqual(await fn(), x), timeout),
  toBeLessThan: (x: number) =>
    eventually(async () => {
      const v = (await fn()) as number
      assert.ok(v < x, `${v} no es menor que ${x}`)
    }, timeout),
  toContain: (x: string) =>
    eventually(async () => {
      const v = (await fn()) as string
      assert.ok(v.includes(x), `${JSON.stringify(v)} no contiene ${JSON.stringify(x)}`)
    }, timeout),
  toMatchObject: (x: object) => eventually(async () => assert.partialDeepStrictEqual(await fn(), x), timeout),
  toBeTruthy: () =>
    eventually(async () => {
      assert.ok(await fn())
    }, timeout)
})

// ---- Localizadores ----

type TextFilter = string | RegExp
interface Step {
  css: string
  hasText?: { str?: string; re?: { source: string; flags: string } }
  visible?: boolean
  nth?: number
}

// Se evalúa dentro de la página: devuelve los elementos que cumplen la cadena de pasos.
const RESOLVE = `
const norm = (s) => s.replace(/\\s+/g, ' ').trim();
const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' };
const resolve = (steps) => {
  let scope = [document];
  for (const st of steps) {
    let out = []; const seen = new Set();
    for (const s of scope) for (const e of s.querySelectorAll(st.css)) if (!seen.has(e)) { seen.add(e); out.push(e) }
    if (st.hasText) {
      const t = st.hasText;
      out = out.filter((e) => { const x = norm(e.textContent || ''); return t.re ? new RegExp(t.re.source, t.re.flags).test(x) : x.toLowerCase().includes(norm(t.str).toLowerCase()) })
    }
    if (st.visible) out = out.filter(vis);
    if (st.nth !== undefined) { const e = st.nth < 0 ? out[out.length + st.nth] : out[st.nth]; out = e ? [e] : [] }
    scope = out;
  }
  return scope;
};`

export class Locator {
  private s: Session
  private steps: Step[]
  constructor(s: Session, steps: Step[]) {
    this.s = s
    this.steps = steps
  }

  locator(css: string, o: { hasText?: TextFilter; visible?: boolean } = {}): Locator {
    const step: Step = { css }
    if (o.hasText !== undefined)
      step.hasText = typeof o.hasText === 'string' ? { str: o.hasText } : { re: { source: o.hasText.source, flags: o.hasText.flags } }
    if (o.visible) step.visible = true
    return new Locator(this.s, [...this.steps, step])
  }
  private withNth(n: number) {
    const steps = this.steps.map((x) => ({ ...x }))
    steps[steps.length - 1].nth = n
    return new Locator(this.s, steps)
  }
  first = () => this.withNth(0)
  last = () => this.withNth(-1)
  nth = (n: number) => this.withNth(n)

  // Ejecuta `body` en la página con `els` (los elementos resueltos) y `arg`.
  private run<T>(body: string, arg?: unknown): Promise<T> {
    return this.s.exec<T>(`${RESOLVE}\nconst els = resolve(arguments[0]); const arg = arguments[1];\n${body}`, [this.steps, arg])
  }

  count = () => this.run<number>('return els.length')
  texts = () => this.run<string[]>('return els.map((e) => norm(e.textContent || ""))')
  allInnerTexts = () => this.run<string[]>('return els.map((e) => e.innerText)')
  innerText = async () => (await this.run<string[]>('return els.map((e) => e.innerText)'))[0]
  value = () => this.run<string | null>('return els[0] ? els[0].value : null')
  evaluate = <R>(fn: (el: HTMLElement) => R) => this.run<R>(`return (${fn.toString()})(els[0])`)

  // Espera a que haya un elemento visible y estable; devuelve su caja en coordenadas de la ventana.
  private async settle(timeout = 10_000) {
    const end = Date.now() + timeout
    let prev = ''
    for (;;) {
      const r = await this.run<{ x: number; y: number; width: number; height: number } | null>(
        `const e = els[0]; if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null`
      )
      const key = JSON.stringify(r)
      if (r && key === prev) return r
      prev = key
      if (Date.now() > end) throw new Error(`Elemento no visible: ${JSON.stringify(this.steps)}`)
      await sleep(50)
    }
  }
  boundingBox = () => this.settle()

  async click(o: { force?: boolean } = {}) {
    if (o.force) {
      await eventually(async () => assert.ok((await this.count()) > 0, `Sin elementos: ${JSON.stringify(this.steps)}`))
      await this.run('els[0].click()')
      return
    }
    const b = await this.settle()
    await this.s.click(b.x + b.width / 2, b.y + b.height / 2, 1)
  }
  async dblclick() {
    const b = await this.settle()
    await this.s.click(b.x + b.width / 2, b.y + b.height / 2, 2)
  }

  async focus() {
    await eventually(async () => assert.ok((await this.count()) > 0, `Sin elementos: ${JSON.stringify(this.steps)}`))
    await this.run('els[0].focus()')
  }
  async fill(text: string) {
    await this.focus()
    // Mismo efecto que fill() de Playwright: asigna el valor y emite "input" (React lo escucha).
    await this.run(
      `const e = els[0]; const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, arg); e.dispatchEvent(new Event('input', { bubbles: true }))`,
      text
    )
  }
  async press(key: string) {
    await this.focus()
    await this.s.press(key)
  }
  async selectOption(o: { label: string }) {
    await eventually(async () => assert.ok((await this.count()) > 0, `Sin elementos: ${JSON.stringify(this.steps)}`))
    const ok = await this.run<boolean>(
      `const e = els[0]; const opt = [...e.options].find((x) => x.label === arg || x.textContent.trim() === arg); if (!opt) return false;
       Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, opt.value); e.dispatchEvent(new Event('change', { bubbles: true })); return true`,
      o.label
    )
    assert.ok(ok, `Sin opción ${o.label}`)
  }

  // ---- Aserciones con reintento (equivalentes a expect(locator).…) ----
  async toHaveCount(n: number, timeout = EXPECT_TIMEOUT) {
    await eventually(async () => assert.strictEqual(await this.count(), n), timeout)
  }
  async toBeVisible(timeout = EXPECT_TIMEOUT) {
    await eventually(
      async () => assert.ok(await this.run<boolean>('return els.length > 0 && vis(els[0])'), `No visible: ${JSON.stringify(this.steps)}`),
      timeout
    )
  }
  async toBeFocused() {
    await eventually(async () => assert.ok(await this.run<boolean>('return els[0] !== undefined && els[0] === document.activeElement'), 'Sin foco'))
  }
  async toHaveText(want: string | string[] | RegExp, timeout = EXPECT_TIMEOUT) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
    await eventually(async () => {
      const got = await this.texts()
      if (Array.isArray(want)) return assert.deepStrictEqual(got, want.map(norm))
      assert.ok(got.length > 0, `Sin elementos: ${JSON.stringify(this.steps)}`)
      if (want instanceof RegExp) assert.match(got[0], want)
      else assert.strictEqual(got[0], norm(want))
    }, timeout)
  }
  async toContainText(want: string | RegExp) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
    await eventually(async () => {
      const got = await this.texts()
      assert.ok(got.length > 0, `Sin elementos: ${JSON.stringify(this.steps)}`)
      if (want instanceof RegExp) assert.match(got[0], want)
      else assert.ok(got[0].includes(norm(want)), `${JSON.stringify(got[0])} no contiene ${JSON.stringify(want)}`)
    })
  }
  async notToContainText(want: string) {
    await eventually(async () => {
      const got = await this.texts()
      assert.ok(got.length > 0, `Sin elementos: ${JSON.stringify(this.steps)}`)
      assert.ok(!got[0].includes(want), `${JSON.stringify(got[0])} contiene ${JSON.stringify(want)}`)
    })
  }
  async toHaveClass(re: RegExp) {
    await eventually(async () => {
      const c = await this.run<string | null>('return els[0] ? els[0].getAttribute("class") : null')
      assert.ok(c !== null, 'Sin elementos')
      assert.match(c, re)
    })
  }
  async toHaveAttribute(name: string, re: RegExp) {
    await eventually(async () => {
      const v = await this.run<string | null>('return els[0] ? els[0].getAttribute(arg) : null', name)
      assert.ok(v !== null, `Sin atributo ${name}`)
      assert.match(v, re)
    })
  }
  async toHaveValue(want: string) {
    await eventually(async () => assert.strictEqual(await this.value(), want))
  }
}

// ---- Sesión WebDriver ----

const KEYS: Record<string, string> = {
  Control: '',
  Shift: '',
  Alt: '',
  Enter: '',
  Escape: '',
  Tab: '',
  Backspace: ''
}

export class Session {
  private base: string
  readonly id: string
  constructor(base: string, id: string) {
    this.base = base
    this.id = id
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}/session/${this.id}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const json = (await res.json()) as { value: unknown }
    if (!res.ok) throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(json.value)}`)
    return json.value
  }

  exec<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.req('POST', '/execute/sync', { script, args }) as Promise<T>
  }
  private actions(actions: unknown[]) {
    return this.req('POST', '/actions', { actions })
  }
  locator(css: string, o?: { hasText?: TextFilter; visible?: boolean }): Locator {
    return new Locator(this, []).locator(css, o)
  }

  async click(x: number, y: number, times: number) {
    const a: unknown[] = [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 }]
    for (let i = 0; i < times; i++) a.push({ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 })
    await this.actions([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: a }])
    await this.req('DELETE', '/actions')
  }
  mouse = {
    move: (x: number, y: number) => this.pointer([{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 }]),
    down: () => this.pointer([{ type: 'pointerDown', button: 0 }]),
    up: () => this.pointer([{ type: 'pointerUp', button: 0 }])
  }
  private async pointer(a: unknown[]) {
    await this.actions([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: a }])
  }

  // "Control+Shift+C", "Shift+Tab", "Enter", "3"…
  async press(combo: string) {
    const parts = combo.split('+')
    const key = parts.pop()!
    const mods = parts
    const shift = mods.includes('Shift')
    const val = KEYS[key] ?? (shift && key.length === 1 ? key.toUpperCase() : key)
    const a: unknown[] = []
    for (const m of mods) a.push({ type: 'keyDown', value: KEYS[m] })
    a.push({ type: 'keyDown', value: val }, { type: 'keyUp', value: val })
    for (const m of [...mods].reverse()) a.push({ type: 'keyUp', value: KEYS[m] })
    await this.actions([{ type: 'key', id: 'kb', actions: a }])
    await this.req('DELETE', '/actions')
  }
  async type(text: string) {
    const a: unknown[] = []
    for (const ch of text) a.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch })
    await this.actions([{ type: 'key', id: 'kb', actions: a }])
    await this.req('DELETE', '/actions')
  }

  // window.confirm/alert no se pueden aceptar por evento en WebDriver: se reemplazan y se guarda el mensaje.
  async acceptDialogs() {
    await this.exec(`window.__dialogs = window.__dialogs || []; window.confirm = (m) => { window.__dialogs.push(String(m)); return true }; window.alert = (m) => { window.__dialogs.push(String(m)) }`)
    return () => this.exec<string[]>('return window.__dialogs || []')
  }
  waitForTimeout = sleep

  async quit() {
    await this.req('DELETE', '').catch(() => {})
  }
}

// ---- Arranque de la app ----

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port
      srv.close(() => resolve(p))
    })
  })

const waitPort = async (port: number, timeout = 15_000) => {
  const end = Date.now() + timeout
  for (;;) {
    const ok = await new Promise<boolean>((r) => {
      const c = connect(port, '127.0.0.1', () => (c.destroy(), r(true)))
      c.once('error', () => r(false))
    })
    if (ok) return
    if (Date.now() > end) throw new Error(`tauri-driver no escucha en ${port}`)
    await sleep(100)
  }
}

export interface LaunchEnv {
  app: string
  tauriDriver: string
  nativeDriver: string
  env: Record<string, string>
  args: string[]
}

export interface Running {
  session: Session
  driver: ChildProcess
  // PID de todo proceso que lleva el HOME de esta instancia (driver, app, claude falso y sus hijos).
  marker: string
}

export async function launchApp(o: LaunchEnv): Promise<Running> {
  const port = await freePort()
  const nativePort = await freePort()
  const driver = spawn(o.tauriDriver, ['--port', String(port), '--native-port', String(nativePort), '--native-driver', o.nativeDriver], {
    env: { ...process.env, ...o.env },
    stdio: 'ignore'
  })
  driver.on('error', () => {})
  await waitPort(port)
  const base = `http://127.0.0.1:${port}`
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: o.app, args: o.args } } } })
  })
  const json = (await res.json()) as { value: { sessionId?: string; error?: string; message?: string } }
  if (!json.value.sessionId) {
    driver.kill('SIGKILL')
    throw new Error(`No se pudo crear la sesión: ${JSON.stringify(json.value)}`)
  }
  return { session: new Session(base, json.value.sessionId), driver, marker: `HOME=${o.env.HOME}` }
}

// PIDs de los procesos del usuario cuyo entorno incluye exactamente `marker` (HOME único por prueba).
export function pidsWithEnv(marker: string): number[] {
  const out: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      const env = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0')
      if (env.includes(marker)) out.push(Number(name))
    } catch {
      // proceso ajeno o ya terminado
    }
  }
  return out
}

export async function stopApp(r: Running) {
  await r.session.quit()
  const pids = pidsWithEnv(r.marker)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* ya terminó */
    }
  }
  const end = Date.now() + 4000
  while (Date.now() < end && pidsWithEnv(r.marker).length) await sleep(100)
  for (const pid of pidsWithEnv(r.marker)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ya terminó */
    }
  }
}

// ---- Pantalla virtual y portapapeles ----

export async function startXvfb(bin: string): Promise<{ display: string; proc: ChildProcess }> {
  for (let n = 90; n < 130; n++) {
    const display = `:${n}`
    const proc = spawn(bin, [display, '-screen', '0', '1700x1100x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
    await sleep(600)
    if (proc.exitCode === null) return { display, proc }
  }
  throw new Error('No se pudo iniciar Xvfb')
}

export function clipboardRead(display: string): string {
  const r = spawnSync('xclip', ['-display', display, '-selection', 'clipboard', '-o'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : ''
}
export function clipboardWrite(display: string, text: string) {
  spawnSync('xclip', ['-display', display, '-selection', 'clipboard', '-i'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
}
