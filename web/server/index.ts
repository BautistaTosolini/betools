import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { PtyManager } from '../../src/main/pty-manager'
import { SHELL_PREFIX, ShellManager } from '../../src/main/shell-manager'
import { StatusTracker } from '../../src/main/status-tracker'
import { discoverSessions } from '../../src/main/discover'
import { resolveEnv, validateName } from '../../src/main/env-core'
import type { EnvScope, EnvSource, Session } from '../../src/shared/types'
import { WebStore } from './store'
import { MasterKeySecrets, readMasterKey } from './master-secrets'

// clawhip web: selector de sesiones + Claude + terminal + variables, para correr en un contenedor
// (p. ej. en una Raspberry Pi) y usarlo desde el navegador. Sin autenticación: pensado para una red
// aislada. Cualquiera que llegue al puerto puede ejecutar comandos con el usuario del contenedor.

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const DATA = process.env.CLAWHIP_DATA_DIR || '/data'
const PUBLIC = join(import.meta.dirname, 'public')

const store = new WebStore(DATA)
const secrets = new MasterKeySecrets(DATA, readMasterKey())
const clients = new Set<WebSocket>()

const broadcast = (channel: string, ...args: unknown[]) => {
  const msg = JSON.stringify({ t: 'event', channel, args })
  for (const c of clients) if (c.readyState === c.OPEN) c.send(msg)
}
const sendTo = (ws: WebSocket, channel: string, ...args: unknown[]) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'event', channel, args }))
}

const envLayers = (session: Session) => [{ scope: { kind: 'session', id: session.id } as EnvScope, vars: store.envOf({ kind: 'session', id: session.id }) }]

const status = new StatusTracker(join(DATA, 'status'), (id, next) => broadcast('session:status', id, next))
const ptys = new PtyManager({
  // La versión web no activa Remote Control (por ahora solo la app de escritorio).
  remoteControlName: () => null,
  onSpawn: (id) => status.start(id),
  onData: (id, data) => broadcast('pty:data', id, data),
  onExit: (id, code) => {
    status.exited(id)
    broadcast('pty:exit', id, code)
  },
  resolveEnv: (session) => resolveEnv(envLayers(session), secrets)
})
const shells = new ShellManager({
  onData: (key, data) => broadcast('pty:data', key, data),
  onExit: (key, code) => broadcast('pty:exit', key, code),
  resolveEnv: (session) => resolveEnv(envLayers(session), secrets)
})

const isShell = (key: string) => key.startsWith(SHELL_PREFIX)
const sessionOf = (key: string) => store.find(isShell(key) ? key.slice(SHELL_PREFIX.length) : key)

function assertDir(p: string): void {
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`No existe la carpeta ${p}`)
}

function checkSource(src: EnvSource): EnvSource {
  if (src.kind === 'plain') return { kind: 'plain', value: String(src.value ?? '') }
  if (src.kind === 'local') return { kind: 'local' }
  throw new Error('En la versión web solo hay variables visibles y cifradas.')
}

// Autocompletado de carpetas para el diálogo de sesión nueva (no hay selector nativo).
function completeDir(prefix: string): string[] {
  const p = prefix.startsWith('~') ? join(homedir(), prefix.slice(1)) : prefix || homedir() + '/'
  const dir = p.endsWith('/') ? p : dirname(p)
  const start = p.endsWith('/') ? '' : basename(p)
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name.startsWith(start))
      .slice(0, 50)
      .map((d) => join(dir, d.name))
      .sort()
  } catch {
    return []
  }
}

type Handler = (ws: WebSocket, ...args: any[]) => unknown

