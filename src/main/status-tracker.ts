import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionStatus } from '../shared/types'

// Estado de cada sesión a partir de hooks de Claude Code. Los hooks se pasan con --settings
// solo a las sesiones que lanza clawhip (no se toca ~/.claude/settings.json) y cada uno
// agrega una palabra al archivo $CLAWHIP_STATUS_FILE de su sesión.
const append = (word: string) => `printf '${word}\\n' >> "$CLAWHIP_STATUS_FILE"`

const HOOKS = {
    SessionStart: [{ hooks: [{ type: 'command', command: append('idle') }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: append('working') }] }],
    // Después de aprobar un permiso, la herramienta corre y la sesión vuelve a "trabajando".
    PostToolUse: [{ hooks: [{ type: 'command', command: append('working') }] }],
    Notification: [
      {
        hooks: [
          {
            type: 'command',
            // El payload llega por stdin; se lee entero (sin grep -q) para no cortar el pipe.
            command:
              `p=$(cat); case "$p" in ` +
              `*permission_prompt*|*elicitation_dialog*|*"needs your permission"*) ${append('waiting')};; ` +
              `*idle_prompt*) ${append('idle_prompt')};; esac; exit 0`
          }
        ]
      }
    ],
    Stop: [{ hooks: [{ type: 'command', command: append('done') }] }]
}

// Comandos cuyo único fin es volcar el entorno completo. No impide un "echo $VAR" puntual
// (bloquearlo impediría usar la variable por nombre), por eso va junto con la instrucción en el prompt.
const ENV_DUMP_DENY = [
  'Bash(env)',
  'Bash(printenv)',
  'Bash(printenv:*)',
  'Bash(set)',
  'Bash(export)',
  'Bash(export -p)',
  'Bash(declare -x)',
  'Bash(declare -p)',
  'Bash(cat /proc/self/environ)',
  'Bash(strings /proc/self/environ)'
]

// Status line propio: guarda el JSON que manda Claude Code (modelo, contexto, límites del plan) en
// $CLAWHIP_STATUS_FILE.line para que betools lo muestre arriba, y después corre el status line del
// usuario (si tiene) con BETOOLS=1, para que pueda omitir lo que ya muestra betools.
const STATUS_LINE =
  `p=$(cat); f="$CLAWHIP_STATUS_FILE.line"; printf '%s' "$p" > "$f.tmp" && mv -f "$f.tmp" "$f"; ` +
  `if [ -n "$BETOOLS_USER_STATUSLINE" ]; then printf '%s' "$p" | BETOOLS=1 sh -c "$BETOOLS_USER_STATUSLINE"; fi; exit 0`

export function buildSettings(hasSecrets: boolean): string {
  return JSON.stringify({
    hooks: HOOKS,
    // refreshInterval: cada 30 s además de los eventos, para que los límites no queden viejos.
    statusLine: { type: 'command', command: STATUS_LINE, refreshInterval: 30 },
    ...(hasSecrets ? { permissions: { deny: ENV_DUMP_DENY } } : {})
  })
}

// Comando de status line del usuario (~/.claude/settings.json), que el de betools reemplaza y vuelve a llamar.
export function userStatusLine(): string {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    return s?.statusLine?.type === 'command' && typeof s.statusLine.command === 'string' ? s.statusLine.command : ''
  } catch {
    return ''
  }
}

interface Tracked {
  file: string
  offset: number
}

export class StatusTracker {
  private readonly status = new Map<string, SessionStatus>()
  private readonly tracked = new Map<string, Tracked>()

  constructor(
    private readonly dir: string,
    private readonly onChange: (id: string, status: SessionStatus, prev: SessionStatus) => void
  ) {
    mkdirSync(dir, { recursive: true })
  }

  get(id: string): SessionStatus {
    return this.status.get(id) ?? 'stopped'
  }

  // Se llama justo antes de lanzar el pty. Devuelve el archivo que escriben los hooks.
  start(id: string): string {
    this.stop(id)
    const file = join(this.dir, `${id}.status`)
    writeFileSync(file, '')
    const t: Tracked = { file, offset: 0 }
    this.tracked.set(id, t)
    watchFile(file, { interval: 400 }, () => this.read(id, t))
    this.set(id, 'idle')
    return file
  }

  exited(id: string): void {
    this.stop(id)
    this.set(id, 'exited')
  }

  forget(id: string): void {
    this.stop(id)
    this.status.delete(id)
  }

  // "done" significa "terminó y no lo viste": al mirar la sesión pasa a "idle".
  seen(id: string): void {
    if (this.get(id) === 'done') this.set(id, 'idle')
  }

  private stop(id: string): void {
    const t = this.tracked.get(id)
    if (!t) return
    unwatchFile(t.file)
    this.tracked.delete(id)
  }

  private read(id: string, t: Tracked): void {
    if (this.tracked.get(id) !== t) return
    let size: number
    try {
      size = statSync(t.file).size
    } catch {
      return
    }
    if (size <= t.offset) return
    const buf = Buffer.alloc(size - t.offset)
    const fd = openSync(t.file, 'r')
    try {
      readSync(fd, buf, 0, buf.length, t.offset)
    } finally {
      closeSync(fd)
    }
    t.offset = size
    for (const word of buf.toString('utf8').split('\n')) this.apply(id, word.trim())
  }

  private apply(id: string, event: string): void {
    const cur = this.get(id)
    switch (event) {
      case 'idle':
      case 'working':
      case 'waiting':
      case 'done':
        this.set(id, event)
        break
      case 'idle_prompt':
        // Si se interrumpió con Esc, Stop no corre; el aviso de inactividad corrige el estado.
        if (cur === 'working' || cur === 'waiting') this.set(id, 'idle')
        break
    }
  }

  private set(id: string, next: SessionStatus): void {
    const prev = this.get(id)
    if (prev === next) return
    this.status.set(id, next)
    this.onChange(id, next, prev)
  }
}
