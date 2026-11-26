import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
// Node ejecuta .ts quitando tipos y exige la extensión en el import.
import { clipboardRead, clipboardWrite, eventually, launchApp, poll, startXvfb, stopApp, type Running, type Session } from './driver.ts'

// Port de test/e2e/app.spec.ts (Playwright + Electron) a WebDriver contra la app Tauri compilada. Misma app, mismo
// "claude" falso (test/e2e/fake-claude.mjs) y mismos casos. Cada prueba usa un HOME, una carpeta de datos y una sesión
// propios: no toca el ~/.claude real ni llama a ningún modelo. Corre en una pantalla virtual (Xvfb) para no abrir
// ventanas en el escritorio.
//
// Variables (todas opcionales si los binarios están en el PATH / en target/release):
//   BETOOLS_BIN        binario de la app Tauri (por defecto target/release/betools)
//   TAURI_DRIVER       binario de tauri-driver (cargo install tauri-driver --locked)
//   WEBKIT_DRIVER      binario WebKitWebDriver (paquete webkit2gtk-driver)
//   XVFB               binario de Xvfb (paquete xvfb); E2E_USE_DISPLAY=1 usa el DISPLAY actual
//   Para correr una sola prueba: node --test --test-name-pattern="texto" test/e2e-tauri/app.spec.ts

const ROOT = resolve(import.meta.dirname, '../..')
const FAKE = join(ROOT, 'test/e2e/fake-claude.mjs')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string
const APP = process.env.BETOOLS_BIN ?? join(ROOT, 'target/release/betools')
const TAURI_DRIVER = process.env.TAURI_DRIVER ?? 'tauri-driver'
const WEBKIT_DRIVER = process.env.WEBKIT_DRIVER ?? 'WebKitWebDriver'
const XVFB = process.env.XVFB ?? 'Xvfb'

let display = process.env.DISPLAY ?? ''
let xvfb: ChildProcess | undefined
before(async () => {
  if (process.env.E2E_USE_DISPLAY) return
  const x = await startXvfb(XVFB)
  display = x.display
  xvfb = x.proc
})
after(() => {
  xvfb?.kill('SIGTERM')
})

type Page = Session

interface Ctx {
  run: Running
  page: Page
  home: string
  cwd: string
  id: string
  log: string
}
// Transcript inicial: herramienta con resultado, herramienta con error, edición, razonamiento, avisos y un
// bloque de código.
function seed(id: string, cwd: string): string {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 25, 12, 0, s)).toISOString()
  const base = { sessionId: id, cwd }
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Revisa el proyecto' }, timestamp: at(0) },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'thinking', thinking: 'Primero miro los archivos.' }] }, timestamp: at(1) },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }] }, timestamp: at(2) },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'README.md\nsrc' }] }, toolUseResult: { stdout: 'README.md\nsrc', stderr: '' }, timestamp: at(3) },
    { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'cat nope.txt' } }] }, timestamp: at(4) },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_err', is_error: true, content: 'cat: nope.txt: No such file or directory' }] }, timestamp: at(5) },
    { type: 'assistant', message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: join(cwd, 'README.md'), old_string: 'hola', new_string: 'chau' } }] }, timestamp: at(6) },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'The file has been updated.' }] }, timestamp: at(7) },
    { type: 'assistant', message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'Listo. Corre esto:\n\n```sql\nSELECT 1;\nSELECT 2;\n```' }] }, timestamp: at(8) },
    { type: 'system', subtype: 'turn_duration', durationMs: 75_000, isMeta: true, timestamp: at(9) },
    { type: 'system', subtype: 'away_summary', content: 'Revisaste el proyecto. (turn off recaps in /config)', timestamp: at(10) },
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>\n</task-notification>' }, timestamp: at(11) }
  ]
  return lines.map((l) => JSON.stringify({ ...base, ...l })).join('\n') + '\n'
}

interface LaunchOpts {
  history?: boolean
  // Carpeta que contiene el proyecto (path = cwd) con sus variables, y variables propias de la sesión.
  folderEnv?: Record<string, string>
  sessionEnv?: Record<string, string>
}

const plainVars = (vars: Record<string, string>) =>
  Object.entries(vars).map(([name, value]) => ({ name, source: { kind: 'plain', value }, updatedAt: '2026-11-25T00:00:00.000Z' }))

