import { describe, expect, it } from 'vitest'
import { EnvExistsError, moveEnv, type EnvMetaStore, type LocalStoreRW } from '../../src/main/env-core'
import type { EnvScope, EnvVarMeta } from '../../src/shared/types'

const key = (s: EnvScope) => `${s.kind}:${s.id}`
const S: EnvScope = { kind: 'session', id: 's1' }
const F: EnvScope = { kind: 'folder', id: 'f1' }

function stores(failSet = false) {
  const meta = new Map<string, EnvVarMeta[]>()
  const vals = new Map<string, string>()
  const m: EnvMetaStore = {
    envOf: (s) => (meta.get(key(s)) ?? []).map((e) => ({ ...e, source: { ...e.source } })),
    setEnv: (s, v) => meta.set(key(s), [...(meta.get(key(s)) ?? []).filter((e) => e.name !== v.name), v]),
    deleteEnv: (s, n) => meta.set(key(s), (meta.get(key(s)) ?? []).filter((e) => e.name !== n))
  }
  const l: LocalStoreRW = {
    get: (s, n) => vals.get(`${key(s)}:${n}`) ?? null,
    set: (s, n, v) => {
      if (failSet) throw new Error('No system keyring')
      vals.set(`${key(s)}:${n}`, v)
    },
    delete: (s, n) => void vals.delete(`${key(s)}:${n}`)
  }
  const add = (s: EnvScope, v: EnvVarMeta, value?: string) => {
    m.setEnv(s, v)
    if (value !== undefined) vals.set(`${key(s)}:${v.name}`, value)
  }
  return { m, l, vals, add }
}
const plain = (name: string, value: string): EnvVarMeta => ({ name, source: { kind: 'plain', value }, updatedAt: '2026-01-01T00:00:00.000Z' })
const local = (name: string): EnvVarMeta => ({ name, source: { kind: 'local' }, updatedAt: '2026-01-01T00:00:00.000Z' })

describe('moveEnv', () => {
  it('moves a plain variable from session to folder', () => {
    const { m, l, add } = stores()
    add(S, plain('AWS_PROFILE', 'client-prd'))
    moveEnv(m, l, S, F, 'AWS_PROFILE')
    expect(m.envOf(S)).toEqual([])
    expect(m.envOf(F)).toMatchObject([{ name: 'AWS_PROFILE', source: { kind: 'plain', value: 'client-prd' } }])
    expect(m.envOf(F)[0].updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
  })

  it('moves a local secret from folder to session, re-keying the encrypted value', () => {
    const { m, l, vals, add } = stores()
    add(F, local('GITHUB_TOKEN'), 'tok-123')
    moveEnv(m, l, F, S, 'GITHUB_TOKEN')
    expect(l.get(S, 'GITHUB_TOKEN')).toBe('tok-123')
    expect(l.get(F, 'GITHUB_TOKEN')).toBeNull()
    expect([...vals.keys()]).toEqual(['session:s1:GITHUB_TOKEN'])
    expect(m.envOf(F)).toEqual([])
  })

  it('keeps AWS references as references', () => {
    const { m, l, add } = stores()
    const ref: EnvVarMeta = { name: 'DB_PASS', source: { kind: 'aws-sm', profile: 'p', secretId: 'x', jsonKey: 'k' }, updatedAt: 't' }
    add(S, ref)
    moveEnv(m, l, S, F, 'DB_PASS')
    expect(m.envOf(F)[0].source).toEqual(ref.source)
  })

  it('refuses to overwrite an existing destination unless asked', () => {
    const { m, l, add } = stores()
    add(S, plain('REGION', 'us-east-1'))
    add(F, plain('REGION', 'sa-east-1'))
    expect(() => moveEnv(m, l, S, F, 'REGION')).toThrow(EnvExistsError)
    expect(m.envOf(S)).toHaveLength(1)
    expect(m.envOf(F)[0].source).toMatchObject({ value: 'sa-east-1' })
    moveEnv(m, l, S, F, 'REGION', true)
    expect(m.envOf(F)[0].source).toMatchObject({ value: 'us-east-1' })
    expect(m.envOf(S)).toEqual([])
  })

  it('drops the stale encrypted value when a plain variable replaces a local one', () => {
    const { m, l, add } = stores()
    add(F, local('X'), 'old-secret')
    add(S, plain('X', 'new'))
    moveEnv(m, l, S, F, 'X', true)
    expect(l.get(F, 'X')).toBeNull()
    expect(m.envOf(F)[0].source).toEqual({ kind: 'plain', value: 'new' })
  })

  it('fails without changes when the variable or its value is missing', () => {
    const { m, l, add } = stores()
    expect(() => moveEnv(m, l, S, F, 'NOPE')).toThrow(/does not exist/)
    add(S, local('ORPHAN'))
    expect(() => moveEnv(m, l, S, F, 'ORPHAN')).toThrow(/no stored value/)
    expect(m.envOf(S)).toHaveLength(1)
    expect(m.envOf(F)).toEqual([])
  })

  it('rejects moving onto the same scope', () => {
    const { m, l, add } = stores()
    add(S, plain('A', '1'))
    expect(() => moveEnv(m, l, S, { ...S }, 'A')).toThrow(/same/)
  })

  it('never loses the variable when writing the destination fails', () => {
    const { m, l, add } = stores(true)
    add(S, local('TOKEN'), 'v')
    expect(() => moveEnv(m, l, S, F, 'TOKEN')).toThrow(/keyring/)
    expect(m.envOf(S)).toHaveLength(1)
    expect(l.get(S, 'TOKEN')).toBe('v')
    expect(m.envOf(F)).toEqual([])
  })
})
