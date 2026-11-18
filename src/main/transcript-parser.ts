// Parser incremental del transcript .jsonl de Claude Code. Sin dependencias de Electron
// para poder probarlo aislado. El formato es interno de Claude Code: se toleran campos
// desconocidos y líneas que no parsean.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { Artifact, ArtifactSource } from '../shared/types'

// Extensiones que se consideran "documento" (filtro por defecto del panel).
export const DOCUMENT_EXTS = new Set([
  '.pdf', '.html', '.htm', '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.docx', '.doc', '.odt', '.xlsx', '.xls', '.ods', '.pptx', '.ppt', '.odp',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.drawio', '.mp4', '.webm'
])

// En comandos Bash solo se buscan estas: archivos que suelen *generarse* por script
// (pandoc, playwright, scripts de reportes) y que no se ven como Write/Edit.
const BASH_EXTS = ['pdf', 'html', 'htm', 'docx', 'xlsx', 'pptx', 'odt', 'png', 'jpg', 'jpeg', 'svg', 'csv', 'drawio', 'md']
const BASH_PATH_RE = new RegExp(`(?:^|[\\s'"=>(])((?:~|\\.{1,2})?/?[\\w@%+.,/~-]*\\.(?:${BASH_EXTS.join('|')}))(?=$|[\\s'";)|&<>])`, 'gi')

// Escrituras internas de Claude Code (memoria, etc.) que no son artefactos de la sesión.
const IGNORED_PREFIXES = [resolve(homedir(), '.claude', 'projects')]

const FILE_TOOLS: Record<string, ArtifactSource> = {
  Write: 'Write',
  Edit: 'Edit',
  MultiEdit: 'MultiEdit',
  NotebookEdit: 'NotebookEdit'
}

interface Op {
  path: string
  source: ArtifactSource
  at: string
}

interface Mutable {
  path: string
  sources: Set<ArtifactSource>
  firstAt: string
  lastAt: string
  ops: number
}

export class TranscriptParser {
  private remainder = Buffer.alloc(0)
  private readonly artifacts = new Map<string, Mutable>()
  // tool_use_id → operaciones, para descartar las que terminaron en error.
  private readonly pending = new Map<string, Op[]>()
  private customTitle: string | null = null
  private aiTitle: string | null = null

  // /rename gana sobre el título generado por Claude.
  title(): string | null {
    return this.customTitle ?? this.aiTitle
  }

  // Recibe bytes nuevos del archivo. Corta por "\n" a nivel de bytes (seguro en UTF-8)
  // y guarda la última línea incompleta para la próxima llamada.
  push(chunk: Buffer): boolean {
    const buf = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk
    let start = 0
    let changed = false
    for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
      if (nl > start) changed = this.line(buf.subarray(start, nl).toString('utf8')) || changed
      start = nl + 1
    }
    this.remainder = Buffer.from(buf.subarray(start))
    return changed
  }

  list(): Artifact[] {
    return [...this.artifacts.values()]
      .map((a) => {
        const ext = extname(a.path).toLowerCase()
        return {
          path: a.path,
          name: basename(a.path),
          ext,
          sources: [...a.sources],
          isDocument: DOCUMENT_EXTS.has(ext),
          firstAt: a.firstAt,
          lastAt: a.lastAt,
          exists: existsSync(a.path)
        }
      })
      .sort((x, y) => y.lastAt.localeCompare(x.lastAt))
  }

  private line(text: string): boolean {
    let d: any
    try {
      d = JSON.parse(text)
    } catch {
      return false
    }
    if (d?.type === 'custom-title' && typeof d.customTitle === 'string') {
      this.customTitle = d.customTitle.trim() || null
      return true
    }
    if (d?.type === 'ai-title' && typeof d.aiTitle === 'string') {
      this.aiTitle = d.aiTitle.trim() || null
      return true
    }
    const content = d?.message?.content
    if (!Array.isArray(content)) return false
    const at: string = d.timestamp ?? new Date().toISOString()
    const cwd: string | undefined = d.cwd
    let changed = false

    for (const c of content) {
      if (c?.type === 'tool_use' && d.type === 'assistant') {
        const ops = this.opsFor(c, cwd, at)
        if (ops.length) {
          this.pending.set(c.id, ops)
          for (const op of ops) this.add(op)
          changed = true
        }
      } else if (c?.type === 'tool_result' && c.tool_use_id) {
        const ops = this.pending.get(c.tool_use_id)
        this.pending.delete(c.tool_use_id)
        if (ops && c.is_error) {
          for (const op of ops) this.undo(op)
          changed = true
        }
      }
    }
    return changed
  }

  private opsFor(c: any, cwd: string | undefined, at: string): Op[] {
    const input = c.input ?? {}
    const fileSource = FILE_TOOLS[c.name]
    if (fileSource) {
      const p = this.normalize(input.file_path ?? input.notebook_path, cwd)
      return p ? [{ path: p, source: fileSource, at }] : []
    }
    if (c.name === 'Bash' && typeof input.command === 'string') {
      // Heurística: rutas con extensión de documento que existen y se modificaron
      // después de que se lanzó el comando (descarta los archivos que solo se leen).
      const since = Date.parse(at) - 2000
      const ops: Op[] = []
      for (const m of input.command.matchAll(BASH_PATH_RE)) {
        const p = this.normalize(m[1], cwd)
        if (!p || ops.some((o) => o.path === p)) continue
        try {
          if (statSync(p).mtimeMs >= since) ops.push({ path: p, source: 'Bash', at })
        } catch {
          // no existe: no se generó (o se movió después)
        }
      }
      return ops
    }
    return []
  }

  private normalize(p: unknown, cwd: string | undefined): string | null {
    if (typeof p !== 'string' || !p) return null
    let abs = p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p
    if (!isAbsolute(abs)) {
      if (!cwd) return null
      abs = resolve(cwd, abs)
    }
    abs = resolve(abs)
    return IGNORED_PREFIXES.some((pre) => abs.startsWith(pre + '/')) ? null : abs
  }

  private add(op: Op): void {
    const a = this.artifacts.get(op.path)
    if (!a) {
      this.artifacts.set(op.path, { path: op.path, sources: new Set([op.source]), firstAt: op.at, lastAt: op.at, ops: 1 })
      return
    }
    a.sources.add(op.source)
    a.ops++
    if (op.at > a.lastAt) a.lastAt = op.at
  }

  private undo(op: Op): void {
    const a = this.artifacts.get(op.path)
    if (!a) return
    a.ops--
    if (a.ops <= 0) this.artifacts.delete(op.path)
  }
}