async function launch(opts: LaunchOpts = {}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), 'betools-e2e-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  const ud = join(root, 'userdata')
  const log = join(root, 'fake.log')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(ud, { recursive: true })
  writeFileSync(log, '')
  const id = randomUUID()
  const now = new Date().toISOString()
  const folders = opts.folderEnv ? [{ id: 'f1', name: 'Client', color: '#5b8def', path: cwd, env: plainVars(opts.folderEnv) }] : []
  const session = { id, name: 'e2e', cwd, createdAt: now, lastActiveAt: now, ...(opts.sessionEnv ? { env: plainVars(opts.sessionEnv) } : {}) }
  writeFileSync(join(ud, 'sessions.json'), JSON.stringify({ folders, sessions: [session], selectedId: id }))
  writeFileSync(join(ud, 'settings.json'), JSON.stringify({ closeToTray: false, autostart: false, notifications: false, eagerStart: false, remoteControl: false }))
  if (opts.history !== false) {
    const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), seed(id, cwd))
  }
  return start({ home, cwd, id, log, ud })
}

async function start(c: { home: string; cwd: string; id: string; log: string; ud: string }): Promise<Ctx> {
  const run = await launchApp({
    app: APP,
    tauriDriver: TAURI_DRIVER,
    nativeDriver: WEBKIT_DRIVER,
    args: [`--user-data-dir=${c.ud}`],
    env: { HOME: c.home, DISPLAY: display, CLAWHIP_CLAUDE_BIN: FAKE, FAKE_LOG: c.log, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }
  })
  const page = run.session
  await eventually(async () => assert.ok((await page.locator('.tabbar').count()) > 0), 30_000)
  return { run, page, home: c.home, cwd: c.cwd, id: c.id, log: c.log }
}

// Cierra la app y la vuelve a abrir con los mismos datos (como reiniciar betools).
async function restartApp(c: Ctx): Promise<Ctx> {
  await stopApp(c.run)
  return start({ ...c, ud: join(c.home, '..', 'userdata') })
}

const events = (ctx: Ctx) =>
  readFileSync(ctx.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const tab = (page: Page, name: 'Rendered' | 'Terminal' | 'CLI') => page.locator('.tabbar .tab', { hasText: new RegExp(`^${name}$`) }).click()
const composer = (page: Page) => page.locator('.composer textarea')

async function prompt(ctx: Ctx, text: string) {
  // El proceso de Claude ya arrancó (dibujó el prompt) antes de mandar.
  await poll(() => events(ctx).some((e) => e.ev === 'hook' && e.event === 'SessionStart')).toBe(true)
  await composer(ctx.page).fill(text)
  await composer(ctx.page).press('Enter')
  await poll(() => events(ctx).some((e) => e.ev === 'prompt' && e.text === text)).toBe(true)
}

let ctx = undefined as unknown as Ctx
afterEach(async () => {
  if (ctx) {
    await stopApp(ctx.run).catch(() => {})
    rmSync(join(ctx.home, '..'), { recursive: true, force: true })
    ctx = undefined as unknown as Ctx
  }
})

const T = { timeout: 90_000 }

test('shows the installed version in the header', T, async () => {
  ctx = await launch()
  await ctx.page.locator('.brand-version').toHaveText(`v${VERSION}`)
})

test('starts Claude with --resume and the status hooks of betools', T, async () => {
  ctx = await launch()
  await poll(() => events(ctx).find((e) => e.ev === 'start')).toBeTruthy()
  const start = events(ctx).find((e) => e.ev === 'start')
  for (const a of ['--resume', ctx.id, '--settings']) assert.ok(start.args.includes(a), `falta ${a} en ${JSON.stringify(start.args)}`)
  assert.strictEqual(start.statusFile, true)
  // En reposo la barra lateral no muestra estado (solo trabajando, esperando o terminado).
  await ctx.page.locator('.sidebar').toBeVisible()
  await ctx.page.locator('.sidebar .status').toHaveCount(0)
})

test('starts a new session with --session-id when there is no transcript', T, async () => {
  ctx = await launch({ history: false })
  await poll(() => events(ctx).find((e) => e.ev === 'start')?.args.includes('--session-id') && events(ctx).find((e) => e.ev === 'start')?.args.includes(ctx.id)).toBe(true)
})

describe('Rendered: history from the transcript', () => {
  test('shows tools with their result, errors, edits, thinking and notices', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await p.locator('.msg.user').first().toContainText('Revisa el proyecto')
    await p.locator('.tool-row').toHaveCount(3)
    await p.locator('.tool-row.error').toHaveCount(1)
    await p.locator('.msg.tools summary').first().toContainText('1 failed')

    // Se despliega el grupo y cada herramienta.
    await p.locator('.msg.tools > summary').first().click()
    const ok = p.locator('.tool-row.ok').first()
    await ok.locator('summary').click()
    await ok.locator('.tool-input').toHaveText('# List files\nls -la')
    await ok.locator('.tool-result').toHaveText('README.md\nsrc')
    const err = p.locator('.tool-row.error')
    await err.locator('summary').click()
    await err.locator('.tool-result.error').toContainText('No such file')

    const edit = p.locator('.tool-row', { hasText: 'Edit' })
    await edit.locator('summary').click()
    await edit.locator('.tool-diff .del').toHaveText('- hola\n')
    await edit.locator('.tool-diff .add').toHaveText('+ chau\n')

    await p.locator('.msg.thinking summary').toHaveText('✻ Thinking')
    await p.locator('.msg.notice.done', { hasText: 'Worked for 1m 15s' }).toBeVisible()
    await p.locator('.msg.notice.info', { hasText: 'Recap: Revisaste el proyecto.' }).notToContainText('turn off recaps')
    await p.locator('.msg.notice.done', { hasText: 'Background command "Build" completed' }).toBeVisible()
  })

  test('code blocks are one block: no border or background per line', T, async () => {
    ctx = await launch()
    const code = ctx.page.locator('.md pre code').first()
    await code.toContainText('SELECT 1;')
    const style = await code.evaluate((el) => ({ shadow: getComputedStyle(el).boxShadow, bg: getComputedStyle(el).backgroundColor }))
    assert.deepStrictEqual(style, { shadow: 'none', bg: 'rgba(0, 0, 0, 0)' })
  })
})

