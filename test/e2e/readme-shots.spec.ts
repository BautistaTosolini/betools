import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Capturas del README (docs/screenshots). No es una prueba: solo corre con README_SHOTS=1.
//   README_SHOTS=1 npm run test:e2e -- readme-shots
// Todo es ficticio (clientes, sesiones, variables, conversación) y aislado como en app.spec.ts: HOME, datos de la
// app y "claude" falsos. Nunca usa datos reales.

test.skip(!process.env.README_SHOTS, 'Only to regenerate the README screenshots (README_SHOTS=1).')

const ROOT = resolve(import.meta.dirname, '../..')
const FAKE = join(import.meta.dirname, 'fake-claude.mjs')
const OUT = join(ROOT, 'docs', 'screenshots')

const PLAN = `# Health checks for the API gateway

Goal: every service answers \`GET /healthz\` and the load balancer stops sending traffic to an unhealthy task.

## Steps

- [x] Add the \`/healthz\` route to the gateway
- [x] Unit tests for the healthy and degraded responses
- [ ] Point the target group health check to \`/healthz\`
- [ ] Alarm when fewer than 2 tasks are healthy

## Responses

| Status | When | Body |
|---|---|---|
| 200 | Database and cache reachable | \`{"status":"ok"}\` |
| 503 | One dependency down | \`{"status":"degraded"}\` |

> The check never calls third-party APIs: a slow provider must not take the gateway out of rotation.

\`\`\`bash
curl -s localhost:8080/healthz
\`\`\`
`

function transcript(id: string, cwd: string): string {
  const t0 = Date.now() - 20 * 60_000
  const at = (s: number) => new Date(t0 + s * 8_000).toISOString()
  const usage = { input_tokens: 2_400, output_tokens: 1_850, cache_creation_input_tokens: 18_000, cache_read_input_tokens: 96_000 }
  const base = { sessionId: id, cwd }
  const a = (mid: string, content: unknown[]) => ({ type: 'assistant', message: { id: mid, role: 'assistant', model: 'claude-opus-5-5', content, usage } })
  const r = (tid: string, content: string, extra = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content }] }, ...extra })
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Add a /healthz endpoint to the gateway and write the plan in PLAN.md' } },
    a('m1', [{ type: 'thinking', thinking: 'Look at the router first, then add the route and its tests.' }]),
    a('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls src/routes', description: 'List the gateway routes' } }]),
    r('t1', 'auth.ts\norders.ts\nusers.ts', { toolUseResult: { stdout: 'auth.ts\norders.ts\nusers.ts', stderr: '' } }),
    a('m2', [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: join(cwd, 'src/routes/health.ts'), content: 'export const health = …' } }]),
    r('t2', 'File created successfully.'),
    a('m3', [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: join(cwd, 'src/server.ts'), old_string: 'app.use(orders)', new_string: 'app.use(orders)\napp.use(health)' } }]),
    r('t3', 'The file has been updated.'),
    a('m4', [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'npm test -- health', description: 'Run the health check tests' } }]),
    r('t4', 'PASS  test/health.test.ts\n  ✓ answers 200 when everything is up\n  ✓ answers 503 when the database is down\n\nTests: 2 passed', {
      toolUseResult: { stdout: 'PASS  test/health.test.ts\nTests: 2 passed', stderr: '' }
    }),
    a('m5', [{ type: 'tool_use', id: 't5', name: 'Write', input: { file_path: join(cwd, 'PLAN.md'), content: PLAN } }]),
    r('t5', 'File created successfully.'),
    a('m6', [
      {
        type: 'text',
        text: 'Done. The gateway answers `GET /healthz`:\n\n- **200** when the database and the cache respond.\n- **503** when one of them is down.\n\nThe two tests pass. To try it locally:\n\n```bash\ncurl -s localhost:8080/healthz\n```\n\nThe next steps (target group and alarm) are in `PLAN.md`.'
      }
    ]),
    { type: 'system', subtype: 'turn_duration', durationMs: 94_000, isMeta: true }
  ]
  return lines.map((l, i) => JSON.stringify({ ...base, timestamp: at(i), ...l })).join('\n') + '\n'
}

const plain = (name: string, value: string) => ({ name, source: { kind: 'plain', value }, updatedAt: '2026-11-26T00:00:00.000Z' })

let app: ElectronApplication
let root: string

