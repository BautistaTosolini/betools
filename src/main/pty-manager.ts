import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import { claudeBin, transcriptExists } from './claude-paths'
import { buildSettings, userStatusLine } from './status-tracker'
import type { ResolvedEnv } from './env-core'
import type { Session } from '../shared/types'

// Máximo de salida guardada por sesión para poder redibujar la terminal si el renderer se recarga.
const BUFFER_LIMIT = 2 * 1024 * 1024

// Variables que Claude Code define para sus procesos hijos. Si la app se lanza desde una sesión
// de Claude, se heredan y la sesión nueva se cree "hija": entre otras cosas, no guarda el transcript.
// Se quitan solo estas; las CLAUDE_CODE_* de configuración del usuario (Bedrock, etc.) se respetan.
const INHERITED_SESSION_VARS = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'
]

export function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  for (const k of INHERITED_SESSION_VARS) delete env[k]
  return env
}

interface Entry {
  proc: pty.IPty
  buffer: string
}

export interface PtyEvents {
  // Devuelve el archivo de estado que van a escribir los hooks de esta sesión.
  onSpawn(id: string): string
  onData(id: string, data: string): void
  onExit(id: string, code: number): void
  // Variables de entorno de la sesión (carpeta + propias), resueltas al lanzar.
  resolveEnv(session: Session): Promise<ResolvedEnv>
  // Remote Control: null = apagado; '' = encendido sin nombre; texto = nombre visible en claude.ai/el teléfono.
  remoteControlName(session: Session): string | null
}

// Instrucción para Claude cuando la sesión tiene variables con secretos.
function secretsPrompt(names: string[]): string {
  return [
    `This session has environment variables with sensitive values: ${names.join(', ')}.`,
    'Use them only by reference in commands (for example "$NAME"). Never print, display, log, copy to',
    'files or include their values in replies, and never run commands whose purpose is to show them',
    '(echo, printenv, env, set, cat /proc/*/environ, etc.). If a task requires seeing the value, stop',
    'and ask the user for it.'
  ].join(' ')
}

export class PtyManager {
  private readonly entries = new Map<string, Entry>()
  // Sesiones resolviendo variables antes de lanzar: evita lanzar dos veces y guarda el último tamaño.
  private readonly starting = new Map<string, { cols: number; rows: number }>()

  // Primer mensaje de una sesión nueva (p. ej. el traspaso de otra sesión): va como prompt inicial de claude.
  private readonly firstPrompt = new Map<string, string>()

  constructor(private readonly events: PtyEvents) {}

  setFirstPrompt(id: string, text: string): void {
    this.firstPrompt.set(id, text)
  }

  isRunning(id: string): boolean {
    return this.entries.has(id)
  }

  size(id: string): { cols: number; rows: number } | null {
    const e = this.entries.get(id)
    return e ? { cols: e.proc.cols, rows: e.proc.rows } : null
  }

  // Si el proceso ya corre, devuelve lo acumulado para redibujar; si no, lo lanza.
  attach(session: Session, cols: number, rows: number): string | null {
    const entry = this.entries.get(session.id)
    if (entry) {
      entry.proc.resize(cols, rows)
      return entry.buffer
    }
    const pending = this.starting.get(session.id)
    if (pending) {
      pending.cols = cols
      pending.rows = rows
      return null
    }
    if (!existsSync(session.cwd)) {
      // La carpeta de trabajo se movió o se borró: se avisa en la terminal en vez de fallar.
      this.events.onData(session.id, `\r\n\x1b[33mThe working directory no longer exists: ${session.cwd}\x1b[0m\r\n`)
      this.events.onExit(session.id, 1)
      return null
    }
    this.starting.set(session.id, { cols, rows })
    void this.start(session)
    return null
  }

  private async start(session: Session): Promise<void> {
    let resolved: ResolvedEnv = { env: {}, names: [], errors: [] }
    try {
      resolved = await this.events.resolveEnv(session)
    } catch (e) {
      resolved.errors.push(e instanceof Error ? e.message : String(e))
    }
    const size = this.starting.get(session.id)
    this.starting.delete(session.id)
    // Se cerró la sesión mientras se resolvían las variables.
    if (!size) return
    if (resolved.errors.length) {
      const lines = resolved.errors.map((e) => `  · ${e}`).join('\r\n')
      this.events.onData(
        session.id,
        `\x1b[33mSome environment variables could not be loaded (the session starts without them):\r\n${lines}\x1b[0m\r\n\r\n`
      )
    }
    this.spawn(session, size.cols, size.rows, resolved)
  }

  private spawn(session: Session, cols: number, rows: number, resolved: ResolvedEnv): void {
    // Sesión con historial → --resume. Sesión nueva (o sin mensajes todavía) → --session-id.
    const resume = transcriptExists(session.cwd, session.id)
    const args = resume ? ['--resume', session.id] : ['--session-id', session.id, '--name', session.name]
    // Prompt inicial (posicional): primero, para que ningún flag con valor opcional lo tome como suyo.
    const first = this.firstPrompt.get(session.id)
    this.firstPrompt.delete(session.id)
    if (first && !resume) args.unshift(first)
    args.push('--settings', buildSettings(resolved.names.length > 0))
    if (resolved.names.length) args.push('--append-system-prompt', secretsPrompt(resolved.names))
    // Va al final: el nombre es opcional y, sin él, el flag no debe tomar el argumento siguiente.
    // Doc: https://code.claude.com/docs/en/remote-control
    const rc = this.events.remoteControlName(session)
    if (rc !== null) args.push('--remote-control', ...(rc ? [rc] : []))
    const statusFile = this.events.onSpawn(session.id)

    const proc = pty.spawn(claudeBin(), args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: session.cwd,
      env: {
        ...cleanEnv(),
        // Variables de la carpeta y de la sesión. Van antes de las propias de clawhip para no pisarlas.
        ...resolved.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Renderer de pantalla completa: evita que Claude reescriba el scrollback en cada frame
        // (causa del salto del scroll en xterm.js).
        CLAUDE_CODE_NO_FLICKER: '1',
        // Frames atómicos (DEC 2026), que xterm.js 6 soporta.
        CLAUDE_CODE_FORCE_SYNC_OUTPUT: '1',
        CLAWHIP_STATUS_FILE: statusFile,
        BETOOLS_USER_STATUSLINE: userStatusLine()
      }
    })

    const entry: Entry = { proc, buffer: '' }
    this.entries.set(session.id, entry)

    proc.onData((data) => {
      entry.buffer += data
      if (entry.buffer.length > BUFFER_LIMIT) entry.buffer = entry.buffer.slice(-BUFFER_LIMIT)
      this.events.onData(session.id, data)
    })
    proc.onExit(({ exitCode }) => {
      // Si se mató a propósito (cerrar/reiniciar), la entrada ya no es esta: no se avisa.
      if (this.entries.get(session.id) !== entry) return
      this.entries.delete(session.id)
      this.events.onExit(session.id, exitCode)
    })
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.entries.get(id)?.proc.resize(cols, rows)
  }

  kill(id: string): void {
    this.starting.delete(id)
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.proc.kill()
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }
}
