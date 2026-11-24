import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, unwatchFile, watchFile } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { PtyManager } from './pty-manager'
import { SHELL_PREFIX, ShellManager } from './shell-manager'
import { SessionStore } from './session-store'
import { TranscriptWatcher } from './transcript-watcher'
import { openArtifact, revealArtifact } from './artifact-opener'
import { StatusTracker } from './status-tracker'
import { SettingsStore } from './settings'
import { discoverSessions } from './discover'
import { migrateLegacyData } from './migrate'
import { TabTitles } from './titles'
import { DailyTokenCounter, StatusLineWatcher } from './usage'
import { INTERRUPTED } from './transcript-parser'
import { listSlashCommandsFull } from './slash-commands'
import { awsProfiles, LocalSecrets, resolveEnv, resolveRef, validateName } from './secrets'
import type { EnvScope, EnvSource, Folder, FolderSuggestion, SavedCommand, Session, SessionMeta, SessionStatus, Settings } from '../shared/types'

// Dos instancias reanudarían las mismas sesiones y escribirían el mismo transcript.
if (!app.requestSingleInstanceLock()) app.exit(0)

// Instalada, el ícono va fuera del asar (extraResources) para que las notificaciones puedan leerlo.
const ICON = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../resources/icon.png')
const startHidden = process.argv.includes('--hidden')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let store: SessionStore
let settings: SettingsStore
let ptys: PtyManager
let shells: ShellManager
let watcher: TranscriptWatcher
let status: StatusTracker
let titles: TabTitles
let secrets: LocalSecrets
let lines: StatusLineWatcher
let daily: DailyTokenCounter