describe('Rendered: live work', () => {
  test('a prompt shows activity, the live pane and the running tool, then the reply and status done', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'work')
    await p.locator('.msg.user', { hasText: 'work' }).toBeVisible()
    await p.locator('.activity-label').toHaveText('Pondering…')
    await p.locator('.live-pane').toContainText('Read the code')
    await p.locator('.live-pane').toContainText('Explore(Find components)')
    await p.locator('.live-pane').notToContainText('Tip:')
    await p.locator('.cli-footer').toContainText('auto mode on')
    await p.locator('.status.working').first().toBeVisible()
    await p.locator('.tool-row.running').toHaveCount(1)
    await p.locator('.tool-row.running').toHaveCount(0, 15_000)
    await p.locator('.msg.assistant').last().toContainText('All 42 tests pass.')
    await p.locator('.activity').toHaveCount(0)
    await p.locator('.live-pane').toHaveCount(0)
    assert.deepStrictEqual(events(ctx).filter((e) => e.ev === 'hook').map((e) => e.event), ['SessionStart', 'UserPromptSubmit', 'Stop'])
  })

  test('Esc interrupts Claude from Rendered', T, async () => {
    ctx = await launch()
    await prompt(ctx, 'work')
    await ctx.page.locator('.activity-label').toHaveText('Pondering…')
    await ctx.page.press('Escape')
    await poll(() => events(ctx).some((e) => e.ev === 'input' && e.data === '\x1b')).toBe(true)
    await ctx.page.locator('.msg.summary', { hasText: 'Interrupted by user' }).toBeVisible()
  })
})