async function demo(): Promise<{ page: Page; log: string; root: string; statusLine: string }> {
  root = mkdtempSync(join(tmpdir(), 'betools-demo-'))
  const home = join(root, 'home')
  const ud = join(root, 'userdata')
  const log = join(root, 'fake.log')
  const work = join(home, 'work')
  const dirs = {
    gateway: join(work, 'acme', 'api-gateway'),
    pipeline: join(work, 'acme', 'data-pipeline'),
    billing: join(work, 'initech', 'billing-migration'),
    infra: join(work, 'initech', 'infra-live'),
    notes: join(work, 'notes')
  }
  for (const d of [ud, ...Object.values(dirs)]) mkdirSync(d, { recursive: true })
  mkdirSync(join(dirs.gateway, 'src', 'routes'), { recursive: true })
  writeFileSync(join(dirs.gateway, 'PLAN.md'), PLAN)
  writeFileSync(join(dirs.gateway, 'src', 'routes', 'health.ts'), 'export const health = {}\n')
  writeFileSync(join(dirs.gateway, 'src', 'server.ts'), 'app.use(health)\n')
  writeFileSync(log, '')
  const now = Date.now()
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  const ids = { gateway: '11111111-1111-4111-8111-111111111111', pipeline: '22222222-2222-4222-8222-222222222222', billing: '33333333-3333-4333-8333-333333333333', infra: '44444444-4444-4444-8444-444444444444', notes: '55555555-5555-4555-8555-555555555555' }
  const session = (k: keyof typeof ids, name: string, min: number, extra = {}) => ({ id: ids[k], name, cwd: dirs[k], createdAt: ago(min + 60), lastActiveAt: ago(min), ...extra })
  const folders = [
    {
      id: 'acme',
      name: 'Acme',
      color: '#5b8def',
      path: join(work, 'acme'),
      env: [plain('AWS_PROFILE', 'acme-dev'), plain('AWS_REGION', 'us-east-1')],
      commands: [{ id: 'c1', name: 'AWS login', command: 'aws sso login --profile acme-dev' }]
    },
    { id: 'initech', name: 'Initech', color: '#e0a03a', path: join(work, 'initech'), env: [plain('AWS_PROFILE', 'initech-prod')] }
  ]
  const sessions = [
    session('gateway', 'ACME-142 api-gateway health checks', 2, {
      env: [
        plain('API_BASE_URL', 'https://api.dev.acme.example'),
        { name: 'DATABASE_PASSWORD', source: { kind: 'local' }, updatedAt: '2026-11-26T00:00:00.000Z' },
        { name: 'STRIPE_KEY', source: { kind: 'aws-sm', profile: 'acme-dev', region: 'us-east-1', secretId: 'acme/dev/payments', jsonKey: 'stripe_key' }, updatedAt: '2026-11-26T00:00:00.000Z' }
      ]
    }),
    session('pipeline', 'ACME-118 ACME-121 nightly ETL retries', 35),
    session('billing', 'INI-57 billing migration plan', 80),
    session('infra', 'INI-63 terraform upgrade', 190),
    session('notes', 'weekly notes', 600)
  ]
  writeFileSync(join(ud, 'sessions.json'), JSON.stringify({ folders, sessions, selectedId: ids.gateway }))
  writeFileSync(join(ud, 'settings.json'), JSON.stringify({ closeToTray: false, autostart: false, notifications: false, eagerStart: false, remoteControl: false }))
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) {
    const dir = join(home, '.claude', 'projects', dirs[k].replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${ids[k]}.jsonl`), k === 'gateway' ? transcript(ids[k], dirs[k]) : '')
  }
  app = await electron.launch({
    args: [ROOT, `--user-data-dir=${ud}`],
    cwd: ROOT,
    env: { ...process.env, HOME: home, CLAWHIP_CLAUDE_BIN: FAKE, FAKE_LOG: log, ELECTRON_ENABLE_LOGGING: '0' } as Record<string, string>
  })
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    // Pantalla completa a 1920×1080, como se usa la app (no la ventana chica con la que abre).
    w.setFullScreen(false)
    w.setBounds({ x: 0, y: 0, width: 1920, height: 1080 })
    w.setContentSize(1920, 1080)
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.tabbar')
  return { page, log, root, statusLine: join(ud, 'status', `${ids.gateway}.status.line`) }
}

// Las rutas temporales del demo se muestran como ~, igual que un HOME real; sin restos del "claude" falso.
async function tidy(p: Page, root: string) {
  await p.evaluate((home) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue?.includes(home)) n.nodeValue = n.nodeValue.split(home).join('~')
    document.querySelectorAll('[title]').forEach((e) => e.setAttribute('title', e.getAttribute('title')!.split(home).join('~')))
    for (const e of document.querySelectorAll('.conversation *')) if (e.children.length === 0 && e.textContent === 'Fake session started') e.parentElement?.remove()
  }, join(root, 'home'))
}

// Lo que Claude Code le pasa al status line (modelo, contexto y límites del plan): llena la barra de arriba.
function statusBar(file: string) {
  const resets = (h: number) => Math.floor(Date.now() / 1000) + h * 3600
  writeFileSync(file, JSON.stringify({
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: { used_percentage: 34 },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: resets(2) }, seven_day: { used_percentage: 18, resets_at: resets(90) } }
  }))
}

const started = (log: string) => readFileSync(log, 'utf8').includes('"SessionStart"')
let demoRoot = ''
const shot = async (p: Page, name: string) => {
  await tidy(p, demoRoot)
  await p.screenshot({ path: join(OUT, `${name}.png`) })
}
const tab = (p: Page, name: string) => p.locator('.tabbar .tab', { hasText: new RegExp(`^${name}$`) }).click()

test.afterEach(async () => {
  await app?.close().catch(() => {})
  if (root) rmSync(root, { recursive: true, force: true })
})

test('README screenshots', async () => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  const { page: p, log, root: r, statusLine } = await demo()
  demoRoot = r
  await expect.poll(() => started(log)).toBe(true)
  statusBar(statusLine)
  // Las herramientas que usó Claude, desplegadas.
  await p.locator('.conversation').getByText(/\(\+\d+ more\)/).first().click().catch(() => {})
  await expect(p.locator('.artifact-name', { hasText: 'PLAN.md' })).toBeVisible()
  await p.waitForTimeout(800)
  await shot(p, 'rendered')
  // La barra lateral sola: en la captura completa, achicada en el README, los tickets no se llegan a leer.
  const bar = (await p.locator('.sidebar').boundingBox())!
  await p.screenshot({ path: join(OUT, 'sidebar.png'), clip: { x: bar.x, y: bar.y, width: bar.width, height: 520 } })

  // Permiso pedido por Claude, respondido desde Rendered.
  await p.locator('.composer textarea').fill('ask')
  await p.locator('.composer textarea').press('Enter')
  await expect(p.locator('.menu-panel')).toBeVisible()
  await p.waitForTimeout(400)
  await shot(p, 'permission')
  await p.keyboard.press('Escape')


  // Visor de Markdown y edición visual.
  await p.locator('.artifact-name', { hasText: 'PLAN.md' }).click()
  await expect(p.locator('.doc h1')).toHaveText('Health checks for the API gateway')
  // Más ancho para el documento: se pliega el panel de artefactos.
  await p.locator('.artifacts [title="Collapse panel"], aside [title="Collapse panel"]').last().click()
  await p.locator('.doc-bar button', { hasText: /^Edit$/ }).click()
  await p.locator('.rich-md p').first().click()
  await p.waitForTimeout(400)
  await shot(p, 'markdown-visual')
  await p.locator('.doc-bar .seg button', { hasText: /^Source$/ }).click()
  await p.waitForTimeout(400)
  await shot(p, 'markdown-source')
  await p.locator('.doc-bar .seg button', { hasText: /^Visual$/ }).click()
  await p.locator('.doc-bar button', { hasText: /^Done$/ }).click()

  // Variables de entorno de la sesión (con las heredadas de la carpeta).
  await tab(p, 'Rendered')
  await p.locator('.kebab-btn[title="Session actions"]').click()
  await p.locator('.menu-item', { hasText: 'Environment variables…' }).click()
  await expect(p.locator('.modal h2')).toContainText('Variables for')
  await p.waitForTimeout(300)
  await shot(p, 'env-vars')
})

test('README screenshot: command panel', async () => {
  mkdirSync(OUT, { recursive: true })
  const { page: p, log, root: r, statusLine } = await demo()
  demoRoot = r
  await expect.poll(() => started(log)).toBe(true)
  statusBar(statusLine)
  // Paneles de la CLI (/config, /usage, /model…) dibujados en Rendered.
  await p.locator('.composer textarea').fill('/config')
  await p.locator('.composer textarea').press('Enter')
  await expect(p.locator('.tui-panel')).toBeVisible()
  await p.waitForTimeout(400)
  await shot(p, 'panel')
})
