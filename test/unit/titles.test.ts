import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabTitles } from '../../src/main/titles'

const DIR = () => join(homedir(), '.claude', 'tab-titles')
const file = (id: string) => join(DIR(), id)
const settle = () => new Promise((r) => setTimeout(r, 250)) // ver nota en transcript-watcher.test.ts
const WAIT = { timeout: 6000, interval: 100 }

let calls: [string, string | null][]
let tt: TabTitles
const ids = ['a', 'b', 'c']
beforeEach(() => {
  rmSync(join(homedir(), '.claude'), { recursive: true, force: true })
  calls = []
  tt = new TabTitles((id, t) => calls.push([id, t]))
})
afterEach(() => ids.forEach((i) => tt.unwatch(i)))

describe('TabTitles: fixes', () => {
  it('set() before watch() still starts polling for external changes', async () => {
    tt.set('a', 'PROJ-1 desde la app')
    tt.watch('a')
    await settle()
    writeFileSync(file('a'), 'PROJ-2 desde el hook\n')
    await vi.waitFor(() => expect(tt.get('a')).toBe('PROJ-2 desde el hook'), WAIT)
    expect(calls.at(-1)).toEqual(['a', 'PROJ-2 desde el hook'])
  })

  it('set() with the same title does not notify again', () => {
    tt.set('a', 'PROJ-1 x')
    tt.set('a', '  PROJ-1   x ')
    expect(calls).toEqual([['a', 'PROJ-1 x']])
  })
})

describe('TabTitles.set / get', () => {
  it('writes ~/.claude/tab-titles/<id> with a trailing newline, creating the directory', async () => {
    tt.set('a', 'PROJ-1 Arreglar login')
    expect(readFileSync(file('a'), 'utf8')).toBe('PROJ-1 Arreglar login\n')
    expect(tt.get('a')).toBe('PROJ-1 Arreglar login')
    expect(calls).toEqual([['a', 'PROJ-1 Arreglar login']])
  })

  it('normalizes whitespace and newlines', async () => {
    tt.set('a', '  PROJ-1 \n\t  muchos   espacios \n')
    expect(readFileSync(file('a'), 'utf8')).toBe('PROJ-1 muchos espacios\n')
    expect(tt.get('a')).toBe('PROJ-1 muchos espacios')
  })

  it('an empty or blank title clears: removes the file, get() is null and onChange(null) fires', async () => {
    tt.set('a', 'algo')
    tt.set('a', '   \n ')
    expect(existsSync(file('a'))).toBe(false)
    expect(tt.get('a')).toBeNull()
    expect(calls.at(-1)).toEqual(['a', null])
  })

  it('clearing a title that never existed does not fail', async () => {
    expect(() => tt.set('a', '')).not.toThrow()
    expect(tt.get('a')).toBeNull()
  })

  it('get() of an unknown id is null', async () => {
    expect(tt.get('zzz')).toBeNull()
  })

  it('overwrites a previous title', async () => {
    tt.set('a', 'uno')
    tt.set('a', 'dos')
    expect(readFileSync(file('a'), 'utf8')).toBe('dos\n')
    expect(calls.map((c) => c[1])).toEqual(['uno', 'dos'])
  })
})

describe('TabTitles.watch', () => {
  it('loads an existing title immediately without notifying', async () => {
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('a'), '  PROJ-2   hola\n')
    tt.watch('a')
    await settle()
    expect(tt.get('a')).toBe('PROJ-2 hola')
    expect(calls).toEqual([])
  })

  it('a missing file gives null', async () => {
    tt.watch('a')
    await settle()
    expect(tt.get('a')).toBeNull()
  })

  it('an empty file gives null', async () => {
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('a'), '\n')
    tt.watch('a')
    await settle()
    expect(tt.get('a')).toBeNull()
  })

  it('picks up an external write (file that did not exist)', async () => {
    tt.watch('a')
    await settle()
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('a'), 'PROJ-3 externo\n')
    await vi.waitFor(() => expect(calls).toEqual([['a', 'PROJ-3 externo']]), WAIT)
    expect(tt.get('a')).toBe('PROJ-3 externo')
  })

  it('picks up external changes and removals', async () => {
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('a'), 'uno\n')
    tt.watch('a')
    await settle()
    writeFileSync(file('a'), 'dos dos\n')
    await vi.waitFor(() => expect(tt.get('a')).toBe('dos dos'), WAIT)
    rmSync(file('a'))
    await vi.waitFor(() => expect(tt.get('a')).toBeNull(), WAIT)
    expect(calls).toEqual([['a', 'dos dos'], ['a', null]])
  })

  it('does not notify when the normalized content is unchanged', async () => {
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('a'), 'igual\n')
    tt.watch('a')
    await settle()
    writeFileSync(file('a'), '  igual  \n\n')
    await new Promise((r) => setTimeout(r, 2500))
    expect(calls).toEqual([])
  })

  it('does not double-notify after set(): the poller sees the same value', async () => {
    tt.watch('a')
    await settle()
    tt.set('a', 'desde app')
    await new Promise((r) => setTimeout(r, 2500))
    expect(calls).toEqual([['a', 'desde app']])
  })

  it('watch() twice is a no-op', async () => {
    tt.watch('a')
    await settle()
    tt.watch('a')
    await settle()
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('a'), 'x\n')
    await vi.waitFor(() => expect(calls).toHaveLength(1), WAIT)
    await new Promise((r) => setTimeout(r, 1800))
    expect(calls).toHaveLength(1)
  })

  it('unwatch stops notifications and forgets the value', async () => {
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('a'), 'uno\n')
    tt.watch('a')
    await settle()
    tt.unwatch('a')
    expect(tt.get('a')).toBeNull()
    writeFileSync(file('a'), 'dos\n')
    await new Promise((r) => setTimeout(r, 2500))
    expect(calls).toEqual([])
  })

  it('tracks several ids independently', async () => {
    tt.watch('a')
    await settle()
    tt.watch('b')
    await settle()
    mkdirSync(DIR(), { recursive: true })
    writeFileSync(file('b'), 'solo b\n')
    await vi.waitFor(() => expect(calls).toEqual([['b', 'solo b']]), WAIT)
    expect(tt.get('a')).toBeNull()
  })
})
