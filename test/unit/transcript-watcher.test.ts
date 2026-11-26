import { appendFileSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectDir, transcriptPath } from '../../src/main/claude-paths'
import { TranscriptWatcher } from '../../src/main/transcript-watcher'
import type { Artifact, ConversationItem, Session } from '../../src/shared/types'

const TS = '2026-01-01T10:00:00.000Z'
const jl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
const user = (text: string) => ({ type: 'user', timestamp: TS, message: { content: text } })
const toolUse = (id: string, extra: object = {}) => ({
  type: 'assistant',
  timestamp: TS,
  message: { id: 'm-' + id, model: 'claude-x', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo' } }] },
  ...extra
})
const toolResult = (id: string, content: string) => ({ type: 'user', timestamp: TS, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } })

let n = 0
const newSession = (cwd = `/proj/w${++n}`): Session => ({ id: `sess-${process.pid}-${n}`, name: 'x', cwd, createdAt: TS, lastActiveAt: TS })

function setup() {
  const conv: [string, number, ConversationItem[]][] = []
  const titles: [string, string | null][] = []
  const models: [string, string | null][] = []
  const changes: [string, Artifact[]][] = []
  const w = new TranscriptWatcher(
    (id, a) => changes.push([id, a]),
    (id, t) => titles.push([id, t]),
    (id, m) => models.push([id, m]),
    (id, s, items) => conv.push([id, s, items])
  )
  return { w, conv, titles, models, changes }
}

