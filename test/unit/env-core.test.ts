import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { awsProfiles, resolveEnv, resolveRef, validateName, type LocalStore } from '../../src/main/env-core'
import type { EnvScope, EnvVarMeta } from '../../src/shared/types'

describe('validateName', () => {
  it.each(['FOO', 'foo', '_x', 'A1_b2', 'MY_API_KEY', 'PATHX', 'HOMEDIR', 'BETOOL', 'CLAUDE_CODE', 'CLAUDECODEX'])('accepts %s', (n) => {
    expect(() => validateName(n)).not.toThrow()
  })

  it.each(['', '1ABC', 'A-B', 'A B', 'A.B', 'Ñu', 'A=B', 'A$B', '-x', 'A\n'])('rejects invalid name %j', (n) => {
    expect(() => validateName(n)).toThrow(/Invalid name/)
  })

  it.each([
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'COLORTERM', 'PWD',
    'CLAWHIP_STATUS_FILE', 'CLAWHIP_', 'CLAWHIP_X', 'BETOOLS', 'BETOOLS_USER_STATUSLINE', 'BETOOLSX',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_X', 'CLAUDECODE'
  ])('rejects reserved name %s', (n) => {
    expect(() => validateName(n)).toThrow(/reserved/)
  })

  it('is case sensitive for reserved names', () => {
    expect(() => validateName('path')).not.toThrow()
    expect(() => validateName('home')).not.toThrow()
  })
})

// aws falso: registra los argumentos (uno por línea) y responde según variables de entorno.
let binDir: string
let logFile: string
const savedPath = process.env.PATH

function fakeAws(opts: { out?: string; err?: string; rc?: number }) {
  process.env.FAKE_AWS_OUT = opts.out ?? ''
  process.env.FAKE_AWS_ERR = opts.err ?? ''
  process.env.FAKE_AWS_RC = String(opts.rc ?? 0)
}
const calls = () =>
  readFileSync(logFile, 'utf8')
    .split('\n--END--\n')
    .filter(Boolean)
    .map((c) => c.split('\n'))

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'fakeaws-'))
  logFile = join(binDir, 'calls.log')
  const script = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "${logFile}"; done
