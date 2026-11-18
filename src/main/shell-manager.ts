import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import { cleanEnv } from './pty-manager'
import type { ResolvedEnv } from './env-core'
import type { Session } from '../shared/types'

const BUFFER_LIMIT = 1024 * 1024
export const SHELL_PREFIX = 'shell:'

interface Entry {
  proc: pty.IPty
  buffer: string
}

export interface ShellEvents {
  onData(key: string, data: string): void
  onExit(key: string, code: number): void
  resolveEnv(session: Session): Promise<ResolvedEnv>
}

// Shell del usuario por sesión (pestaña "Terminal"): en la carpeta de la sesión y con sus mismas
// variables de entorno, para cosas como `aws sso login`. Clave: "shell:<sessionId>".
export class ShellManager {
  private readonly entries = new Map<string, Entry>()
  private readonly starting = new Map<string, { cols: number; rows: number; queued: string[] }>()

  constructor(private readonly events: ShellEvents) {}

  isRunning(key: string): boolean {
    return this.entries.has(key)
  }

  attach(session: Session, cols: number, rows: number): string | null {
    const key = SHELL_PREFIX + session.id
    const entry = this.entries.get(key)
    if (entry) {
      entry.proc.resize(cols, rows)
      return entry.buffer
    }
    const pending = this.starting.get(key)
    if (pending) {
      Object.assign(pending, { cols, rows })
      return null
    }
    this.starting.set(key, { cols, rows, queued: [] })
    void this.start(session)
    return null
  }

  // Escribe un comando y Enter. Si el shell todavía está arrancando, queda en cola.
  run(session: Session, command: string): void {
    const key = SHELL_PREFIX + session.id
    const entry = this.entries.get(key)
    if (entry) {
      entry.proc.write(command + '\r')
      return
    }
    if (!this.starting.has(key)) this.attach(session, 120, 30)
    this.starting.get(key)?.queued.push(command)
  }

  private async start(session: Session): Promise<void> {
    const key = SHELL_PREFIX + session.id
    let resolved: ResolvedEnv = { env: {}, names: [], errors: [] }
    try {
      resolved = await this.events.resolveEnv(session)
    } catch (e) {
      resolved.errors.push(e instanceof Error ? e.message : String(e))
    }
    const pending = this.starting.get(key)
    this.starting.delete(key)
    if (!pending) return
    if (resolved.errors.length) {
      this.events.onData(key, `\x1b[33mNo se pudieron cargar algunas variables:\r\n${resolved.errors.map((e) => `  · ${e}`).join('\r\n')}\x1b[0m\r\n`)
    }
    const shell = process.env.SHELL || '/bin/bash'
    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: pending.cols,
      rows: pending.rows,
      cwd: existsSync(session.cwd) ? session.cwd : process.env.HOME,
      env: { ...cleanEnv(), ...resolved.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAWHIP_SESSION_ID: session.id }
    })
    const entry: Entry = { proc, buffer: '' }
    this.entries.set(key, entry)
    proc.onData((data) => {
      entry.buffer += data
      if (entry.buffer.length > BUFFER_LIMIT) entry.buffer = entry.buffer.slice(-BUFFER_LIMIT)
      this.events.onData(key, data)
    })
    proc.onExit(({ exitCode }) => {
      if (this.entries.get(key) !== entry) return
      this.entries.delete(key)
      this.events.onExit(key, exitCode)
    })
    // Comandos pedidos mientras arrancaba: se mandan cuando el shell ya está listo para leer.
    for (const c of pending.queued) proc.write(c + '\r')
  }

  write(key: string, data: string): void {
    this.entries.get(key)?.proc.write(data)
  }

  resize(key: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.entries.get(key)?.proc.resize(cols, rows)
  }

  kill(key: string): void {
    this.starting.delete(key)
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    entry.proc.kill()
  }

  killAll(): void {
    for (const k of [...this.entries.keys()]) this.kill(k)
  }
}
