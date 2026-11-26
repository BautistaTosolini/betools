// Instala window.clawhip sobre Tauri con la misma API exacta que src/preload/index.ts.
// Cada método usa el mismo nombre de canal que en Electron; los comandos genéricos ipc_invoke / ipc_send
// los recibe el despachador de Rust, y los eventos llegan por un único evento Tauri "ipc" {channel, args}.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ClawhipApi } from '../../preload'

type Listener = (...args: any[]) => void

// Mismo formato de error que ipcRenderer.invoke: la interfaz le quita este prefijo para mostrar el mensaje.
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await invoke('ipc_invoke', { channel, args })) as T
  } catch (e) {
    throw new Error(`Error invoking remote method '${channel}': Error: ${typeof e === 'string' ? e : (e as Error)?.message ?? e}`)
  }
}

// ipcRenderer.send: sin respuesta. Los errores se ignoran como en Electron.
const send = (channel: string, ...args: unknown[]): void => {
  void invoke('ipc_send', { channel, args }).catch(() => {})
}

const listeners = new Map<string, Set<Listener>>()

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  let set = listeners.get(channel)
  if (!set) listeners.set(channel, (set = new Set()))
  set.add(cb as Listener)
  return () => void set!.delete(cb as Listener)
}

function install(): void {
  // Un solo listener Tauri: se registra ya, antes de que la interfaz pida nada.
  void listen<{ channel: string; args: unknown[] }>('ipc', (e) => {
    const set = listeners.get(e.payload.channel)
    if (set) for (const cb of [...set]) cb(...e.payload.args)
  })

  const api = {
    // Al cambiar variables, el proceso principal reinicia las sesiones afectadas (ver envChanged).
    autoRestart: true,
    listSessions: () => call('sessions:list'),
    createSession: (cwd: string, name: string, title?: string) => call('sessions:create', cwd, name, title),
    setTitle: (id: string, title: string) => call('sessions:setTitle', id, title),
    onTitle: (cb: (id: string, title: string | null) => void) => on('session:title', cb),
    createFolder: (f: unknown) => call('folders:create', f),
    updateFolder: (id: string, patch: unknown) => call('folders:update', id, patch),
    deleteFolder: (id: string) => call('folders:delete', id),
    suggestFolders: () => call('folders:suggest'),
    suggestExtraPaths: (name: string, taken: string[]) => call('folders:suggestExtra', name, taken),
    moveFolder: (id: string, delta: -1 | 1) => call('folders:move', id, delta),
    closeSession: (id: string) => call('sessions:close', id),
    renameSession: (id: string, name: string) => call('sessions:rename', id, name),
    selectSession: (id: string) => call('sessions:select', id),
    discoverSessions: () => call('sessions:discover'),
    importSession: (id: string, cwd: string, name: string) => call('sessions:import', id, cwd, name),
    getSettings: () => call('settings:get'),
    updateSettings: (patch: unknown) => call('settings:update', patch),
    onSelect: (cb: (id: string) => void) => on('ui:select', cb),
    pickFolder: () => call('dialog:pickFolder'),

    attach: (id: string, cols: number, rows: number) => send('pty:attach', id, cols, rows),
    restart: (id: string, cols: number, rows: number) => send('pty:restart', id, cols, rows),
    input: (id: string, data: string) => send('pty:input', id, data),
    resize: (id: string, cols: number, rows: number) => send('pty:resize', id, cols, rows),
    onData: (cb: (id: string, data: string) => void) => on('pty:data', cb),
    onExit: (cb: (id: string, code: number) => void) => on('pty:exit', cb),
    onStatus: (cb: (id: string, status: string) => void) => on('session:status', cb),

    listArtifacts: (id: string) => call('artifacts:list', id),
    openArtifact: (path: string) => call('artifacts:open', path),
    revealArtifact: (path: string) => call('artifacts:reveal', path),
    onArtifacts: (cb: (id: string, artifacts: unknown[]) => void) => on('artifacts:changed', cb),

    listEnv: (scope: unknown) => call('env:list', scope),
    envLayers: (sessionId: string) => call('env:layers', sessionId),
    setEnv: (scope: unknown, name: string, source: unknown, value?: string) => call('env:set', scope, name, source, value),
    deleteEnv: (scope: unknown, name: string) => call('env:delete', scope, name),
    envMoveTargets: (scope: unknown) => call('env:moveTargets', scope),
    moveEnv: (from: unknown, to: unknown, name: string, overwrite?: boolean) => call('env:move', from, to, name, overwrite),
    testEnvRef: (source: unknown) => call('env:test', source),
    awsProfiles: () => call('env:awsProfiles'),
    secureStorage: () => call('env:secureStorage'),
    restartSession: (id: string) => call('sessions:restart', id),
    isRunning: (id: string) => call('sessions:running', id),
    onReset: (cb: (id: string) => void) => on('pty:reset', cb),

    runCommand: (sessionId: string, command: string) => call('shell:run', sessionId, command),
    setFolderCommands: (folderId: string, commands: unknown[]) => call('folders:setCommands', folderId, commands),

    getUsage: () => call('usage:get'),
    onMeta: (cb: (id: string, meta: unknown) => void) => on('session:meta', cb),
    onLimits: (cb: (limits: unknown) => void) => on('usage:limits', cb),
    onDaily: (cb: (daily: unknown) => void) => on('usage:daily', cb),

    getConversation: (id: string) => call('conversation:get', id),
    onConversation: (cb: (id: string, start: number, items: unknown[]) => void) => on('conversation:changed', cb),
    openExternal: (url: string) => call('shell:openExternal', url),
    pendingRestarts: () => call('sessions:pendingRestart'),
    onPendingRestart: (cb: (id: string, on: boolean) => void) => on('session:pendingRestart', cb),

    listSlashCommands: (sessionId: string, quick?: boolean) => call('slash:list', sessionId, quick),

    // Visor de Markdown dentro de betools.
    readDoc: (path: string) => call('doc:read', path),
    watchDoc: (path: string) => call('doc:watch', path),
    unwatchDoc: (path: string) => call('doc:unwatch', path),
    // Solo en la versión Rust: guardar un .md editado en el visor. mtime = versión que se editaba (null = pisar).
    writeDoc: (path: string, text: string, mtime: number | null) => call<{ text: string; mtime: number }>('doc:write', path, text, mtime),
    onDocChanged: (cb: (path: string, doc: { text: string; mtime: number } | null) => void) => on('doc:changed', cb),

    // Zoom de toda la ventana (el del chat se hace en el renderer): zoom del webview.
    setZoomFactor: (factor: number) => void invoke('set_zoom', { factor }).catch(() => {}),

    // El portapapeles va por Rust (arboard): el del webview exige un gesto del usuario.
    readClipboard: () => call<string>('clipboard:read'),
    writeClipboard: (text: string) => call<void>('clipboard:write', text)
  }

  ;(window as unknown as { clawhip: ClawhipApi }).clawhip = api as unknown as ClawhipApi

  // Ctrl+Shift+I abre las herramientas de desarrollo (en Electron las abre el proceso principal).
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        void invoke('toggle_devtools').catch(() => {})
      }
    },
    true
  )

  // La ventana nunca abre ventanas nuevas: los links http(s) y mailto van al navegador del sistema.
  window.open = (url?: string | URL) => {
    const u = String(url ?? '')
    if (/^(https?:|mailto:)/i.test(u)) void call('shell:openExternal', u).catch(() => {})
    return null
  }
}

// Solo dentro de Tauri y si no hay ya un preload (Electron).
if (!(window as { clawhip?: unknown }).clawhip && '__TAURI_INTERNALS__' in window) install()
