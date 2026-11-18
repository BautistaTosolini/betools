import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnvScope, EnvVarMeta, Session } from '../../src/shared/types'

// Versión web: solo sesiones (sin carpetas ni tickets), cada una con sus variables.
interface State {
  sessions: Session[]
  selectedId: string | null
}

export class WebStore {
  private readonly file: string
  private state: State = { sessions: [], selectedId: null }

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'sessions.json')
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<State>
      this.state = { sessions: raw.sessions ?? [], selectedId: raw.selectedId ?? null }
    } catch {
      // primer arranque
    }
  }

  get(): State {
    return structuredClone(this.state)
  }
  find(id: string): Session | undefined {
    return this.state.sessions.find((s) => s.id === id)
  }
  add(s: Session): void {
    this.state.sessions.push(s)
    this.state.selectedId = s.id
    this.save()
  }
  remove(id: string): void {
    const i = this.state.sessions.findIndex((s) => s.id === id)
    if (i === -1) return
    this.state.sessions.splice(i, 1)
    if (this.state.selectedId === id) this.state.selectedId = this.state.sessions[Math.min(i, this.state.sessions.length - 1)]?.id ?? null
    this.save()
  }
  rename(id: string, name: string): void {
    const s = this.find(id)
    if (s && name.trim()) {
      s.name = name.trim()
      this.save()
    }
  }
  select(id: string): void {
    const s = this.find(id)
    if (!s) return
    this.state.selectedId = id
    s.lastActiveAt = new Date().toISOString()
    this.save()
  }
  envOf(scope: EnvScope): EnvVarMeta[] {
    if (scope.kind !== 'session') return []
    return structuredClone(this.find(scope.id)?.env ?? [])
  }
  setEnv(scope: EnvScope, meta: EnvVarMeta): void {
    const s = scope.kind === 'session' ? this.find(scope.id) : undefined
    if (!s) throw new Error('No existe la sesión')
    s.env = [...(s.env ?? []).filter((e) => e.name !== meta.name), meta].sort((a, b) => a.name.localeCompare(b.name))
    this.save()
  }
  deleteEnv(scope: EnvScope, name: string): void {
    const s = scope.kind === 'session' ? this.find(scope.id) : undefined
    if (!s?.env) return
    s.env = s.env.filter((e) => e.name !== name)
    this.save()
  }
  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }
}