describe('Rendered: dialogs', () => {
  test('numbered permission menu: status waiting and choosing an option by click', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'ask')
    await p.locator('.menu-panel .menu-option').toHaveCount(3)
    await p.locator('.menu-panel').toContainText('rm -rf build')
    await p.locator('.status.waiting').first().toBeVisible()
    await p.locator('.menu-panel .menu-option', { hasText: "don't ask again" }).click()
    await poll(() => events(ctx).find((e) => e.ev === 'menu')?.choice).toBe("Yes, and don't ask again")
    await p.locator('.menu-panel').toHaveCount(0)
  })

  test('numbered permission menu: digit keys choose from the composer', T, async () => {
    ctx = await launch()
    await prompt(ctx, 'ask')
    await ctx.page.locator('.menu-panel .menu-option').toHaveCount(3)
    await composer(ctx.page).press('3')
    await poll(() => events(ctx).find((e) => e.ev === 'menu')?.choice).toBe('No')
  })

  test('permission menu: a written answer rejects with that feedback (No + Tab), never approves', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'ask')
    await p.locator('.menu-panel .menu-option').toHaveCount(3)
    await composer(p).toHaveAttribute('placeholder', /answers No/)
    await composer(p).fill('usa otro directorio')
    await composer(p).press('Enter')
    await poll(() => events(ctx).find((e) => e.ev === 'menu')).toMatchObject({ choice: 'No, usa otro directorio', feedback: 'usa otro directorio' })
  })

  test('AskUserQuestion: every option is shown, including "Chat about this" below the divider', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'question')
    await p.locator('.menu-panel .menu-option').toHaveCount(4)
    await p.locator('.menu-panel .menu-question').toHaveText('Which color do you want?')
    await p.locator('.menu-panel .menu-option').nth(2).toContainText('write below')
  })

  test('AskUserQuestion: clicking "Type something." does not reject the question; the answer goes there', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'question')
    await p.locator('.menu-panel .menu-option', { hasText: 'Type something.' }).click()
    await composer(p).toBeFocused()
    await p.locator('.menu-panel .menu-option.on').toContainText('Type something.')
    // Antes se mandaba Enter y Claude Code lo tomaba como "Declined to answer".
    assert.strictEqual(events(ctx).some((e) => e.ev === 'question'), false)
    await composer(p).fill('verde agua')
    await composer(p).press('Enter')
    await poll(() => events(ctx).find((e) => e.ev === 'question')).toMatchObject({ answer: 'verde agua', declined: false })
  })

  test('AskUserQuestion: writing without choosing first also answers in "Type something."', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'question')
    await p.locator('.menu-panel .menu-option').toHaveCount(4)
    await composer(p).press('3')
    assert.strictEqual(events(ctx).some((e) => e.ev === 'question'), false)
    await composer(p).fill('amarillo')
    await composer(p).press('Enter')
    await poll(() => events(ctx).find((e) => e.ev === 'question')?.answer).toBe('amarillo')
  })

  test('a menu without a text answer does not send typed text (no option gets confirmed)', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'mcp')
    await p.locator('.menu-panel .menu-option').toHaveCount(3)
    await composer(p).fill('hola')
    await composer(p).press('Enter')
    await p.locator('.composer-flash').toContainText('no text answer')
    await p.waitForTimeout(400)
    assert.strictEqual(events(ctx).some((e) => e.ev === 'menu'), false)
    await composer(p).toHaveValue('hola')
  })

  test('menu without numbers ("New MCP server found") is clickable', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'mcp')
    await p.locator('.menu-panel .menu-option').toHaveCount(3)
    await p.locator('.menu-panel .menu-option.on').toContainText('Continue without')
    await p.locator('.menu-panel .menu-option', { hasText: /^1Use this MCP server$/ }).click()
    await poll(() => events(ctx).find((e) => e.ev === 'menu')?.choice).toBe('Use this MCP server')
  })

  test('MCP form: choose, toggle, type and accept', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, 'form')
    const fields = p.locator('.form-field > .menu-option')
    await fields.toHaveCount(3)
    await p.locator('.menu-panel .menu-question').toHaveText('MCP server “fake” requests your input')
    await fields.nth(0).click() // despliega
    await p.locator('.form-choices .menu-option').toHaveCount(2)
    await p.locator('.form-choices .menu-option', { hasText: 'Reject' }).click()
    await fields.nth(0).toContainText('Reject')
    await fields.nth(1).click() // foco
    await fields.nth(1).toContainText('No')
    await fields.nth(1).click() // alterna
    await fields.nth(1).toContainText('Yes')
    await fields.nth(2).click()
    await fields.nth(2).toContainText('type below')
    await composer(p).fill('hola mundo')
    await composer(p).press('Enter')
    await fields.nth(2).toContainText('hola mundo')
    await p.locator('.menu-keys button', { hasText: 'Accept' }).click()
    await poll(() => events(ctx).find((e) => e.ev === 'form')).toMatchObject({ action: 'accept', content: { decision: 'Reject', confirm: true, name: 'hola mundo' } })
  })

  test('MCP form: decline from the first field', T, async () => {
    ctx = await launch()
    await prompt(ctx, 'form')
    await ctx.page.locator('.form-field').toHaveCount(3)
    await ctx.page.locator('.menu-keys button', { hasText: 'Decline' }).click()
    await poll(() => events(ctx).find((e) => e.ev === 'form')?.action).toBe('decline')
  })
})

