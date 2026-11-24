import type { Folder, Session } from '../../shared/types'

// Carpeta de una sesión: la que tiene el path (principal o adicional) más largo que contiene su cwd.

// Path de la carpeta que contiene el cwd (para mostrar la ruta relativa).
export function basePathFor(cwd: string, folder: Folder): string | null {
  let best: string | null = null
  for (const p of [folder.path, ...(folder.extraPaths ?? [])]) {
    const base = p.replace(/\/+$/, '')
    if ((cwd === base || cwd.startsWith(base + '/')) && (!best || base.length > best.length)) best = base
  }
  return best
}
export function folderFor(session: Session, folders: Folder[]): Folder | undefined {
  let best: Folder | undefined
  let bestLen = -1
  for (const f of folders) {
    for (const p of [f.path, ...(f.extraPaths ?? [])]) {
      const base = p.replace(/\/+$/, '')
      if ((session.cwd === base || session.cwd.startsWith(base + '/')) && base.length > bestLen) {
        best = f
        bestLen = base.length
      }
    }
  }
  return best
}

export interface Group {
  folder: Folder | null
  sessions: Session[]
}

// Grupos en orden de carpetas; "Sin carpeta" al final y solo si tiene sesiones.
export function groupSessions(sessions: Session[], folders: Folder[]): Group[] {
  const by = new Map<string | null, Session[]>()
  for (const s of sessions) {
    const id = folderFor(s, folders)?.id ?? null
    by.set(id, [...(by.get(id) ?? []), s])
  }
  const groups: Group[] = folders.map((f) => ({ folder: f, sessions: by.get(f.id) ?? [] }))
  const loose = by.get(null)
  if (loose?.length) groups.push({ folder: null, sessions: loose })
  return groups
}

// Título "<KEY> [<KEY>…] <resumen>": una o más keys de Jira al principio (la primera es la principal).
// "SURT-43 SURT-46 deploy codebuild" → { ticket: "SURT-43", tickets: ["SURT-43", "SURT-46"], summary: "deploy codebuild" }
// El estándar separa las keys con espacios; también se aceptan ",", "+", "/" y "&" por tolerancia.
const KEY = '[A-Za-z][A-Za-z0-9]{1,9}-\\d+'
const TITLE_RE = new RegExp(`^(${KEY}(?:\\s*[,+/&]?\\s*${KEY})*)\\b[\\s:·—,.-]*(.*)$`)
export function parseTitle(title: string | null | undefined): { ticket: string | null; tickets: string[]; summary: string | null } {
  if (!title) return { ticket: null, tickets: [], summary: null }
  const t = title.trim()
  const m = TITLE_RE.exec(t)
  // Sin key al principio, o con minúsculas que no parecen key ("a-1"): todo es resumen.
  if (!m) return { ticket: null, tickets: [], summary: t }
  // Las keys se muestran en mayúsculas aunque se hayan escrito en minúsculas ("ve-1526 …").
  const tickets = [...new Set(m[1].split(/[\s,+/&]+/).filter(Boolean).map((k) => k.toUpperCase()))]
  return { ticket: tickets[0], tickets, summary: m[2] || null }
}

// Lo que se muestra de una sesión: su título y, si no tiene, el nombre con el que se creó/importó
// (que puede empezar con el ticket). `fallback` indica que no hay título real.
export function sessionLabel(title: string | null | undefined, name: string) {
  const fromTitle = parseTitle(title)
  if (fromTitle.ticket || fromTitle.summary) return { ...fromTitle, fallback: false }
  return { ...parseTitle(name), fallback: true }
}

// Texto legible sobre un color de fondo arbitrario.
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff'
}

export const PALETTE = ['#d97757', '#61afef', '#4fbf7f', '#c678dd', '#e5c07b', '#e06c75', '#56b6c2', '#f0a6ca']
export const NO_FOLDER_COLOR = '#6b7085'
