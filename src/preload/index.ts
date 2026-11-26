import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import type { Artifact, ConversationItem, SlashCommand, DailyTokens, PlanLimits, SessionMeta, DiscoveredSession, SavedCommand, EnvScope, EnvSource, EnvVarMeta, Folder, FolderSuggestion, SessionStatus, Session, Settings, StoreState } from '../shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // Al cambiar variables, el proceso principal reinicia las sesiones afectadas (ver envChanged).
  autoRestart: true,
  listSessions: (): Promise<
    StoreState & { status: Record<string, SessionStatus>; titles: Record<string, string | null> }
  > => ipcRenderer.invoke('sessions:list'),
  createSession: (cwd: string, name: string, title?: string): Promise<Session> =>
    ipcRenderer.invoke('sessions:create', cwd, name, title),
  setTitle: (id: string, title: string): Promise<void> => ipcRenderer.invoke('sessions:setTitle', id, title),
  onTitle: (cb: (id: string, title: string | null) => void) => on('session:title', cb),
  createFolder: (f: Omit<Folder, 'id'>): Promise<Folder> => ipcRenderer.invoke('folders:create', f),
  updateFolder: (id: string, patch: Partial<Omit<Folder, 'id'>>): Promise<Folder> =>
    ipcRenderer.invoke('folders:update', id, patch),
  deleteFolder: (id: string): Promise<void> => ipcRenderer.invoke('folders:delete', id),
  suggestFolders: (): Promise<FolderSuggestion[]> => ipcRenderer.invoke('folders:suggest'),
  suggestExtraPaths: (name: string, taken: string[]): Promise<string[]> =>
    ipcRenderer.invoke('folders:suggestExtra', name, taken),
  moveFolder: (id: string, delta: -1 | 1): Promise<void> => ipcRenderer.invoke('folders:move', id, delta),
  closeSession: (id: string): Promise<void> => ipcRenderer.invoke('sessions:close', id),
  renameSession: (id: string, name: string): Promise<void> => ipcRenderer.invoke('sessions:rename', id, name),
  selectSession: (id: string): Promise<void> => ipcRenderer.invoke('sessions:select', id),
  discoverSessions: (): Promise<DiscoveredSession[]> => ipcRenderer.invoke('sessions:discover'),
  importSession: (id: string, cwd: string, name: string): Promise<Session> =>
    ipcRenderer.invoke('sessions:import', id, cwd, name),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', patch),
  onSelect: (cb: (id: string) => void) => on('ui:select', cb),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),

  attach: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:attach', id, cols, rows),
  restart: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:restart', id, cols, rows),
  input: (id: string, data: string) => ipcRenderer.send('pty:input', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  onData: (cb: (id: string, data: string) => void) => on('pty:data', cb),
  onExit: (cb: (id: string, code: number) => void) => on('pty:exit', cb),
  onStatus: (cb: (id: string, status: SessionStatus) => void) => on('session:status', cb),

  listArtifacts: (id: string): Promise<Artifact[]> => ipcRenderer.invoke('artifacts:list', id),
  openArtifact: (path: string): Promise<void> => ipcRenderer.invoke('artifacts:open', path),
  revealArtifact: (path: string): Promise<void> => ipcRenderer.invoke('artifacts:reveal', path),
  onArtifacts: (cb: (id: string, artifacts: Artifact[]) => void) => on('artifacts:changed', cb),

  listEnv: (scope: EnvScope): Promise<EnvVarMeta[]> => ipcRenderer.invoke('env:list', scope),
  envLayers: (sessionId: string): Promise<{ scope: EnvScope; label: string; vars: EnvVarMeta[] }[]> =>
    ipcRenderer.invoke('env:layers', sessionId),
  setEnv: (scope: EnvScope, name: string, source: EnvSource, value?: string): Promise<void> =>
    ipcRenderer.invoke('env:set', scope, name, source, value),
  deleteEnv: (scope: EnvScope, name: string): Promise<void> => ipcRenderer.invoke('env:delete', scope, name),
  envMoveTargets: (scope: EnvScope): Promise<{ scope: EnvScope; label: string }[]> => ipcRenderer.invoke('env:moveTargets', scope),
  moveEnv: (from: EnvScope, to: EnvScope, name: string, overwrite?: boolean): Promise<void> =>
    ipcRenderer.invoke('env:move', from, to, name, overwrite),
  testEnvRef: (source: EnvSource): Promise<{ ok: boolean; length: number }> => ipcRenderer.invoke('env:test', source),
  awsProfiles: (): Promise<string[]> => ipcRenderer.invoke('env:awsProfiles'),
  secureStorage: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('env:secureStorage'),
  restartSession: (id: string): Promise<void> => ipcRenderer.invoke('sessions:restart', id),
  isRunning: (id: string): Promise<boolean> => ipcRenderer.invoke('sessions:running', id),
  onReset: (cb: (id: string) => void) => on('pty:reset', cb),

  runCommand: (sessionId: string, command: string): Promise<void> => ipcRenderer.invoke('shell:run', sessionId, command),
  setFolderCommands: (folderId: string, commands: SavedCommand[]): Promise<Folder> =>
    ipcRenderer.invoke('folders:setCommands', folderId, commands),

  getUsage: (): Promise<{ limits: PlanLimits | null; daily: DailyTokens; meta: Record<string, SessionMeta> }> =>
    ipcRenderer.invoke('usage:get'),
  onMeta: (cb: (id: string, meta: SessionMeta) => void) => on('session:meta', cb),
  onLimits: (cb: (limits: PlanLimits) => void) => on('usage:limits', cb),
  onDaily: (cb: (daily: DailyTokens) => void) => on('usage:daily', cb),

  getConversation: (id: string): Promise<ConversationItem[]> => ipcRenderer.invoke('conversation:get', id),
  onConversation: (cb: (id: string, start: number, items: ConversationItem[]) => void) => on('conversation:changed', cb),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  pendingRestarts: (): Promise<string[]> => ipcRenderer.invoke('sessions:pendingRestart'),
  onPendingRestart: (cb: (id: string, on: boolean) => void) => on('session:pendingRestart', cb),

  listSlashCommands: (sessionId: string, quick?: boolean): Promise<SlashCommand[]> => ipcRenderer.invoke('slash:list', sessionId, quick),

  // Visor de Markdown dentro de betools.
  readDoc: (path: string): Promise<{ text: string; mtime: number }> => ipcRenderer.invoke('doc:read', path),
  watchDoc: (path: string): Promise<void> => ipcRenderer.invoke('doc:watch', path),
  unwatchDoc: (path: string): Promise<void> => ipcRenderer.invoke('doc:unwatch', path),
  // Guarda un .md editado en el visor. mtime = versión que se editaba (null = pisar); si cambió en disco, el
  // error empieza con CONFLICT:.
  writeDoc: (path: string, text: string, mtime: number | null): Promise<{ text: string; mtime: number }> =>
    ipcRenderer.invoke('doc:write', path, text, mtime),
  onDocChanged: (cb: (path: string, doc: { text: string; mtime: number } | null) => void) => on('doc:changed', cb),

  // Zoom de toda la ventana (el del chat se hace en el renderer).
  setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),

  // El portapapeles va por el proceso principal: el módulo clipboard ya no está disponible en el preload de
  // Electron 45 (llegaba undefined y copiar/pegar fallaba sin error visible).
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text)
}

contextBridge.exposeInMainWorld('clawhip', api)
export type ClawhipApi = typeof api
