import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredSession } from '../shared/types'

const HEAD = 256 * 1024
const TAIL = 256 * 1024

function readRange(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function parseLines(text: string): any[] {
  const out: any[] = []
  for (const l of text.split('\n')) {
    try {
      out.push(JSON.parse(l))
    } catch {
      // línea cortada en el borde del rango o no-JSON
    }
  }
  return out
}

function promptText(d: any): string | null {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return null
  const c = d.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x?.type === 'text')?.text : null
  if (typeof text !== 'string') return null
  const t = text.trim()
  // Se saltan los mensajes que inyecta el sistema (comandos, recordatorios, caveats).
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null
  return t.replace(/\s+/g, ' ').slice(0, 140)
}

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

interface Raw {
  id: string
  dir: string
  mtime: number
  size: number
  headCwd?: string
  tailCwd?: string
  title: string
}

// Lista las sesiones de ~/.claude/projects, las más recientes primero.
// Lee solo el principio (primer prompt) y el final (cwd actual, título) de cada archivo.
//
// El cwd: las primeras líneas guardan el directorio donde empezó la sesión, que puede ya no
// existir si la carpeta se movió (p. ej. ~/workdir/clients/vemo → ~/workdir/infra/clients/vemo).
// Se usa, en orden: el directorio que corresponde a la carpeta de proyecto donde vive el .jsonl
// (desde donde se lanzó), el mismo deducido de un movimiento de carpeta, y si no, el último y el
// primer cwd registrados que existan.
export function discoverSessions(exclude: Set<string>, limit = 300): DiscoveredSession[] {
  const root = join(homedir(), '.claude', 'projects')
  const files: { id: string; dir: string; path: string; mtime: number; size: number }[] = []
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const f of readdirSync(join(root, dir.name))) {
      if (!f.endsWith('.jsonl')) continue
      const id = f.slice(0, -6)
      if (exclude.has(id)) continue
      const path = join(root, dir.name, f)
      const st = statSync(path)
      if (st.size === 0) continue
      files.push({ id, dir: dir.name, path, mtime: st.mtimeMs, size: st.size })
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)

  const raws: Raw[] = []
  for (const f of files.slice(0, limit)) {
    const head = parseLines(readRange(f.path, 0, Math.min(HEAD, f.size)))
    const tail = f.size > HEAD ? parseLines(readRange(f.path, Math.max(0, f.size - TAIL), Math.min(TAIL, f.size))) : head
    const headCwd = head.find((d) => typeof d.cwd === 'string')?.cwd
    let tailCwd: string | undefined
    // Gana el último título puesto a mano; si no hay, el último generado por Claude.
    let custom = ''
    let ai = ''
    for (const d of tail) {
      if (typeof d.cwd === 'string') tailCwd = d.cwd
      if (d.type === 'custom-title' && typeof d.customTitle === 'string') custom = d.customTitle
      if (d.type === 'ai-title' && typeof d.aiTitle === 'string') ai = d.aiTitle
    }
    if (!headCwd && !tailCwd) continue
    const title = custom || ai || head.map(promptText).find(Boolean) || '(no prompt)'
    raws.push({ id: f.id, dir: f.dir, mtime: f.mtime, size: f.size, headCwd, tailCwd, title })
  }

  // Directorio real de cada carpeta de proyecto: un cwd existente cuya codificación coincide.
  const dirCwd = new Map<string, string>()
  for (const r of raws) {
    for (const c of [r.tailCwd, r.headCwd]) {
      if (c && !dirCwd.has(r.dir) && encode(c) === r.dir && isDir(c)) dirCwd.set(r.dir, c)
    }
  }

  // Carpetas movidas: de sesiones que empezaron en un path que ya no existe y siguieron en otro
  // con el mismo final (…/clients/vemo → …/infra/clients/vemo) se aprende el cambio de prefijo.
  const rewrites = new Map<string, string>()
  for (const r of raws) {
    if (!r.headCwd || !r.tailCwd || r.headCwd === r.tailCwd || isDir(r.headCwd) || !isDir(r.tailCwd)) continue
    const a = r.headCwd.split('/')
    const b = r.tailCwd.split('/')
    let k = 0
    while (k < a.length - 1 && k < b.length - 1 && a[a.length - 1 - k] === b[b.length - 1 - k]) k++
    if (k > 0) rewrites.set(a.slice(0, a.length - k).join('/'), b.slice(0, b.length - k).join('/'))
  }
  // Solo se acepta si el resultado existe y coincide con la carpeta de proyecto del .jsonl.
  const rewrite = (r: Raw): string | undefined => {
    for (const c of [r.tailCwd, r.headCwd]) {
      if (!c) continue
      for (const [from, to] of rewrites) {
        if (c !== from && !c.startsWith(from + '/')) continue
        const cand = to + c.slice(from.length)
        if (encode(cand) === r.dir && isDir(cand)) return cand
      }
    }
    return undefined
  }

  return raws.map((r) => {
    // Primero el directorio desde el que se lanzó (el de la carpeta de proyecto): durante la sesión
    // Claude puede haber hecho cd a subdirectorios profundos, que no sirven como lugar de trabajo.
    const cwd = [dirCwd.get(r.dir), rewrite(r), r.tailCwd, r.headCwd].find((c): c is string => !!c && isDir(c))
    return {
      id: r.id,
      cwd: cwd ?? r.tailCwd ?? r.headCwd ?? '',
      cwdExists: !!cwd,
      title: r.title,
      modifiedAt: new Date(r.mtime).toISOString(),
      sizeKb: Math.round(r.size / 1024)
    }
  })
}
