import { app } from 'electron'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// La app se llamaba "clawhip": sus datos estaban en ~/.config/clawhip. En el primer arranque con el
// nombre nuevo se copian a la carpeta actual (~/.config/betools). No se borra la vieja.
const FILES = ['sessions.json', 'settings.json', 'openers.json', 'secrets.json']

export function migrateLegacyData(): void {
  const from = join(homedir(), '.config', 'clawhip')
  const to = app.getPath('userData')
  if (from === to || !existsSync(join(from, 'sessions.json')) || existsSync(join(to, 'sessions.json'))) return
  mkdirSync(to, { recursive: true })
  for (const f of FILES) {
    if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f), { preserveTimestamps: true })
  }
}
