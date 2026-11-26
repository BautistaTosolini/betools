import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvScope, EnvSource, EnvVarMeta } from '../shared/types'

// Lógica de variables de entorno sin dependencias de Electron: la usan la app de escritorio
// y la versión web.

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// Variables que no se pueden pisar: romperían la sesión o el seguimiento de estado.
const RESERVED = /^(PATH|HOME|USER|SHELL|TERM|COLORTERM|PWD|CLAWHIP_.*|BETOOLS.*|CLAUDE_CODE_.*|CLAUDECODE)$/

export function validateName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error('Invalid name: only letters, numbers and "_", not starting with a number.')
  if (RESERVED.test(name)) throw new Error(`${name} is reserved and cannot be overridden.`)
}

// Almacén de valores secretos "local" (escritorio: llavero del sistema; web: clave maestra).
export interface LocalStore {
  get(scope: EnvScope, name: string): string | null
}

// Lectura desde AWS con el CLI y el perfil indicado. Sin shell: los argumentos van separados.
function aws(args: string[], profile: string, region?: string): Promise<string> {
  const full = [...args, '--profile', profile, '--output', 'text', ...(region ? ['--region', region] : [])]
  return new Promise((resolve, reject) => {
    execFile('aws', full, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // El stderr del CLI no incluye el valor del secreto; se recorta para el mensaje.
        const msg = (stderr || err.message).trim().split('\n').pop() ?? 'error'
        reject(new Error(msg.slice(0, 300)))
      } else resolve(stdout.replace(/\n$/, ''))
    })
  })
}

export async function resolveRef(source: EnvSource): Promise<string> {
  if (source.kind === 'plain') return source.value
  if (source.kind === 'aws-ssm') {
    return aws(['ssm', 'get-parameter', '--name', source.name, '--with-decryption', '--query', 'Parameter.Value'], source.profile, source.region)
  }
  if (source.kind === 'aws-sm') {
    const raw = await aws(['secretsmanager', 'get-secret-value', '--secret-id', source.secretId, '--query', 'SecretString'], source.profile, source.region)
    if (!source.jsonKey) return raw
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('The secret is not JSON: the given key cannot be extracted.')
    }
    const v = (parsed as Record<string, unknown>)?.[source.jsonKey]
    if (v === undefined) throw new Error(`The secret has no key "${source.jsonKey}".`)
    return typeof v === 'string' ? v : JSON.stringify(v)
  }
  throw new Error('Unsupported source')
}

// Perfiles de ~/.aws/config, para elegir en la interfaz.
export function awsProfiles(): string[] {
  const file = join(homedir(), '.aws', 'config')
  if (!existsSync(file)) return []
  const out: string[] = []
  for (const m of readFileSync(file, 'utf8').matchAll(/^\[(?:profile\s+)?([^\]\s]+)\]/gm)) out.push(m[1])
  return [...new Set(out)].sort()
}

export interface ResolvedEnv {
  env: Record<string, string>
  names: string[] // solo las secretas (local / AWS): son las que se mencionan en la instrucción a Claude
  errors: string[] // solo nombres y motivo, nunca valores
}

// Variables efectivas de una sesión: las de su carpeta y, encima, las propias.
export async function resolveEnv(
  layers: { scope: EnvScope; vars: EnvVarMeta[] }[],
  local: LocalStore
): Promise<ResolvedEnv> {
  const effective = new Map<string, { scope: EnvScope; meta: EnvVarMeta }>()
  for (const layer of layers) for (const meta of layer.vars) effective.set(meta.name, { scope: layer.scope, meta })

  const env: Record<string, string> = {}
  const errors: string[] = []
  await Promise.all(
    [...effective.values()].map(async ({ scope, meta }) => {
      try {
        const v =
          meta.source.kind === 'plain'
            ? meta.source.value
            : meta.source.kind === 'local'
              ? local.get(scope, meta.name)
              : await resolveRef(meta.source)
        if (v === null) throw new Error('no stored value')
        env[meta.name] = v
      } catch (e) {
        errors.push(`${meta.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  )
  const secret = [...effective.values()].filter((e) => e.meta.source.kind !== 'plain').map((e) => e.meta.name)
  return { env, names: secret.filter((n) => n in env).sort(), errors }
}

// Lo mínimo que necesita moveEnv del almacén de metadatos y del de valores cifrados.
export interface EnvMetaStore {
  envOf(scope: EnvScope): EnvVarMeta[]
  setEnv(scope: EnvScope, meta: EnvVarMeta): void
  deleteEnv(scope: EnvScope, name: string): void
}
export interface LocalStoreRW extends LocalStore {
  set(scope: EnvScope, name: string, value: string): void
  delete(scope: EnvScope, name: string): void
}

export class EnvExistsError extends Error {
  constructor(name: string) {
    super(`${name} already exists in the destination.`)
    this.name = 'EnvExistsError'
  }
}

// Mueve una variable entre ámbitos (sesión ↔ carpeta). El valor cifrado se re-cifra con la clave
// del destino sin pasar por la interfaz. Primero se escribe el destino y recién después se borra
// el origen: si algo falla a mitad de camino, la variable queda duplicada, nunca perdida.
export function moveEnv(
  meta: EnvMetaStore,
  local: LocalStoreRW,
  from: EnvScope,
  to: EnvScope,
  name: string,
  overwrite = false
): void {
  if (from.kind === to.kind && from.id === to.id) throw new Error('Source and destination are the same.')
  const v = meta.envOf(from).find((e) => e.name === name)
  if (!v) throw new Error(`${name} does not exist in the source.`)
  if (!overwrite && meta.envOf(to).some((e) => e.name === name)) throw new EnvExistsError(name)
  if (v.source.kind === 'local') {
    const value = local.get(from, name)
    if (value === null) throw new Error(`${name} has no stored value to move.`)
    local.set(to, name, value)
  } else {
    local.delete(to, name) // si el destino tenía una local con ese nombre, su valor cifrado sobra
  }
  meta.setEnv(to, { name, source: { ...v.source }, updatedAt: new Date().toISOString() })
  local.delete(from, name)
  meta.deleteEnv(from, name)
}