test('slash autocomplete: Claude Code commands at once, init skills after, hidden ones never', T, async () => {
  ctx = await launch()
  const p = ctx.page
  await composer(p).fill('/')
  await p.locator('.slash-item').first().toBeVisible(2000)
  await composer(p).fill('/res')
  await p.locator('.slash-name').first().toHaveText('/resume')
  await composer(p).fill('/fake-init')
  await p.locator('.slash-name').first().toHaveText('/fake-init-skill')
  await composer(p).fill('/workflow-launch')
  await p.locator('.slash-item').toHaveCount(0)
  await composer(p).fill('/')
  const names = await p.locator('.slash-name').allInnerTexts()
  assert.ok(!names.includes('/__hidden'))
  assert.deepStrictEqual([...names].sort((a, b) => a.localeCompare(b)), names)
  // La sonda de comandos nunca puede llegar a la API.
  assert.ok(events(ctx).filter((e) => e.ev === 'probe').every((e) => e.baseUrl === 'http://127.0.0.1:9'))
})

test('Rendered stays at the bottom after switching tabs', T, async () => {
  ctx = await launch()
  const p = ctx.page
  await prompt(ctx, 'long')
  await p.locator('.msg.assistant', { hasText: 'Long answer 60.' }).toBeVisible()
  const gap = () => p.locator('.conversation').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  await poll(gap).toBeLessThan(5)
  for (const other of ['CLI', 'Terminal', 'CLI'] as const) {
    await tab(p, other)
    await p.waitForTimeout(500)
    await tab(p, 'Rendered')
    await poll(gap).toBeLessThan(5)
  }
})

describe('copy in the terminal', () => {
  const clipboard = () => clipboardRead(display)

  test('OSC 52 from Claude Code reaches the clipboard', T, async () => {
    ctx = await launch()
    clipboardWrite(display, 'before')
    await prompt(ctx, 'copy')
    await poll(clipboard).toBe('copied from fake claude ✓')
  })

  test('Ctrl+Shift+C copies the selection; Ctrl+C always goes to the process', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await poll(() => events(ctx).some((e) => e.ev === 'hook' && e.event === 'SessionStart')).toBe(true)
    await tab(p, 'CLI')
    const screen = p.locator('.terminal-wrap', { visible: true }).locator('.xterm-screen')
    await screen.toBeVisible()
    clipboardWrite(display, 'before')
    // Selección con el mouse sobre la primera línea ("● Fake Claude ready.").
    const box = await screen.boundingBox()
    await p.mouse.move(box.x + 2, box.y + 6)
    await p.mouse.down()
    for (let i = 1; i <= 8; i++) await p.mouse.move(box.x + 2 + ((160 - 2) * i) / 8, box.y + 6)
    await p.mouse.up()
    await p.press('Control+Shift+C')
    await poll(clipboard).toContain('Fake Claude')
    clipboardWrite(display, 'unchanged')
    await p.press('Control+C')
    await poll(() => events(ctx).some((e) => e.ev === 'ctrl-c')).toBe(true)
    assert.strictEqual(clipboard(), 'unchanged')
  })
})