// "claude-opus-5-5" → "Opus 5.5"; "claude-sonnet-4-5-20250929" → "Sonnet 4.5". Solo para cuando
// todavía no hay status line (sesión sin lanzar): ahí Claude Code da el nombre visible.
function prettyModel(id: string | null): string | null {
  if (!id) return null
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}${m[4] ? ' (1M)' : ''}`
}

// Reinicio automático al cambiar variables. Si la sesión está trabajando o esperando una respuesta tuya
// (permiso, pregunta, selección), se espera a que termine. Debounce para que agregar varias variables
// seguidas reinicie una sola vez.
const pendingRestart = new Set<string>()
const restartTimers = new Map<string, NodeJS.Timeout>()

function restartNow(id: string): void {
  const session = store.find(id)
  if (!session) return
  const size = ptys.size(id) ?? { cols: 120, rows: 40 }
  ptys.kill(id)
  send('pty:reset', id)
  ptys.attach(session, size.cols, size.rows)
}

function setPending(id: string, on: boolean): void {
  if (on === pendingRestart.has(id)) return
  if (on) pendingRestart.add(id)
  else pendingRestart.delete(id)
  send('session:pendingRestart', id, on)
}

function applyRestart(id: string): void {
  if (!ptys.isRunning(id)) return setPending(id, false)
  const st = status.get(id)
  if (st === 'working' || st === 'waiting') return setPending(id, true)
  setPending(id, false)
  restartNow(id)
}

// Sesiones que usan las variables de un ámbito: la sesión misma, o las de la carpeta.
function sessionsUsing(scope: EnvScope): Session[] {
  if (scope.kind === 'session') return store.get().sessions.filter((s) => s.id === scope.id)
  return store.get().sessions.filter((s) => envLayers(s).some((l) => l.scope.kind === 'folder' && l.scope.id === scope.id))
}

function envChanged(scope: EnvScope): void {
  for (const s of sessionsUsing(scope)) {
    // Sin proceso no hay nada que reiniciar: toma las variables al arrancar.
    if (!ptys.isRunning(s.id)) continue
    clearTimeout(restartTimers.get(s.id))
    restartTimers.set(
      s.id,
      setTimeout(() => {
        restartTimers.delete(s.id)
        applyRestart(s.id)
      }, 1500)
    )
  }
}

// Visor de documentos: solo Markdown, hasta 5 MB. Cada documento abierto se vigila (polling) y se
// reenvía al renderer cuando cambia, por ejemplo si Claude lo edita.
const DOC_EXTS = new Set(['.md', '.markdown', '.mdx'])
const DOC_MAX = 5 * 1024 * 1024
const docWatch = new Map<string, number>()

function readDoc(path: string): { text: string; mtime: number } {
  if (!DOC_EXTS.has(extname(path).toLowerCase())) throw new Error('Only Markdown files can be opened in betools.')
  const st = statSync(path)
  if (!st.isFile()) throw new Error(`Not a file: ${path}`)
  if (st.size > DOC_MAX) throw new Error('The file is too large to preview (over 5 MB).')
  return { text: readFileSync(path, 'utf8'), mtime: st.mtimeMs }
}

function watchDoc(path: string): void {
  const n = docWatch.get(path) ?? 0
  docWatch.set(path, n + 1)
  if (n > 0) return
  watchFile(path, { interval: 1000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return
    try {
      send('doc:changed', path, readDoc(path))
    } catch {
      send('doc:changed', path, null) // se borró o se volvió ilegible
    }
  })
}

function unwatchDoc(path: string): void {
  const n = (docWatch.get(path) ?? 0) - 1
  if (n > 0) return void docWatch.set(path, n)
  docWatch.delete(path)
  unwatchFile(path)
}

function metaOf(id: string): SessionMeta {
  const live = lines.getMeta(id)
  return { model: live?.model ?? prettyModel(watcher.model(id)), contextPct: live?.contextPct ?? null }
}

// Capas de variables de una sesión: primero las de su carpeta, después las propias (pisan).
// La carpeta se calcula igual que en la interfaz: el path (principal o adicional) más largo.
function envLayers(session: Session): { scope: EnvScope; vars: import('../shared/types').EnvVarMeta[] }[] {
  let folder: Folder | undefined
  let best = -1
  for (const f of store.get().folders) {
    for (const p of [f.path, ...(f.extraPaths ?? [])]) {
      const base = p.replace(/\/+$/, '')
      if ((session.cwd === base || session.cwd.startsWith(base + '/')) && base.length > best) {
        folder = f
        best = base.length
      }
    }
  }
  const layers: { scope: EnvScope; vars: import('../shared/types').EnvVarMeta[] }[] = []
  if (folder) layers.push({ scope: { kind: 'folder', id: folder.id }, vars: store.envOf({ kind: 'folder', id: folder.id }) })
  layers.push({ scope: { kind: 'session', id: session.id }, vars: store.envOf({ kind: 'session', id: session.id }) })
  return layers
}

// Valida una referencia de AWS antes de guardarla (sin shell; perfil y región obligatorios donde aplica).
function checkSource(src: EnvSource): EnvSource {
  if (src.kind === 'local') return { kind: 'local' }
  if (src.kind === 'plain') {
    if (typeof src.value !== 'string') throw new Error('Enter the value.')
    return { kind: 'plain', value: src.value }
  }
  const profile = src.profile?.trim()
  if (!profile) throw new Error('Choose the AWS profile.')
  const region = src.region?.trim() || undefined
  if (src.kind === 'aws-sm') {
    if (!src.secretId?.trim()) throw new Error('Enter the secret name or ARN.')
    return { kind: 'aws-sm', profile, region, secretId: src.secretId.trim(), jsonKey: src.jsonKey?.trim() || undefined }
  }
  if (!src.name?.trim()) throw new Error('Enter the parameter name.')
  return { kind: 'aws-ssm', profile, region, name: src.name.trim() }
}

// Título visible: el de la pestaña (<TICKET> <resumen>) y, si no hay, el de Claude (/rename o ai-title).
const displayTitle = (id: string): string | null => titles.get(id) ?? watcher.title(id)
const labelOf = (s: Session) => displayTitle(s.id) ?? s.name
const emitTitle = (id: string) => {
  send('session:title', id, displayTitle(id))
  updateTray()
}

function assertDir(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Folder not found: ${path}`)
}

// Paths adicionales: se normalizan, sin duplicados ni el principal. Pueden no existir ya
// (sesiones de una estructura de carpetas vieja), así que no se valida que existan.
function cleanExtra(paths: string[] | undefined, main?: string): string[] {
  const out = new Set<string>()
  for (const p of paths ?? []) {
    const t = p.trim().replace(/\/+$/, '')
    if (t && t !== main) out.add(t)
  }
  return [...out]
}

