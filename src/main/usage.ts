import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DailyTokens, PlanLimits, PlanWindow, SessionMeta } from '../shared/types'

// Datos que Claude Code le pasa al comando de status line (JSON por stdin). Las sesiones que lanza
// betools usan un status line propio (ver status-tracker) que guarda ese JSON en <statusFile>.line.
// Campos usados: model.display_name, context_window.used_percentage y rate_limits.{five_hour,seven_day}
// (este último solo existe con suscripción Pro/Max y después de la primera respuesta).
// Referencia: https://code.claude.com/docs/en/statusline
interface LineJson {
  model?: { id?: string; display_name?: string }
  context_window?: { used_percentage?: number | null }
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number }
    seven_day?: { used_percentage?: number; resets_at?: number }
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// Margen para considerar que dos resets_at son la misma ventana (pueden variar unos segundos entre lecturas).
const SAME_WINDOW_S = 300

// Combina la lectura guardada con una nueva de la misma ventana (5 h o semanal):
// - ventana nueva (reinicio posterior): se toma la nueva, aunque sea menor;
// - lectura de una ventana anterior (otra sesión con datos viejos): se ignora;
// - misma ventana: se queda el mayor porcentaje.
export function mergeWindow(cur: PlanWindow | null, next: PlanWindow | null, nowSec: number): PlanWindow | null {
  if (!next) return cur
  if (!cur) return next
  if (next.resetsAt !== null && next.resetsAt < nowSec) return cur
  if (cur.resetsAt !== null && cur.resetsAt < nowSec) return next
  if (cur.resetsAt === null || next.resetsAt === null) return next.pct >= cur.pct ? next : cur
  if (next.resetsAt > cur.resetsAt + SAME_WINDOW_S) return next
  if (next.resetsAt < cur.resetsAt - SAME_WINDOW_S) return cur
  return next.pct >= cur.pct ? next : cur
}

export class StatusLineWatcher {
  private readonly files = new Map<string, string>()
  private readonly meta = new Map<string, SessionMeta>()
  private limits: PlanLimits | null = null

  constructor(
    private readonly limitsFile: string,
    private readonly onMeta: (id: string, meta: SessionMeta) => void,
    private readonly onLimits: (limits: PlanLimits) => void
  ) {
    // Los límites son de la cuenta, no de la sesión: se guarda el último para mostrarlo al reabrir.
    try {
      this.limits = JSON.parse(readFileSync(limitsFile, 'utf8'))
    } catch {
      this.limits = null
    }
  }

  getMeta(id: string): SessionMeta | null {
    return this.meta.get(id) ?? null
  }

  getLimits(): PlanLimits | null {
    return this.limits
  }

  watch(id: string, statusFile: string): void {
    this.unwatch(id)
    const file = statusFile + '.line'
    this.files.set(id, file)
    watchFile(file, { interval: 1000 }, () => this.read(id, file))
    this.read(id, file)
  }

  unwatch(id: string): void {
    const f = this.files.get(id)
    if (f) unwatchFile(f)
    this.files.delete(id)
  }

  forget(id: string): void {
    this.unwatch(id)
    this.meta.delete(id)
  }

  private read(id: string, file: string): void {
    if (this.files.get(id) !== file) return
    let d: LineJson
    try {
      d = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return
    }
    const meta: SessionMeta = {
      model: d.model?.display_name || d.model?.id || null,
      contextPct: num(d.context_window?.used_percentage)
    }
    const prev = this.meta.get(id)
    if (!prev || prev.model !== meta.model || prev.contextPct !== meta.contextPct) {
      this.meta.set(id, meta)
      this.onMeta(id, meta)
    }

    const rl = d.rate_limits
    if (!rl || (!rl.five_hour && !rl.seven_day)) return
    const win = (w?: { used_percentage?: number; resets_at?: number }) =>
      w && num(w.used_percentage) !== null ? { pct: w.used_percentage as number, resetsAt: num(w.resets_at) } : null
    // Cada sesión guarda la lectura de SU última respuesta y el status line se repite cada 30 s, así que una
    // sesión quieta vuelve a mandar un valor viejo. Se combina por ventana: el consumo solo sube hasta el reinicio.
    const now = Date.now() / 1000
    const next: PlanLimits = {
      fiveHour: mergeWindow(this.limits?.fiveHour ?? null, win(rl.five_hour), now),
      sevenDay: mergeWindow(this.limits?.sevenDay ?? null, win(rl.seven_day), now),
      updatedAt: Date.now()
    }
    if (JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...this.limits, updatedAt: 0 })) return
    this.limits = next
    try {
      mkdirSync(dirname(this.limitsFile), { recursive: true })
      writeFileSync(this.limitsFile + '.tmp', JSON.stringify(next))
      renameSync(this.limitsFile + '.tmp', this.limitsFile)
    } catch {
      // no se pudo guardar: solo se pierde el valor al reiniciar
    }
    this.onLimits(next)
  }
}