describe('Rendered: command panels (/config, /usage…)', () => {
  test('shows the panel and moves, toggles, switches tabs, searches and closes from Rendered', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await prompt(ctx, '/config')
    const panel = p.locator('.tui-panel')
    await panel.toBeVisible()
    await panel.locator('.tui-row', { hasText: 'Auto-compact' }).toHaveClass(/on/)
    // Sin la conversación de arriba.
    await panel.notToContainText('Fake Claude ready')
    await composer(p).toBeFocused()

    // Clic en una fila: el cursor va ahí, salteando la línea que no se puede elegir.
    await panel.locator('.tui-row', { hasText: 'Verbose output' }).click()
    await panel.locator('.tui-row.on').toContainText('Verbose output')
    await poll(() => events(ctx).filter((e) => e.ev === 'panel').at(-1)?.cursor).toBe('Verbose output')

    // Atajo de la línea de ayuda ("Space to toggle").
    await panel.locator('.menu-keys .key', { hasText: 'toggle' }).click()
    await poll(() => events(ctx).find((e) => e.ev === 'panel' && e.action === 'toggle')).toMatchObject({ item: 'Verbose output', on: true })

    // Doble clic: mueve y confirma (Enter).
    const enters = () => events(ctx).filter((e) => e.ev === 'input' && e.data === '\r').length
    const before = enters()
    await panel.locator('.tui-row', { hasText: 'Show tips' }).dblclick()
    await panel.locator('.tui-row.on').toContainText('Show tips')
    await poll(enters).toBe(before + 1)

    // El teclado va al panel: el buscador recibe lo escrito.
    await composer(p).focus()
    await p.type('verb')
    await poll(() => events(ctx).filter((e) => e.ev === 'panel').at(-1)?.search).toBe('verb')
    await composer(p).toHaveValue('')

    // Clic en una pestaña.
    const tabRow = panel.locator('.tui-row', { hasText: /^\s*Settings\s/ })
    const box = await tabRow.boundingBox()
    const ch = await tabRow.evaluate((el) => {
      const s = document.createElement('span')
      s.textContent = 'M'.repeat(10)
      el.appendChild(s)
      const w = s.getBoundingClientRect().width / 10
      s.remove()
      return w
    })
    const line = await tabRow.innerText()
    await p.click(box.x + 10 + (line.indexOf('Usage') + 2.5) * ch, box.y + box.height / 2, 1)
    await panel.toContainText('Usage tab')

    // Esc cierra el panel y vuelve la caja normal.
    await p.press('Escape')
    await poll(() => events(ctx).find((e) => e.ev === 'panel' && e.action === 'close')?.items).toMatchObject({ 'Verbose output': true })
    await panel.toHaveCount(0)
  })

  test('Shift+Tab and the mode in the footer cycle the permission mode', T, async () => {
    ctx = await launch()
    const p = ctx.page
    await poll(() => events(ctx).some((e) => e.ev === 'hook' && e.event === 'SessionStart')).toBe(true)
    await composer(p).focus()
    await p.press('Shift+Tab')
    await poll(() => events(ctx).filter((e) => e.ev === 'input' && e.data === '\x1b[Z').length).toBe(1)
    await p.locator('.cli-footer .cli-mode').click()
    await poll(() => events(ctx).filter((e) => e.ev === 'input' && e.data === '\x1b[Z').length).toBe(2)
  })
})