function create(s: Session, content = ''): string {
  const p = transcriptPath(s.cwd, s.id)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

const WAIT = { timeout: 6000, interval: 100 }
// fs.watchFile toma su estado base de forma asíncrona: una escritura inmediata tras watch() puede pasar
// inadvertida hasta el siguiente cambio (carrera de la fuente). Se deja asentar antes de escribir.
const settle = () => new Promise((r) => setTimeout(r, 250))
const watchers: TranscriptWatcher[] = []
const sessions: Session[] = []
function track(s: ReturnType<typeof setup>, ...ss: Session[]) {
  watchers.push(s.w)
  sessions.push(...ss)
  return s
}

beforeEach(() => rmSync(join_claude(), { recursive: true, force: true }))
afterEach(() => {
  for (const w of watchers) for (const s of sessions) w.unwatch(s.id)
  watchers.length = 0
  sessions.length = 0
})
function join_claude() {
  return homedir() + '/.claude'
}

describe('TranscriptWatcher', () => {
  it('reads an existing transcript synchronously on watch()', async () => {
    const s = newSession()
    create(s, jl(user('hola')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.conv).toHaveLength(1)
    expect(t.conv[0][0]).toBe(s.id)
    expect(t.conv[0][1]).toBe(0)
    expect(t.conv[0][2].map((i) => i.text)).toEqual(['hola'])
    expect(t.w.conversation(s.id).map((i) => i.text)).toEqual(['hola'])
  })

  it('does not fail if the transcript does not exist yet and picks it up after creation', async () => {
    const s = newSession()
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.conv).toEqual([])
    expect(t.w.conversation(s.id)).toEqual([])
    create(s, jl(user('nueva')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(1), WAIT)
    expect(t.conv[0][1]).toBe(0)
    expect(t.conv[0][2][0].text).toBe('nueva')
  })

  it('emits appended lines with the index of the first new item', async () => {
    const s = newSession()
    const p = create(s, jl(user('a')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    appendFileSync(p, jl(user('b'), user('c')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    expect(t.conv[1][1]).toBe(1)
    expect(t.conv[1][2].map((i) => i.text)).toEqual(['b', 'c'])
  })

  it('handles a partial line split between two appends', async () => {
    const s = newSession()
    const p = create(s)
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    const line = JSON.stringify(user('partida'))
    appendFileSync(p, line.slice(0, 15))
    await new Promise((r) => setTimeout(r, 1500))
    expect(t.conv).toEqual([])
    appendFileSync(p, line.slice(15) + '\n')
    await vi.waitFor(() => expect(t.conv).toHaveLength(1), WAIT)
    expect(t.conv[0][2][0].text).toBe('partida')
  })

  it('sends from the earlier index when a tool_result updates an earlier tool item', async () => {
    const s = newSession()
    const p = create(s, jl(user('x'), toolUse('t1'), user('y')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.conv[0][2]).toHaveLength(3)
    appendFileSync(p, jl(toolResult('t1', 'listo'), user('z')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    const [, start, items] = t.conv[1]
    expect(start).toBe(1)
    expect(items.map((i) => i.kind)).toEqual(['tool', 'user', 'user'])
    expect(items[0].tool).toMatchObject({ done: true, result: 'listo' })
    expect(t.w.conversation(s.id)).toHaveLength(4)
  })

  it('sends only the updated item when a tool_result arrives alone', async () => {
    const s = newSession()
    const p = create(s, jl(toolUse('t1')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    appendFileSync(p, jl(toolResult('t1', 'ok')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    expect(t.conv[1][1]).toBe(0)
    expect(t.conv[1][2]).toHaveLength(1)
    expect(t.conv[1][2][0].tool!.done).toBe(true)
  })

  it('re-reads from 0 when the file is truncated or replaced by a smaller one', async () => {
    const s = newSession()
    const p = create(s, jl(user('uno'), user('dos'), user('tres')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.w.conversation(s.id)).toHaveLength(3)
    writeFileSync(p, jl(user('solo')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    expect(t.conv[1][1]).toBe(0)
    expect(t.conv[1][2].map((i) => i.text)).toEqual(['solo'])
    expect(t.w.conversation(s.id).map((i) => i.text)).toEqual(['solo'])
  })

  it('truncation resets artifacts, title and model of the previous content', async () => {
    const s = newSession()
    const p = create(s, jl({ type: 'ai-title', aiTitle: 'Viejo' }, toolUse('t1')) + 'x'.repeat(300) + '\n')
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.w.title(s.id)).toBe('Viejo')
    expect(t.w.model(s.id)).toBe('claude-x')
    writeFileSync(p, jl(user('a')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    expect(t.w.title(s.id)).toBeNull()
    expect(t.w.model(s.id)).toBeNull()
  })

  it('onTitle and onModel are called only on changes', async () => {
    const s = newSession()
    const p = create(s, jl({ type: 'ai-title', aiTitle: 'T1' }, toolUse('t1')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.titles).toEqual([[s.id, 'T1']])
    expect(t.models).toEqual([[s.id, 'claude-x']])
    expect(t.w.title(s.id)).toBe('T1')
    appendFileSync(p, jl(user('algo')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    expect(t.titles).toHaveLength(1)
    expect(t.models).toHaveLength(1)
    appendFileSync(p, jl({ type: 'custom-title', customTitle: 'Renombrada' }, { ...toolUse('t2'), message: { id: 'm2', model: 'claude-y', content: [] } }))
    await vi.waitFor(() => expect(t.titles).toHaveLength(2), WAIT)
    expect(t.titles[1]).toEqual([s.id, 'Renombrada'])
    await vi.waitFor(() => expect(t.models).toHaveLength(2), WAIT)
    expect(t.models[1]).toEqual([s.id, 'claude-y'])
  })

  it('onChange delivers artifacts', async () => {
    const s = newSession()
    const p = create(s)
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.changes).toEqual([])
    const write = { type: 'assistant', timestamp: TS, cwd: '/proj', message: { id: 'mw', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/proj/out/informe.md' } }] } }
    appendFileSync(p, jl(write))
    await vi.waitFor(() => expect(t.changes).toHaveLength(1), WAIT)
    expect(t.changes[0][0]).toBe(s.id)
    expect(t.changes[0][1]).toMatchObject([{ path: '/proj/out/informe.md', sources: ['Write'], isDocument: true }])
    expect(t.w.list(s.id)).toHaveLength(1)
  })

  it('does not call onChange for lines that change nothing', async () => {
    const s = newSession()
    const p = create(s, jl(user('a')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    appendFileSync(p, jl(user('b')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    expect(t.changes).toEqual([])
  })

  it('unwatch stops notifications and clears state', async () => {
    const s = newSession()
    const p = create(s, jl(user('a')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    t.w.unwatch(s.id)
    expect(t.w.conversation(s.id)).toEqual([])
    expect(t.w.list(s.id)).toEqual([])
    expect(t.w.title(s.id)).toBeNull()
    expect(t.w.model(s.id)).toBeNull()
    appendFileSync(p, jl(user('b')))
    await new Promise((r) => setTimeout(r, 2300))
    expect(t.conv).toHaveLength(1)
    t.w.unwatch(s.id) // doble unwatch: no falla
  })

  it('a transcript truncated to 0 bytes empties the conversation', async () => {
    const s = newSession()
    const file = create(s, jl(user('a'), user('b')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.conv[0][2]).toHaveLength(2)
    writeFileSync(file, '')
    await vi.waitFor(() => expect(t.conv.at(-1)).toEqual([s.id, 0, []]), WAIT)
    expect(t.w.conversation(s.id)).toEqual([])
  })

  it('watching the same session twice is a no-op', async () => {
    const s = newSession()
    create(s, jl(user('a')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    t.w.watch(s)
    await settle()
    expect(t.conv).toHaveLength(1)
  })

  it('can be re-watched after unwatch, re-reading from the start', async () => {
    const s = newSession()
    create(s, jl(user('a')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    t.w.unwatch(s.id)
    t.w.watch(s)
    await settle()
    expect(t.conv).toHaveLength(2)
    expect(t.conv[1][1]).toBe(0)
  })

  it('finds a transcript in another project dir (moved folder)', async () => {
    const s = newSession('/old/location')
    const other = newSession('/new/location')
    const p = transcriptPath(other.cwd, s.id)
    mkdirSync(projectDir(other.cwd), { recursive: true })
    writeFileSync(p, jl(user('movida')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    expect(t.conv[0][2][0].text).toBe('movida')
    appendFileSync(p, jl(user('sigue')))
    await vi.waitFor(() => expect(t.conv).toHaveLength(2), WAIT)
    expect(t.conv[1][2][0].text).toBe('sigue')
  })

  it('tracks several sessions independently', async () => {
    const a = newSession()
    const b = newSession()
    const pa = create(a, jl(user('a1')))
    create(b, jl(user('b1')))
    const t = track(setup(), a, b)
    t.w.watch(a)
    await settle()
    t.w.watch(b)
    await settle()
    appendFileSync(pa, jl(user('a2')))
    await vi.waitFor(() => expect(t.conv.filter((c) => c[0] === a.id)).toHaveLength(2), WAIT)
    expect(t.conv.filter((c) => c[0] === b.id)).toHaveLength(1)
  })

  it('truncating to empty and writing new content re-reads', async () => {
    const s = newSession()
    const p = create(s, jl(user('a'), user('b')))
    const t = track(setup(), s)
    t.w.watch(s)
    await settle()
    truncateSync(p, 0)
    await new Promise((r) => setTimeout(r, 1500))
    appendFileSync(p, jl(user('c')))
    await vi.waitFor(() => expect(t.conv.at(-1)![2].map((i) => i.text)).toEqual(['c']), WAIT)
    expect(t.conv.at(-1)![1]).toBe(0)
  })
})