// Paths adicionales sugeridos a partir de tus sesiones: cwd con ".../clients/<nombre>".
function suggestExtraPaths(name: string, taken: string[]): string[] {
  const n = name.trim().toLowerCase()
  if (!n) return []
  const out = new Set<string>()
  for (const s of discoverSessions(new Set(), 2000)) {
    const m = /^(.*\/clients\/([^/]+))(\/|$)/.exec(s.cwd)
    if (m && m[2].toLowerCase() === n) out.add(m[1])
  }
  return [...out].filter((p) => !taken.includes(p)).sort()
}

// Sugerencias para carpetas nuevas: ~/workdir/<área>/clients/<cliente>.
function suggestFolders(): FolderSuggestion[] {
  const root = join(homedir(), 'workdir')
  const taken = new Set(store.get().folders.map((f) => f.path))
  const out: FolderSuggestion[] = []
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    } catch {
      return []
    }
  }
  for (const area of dirs(root)) {
    for (const client of dirs(join(root, area.name, 'clients'))) {
      if (client.name === 'archived') continue
      const path = join(root, area.name, 'clients', client.name)
      if (!taken.has(path)) out.push({ name: client.name, path })
    }
  }
  return out
}

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    title: 'betools',
    icon: ICON,
    show: !startHidden,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // La ventana nunca navega fuera de la app (p. ej. un link en la vista Rendered): se abre afuera.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Sin menú: el menú por defecto de Electron captura Ctrl+R, Ctrl+W, etc., que Claude usa.
  Menu.setApplicationMenu(null)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  // Con "cerrar a la bandeja", la X oculta la ventana y las sesiones siguen corriendo.
  win.on('close', (e) => {
    if (!quitting && tray && settings.get().closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('focus', () => {
    const id = store.get().selectedId
    if (id) status.seen(id)
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

const TRAY_LABEL: Partial<Record<SessionStatus, string>> = {
  working: '⏳',
  waiting: '❗',
  done: '✔'
}

function updateTray(): void {
  if (!tray) return
  const sessions = store.get().sessions
  const waiting = sessions.filter((s) => status.get(s.id) === 'waiting').length
  tray.setToolTip(waiting ? `betools — ${waiting} waiting for input` : 'betools')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: showWindow },
      { type: 'separator' },
      ...sessions.map((s) => ({
        label: `${TRAY_LABEL[status.get(s.id)] ?? '  '} ${labelOf(s)}`,
        click: () => selectFromOutside(s.id)
      })),
      { type: 'separator' },
      {
        label: 'Quit (stops the sessions)',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray(): void {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 22, height: 22 }))
    tray.on('click', showWindow)
    updateTray()
  } catch {
    // Sin soporte de bandeja: la X cierra la app como antes.
    tray = null
  }
}

function selectFromOutside(id: string): void {
  store.select(id)
  status.seen(id)
  send('ui:select', id)
  showWindow()
}

function notify(id: string, next: SessionStatus): void {
  if (!settings.get().notifications || !Notification.isSupported()) return
  const session = store.find(id)
  if (!session) return
  // No se avisa de la sesión que estás mirando.
  if (win?.isVisible() && win.isFocused() && store.get().selectedId === id) return
  const body = next === 'waiting' ? 'Needs your input' : 'Done'
  const n = new Notification({ title: labelOf(session), body, icon: ICON, urgency: next === 'waiting' ? 'critical' : 'normal' })
  n.on('click', () => selectFromOutside(id))
  n.show()
}

function registerIpc(): void {
  ipcMain.handle('sessions:list', () => {
    const state = store.get()
    return {
      ...state,
      status: Object.fromEntries(state.sessions.map((s) => [s.id, status.get(s.id)])),
      titles: Object.fromEntries(state.sessions.map((s) => [s.id, displayTitle(s.id)]))
    }
  })

  const addSession = (session: Session): Session => {
    store.add(session)
    watcher.watch(session)
    titles.watch(session.id)
    // Las sesiones importadas ya pueden tener título (Warp, /rename o ai-title): se avisa enseguida.
    emitTitle(session.id)
    return session
  }

  // title: "<TICKET> <resumen>" opcional; se guarda en ~/.claude/tab-titles como hace el script de Warp.
  ipcMain.handle('sessions:create', (_e, cwd: string, name: string, title?: string): Session => {
    assertDir(cwd)
    const now = new Date().toISOString()
    const session = addSession({ id: randomUUID(), name: name.trim() || basename(cwd), cwd, createdAt: now, lastActiveAt: now })
    if (title?.trim()) titles.set(session.id, title)
    return session
  })
  ipcMain.handle('sessions:setTitle', (_e, id: string, title: string) => {
    if (store.find(id)) titles.set(id, title)
  })

  ipcMain.handle('folders:create', (_e, f: Omit<Folder, 'id'>): Folder => {
    assertDir(f.path)
    const folder: Folder = {
      id: randomUUID(),
      name: f.name.trim() || basename(f.path),
      color: f.color,
      path: f.path,
      extraPaths: cleanExtra(f.extraPaths, f.path)
    }
    store.addFolder(folder)
    return folder
  })
  ipcMain.handle('folders:update', (_e, id: string, patch: Partial<Omit<Folder, 'id'>>) => {
    if (patch.path) assertDir(patch.path)
    if (patch.extraPaths) patch.extraPaths = cleanExtra(patch.extraPaths, patch.path)
    return store.updateFolder(id, patch)
  })
  ipcMain.handle('folders:move', (_e, id: string, delta: -1 | 1) => store.moveFolder(id, delta))
  ipcMain.handle('folders:suggestExtra', (_e, name: string, taken: string[]) => suggestExtraPaths(name, taken))
  ipcMain.handle('folders:delete', (_e, id: string) => {
    secrets.deleteScope({ kind: 'folder', id })
    store.removeFolder(id)
  })

  // Variables de entorno. Ningún handler devuelve valores: solo nombre, origen y fecha.
  ipcMain.handle('env:list', (_e, scope: EnvScope) => store.envOf(scope))
  ipcMain.handle('env:layers', (_e, sessionId: string) => {
    const session = store.find(sessionId)
    if (!session) return []
    return envLayers(session).map((l) => ({
      scope: l.scope,
      label: l.scope.kind === 'folder' ? store.get().folders.find((f) => f.id === l.scope.id)?.name ?? '' : 'session',
      vars: l.vars
    }))
  })
  ipcMain.handle('env:set', (_e, scope: EnvScope, name: string, source: EnvSource, value?: string) => {
    validateName(name)
    const src = checkSource(source)
    if (src.kind === 'local') {
      // Reemplazar el origen sin valor nuevo no está permitido para "local": hace falta el valor.
      if (typeof value !== 'string' || value === '') throw new Error('Enter the value.')
      secrets.set(scope, name, value)
    } else {
      secrets.delete(scope, name) // si antes era local, se borra el valor cifrado
    }
    store.setEnv(scope, { name, source: src, updatedAt: new Date().toISOString() })
    envChanged(scope)
  })
  ipcMain.handle('env:delete', (_e, scope: EnvScope, name: string) => {
    secrets.delete(scope, name)
    store.deleteEnv(scope, name)
    envChanged(scope)
  })
  // Prueba una referencia de AWS: solo informa si se pudo leer y el largo, nunca el valor.
  ipcMain.handle('env:test', async (_e, source: EnvSource) => {
    const v = await resolveRef(checkSource(source))
    return { ok: true, length: v.length }
  })
  ipcMain.handle('env:awsProfiles', () => awsProfiles())
  ipcMain.handle('env:secureStorage', () => {
    try {
      secrets.assertSecureBackend()
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })
  // Reinicia el proceso de la sesión para que tome las variables nuevas (retoma con --resume).
  ipcMain.handle('sessions:restart', (_e, id: string) => {
    setPending(id, false)
    restartNow(id)
  })
  ipcMain.handle('sessions:pendingRestart', () => [...pendingRestart])
  ipcMain.handle('conversation:get', (_e, id: string) => watcher.conversation(id))
  // Links de la vista Rendered: solo http(s) y mailto, en el navegador del sistema.
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^(https?:|mailto:)/i.test(url)) return shell.openExternal(url)
  })
  ipcMain.handle('sessions:running', (_e, id: string) => ptys.isRunning(id))
  ipcMain.handle('folders:suggest', () => suggestFolders())

  ipcMain.handle('sessions:discover', () => discoverSessions(new Set(store.get().sessions.map((s) => s.id))))

  ipcMain.handle('sessions:import', (_e, id: string, cwd: string, name: string): Session => {
    if (store.find(id)) throw new Error('The session is already in the list')
    if (!existsSync(cwd)) throw new Error(`The session folder no longer exists: ${cwd}`)
    const now = new Date().toISOString()
    return addSession({ id, name: name.trim() || basename(cwd), cwd, createdAt: now, lastActiveAt: now })
  })

  ipcMain.handle('sessions:close', (_e, id: string) => {
    ptys.kill(id)
    shells.kill(SHELL_PREFIX + id)
    secrets.deleteScope({ kind: 'session', id })
    watcher.unwatch(id)
    titles.unwatch(id)
    status.forget(id)
    lines.forget(id)
    clearTimeout(restartTimers.get(id))
    restartTimers.delete(id)
    pendingRestart.delete(id)
    store.remove(id)
    updateTray()
  })
  ipcMain.handle('sessions:rename', (_e, id: string, name: string) => {
    store.rename(id, name.trim())
    updateTray()
  })
  ipcMain.handle('sessions:select', (_e, id: string) => {
    store.select(id)
    status.seen(id)
  })

  ipcMain.handle('usage:get', () => ({
    limits: lines.getLimits(),
    daily: daily.get(),
    meta: Object.fromEntries(store.get().sessions.map((s) => [s.id, metaOf(s.id)]))
  }))

  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => settings.update(patch))

  ipcMain.handle('slash:list', (_e, sessionId: string) => {
    const session = store.find(sessionId)
    return session ? listSlashCommandsFull(session.cwd) : []
  })
  ipcMain.handle('doc:read', (_e, path: string) => readDoc(path))
  ipcMain.handle('doc:watch', (_e, path: string) => watchDoc(path))
  ipcMain.handle('doc:unwatch', (_e, path: string) => unwatchDoc(path))

  ipcMain.handle('artifacts:list', (_e, id: string) => watcher.list(id))
  ipcMain.handle('artifacts:open', (_e, path: string) => openArtifact(path))
  ipcMain.handle('artifacts:reveal', (_e, path: string) => revealArtifact(path))

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // attach: lanza el pty si no corre; si ya corría, reenvía lo acumulado como si fuera salida nueva.
  // Va por el mismo canal pty:data para mantener el orden con la salida posterior.
  // Las claves "shell:<id>" son la terminal de la sesión; el resto, el proceso de Claude.
  const isShell = (key: string) => key.startsWith(SHELL_PREFIX)
  const sessionOf = (key: string) => store.find(isShell(key) ? key.slice(SHELL_PREFIX.length) : key)

  // attach: lanza el pty si no corre; si ya corría, reenvía lo acumulado como si fuera salida nueva.
  // Va por el mismo canal pty:data para mantener el orden con la salida posterior.
  ipcMain.on('pty:attach', (_e, key: string, cols: number, rows: number) => {
    const session = sessionOf(key)
    if (!session) return
    const buffer = isShell(key) ? shells.attach(session, cols, rows) : ptys.attach(session, cols, rows)
    if (buffer) send('pty:data', key, buffer)
  })
  ipcMain.on('pty:restart', (_e, key: string, cols: number, rows: number) => {
    const session = sessionOf(key)
    if (!session) return
    if (isShell(key)) {
      shells.kill(key)
      shells.attach(session, cols, rows)
    } else {
      ptys.kill(key)
      ptys.attach(session, cols, rows)
    }
  })
  ipcMain.on('pty:input', (_e, key: string, data: string) => (isShell(key) ? shells.write(key, data) : ptys.write(key, data)))
  ipcMain.on('pty:resize', (_e, key: string, cols: number, rows: number) =>
    isShell(key) ? shells.resize(key, cols, rows) : ptys.resize(key, cols, rows)
  )

  ipcMain.handle('shell:run', (_e, sessionId: string, command: string) => {
    const session = store.find(sessionId)
    if (session && command.trim()) shells.run(session, command.trim())
  })
  ipcMain.handle('folders:setCommands', (_e, folderId: string, commands: SavedCommand[]) => {
    const clean = commands
      .map((c) => ({ id: c.id || randomUUID(), name: c.name.trim(), command: c.command.trim() }))
      .filter((c) => c.command)
    return store.updateFolder(folderId, { commands: clean })
  })
}

