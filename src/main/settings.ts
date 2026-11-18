import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../shared/types'

const DEFAULTS: Settings = { closeToTray: true, autostart: false, notifications: true, eagerStart: false }
const AUTOSTART_FILE = join(homedir(), '.config', 'autostart', 'clawhip.desktop')

export class SettingsStore {
  private readonly file = join(app.getPath('userData'), 'settings.json')
  private state: Settings

  constructor() {
    try {
      this.state = { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, 'utf8')) }
    } catch {
      this.state = { ...DEFAULTS }
    }
    // El archivo de autostart manda: si el usuario lo borró a mano, se refleja.
    this.state.autostart = existsSync(AUTOSTART_FILE)
    // Reescribe la entrada para que apunte al ejecutable actual (p. ej. al pasar de dev a instalada).
    if (this.state.autostart) setAutostart(true)
  }

  get(): Settings {
    return { ...this.state }
  }

  update(patch: Partial<Settings>): Settings {
    this.state = { ...this.state, ...patch }
    if (patch.autostart !== undefined) setAutostart(patch.autostart)
    writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    return this.get()
  }
}

// Entrada XDG en ~/.config/autostart. En desarrollo apunta al electron de node_modules
// más la carpeta del proyecto (corre el último `npm run build`); empaquetada, al ejecutable.
function setAutostart(enabled: boolean): void {
  if (!enabled) {
    rmSync(AUTOSTART_FILE, { force: true })
    return
  }
  const q = (s: string) => `"${s.replace(/(["\\`$])/g, '\\$1')}"`
  const exec = app.isPackaged
    ? `${q(process.execPath)} --hidden`
    : `${q(process.execPath)} ${q(app.getAppPath())} --hidden`
  mkdirSync(join(homedir(), '.config', 'autostart'), { recursive: true })
  writeFileSync(
    AUTOSTART_FILE,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=clawhip',
      'Comment=Sesiones de Claude Code',
      `Exec=${exec}`,
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n')
  )
}
