import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnvScope, EnvVarMeta, Folder, SavedCommand, Session, StoreState } from '../shared/types'

// Persiste la lista de sesiones en ~/.config/betools/sessions.json.
// Una sesión solo se elimina cuando el usuario la cierra desde la UI.
export class SessionStore {
  private readonly file: string
  private state: StoreState = { folders: [], sessions: [], selectedId: null }

  constructor() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'sessions.json')
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreState>
      this.state = { folders: raw.folders ?? [], sessions: raw.sessions ?? [], selectedId: raw.selectedId ?? null, commands: raw.commands ?? [] }
    } catch {
      // Primer arranque o archivo ilegible: se empieza vacío.
    }
  }

  get(): StoreState {
    return structuredClone(this.state)
  }

  find(id: string): Session | undefined {
    return this.state.sessions.find((s) => s.id === id)
  }

  add(session: Session): void {
    this.state.sessions.push(session)
    this.state.selectedId = session.id
    this.save()
  }

  remove(id: string): void {
    const idx = this.state.sessions.findIndex((s) => s.id === id)
    if (idx === -1) return
    this.state.sessions.splice(idx, 1)
    if (this.state.selectedId === id) {
      const next = this.state.sessions[Math.min(idx, this.state.sessions.length - 1)]
      this.state.selectedId = next?.id ?? null
    }
    this.save()
  }

  rename(id: string, name: string): void {
    const s = this.find(id)
    if (!s) return
    s.name = name
    this.save()
  }

  select(id: string): void {
    const s = this.find(id)
    if (!s) return
    this.state.selectedId = id
    s.lastActiveAt = new Date().toISOString()
    this.save()
  }

  addFolder(folder: Folder): void {
    this.state.folders.push(folder)
    this.save()
  }

  // Comandos globales y de carpetas de una vez (así mover uno de un lugar a otro es un solo guardado).
  setCommands(global: SavedCommand[], folders: Record<string, SavedCommand[]>): void {
    this.state.commands = global
    for (const f of this.state.folders) if (folders[f.id]) f.commands = folders[f.id]
    this.save()
  }

  updateFolder(id: string, patch: Partial<Omit<Folder, 'id'>>): Folder | undefined {
    const f = this.state.folders.find((x) => x.id === id)
    if (!f) return undefined
    Object.assign(f, patch)
    this.save()
    return { ...f }
  }

  moveFolder(id: string, delta: -1 | 1): void {
    const list = this.state.folders
    const i = list.findIndex((f) => f.id === id)
    const j = i + delta
    if (i === -1 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    this.save()
  }

  // Borrar una carpeta no cierra sus sesiones: pasan a "Sin carpeta".
  removeFolder(id: string): void {
    this.state.folders = this.state.folders.filter((f) => f.id !== id)
    this.save()
  }

  envOf(scope: EnvScope): EnvVarMeta[] {
    const owner = scope.kind === 'folder' ? this.state.folders.find((f) => f.id === scope.id) : this.find(scope.id)
    return owner?.env ? owner.env.map((e) => ({ ...e, source: { ...e.source } })) : []
  }

  setEnv(scope: EnvScope, meta: EnvVarMeta): void {
    const owner = scope.kind === 'folder' ? this.state.folders.find((f) => f.id === scope.id) : this.find(scope.id)
    if (!owner) throw new Error('Folder or session not found')
    owner.env = [...(owner.env ?? []).filter((e) => e.name !== meta.name), meta].sort((a, b) => a.name.localeCompare(b.name))
    this.save()
  }

  deleteEnv(scope: EnvScope, name: string): void {
    const owner = scope.kind === 'folder' ? this.state.folders.find((f) => f.id === scope.id) : this.find(scope.id)
    if (!owner?.env) return
    owner.env = owner.env.filter((e) => e.name !== name)
    this.save()
  }

  // Escritura atómica: tmp + rename, para no corromper el archivo si se corta la luz.
  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }
}
