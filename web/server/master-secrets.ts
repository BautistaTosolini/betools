import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EnvScope } from '../../src/shared/types'
import type { LocalStore } from '../../src/main/env-core'

// En la Raspberry no hay llavero del sistema: los valores "local" se cifran con AES-256-GCM
// usando una clave derivada (scrypt) de la clave maestra que llega como Docker secret.
// Sin clave maestra no se guarda ningún valor cifrado.
interface FileFormat {
  salt: string
  values: Record<string, string> // "iv.tag.ciphertext" en base64
}

const keyOf = (scope: EnvScope, name: string) => `${scope.kind}:${scope.id}:${name}`

export class MasterKeySecrets implements LocalStore {
  private readonly file: string
  private data: FileFormat
  private key: Buffer | null = null

  constructor(dataDir: string, master: string | null) {
    this.file = join(dataDir, 'secrets.json')
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      this.data = { salt: randomBytes(16).toString('base64'), values: {} }
    }
    if (master) this.key = scryptSync(master, Buffer.from(this.data.salt, 'base64'), 32)
  }

  available(): { ok: boolean; reason?: string } {
    return this.key
      ? { ok: true }
      : { ok: false, reason: 'No hay clave maestra (Docker secret clawhip_master_key): no se pueden guardar valores cifrados.' }
  }

  set(scope: EnvScope, name: string, value: string): void {
    if (!this.key) throw new Error(this.available().reason)
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([c.update(value, 'utf8'), c.final()])
    this.data.values[keyOf(scope, name)] = [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.')
    this.save()
  }

  get(scope: EnvScope, name: string): string | null {
    const raw = this.data.values[keyOf(scope, name)]
    if (!raw) return null
    if (!this.key) throw new Error('falta la clave maestra para descifrar')
    const [iv, tag, enc] = raw.split('.').map((p) => Buffer.from(p, 'base64'))
    const d = createDecipheriv('aes-256-gcm', this.key, iv)
    d.setAuthTag(tag)
    try {
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
    } catch {
      throw new Error('no se pudo descifrar (¿cambió la clave maestra?)')
    }
  }

  delete(scope: EnvScope, name: string): void {
    if (delete this.data.values[keyOf(scope, name)]) this.save()
  }

  deleteScope(scope: EnvScope): void {
    const prefix = `${scope.kind}:${scope.id}:`
    const before = Object.keys(this.data.values).length
    for (const k of Object.keys(this.data.values)) if (k.startsWith(prefix)) delete this.data.values[k]
    if (Object.keys(this.data.values).length !== before) this.save()
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
    chmodSync(this.file, 0o600)
  }
}

export function readMasterKey(): string | null {
  if (process.env.CLAWHIP_MASTER_KEY) return process.env.CLAWHIP_MASTER_KEY
  const file = process.env.CLAWHIP_MASTER_KEY_FILE || '/run/secrets/clawhip_master_key'
  if (!existsSync(file)) return null
  const v = readFileSync(file, 'utf8').trim()
  return v || null
}
