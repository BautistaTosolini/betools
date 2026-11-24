import { app, safeStorage } from 'electron'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnvScope } from '../shared/types'
import type { LocalStore } from './env-core'

export { awsProfiles, resolveEnv, resolveRef, validateName, type ResolvedEnv } from './env-core'

const keyOf = (scope: EnvScope, name: string) => `${scope.kind}:${scope.id}:${name}`

// Valores "local" cifrados con el llavero del sistema. El archivo solo tiene texto cifrado
// (base64) y permisos 0600. Nunca se devuelven al renderer.
export class LocalSecrets implements LocalStore {
  private readonly file = join(app.getPath('userData'), 'secrets.json')
  private data: Record<string, string> = {}

  constructor() {
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      this.data = {}
    }
  }

  // En Linux, sin un llavero (GNOME Keyring/KWallet) Electron cae a "basic_text": una clave fija,
  // equivalente a texto plano. En ese caso no se guarda nada.
  assertSecureBackend(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System encryption is not available.')
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'
    if (backend === 'basic_text' || backend === 'unknown') {
      throw new Error('No system keyring (GNOME Keyring/KWallet) is available: values are not stored without real encryption.')
    }
  }

  set(scope: EnvScope, name: string, value: string): void {
    this.assertSecureBackend()
    this.data[keyOf(scope, name)] = safeStorage.encryptString(value).toString('base64')
    this.save()
  }

  get(scope: EnvScope, name: string): string | null {
    const enc = this.data[keyOf(scope, name)]
    if (!enc) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }

  delete(scope: EnvScope, name: string): void {
    if (delete this.data[keyOf(scope, name)]) this.save()
  }

  deleteScope(scope: EnvScope): void {
    const prefix = `${scope.kind}:${scope.id}:`
    let changed = false
    for (const k of Object.keys(this.data)) {
      if (k.startsWith(prefix)) {
        delete this.data[k]
        changed = true
      }
    }
    if (changed) this.save()
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
    chmodSync(this.file, 0o600)
  }
}

