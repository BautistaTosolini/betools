// Implementación de window.clawhip sobre WebSocket: misma API que la app de escritorio (preload),
// así los componentes de la interfaz (terminal, variables, importar) se reutilizan sin cambios.
type Listener = (...args: any[]) => void

export function createWsApi() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  let ws: WebSocket
  let nextId = 1
  let everOpened = false
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const listeners = new Map<string, Set<Listener>>()
  const queue: string[] = []

  const connect = () => {
    ws = new WebSocket(url)
    ws.onopen = () => {
      // Tras una reconexión se recarga: la salida perdida de las terminales no se puede reconstruir
      // de forma confiable y Claude redibuja la pantalla completa al volver a conectar.
      if (everOpened) {
        location.reload()
        return
      }
      everOpened = true
      for (const m of queue.splice(0)) ws.send(m)
      emit('ws:status', 'open')
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.t === 'result') {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.ok) p?.resolve(msg.value)
        else p?.reject(new Error(msg.error))
      } else if (msg.t === 'event') {
        emit(msg.channel, ...msg.args)
      }
    }
    ws.onclose = () => {
      emit('ws:status', 'closed')
      for (const p of pending.values()) p.reject(new Error('Conexión perdida'))
      pending.clear()
      setTimeout(connect, 1500)
    }
  }

  const emit = (channel: string, ...args: unknown[]) => listeners.get(channel)?.forEach((l) => l(...args))
  const on = (channel: string, cb: Listener) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(cb)
    return () => listeners.get(channel)?.delete(cb)
  }
  const raw = (m: object) => {
    const s = JSON.stringify(m)
    if (ws.readyState === WebSocket.OPEN) ws.send(s)
    else queue.push(s)
  }
  const call = <T = any>(method: string, ...args: unknown[]): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      raw({ t: 'call', id, method, args })
    })
  const fire = (method: string, ...args: unknown[]) => raw({ t: 'call', method, args })

  // Portapapeles: en HTTP (sin contexto seguro) no hay navigator.clipboard; se usa execCommand.
  const writeClipboard = async (text: string) => {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }

  connect()

  return {
    web: true,
    // Para pegar se usa el evento nativo del navegador (Ctrl+Shift+V), que funciona sin HTTPS.
    nativePaste: true,
    envKinds: ['plain', 'local'],

    listSessions: () => call('listSessions'),
    createSession: (cwd: string, name: string) => call('createSession', cwd, name),
    discoverSessions: () => call('discoverSessions'),
    importSession: (id: string, cwd: string, name: string) => call('importSession', id, cwd, name),
    closeSession: (id: string) => call('closeSession', id),
    renameSession: (id: string, name: string) => call('renameSession', id, name),
    selectSession: (id: string) => call('selectSession', id),
    completeDir: (prefix: string) => call<string[]>('completeDir', prefix),
    homeDir: () => call<string>('homeDir'),
    pickFolder: async () => null,

    attach: (id: string, cols: number, rows: number) => fire('attach', id, cols, rows),
    restart: (id: string, cols: number, rows: number) => fire('restart', id, cols, rows),
    input: (id: string, data: string) => fire('input', id, data),
    resize: (id: string, cols: number, rows: number) => fire('resize', id, cols, rows),
    onData: (cb: Listener) => on('pty:data', cb),
    onExit: (cb: Listener) => on('pty:exit', cb),
    onStatus: (cb: Listener) => on('session:status', cb),
    onReset: (cb: Listener) => on('pty:reset', cb),
    onSessionsChanged: (cb: Listener) => on('sessions:changed', cb),
    onConnection: (cb: Listener) => on('ws:status', cb),

    listEnv: (scope: unknown) => call('listEnv', scope),
    envLayers: (id: string) => call('envLayers', id),
    setEnv: (scope: unknown, name: string, source: unknown, value?: string) => call('setEnv', scope, name, source, value),
    deleteEnv: (scope: unknown, name: string) => call('deleteEnv', scope, name),
    testEnvRef: (source: unknown) => call('testEnvRef', source),
    awsProfiles: () => call('awsProfiles'),
    secureStorage: () => call('secureStorage'),
    restartSession: (id: string) => call('restartSession', id),
    isRunning: (id: string) => call<boolean>('isRunning', id),
    runCommand: (id: string, command: string) => call('runCommand', id, command),

    readClipboard: async () => (navigator.clipboard && window.isSecureContext ? navigator.clipboard.readText() : ''),
    writeClipboard,
    openArtifact: async () => undefined
  }
}
