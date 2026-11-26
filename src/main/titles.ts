import { mkdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Títulos "<TICKET> <resumen>" que guarda ~/.claude/hooks/warp-tab-title.sh en
// ~/.claude/tab-titles/<session_id>. Es la convención de los CLAUDE.md de clientes;
// clawhip la lee y, al renombrar desde la app, escribe el mismo archivo.
const DIR = join(homedir(), '.claude', 'tab-titles')
const fileFor = (id: string) => join(DIR, id)

export class TabTitles {
  private readonly titles = new Map<string, string | null>()

  constructor(private readonly onChange: (id: string, title: string | null) => void) {}

  private readonly polling = new Set<string>()

  watch(id: string): void {
    // Se controla por el polling y no por el mapa: un set() antes de watch() llena el mapa y dejaba el id sin seguir.
    if (this.polling.has(id)) return
    this.polling.add(id)
    this.titles.set(id, read(id))
    // Polling: el archivo puede no existir hasta que Claude nombre la sesión.
    watchFile(fileFor(id), { interval: 1500 }, () => {
      const next = read(id)
      if (next === this.titles.get(id)) return
      this.titles.set(id, next)
      this.onChange(id, next)
    })
  }

  unwatch(id: string): void {
    unwatchFile(fileFor(id))
    this.polling.delete(id)
    this.titles.delete(id)
  }

  get(id: string): string | null {
    return this.titles.get(id) ?? null
  }

  set(id: string, title: string): void {
    const t = title.replace(/\s+/g, ' ').trim()
    if (t) {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(fileFor(id), t + '\n')
    } else {
      rmSync(fileFor(id), { force: true })
    }
    if ((this.titles.get(id) ?? null) === (t || null)) return
    this.titles.set(id, t || null)
    this.onChange(id, t || null)
  }
}

function read(id: string): string | null {
  try {
    return readFileSync(fileFor(id), 'utf8').replace(/\s+/g, ' ').trim() || null
  } catch {
    return null
  }
}
