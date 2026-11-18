import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

// Reglas de apertura por extensión en ~/.config/clawhip/openers.json.
// "{path}" se reemplaza por la ruta del archivo. "default" aplica al resto.
type Openers = Record<string, string[]>

const DEFAULTS: Openers = {
  '.html': ['firefox', '{path}'],
  '.htm': ['firefox', '{path}'],
  default: ['xdg-open', '{path}']
}

function loadOpeners(): Openers {
  const file = join(app.getPath('userData'), 'openers.json')
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2))
    return DEFAULTS
  }
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(file, 'utf8')) as Openers) }
  } catch {
    return DEFAULTS
  }
}

function run(cmd: string[], path: string): Promise<void> {
  const [bin, ...args] = cmd.map((part) => part.replaceAll('{path}', path))
  return new Promise((resolve, reject) => {
    // Sin shell: la ruta viaja como argumento y no se interpreta.
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function openArtifact(path: string): Promise<void> {
  if (!existsSync(path)) throw new Error(`El archivo ya no existe: ${path}`)
  const openers = loadOpeners()
  const cmd = openers[extname(path).toLowerCase()] ?? openers.default
  try {
    await run(cmd, path)
  } catch {
    // Si el comando configurado no está instalado, se usa la app predeterminada del sistema.
    const err = await shell.openPath(path)
    if (err) throw new Error(err)
  }
}

export function revealArtifact(path: string): void {
  shell.showItemInFolder(path)
}