app.on('second-instance', showWindow)

app.whenReady().then(() => {
  migrateLegacyData()
  store = new SessionStore()
  settings = new SettingsStore()
  secrets = new LocalSecrets()
  status = new StatusTracker(join(app.getPath('userData'), 'status'), (id, next) => {
    send('session:status', id, next)
    updateTray()
    // Reinicio pendiente por cambio de variables: se hace cuando Claude termina el turno.
    if (pendingRestart.has(id)) {
      if (next === 'exited') setPending(id, false)
      else if (next === 'idle' || next === 'done') setTimeout(() => applyRestart(id), 1000)
    }
    if (next === 'waiting' || next === 'done') notify(id, next)
  })
  ptys = new PtyManager({
    onSpawn: (id) => {
      const file = status.start(id)
      lines.watch(id, file)
      return file
    },
    onData: (id, data) => send('pty:data', id, data),
    onExit: (id, code) => {
      status.exited(id)
      send('pty:exit', id, code)
    },
    resolveEnv: (session) => resolveEnv(envLayers(session), secrets),
    // Nombre en claude.ai/el teléfono: el título de betools (ticket + resumen). Sin título, Claude lo nombra
    // con la conversación.
    remoteControlName: (session) => (settings.get().remoteControl ? displayTitle(session.id) ?? '' : null)
  })
  shells = new ShellManager({
    onData: (key, data) => send('pty:data', key, data),
    onExit: (key, code) => send('pty:exit', key, code),
    resolveEnv: (session) => resolveEnv(envLayers(session), secrets)
  })
  lines = new StatusLineWatcher(
    join(app.getPath('userData'), 'plan-limits.json'),
    (id) => send('session:meta', id, metaOf(id)),
    (limits) => send('usage:limits', limits)
  )
  watcher = new TranscriptWatcher(
    (id, artifacts) => send('artifacts:changed', id, artifacts),
    (id) => emitTitle(id),
    (id) => send('session:meta', id, metaOf(id)),
    (id, start, items) => {
      send('conversation:changed', id, start, items)
      // Solo interrupciones recientes: al cargar el transcript entero aparecen también las viejas.
      if (start > 0 && items.some((it) => it.kind === 'summary' && it.text === INTERRUPTED && Date.now() - Date.parse(it.at ?? '') < 60_000))
        status.interrupted(id)
    }
  )
  daily = new DailyTokenCounter((t) => send('usage:daily', t))
  titles = new TabTitles((id) => emitTitle(id))
  for (const s of store.get().sessions) {
    watcher.watch(s)
    titles.watch(s.id)
  }

  registerIpc()
  createWindow()
  daily.start(10_000)
  createTray()

  // Opcional: levantar todas las sesiones al iniciar (por defecto se levantan al seleccionarlas).
  // Tamaño provisorio; la terminal lo corrige al mostrarse.
  if (settings.get().eagerStart) for (const s of store.get().sessions) ptys.attach(s, 120, 40)
})

app.on('before-quit', () => {
  quitting = true
})

// Al salir se terminan los procesos; las sesiones siguen en sessions.json
// y se retoman con --resume en el próximo arranque.
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  ptys?.killAll()
  shells?.killAll()
})

// Con SIGTERM/SIGINT/SIGHUP (apagado de la PC, kill, cierre de la terminal en desarrollo) Electron
// sale sin pasar por will-quit y los procesos de Claude quedaban huérfanos: se terminan acá.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    quitting = true
    ptys?.killAll()
    shells?.killAll()
    app.quit()
  })
}