// Métodos: los mismos nombres que la API de la app de escritorio (window.clawhip).
const methods: Record<string, Handler> = {
  listSessions: () => {
    const st = store.get()
    return {
      folders: [],
      ...st,
      status: Object.fromEntries(st.sessions.map((s) => [s.id, status.get(s.id)])),
      titles: {}
    }
  },
  createSession: (_ws, cwd: string, name: string) => {
    assertDir(cwd)
    const now = new Date().toISOString()
    const s: Session = { id: randomUUID(), name: name?.trim() || basename(cwd), cwd, createdAt: now, lastActiveAt: now }
    store.add(s)
    broadcast('sessions:changed')
    return s
  },
  discoverSessions: () => discoverSessions(new Set(store.get().sessions.map((s) => s.id))),
  importSession: (_ws, id: string, cwd: string, name: string) => {
    if (store.find(id)) throw new Error('La sesión ya está en la lista')
    assertDir(cwd)
    const now = new Date().toISOString()
    const s: Session = { id, name: name?.trim() || basename(cwd), cwd, createdAt: now, lastActiveAt: now }
    store.add(s)
    broadcast('sessions:changed')
    return s
  },
  closeSession: (_ws, id: string) => {
    ptys.kill(id)
    shells.kill(SHELL_PREFIX + id)
    status.forget(id)
    secrets.deleteScope({ kind: 'session', id })
    store.remove(id)
    broadcast('sessions:changed')
  },
  renameSession: (_ws, id: string, name: string) => {
    store.rename(id, name)
    broadcast('sessions:changed')
  },
  selectSession: (_ws, id: string) => {
    store.select(id)
    status.seen(id)
  },
  completeDir: (_ws, prefix: string) => completeDir(prefix),
  homeDir: () => homedir(),

  // Terminales: "<id>" = Claude, "shell:<id>" = terminal. Lo acumulado va solo a quien se conecta.
  attach: (ws, key: string, cols: number, rows: number) => {
    const s = sessionOf(key)
    if (!s) return
    const buf = isShell(key) ? shells.attach(s, cols, rows) : ptys.attach(s, cols, rows)
    if (buf) sendTo(ws, 'pty:data', key, buf)
  },
  restart: (_ws, key: string, cols: number, rows: number) => {
    const s = sessionOf(key)
    if (!s) return
    if (isShell(key)) {
      shells.kill(key)
      shells.attach(s, cols, rows)
    } else {
      ptys.kill(key)
      ptys.attach(s, cols, rows)
    }
  },
  input: (_ws, key: string, data: string) => (isShell(key) ? shells.write(key, data) : ptys.write(key, data)),
  resize: (_ws, key: string, cols: number, rows: number) => (isShell(key) ? shells.resize(key, cols, rows) : ptys.resize(key, cols, rows)),
  restartSession: (_ws, id: string) => {
    const s = store.find(id)
    if (!s) return
    const size = ptys.size(id) ?? { cols: 120, rows: 40 }
    ptys.kill(id)
    broadcast('pty:reset', id)
    ptys.attach(s, size.cols, size.rows)
  },
  isRunning: (_ws, id: string) => ptys.isRunning(id),
  runCommand: (_ws, id: string, command: string) => {
    const s = store.find(id)
    if (s && command?.trim()) shells.run(s, command.trim())
  },

  // Variables: nunca se devuelven valores cifrados, solo nombre/origen/fecha (las visibles sí).
  listEnv: (_ws, scope: EnvScope) => store.envOf(scope),
  envLayers: (_ws, sessionId: string) => {
    const s = store.find(sessionId)
    return s ? envLayers(s).map((l) => ({ ...l, label: 'sesión' })) : []
  },
  setEnv: (_ws, scope: EnvScope, name: string, source: EnvSource, value?: string) => {
    validateName(name)
    const src = checkSource(source)
    if (src.kind === 'local') {
      if (typeof value !== 'string' || value === '') throw new Error('Escribe el valor.')
      secrets.set(scope, name, value)
    } else {
      secrets.delete(scope, name)
    }
    store.setEnv(scope, { name, source: src, updatedAt: new Date().toISOString() })
  },
  deleteEnv: (_ws, scope: EnvScope, name: string) => {
    secrets.delete(scope, name)
    store.deleteEnv(scope, name)
  },
  secureStorage: () => secrets.available(),
  awsProfiles: () => [],
  testEnvRef: () => {
    throw new Error('No disponible en la versión web')
  }
}

// Archivos estáticos del cliente (sin path traversal).
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }
  let file = normalize(join(PUBLIC, decodeURIComponent(url.pathname)))
  if (!file.startsWith(resolve(PUBLIC))) {
    res.writeHead(403).end()
    return
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC, 'index.html')
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
  })
  createReadStream(file).pipe(res)
})

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 })
wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('message', async (raw) => {
    let msg: { t: string; id?: number; method: string; args: unknown[] }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    const fn = methods[msg.method]
    try {
      if (!fn) throw new Error(`Método desconocido: ${msg.method}`)
      const value = await fn(ws, ...(msg.args ?? []))
      if (msg.id !== undefined) ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, value }))
    } catch (e) {
      if (msg.id !== undefined) ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
  })
})

// Sin will-quit acá: con la señal de parada del contenedor se terminan los procesos de Claude.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    ptys.killAll()
    shells.killAll()
    wss.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}

server.listen(PORT, HOST, () => {
  console.log(`clawhip web escuchando en http://${HOST}:${PORT} (datos en ${DATA}, HOME=${homedir()})`)
  if (!secrets.available().ok) console.log('Aviso: sin clave maestra; las variables cifradas no están disponibles.')
})