printf -- '--END--\\n' >> "${logFile}"
printf '%s' "$FAKE_AWS_OUT"
[ -n "$FAKE_AWS_ERR" ] && printf '%s\\n' "$FAKE_AWS_ERR" >&2
exit "\${FAKE_AWS_RC:-0}"
`
  writeFileSync(join(binDir, 'aws'), script)
  chmodSync(join(binDir, 'aws'), 0o755)
  process.env.PATH = `${binDir}:${savedPath}`
})
afterAll(() => {
  process.env.PATH = savedPath
  delete process.env.FAKE_AWS_OUT
  delete process.env.FAKE_AWS_ERR
  delete process.env.FAKE_AWS_RC
})
beforeEach(() => {
  rmSync(logFile, { force: true })
  writeFileSync(logFile, '')
  fakeAws({})
})

describe('resolveRef', () => {
  it('plain returns the value without calling aws', async () => {
    expect(await resolveRef({ kind: 'plain', value: 'x' })).toBe('x')
    expect(calls()).toEqual([])
  })

  it('aws-ssm: args, profile, output text and region', async () => {
    fakeAws({ out: 'valor-ssm\n' })
    const v = await resolveRef({ kind: 'aws-ssm', profile: 'cli-prod', region: 'us-east-1', name: '/app/token' })
    expect(v).toBe('valor-ssm')
    expect(calls()).toEqual([
      ['ssm', 'get-parameter', '--name', '/app/token', '--with-decryption', '--query', 'Parameter.Value', '--profile', 'cli-prod', '--output', 'text', '--region', 'us-east-1']
    ])
  })

  it('aws-ssm without region omits --region', async () => {
    fakeAws({ out: 'v' })
    await resolveRef({ kind: 'aws-ssm', profile: 'p', name: 'n' })
    expect(calls()[0]).not.toContain('--region')
    expect(calls()[0]).toContain('--output')
  })

  it('removes only one trailing newline', async () => {
    fakeAws({ out: 'a\n\n' })
    expect(await resolveRef({ kind: 'aws-ssm', profile: 'p', name: 'n' })).toBe('a\n')
  })

  it('aws-sm without jsonKey returns the raw SecretString', async () => {
    fakeAws({ out: 'plain-secret\n' })
    const v = await resolveRef({ kind: 'aws-sm', profile: 'p', region: 'eu-west-1', secretId: 'prod/db' })
    expect(v).toBe('plain-secret')
    expect(calls()).toEqual([
      ['secretsmanager', 'get-secret-value', '--secret-id', 'prod/db', '--query', 'SecretString', '--profile', 'p', '--output', 'text', '--region', 'eu-west-1']
    ])
  })

  it('aws-sm with jsonKey extracts a string key', async () => {
    fakeAws({ out: '{"user":"admin","pass":"s3cr3t"}\n' })
    expect(await resolveRef({ kind: 'aws-sm', profile: 'p', secretId: 'x', jsonKey: 'pass' })).toBe('s3cr3t')
  })

  it('aws-sm with jsonKey JSON-stringifies non-string values', async () => {
    fakeAws({ out: '{"n":5,"b":false,"o":{"a":1},"l":[1,2],"z":null}' })
    const r = (k: string) => resolveRef({ kind: 'aws-sm', profile: 'p', secretId: 'x', jsonKey: k })
    expect(await r('n')).toBe('5')
    expect(await r('b')).toBe('false')
    expect(await r('o')).toBe('{"a":1}')
    expect(await r('l')).toBe('[1,2]')
    expect(await r('z')).toBe('null')
  })

  it('aws-sm with jsonKey on a non-JSON secret fails without leaking the value', async () => {
    fakeAws({ out: 'esto-es-secreto' })
    const e = await resolveRef({ kind: 'aws-sm', profile: 'p', secretId: 'x', jsonKey: 'k' }).then(() => new Error("did not reject"), (x: Error) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toMatch(/not JSON/)
    expect(e.message).not.toContain('esto-es-secreto')
  })

  it('aws-sm with a missing key fails naming the key only', async () => {
    fakeAws({ out: '{"a":"valor-secreto"}' })
    const e = await resolveRef({ kind: 'aws-sm', profile: 'p', secretId: 'x', jsonKey: 'b' }).then(() => new Error("did not reject"), (x: Error) => x)
    expect(e.message).toBe('The secret has no key "b".')
    expect(e.message).not.toContain('valor-secreto')
  })

  it('aws-sm: JSON that is not an object has no key', async () => {
    fakeAws({ out: 'null' })
    await expect(resolveRef({ kind: 'aws-sm', profile: 'p', secretId: 'x', jsonKey: 'a' })).rejects.toThrow(/no key/)
    fakeAws({ out: '"texto"' })
    await expect(resolveRef({ kind: 'aws-sm', profile: 'p', secretId: 'x', jsonKey: 'a' })).rejects.toThrow(/no key/)
  })

  it('aws failure: rejects with the last line of stderr, truncated to 300 chars', async () => {
    fakeAws({ err: 'linea 1\n' + 'E'.repeat(500), rc: 254 })
    const e = await resolveRef({ kind: 'aws-ssm', profile: 'p', name: 'n' }).then(() => new Error("did not reject"), (x: Error) => x)
    expect(e.message).toBe('E'.repeat(300))
  })

  it('aws failure without stderr uses the error message', async () => {
    fakeAws({ rc: 3 })
    const e = await resolveRef({ kind: 'aws-ssm', profile: 'p', name: 'n' }).then(() => new Error("did not reject"), (x: Error) => x)
    expect(e.message).toMatch(/Command failed/)
  })

  it('does not go through a shell: special characters in arguments are literal', async () => {
    fakeAws({ out: 'v' })
    const name = '/a b/$(touch pwned);`x`'
    await resolveRef({ kind: 'aws-ssm', profile: 'p', name })
    expect(calls()[0][3]).toBe(name)
  })

  it('unsupported source throws', async () => {
    await expect(resolveRef({ kind: 'local' } as any)).rejects.toThrow('Unsupported source')
  })
})

describe('resolveEnv', () => {
  const meta = (name: string, source: EnvVarMeta['source']): EnvVarMeta => ({ name, source, updatedAt: 't' })
  const store = (data: Record<string, string>): LocalStore => ({ get: (scope: EnvScope, name: string) => data[`${JSON.stringify(scope)}:${name}`] ?? null })
  const folder: EnvScope = { kind: 'folder', cwd: '/f' } as any
  const session: EnvScope = { kind: 'session', id: 's1' } as any
  const key = (s: EnvScope, n: string) => `${JSON.stringify(s)}:${n}`

  it('empty layers', async () => {
    expect(await resolveEnv([], store({}))).toEqual({ env: {}, names: [], errors: [] })
  })

  it('plain values are in env but not in names', async () => {
    const r = await resolveEnv([{ scope: folder, vars: [meta('AWS_PROFILE', { kind: 'plain', value: 'prod' })] }], store({}))
    expect(r).toEqual({ env: { AWS_PROFILE: 'prod' }, names: [], errors: [] })
  })

  it('session layer overrides folder layer (also across kinds)', async () => {
    const r = await resolveEnv(
      [
        { scope: folder, vars: [meta('A', { kind: 'plain', value: 'folder' }), meta('B', { kind: 'plain', value: 'b-folder' })] },
        { scope: session, vars: [meta('A', { kind: 'plain', value: 'session' })] }
      ],
      store({})
    )
    expect(r.env).toEqual({ A: 'session', B: 'b-folder' })
  })

  it('an override changes the kind: plain in folder, local in session becomes secret', async () => {
    const r = await resolveEnv(
      [
        { scope: folder, vars: [meta('A', { kind: 'plain', value: 'x' })] },
        { scope: session, vars: [meta('A', { kind: 'local' })] }
      ],
      store({ [key(session, 'A')]: 'sec' })
    )
    expect(r.env.A).toBe('sec')
    expect(r.names).toEqual(['A'])
  })

  it('local values are read from the store with the scope of the winning layer', async () => {
    const r = await resolveEnv(
      [
        { scope: folder, vars: [meta('TOKEN', { kind: 'local' }), meta('OTHER', { kind: 'local' })] },
        { scope: session, vars: [meta('TOKEN', { kind: 'local' })] }
      ],
      store({ [key(folder, 'TOKEN')]: 'de-carpeta', [key(session, 'TOKEN')]: 'de-sesion', [key(folder, 'OTHER')]: 'o' })
    )
    expect(r.env).toEqual({ TOKEN: 'de-sesion', OTHER: 'o' })
    expect(r.names).toEqual(['OTHER', 'TOKEN'])
  })

  it('a local value missing from the store is an error without value, and not in names', async () => {
    const r = await resolveEnv([{ scope: folder, vars: [meta('MISSING', { kind: 'local' })] }], store({}))
    expect(r.env).toEqual({})
    expect(r.names).toEqual([])
    expect(r.errors).toEqual(['MISSING: no stored value'])
  })

  it('an empty string stored locally is valid', async () => {
    const r = await resolveEnv([{ scope: folder, vars: [meta('E', { kind: 'local' })] }], store({ [key(folder, 'E')]: '' }))
    expect(r.env).toEqual({ E: '' })
    expect(r.names).toEqual(['E'])
  })

  it('a store that throws is reported as an error', async () => {
    const bad: LocalStore = { get: () => { throw new Error('keychain locked') } }
    const r = await resolveEnv([{ scope: folder, vars: [meta('X', { kind: 'local' })] }], bad)
    expect(r.errors).toEqual(['X: keychain locked'])
  })

  it('AWS refs are resolved through aws, and errors never include secret values', async () => {
    fakeAws({ out: 'valor-super-secreto\n' })
    const ok = await resolveEnv([{ scope: folder, vars: [meta('DB', { kind: 'aws-ssm', profile: 'p', name: '/db' })] }], store({}))
    expect(ok.env).toEqual({ DB: 'valor-super-secreto' })
    expect(ok.names).toEqual(['DB'])

    fakeAws({ out: '{"a":"valor-super-secreto"}' })
    const bad = await resolveEnv([{ scope: folder, vars: [meta('DB', { kind: 'aws-sm', profile: 'p', secretId: 's', jsonKey: 'zzz' })] }], store({}))
    expect(bad.env).toEqual({})
    expect(bad.errors).toEqual(['DB: The secret has no key "zzz".'])
    expect(JSON.stringify(bad)).not.toContain('valor-super-secreto')
  })

  it('a failing variable does not prevent the others from resolving; names are sorted', async () => {
    fakeAws({ out: 'v' })
    const r = await resolveEnv(
      [
        {
          scope: folder,
          vars: [
            meta('ZED', { kind: 'aws-ssm', profile: 'p', name: 'n' }),
            meta('BAD', { kind: 'local' }),
            meta('ALPHA', { kind: 'aws-ssm', profile: 'p', name: 'n2' }),
            meta('PLAIN', { kind: 'plain', value: 'p' })
          ]
        }
      ],
      store({})
    )
    expect(Object.keys(r.env).sort()).toEqual(['ALPHA', 'PLAIN', 'ZED'])
    expect(r.names).toEqual(['ALPHA', 'ZED'])
    expect(r.errors).toEqual(['BAD: no stored value'])
  })
})

describe('awsProfiles', () => {
  const cfg = join(homedir(), '.aws', 'config')
  beforeEach(() => rmSync(join(homedir(), '.aws'), { recursive: true, force: true }))
  const write = (s: string) => {
    mkdirSync(join(homedir(), '.aws'), { recursive: true })
    writeFileSync(cfg, s)
  }

  it('returns [] without a config file', () => {
    expect(awsProfiles()).toEqual([])
  })

  it('parses [default] and [profile x], deduplicates and sorts', () => {
    write(
      [
        '[profile zeta]', 'region = us-east-1', '',
        '[default]', 'region = us-west-2', '',
        '[profile alpha]', 'role_arn = arn:aws:iam::1:role/x', '',
        '[profile zeta]', 'region = eu-west-1', '',
        '[profile  beta]', ''
      ].join('\n')
    )
    expect(awsProfiles()).toEqual(['alpha', 'beta', 'default', 'zeta'])
  })

  it('ignores sso-session and other non-profile sections and comments', () => {
    write('[sso-session corp]\nsso_region = x\n# [profile commented]\n[profile real]\n')
    // "sso-session corp" tiene espacio: la expresión exige un solo token tras "[" (o "[profile ")
    expect(awsProfiles()).toEqual(['real'])
  })

  it('works with CRLF line endings', () => {
    write('[profile a]\r\nregion=x\r\n[profile b]\r\n')
    expect(awsProfiles()).toEqual(['a', 'b'])
  })

  it('keeps profile names with dots, dashes and colons', () => {
    write('[profile cli-prod.admin]\n[profile a:b]\n')
    expect(awsProfiles()).toEqual(['a:b', 'cli-prod.admin'])
  })
})