// ---------------------------------------------------------------------------------------------
// Tokens del día: suma de message.usage de todas las respuestas con timestamp de hoy (hora local)
// en todos los transcripts de ~/.claude/projects, incluidas las sesiones fuera de betools y los
// subagentes. Una respuesta se guarda en varias líneas (una por bloque) con el mismo usage, así que
// se cuenta una vez por message.id.

const PROJECTS = join(homedir(), '.claude', 'projects')
const CHUNK = 4 * 1024 * 1024

interface FileState {
  offset: number
  remainder: Buffer
}

const startOfDay = (t = new Date()) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()

export class DailyTokenCounter {
  private day = startOfDay()
  private readonly files = new Map<string, FileState>()
  private readonly seen = new Set<string>()
  private totals: DailyTokens = this.empty()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (t: DailyTokens) => void) {}

  get(): DailyTokens {
    return this.totals
  }

  start(intervalMs = 30_000): void {
    this.scan()
    this.timer = setInterval(() => this.scan(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private empty(): DailyTokens {
    return { day: new Date(this.day).toISOString(), input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0 }
  }

  scan(): void {
    const today = startOfDay()
    if (today !== this.day) {
      this.day = today
      this.files.clear()
      this.seen.clear()
      this.totals = this.empty()
    }
    const before = this.totals.total
    for (const file of this.recentFiles()) this.readFile(file)
    if (this.totals.total !== before || before === 0) this.onChange(this.totals)
  }

  // .jsonl modificados hoy, hasta 3 niveles (proyecto / sesión / subagents).
  private recentFiles(): string[] {
    const out: string[] = []
    const walk = (dir: string, depth: number) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (depth < 3) walk(p, depth + 1)
        } else if (e.name.endsWith('.jsonl')) {
          try {
            if (statSync(p).mtimeMs >= this.day) out.push(p)
          } catch {
            // se borró entre readdir y stat
          }
        }
      }
    }
    if (existsSync(PROJECTS)) walk(PROJECTS, 0)
    return out
  }

  private readFile(file: string): void {
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    let st = this.files.get(file)
    if (!st || size < st.offset) {
      st = { offset: 0, remainder: Buffer.alloc(0) }
      this.files.set(file, st)
    }
    if (size === st.offset) return
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, size - st.offset))
      while (st.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - st.offset), st.offset)
        if (n <= 0) break
        st.offset += n
        const data = st.remainder.length ? Buffer.concat([st.remainder, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n))
        let start = 0
        for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
          if (nl > start) this.line(data.subarray(start, nl))
          start = nl + 1
        }
        st.remainder = Buffer.from(data.subarray(start))
      }
    } finally {
      closeSync(fd)
    }
  }

  private line(raw: Buffer): void {
    // Filtro barato antes de parsear: solo interesan respuestas con usage.
    if (raw.indexOf('"usage"') === -1) return
    let d: any
    try {
      d = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    if (d?.type !== 'assistant') return
    const u = d.message?.usage
    const ts = Date.parse(d.timestamp)
    if (!u || !(ts >= this.day)) return
    const key = d.message?.id ?? d.requestId ?? d.uuid
    if (key) {
      if (this.seen.has(key)) return
      this.seen.add(key)
    }
    const t = this.totals
    const input = num(u.input_tokens) ?? 0
    const output = num(u.output_tokens) ?? 0
    const cacheWrite = num(u.cache_creation_input_tokens) ?? 0
    const cacheRead = num(u.cache_read_input_tokens) ?? 0
    t.input += input
    t.output += output
    t.cacheWrite += cacheWrite
    t.cacheRead += cacheRead
    t.total += input + output + cacheWrite + cacheRead
    t.messages++
  }
}
