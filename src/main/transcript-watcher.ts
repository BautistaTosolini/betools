import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile } from 'node:fs'
import { findTranscript, transcriptPath } from './claude-paths'
import { TranscriptParser } from './transcript-parser'
import type { Artifact, ConversationItem, Session } from '../shared/types'

const CHUNK = 4 * 1024 * 1024

interface Watched {
  file: string
  offset: number
  parser: TranscriptParser
}

// Sigue el .jsonl de cada sesión y avisa cuando cambian sus artefactos.
// fs.watchFile (polling) porque el archivo puede no existir todavía (sesión nueva sin mensajes)
// y porque fs.watch pierde eventos cuando el archivo se reemplaza.
export class TranscriptWatcher {
  private readonly watched = new Map<string, Watched>()

  constructor(
    private readonly onChange: (id: string, artifacts: Artifact[]) => void,
    private readonly onTitle: (id: string, title: string | null) => void,
    private readonly onModel: (id: string, model: string | null) => void = () => {},
    // start: desde qué índice reemplazar (0 si se releyó el archivo desde cero).
    private readonly onConversation: (id: string, start: number, items: ConversationItem[]) => void = () => {}
  ) {}

  conversation(id: string): ConversationItem[] {
    return this.watched.get(id)?.parser.items ?? []
  }

  model(id: string): string | null {
    return this.watched.get(id)?.parser.model() ?? null
  }

  title(id: string): string | null {
    return this.watched.get(id)?.parser.title() ?? null
  }

  watch(session: Session): void {
    if (this.watched.has(session.id)) return
    // Sesión nueva: todavía no hay archivo; Claude lo va a crear en la ubicación esperada.
    const file = findTranscript(session.cwd, session.id) ?? transcriptPath(session.cwd, session.id)
    const w: Watched = { file, offset: 0, parser: new TranscriptParser() }
    this.watched.set(session.id, w)
    this.read(session.id, w)
    watchFile(w.file, { interval: 1000 }, () => this.read(session.id, w))
  }

  unwatch(id: string): void {
    const w = this.watched.get(id)
    if (!w) return
    unwatchFile(w.file)
    this.watched.delete(id)
  }

  list(id: string): Artifact[] {
    return this.watched.get(id)?.parser.list() ?? []
  }

  private read(id: string, w: Watched): void {
    let reset = false
    let size: number
    try {
      size = statSync(w.file).size
    } catch {
      return // todavía no existe
    }
    if (size < w.offset) {
      // Se truncó o reemplazó: se vuelve a leer desde cero.
      w.offset = 0
      w.parser = new TranscriptParser()
      reset = true
    }
    if (size === w.offset) return

    let changed = false
    const items = w.parser.items
    const countBefore = items.length
    const lastBefore = items[countBefore - 1]
    const titleBefore = w.parser.title()
    const modelBefore = w.parser.model()
    const fd = openSync(w.file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, size - w.offset))
      while (w.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - w.offset), w.offset)
        if (n <= 0) break
        w.offset += n
        changed = w.parser.push(buf.subarray(0, n)) || changed
      }
    } finally {
      closeSync(fd)
    }
    if (changed) this.onChange(id, w.parser.list())
    const now = w.parser.items
    if (reset) {
      this.onConversation(id, 0, now)
    } else {
      // El último ítem pudo extenderse (otro bloque de la misma respuesta): se reenvía desde ahí.
      const start = countBefore > 0 && now[countBefore - 1] !== lastBefore ? countBefore - 1 : countBefore
      if (now.length > start) this.onConversation(id, start, now.slice(start))
    }
    if (w.parser.title() !== titleBefore) this.onTitle(id, w.parser.title())
    if (w.parser.model() !== modelBefore) this.onModel(id, w.parser.model())
  }
}