describe('Environment variables', () => {
  const starts = (c: Ctx) => events(c).filter((e) => e.ev === 'start')
  const stored = (c: Ctx) => JSON.parse(readFileSync(join(c.home, '..', 'userdata', 'sessions.json'), 'utf8'))
  const names = (vars: { name: string }[]) => vars.map((v) => v.name)
  const openSessionEnv = async (p: Page) => {
    await p.locator('.kebab-btn[title="Session actions"]').click()
    await p.locator('.menu-item', { hasText: 'Environment variables…' }).click()
    await p.locator('.modal h2').toContainText('Variables for')
  }

  test('session and folder variables persist across app restarts and reach Claude', T, async () => {
    ctx = await launch({ folderEnv: { E2E_FOLDER: 'from-folder' }, sessionEnv: { E2E_SESSION: 'from-session' } })
    await poll(() => starts(ctx)[0]?.env).toEqual({ E2E_FOLDER: 'from-folder', E2E_SESSION: 'from-session' })
    // Una variable nueva desde la interfaz queda en sessions.json (no en memoria).
    await openSessionEnv(ctx.page)
    await ctx.page.locator('.env-editor > button', { hasText: 'Add variable' }).click()
    await ctx.page.locator('.env-form input').first().fill('E2E_ADDED')
    await ctx.page.locator('.env-form label', { hasText: 'Value' }).locator('input').fill('typed')
    await ctx.page.locator('.env-form button.primary').click()
    await ctx.page.locator('.env-list:not(.inherited) .env-name').toHaveText(['E2E_ADDED', 'E2E_SESSION'])
    const s = stored(ctx).sessions[0]
    assert.deepStrictEqual(names(s.env).sort(), ['E2E_ADDED', 'E2E_SESSION'])
    // Al cambiar, la sesión se reinicia sola y Claude recibe la nueva.
    const all = { E2E_ADDED: 'typed', E2E_FOLDER: 'from-folder', E2E_SESSION: 'from-session' }
    await poll(() => starts(ctx).at(-1)?.env, 15_000).toEqual(all)
    // Reiniciar betools: siguen ahí y Claude las vuelve a recibir.
    const before = starts(ctx).length
    ctx = await restartApp(ctx)
    await poll(() => starts(ctx).length, 15_000).toBe(before + 1)
    assert.deepStrictEqual(starts(ctx).at(-1).env, all)
    await openSessionEnv(ctx.page)
    await ctx.page.locator('.env-list:not(.inherited) .env-name').toHaveText(['E2E_ADDED', 'E2E_SESSION'])
    await ctx.page.locator('.env-list.inherited .env-name').toHaveText(['E2E_FOLDER'])
  })

  test('moves a variable from the session to its folder and back', T, async () => {
    ctx = await launch({ folderEnv: { E2E_FOLDER: 'from-folder' }, sessionEnv: { E2E_SESSION: 'from-session' } })
    const p = ctx.page
    await poll(() => starts(ctx).length).toBe(1)
    await p.acceptDialogs()
    await openSessionEnv(p)

    // Sesión → carpeta.
    await p.locator('.env-list:not(.inherited) li', { hasText: 'E2E_SESSION' }).locator('select.env-move').selectOption({ label: 'folder Client' })
    await p.locator('.env-list.inherited .env-name').toHaveText(['E2E_FOLDER', 'E2E_SESSION'])
    await p.locator('.env-list:not(.inherited) .empty').toBeVisible()
    let st = stored(ctx)
    assert.deepStrictEqual(st.sessions[0].env, [])
    assert.deepStrictEqual(names(st.folders[0].env), ['E2E_FOLDER', 'E2E_SESSION'])
    // Claude la sigue recibiendo, ahora heredada de la carpeta.
    await poll(() => starts(ctx).at(-1)?.env, 15_000).toEqual({ E2E_FOLDER: 'from-folder', E2E_SESSION: 'from-session' })

    // Carpeta → sesión ("Move here" en una heredada).
    await p.locator('.env-list.inherited li', { hasText: 'E2E_FOLDER' }).locator('button', { hasText: 'Move here' }).click()
    await p.locator('.env-list:not(.inherited) .env-name').toHaveText(['E2E_FOLDER'])
    await p.locator('.env-list.inherited .env-name').toHaveText(['E2E_SESSION'])
    st = stored(ctx)
    assert.deepStrictEqual(names(st.folders[0].env), ['E2E_SESSION'])
    assert.partialDeepStrictEqual(st.sessions[0].env, [{ name: 'E2E_FOLDER', source: { kind: 'plain', value: 'from-folder' } }])
  })

  test('asks before replacing a variable that already exists in the destination', T, async () => {
    ctx = await launch({ folderEnv: { E2E_DUP: 'folder-value' }, sessionEnv: { E2E_DUP: 'session-value' } })
    const p = ctx.page
    const dialogs = await p.acceptDialogs()
    await openSessionEnv(p)
    await p.locator('.env-list.inherited li', { hasText: 'E2E_DUP' }).toContainText('overridden in this session')
    await p.locator('.env-list:not(.inherited) li', { hasText: 'E2E_DUP' }).locator('select.env-move').selectOption({ label: 'folder Client' })
    await poll(async () => (await dialogs()).length).toBe(2)
    assert.ok((await dialogs())[1].includes('already has E2E_DUP'))
    await p.locator('.env-list:not(.inherited) .empty').toBeVisible()
    assert.partialDeepStrictEqual(stored(ctx).folders[0].env, [{ name: 'E2E_DUP', source: { value: 'session-value' } }])
  })

  test('the folder dialog moves a variable to one of its sessions', T, async () => {
    ctx = await launch({ folderEnv: { E2E_FOLDER: 'from-folder' } })
    const p = ctx.page
    await p.acceptDialogs()
    const group = p.locator('.sidebar .kebab-btn[title="Folder actions"]')
    await group.click({ force: true })
    await p.locator('.menu-item', { hasText: 'Environment variables…' }).click()
    await p.locator('.modal h2').toHaveText('Variables for folder Client')
    await p.locator('.env-list li', { hasText: 'E2E_FOLDER' }).locator('select.env-move').selectOption({ label: 'session e2e' })
    await p.locator('.env-list .empty').toBeVisible()
    assert.partialDeepStrictEqual(stored(ctx).sessions[0].env, [{ name: 'E2E_FOLDER' }])
  })
})

test('a closed session file is not left behind in the real HOME', () => {
  // Salvaguarda: las pruebas nunca escriben en el ~/.claude real.
  assert.strictEqual(existsSync(join(process.env.HOME ?? '', '.claude', 'projects', 'betools-e2e')), false)
})
