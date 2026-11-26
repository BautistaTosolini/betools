import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DailyTokenCounter, StatusLineWatcher, mergeWindow } from '../../src/main/usage'
import type { DailyTokens, PlanLimits, SessionMeta } from '../../src/shared/types'

const NOW = 1_800_000_000 // segundos
const w = (pct: number, resetsAt: number | null) => ({ pct, resetsAt })

describe('mergeWindow', () => {
  it('returns cur when next is null (including both null)', () => {
    expect(mergeWindow(null, null, NOW)).toBeNull()
    const cur = w(10, NOW + 1000)
    expect(mergeWindow(cur, null, NOW)).toBe(cur)
  })

  it('returns next when there is no cur', () => {
    const next = w(5, NOW + 1000)
    expect(mergeWindow(null, next, NOW)).toBe(next)
  })

  it('a new (later) window replaces the current one even if lower', () => {
    const cur = w(90, NOW + 1000)
    const next = w(3, NOW + 1000 + 18_000)
    expect(mergeWindow(cur, next, NOW)).toBe(next)
  })

  it('a stale window (resetsAt in the past) in next is ignored', () => {
    const cur = w(10, NOW + 1000)
    expect(mergeWindow(cur, w(99, NOW - 1), NOW)).toBe(cur)
  })

  it('a stale cur is replaced by any non-stale next', () => {
    const next = w(1, NOW + 5000)
    expect(mergeWindow(w(99, NOW - 10), next, NOW)).toBe(next)
  })

  it('an older window than cur (beyond tolerance) is ignored', () => {
    const cur = w(10, NOW + 10_000)
    expect(mergeWindow(cur, w(80, NOW + 10_000 - 301), NOW)).toBe(cur)
  })

  it('the same window keeps the max percentage', () => {
    const lo = w(10, NOW + 1000)
    const hi = w(40, NOW + 1000)
    expect(mergeWindow(lo, hi, NOW)).toBe(hi)
    expect(mergeWindow(hi, lo, NOW)).toBe(hi)
  })

  it('equal percentage in the same window prefers next', () => {
    const cur = w(10, NOW + 1000)
    const next = w(10, NOW + 1010)
    expect(mergeWindow(cur, next, NOW)).toBe(next)
  })

  it('SAME_WINDOW_S tolerance (300 s) is inclusive on both sides', () => {
    const cur = w(50, NOW + 10_000)
    // dentro de la tolerancia: misma ventana, gana el mayor
    expect(mergeWindow(cur, w(20, NOW + 10_300), NOW)).toBe(cur)
    expect(mergeWindow(cur, w(60, NOW + 10_300), NOW)).toEqual(w(60, NOW + 10_300))
    expect(mergeWindow(cur, w(20, NOW + 10_000 - 300), NOW)).toBe(cur)
    expect(mergeWindow(cur, w(60, NOW + 10_000 - 300), NOW)).toEqual(w(60, NOW + 10_000 - 300))
    // fuera de la tolerancia hacia adelante: ventana nueva, aunque sea menor
    const later = w(20, NOW + 10_301)
    expect(mergeWindow(cur, later, NOW)).toBe(later)
  })

  it('null resetsAt: compares only percentages', () => {
    expect(mergeWindow(w(10, null), w(5, NOW + 1000), NOW)).toEqual(w(10, null))
    expect(mergeWindow(w(10, null), w(20, NOW + 1000), NOW)).toEqual(w(20, NOW + 1000))
    expect(mergeWindow(w(10, NOW + 1000), w(5, null), NOW)).toEqual(w(10, NOW + 1000))
    expect(mergeWindow(w(10, NOW + 1000), w(10, null), NOW)).toEqual(w(10, null))
    expect(mergeWindow(w(10, null), w(10, null), NOW)).toEqual(w(10, null))
  })

  it('resetsAt exactly equal to now is not stale', () => {
    const next = w(50, NOW)
    expect(mergeWindow(null, next, NOW)).toBe(next)
    // sin ser vencida, y dentro de la tolerancia, es la misma ventana: gana el mayor
    expect(mergeWindow(w(10, NOW + 100), next, NOW)).toBe(next)
    // más de 300 s antes que cur: ventana anterior, se ignora
    const cur = w(10, NOW + 400)
    expect(mergeWindow(cur, next, NOW)).toBe(cur)
  })
})

describe('StatusLineWatcher', () => {
  const WAIT = { timeout: 5000, interval: 100 }
  let dir: string
  let statusFile: string
  let limitsFile: string
  let metas: [string, SessionMeta][]
  let limits: PlanLimits[]
  let sw: StatusLineWatcher
  const nowS = () => Math.floor(Date.now() / 1000)
  const mk = () => new StatusLineWatcher(limitsFile, (id, m) => metas.push([id, m]), (l) => limits.push(l))
  const writeLine = (o: unknown) => writeFileSync(statusFile + '.line', typeof o === 'string' ? o : JSON.stringify(o))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sw-'))
    statusFile = join(dir, 's.status')
    limitsFile = join(dir, 'sub', 'limits.json')
    metas = []
    limits = []
    sw = mk()
  })
  afterEach(() => {
    sw.forget('a')
    sw.forget('b')
  })

  it('starts with no data when nothing is stored', () => {
    expect(sw.getLimits()).toBeNull()
    expect(sw.getMeta('a')).toBeNull()
  })

  it('loads saved limits from the file at construction', () => {
    const saved: PlanLimits = { fiveHour: w(30, nowS() + 1000), sevenDay: null, updatedAt: 1 }
    mkdirSync(join(dir, 'sub'))
    writeFileSync(limitsFile, JSON.stringify(saved))
    expect(mk().getLimits()).toEqual(saved)
  })

  it('invalid limits file is treated as empty', () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(limitsFile, '{no')
    expect(mk().getLimits()).toBeNull()
  })

  it('watch() reads an existing .line file immediately and reports meta', () => {
    writeLine({ model: { id: 'claude-x', display_name: 'Opus 5' }, context_window: { used_percentage: 42 } })
    sw.watch('a', statusFile)
    expect(metas).toEqual([['a', { model: 'Opus 5', contextPct: 42 }]])
    expect(sw.getMeta('a')).toEqual({ model: 'Opus 5', contextPct: 42 })
  })

  it('model falls back to id; missing data gives nulls', () => {
    writeLine({ model: { id: 'claude-x' } })
    sw.watch('a', statusFile)
    expect(sw.getMeta('a')).toEqual({ model: 'claude-x', contextPct: null })
    writeLine({ context_window: { used_percentage: null } })
    sw.unwatch('a')
    sw.watch('a', statusFile)
    expect(sw.getMeta('a')).toEqual({ model: null, contextPct: null })
  })

  it('ignores a missing file or invalid JSON', () => {
    sw.watch('a', statusFile)
    expect(metas).toEqual([])
    writeLine('{trunc')
    sw.unwatch('a')
    sw.watch('a', statusFile)
    expect(metas).toEqual([])
  })

  it('picks up later changes by polling and only notifies on changes', async () => {
    writeLine({ model: { display_name: 'A' }, context_window: { used_percentage: 1 } })
    sw.watch('a', statusFile)
    await new Promise((r) => setTimeout(r, 250)) // fs.watchFile fija su estado base de forma asíncrona
    writeLine({ model: { display_name: 'A' }, context_window: { used_percentage: 2 } })
    await vi.waitFor(() => expect(metas).toHaveLength(2), WAIT)
    expect(metas[1][1]).toEqual({ model: 'A', contextPct: 2 })
    // el mismo contenido (otro mtime) no vuelve a notificar
    writeLine({ model: { display_name: 'A' }, context_window: { used_percentage: 2 } })
    await new Promise((r) => setTimeout(r, 1500))
    expect(metas).toHaveLength(2)
  })

  it('computes plan limits, persists them atomically and notifies', () => {
    const r5 = nowS() + 3600
    const r7 = nowS() + 86_400
    writeLine({ rate_limits: { five_hour: { used_percentage: 25, resets_at: r5 }, seven_day: { used_percentage: 5, resets_at: r7 } } })
    sw.watch('a', statusFile)
    expect(limits).toHaveLength(1)
    expect(limits[0]).toMatchObject({ fiveHour: { pct: 25, resetsAt: r5 }, sevenDay: { pct: 5, resetsAt: r7 } })
    expect(sw.getLimits()).toBe(limits[0])
    const stored = JSON.parse(readFileSync(limitsFile, 'utf8'))
    expect(stored.fiveHour).toEqual({ pct: 25, resetsAt: r5 })
    expect(() => readFileSync(limitsFile + '.tmp')).toThrow()
  })

  it('only five_hour present: sevenDay stays null', () => {
    writeLine({ rate_limits: { five_hour: { used_percentage: 7, resets_at: nowS() + 100 } } })
    sw.watch('a', statusFile)
    expect(limits[0].sevenDay).toBeNull()
  })

  it('no rate_limits or empty rate_limits: no limits notification', () => {
    writeLine({ model: { id: 'm' } })
    sw.watch('a', statusFile)
    writeLine({ rate_limits: {} })
    sw.unwatch('a')
    sw.watch('a', statusFile)
    expect(limits).toEqual([])
  })

  it('a window without a numeric percentage is ignored', () => {
    writeLine({ rate_limits: { five_hour: { resets_at: nowS() + 100 } } })
    sw.watch('a', statusFile)
    expect(limits[0]?.fiveHour ?? null).toBeNull()
  })

  it('merges between sessions: a stale lower reading of the same window does not lower the percentage', () => {
    const r = nowS() + 3600
    writeLine({ rate_limits: { five_hour: { used_percentage: 60, resets_at: r } } })
    sw.watch('a', statusFile)
    const other = join(dir, 'o.status')
    writeFileSync(other + '.line', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20, resets_at: r + 5 } } }))
    sw.watch('b', other)
    expect(sw.getLimits()!.fiveHour).toEqual({ pct: 60, resetsAt: r })
    expect(limits).toHaveLength(1)
  })

  it('a new window replaces the stored one even when lower', () => {
    const r = nowS() + 3600
    writeLine({ rate_limits: { five_hour: { used_percentage: 60, resets_at: r } } })
    sw.watch('a', statusFile)
    const other = join(dir, 'o.status')
    writeFileSync(other + '.line', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 2, resets_at: r + 18_000 } } }))
    sw.watch('b', other)
    expect(sw.getLimits()!.fiveHour).toEqual({ pct: 2, resetsAt: r + 18_000 })
    expect(limits).toHaveLength(2)
  })

  it('stored limits survive a restart and are merged with new readings', () => {
    const r = nowS() + 3600
    writeLine({ rate_limits: { five_hour: { used_percentage: 60, resets_at: r } } })
    sw.watch('a', statusFile)
    sw.forget('a')
    const sw2 = mk()
    expect(sw2.getLimits()!.fiveHour).toEqual({ pct: 60, resetsAt: r })
    writeLine({ rate_limits: { five_hour: { used_percentage: 10, resets_at: r } } })
    sw2.watch('a', statusFile)
    expect(sw2.getLimits()!.fiveHour!.pct).toBe(60)
    sw2.forget('a')
  })

  it('unwatch stops reading; forget also drops meta', async () => {
    writeLine({ model: { display_name: 'A' } })
    sw.watch('a', statusFile)
    sw.unwatch('a')
    expect(sw.getMeta('a')).not.toBeNull()
    writeLine({ model: { display_name: 'B' } })
    await new Promise((r) => setTimeout(r, 1500))
    expect(metas).toHaveLength(1)
    sw.forget('a')
    expect(sw.getMeta('a')).toBeNull()
  })

  it('re-watch of the same id replaces the previous file', () => {
    writeLine({ model: { display_name: 'A' } })
    sw.watch('a', statusFile)
    const other = join(dir, 'o.status')
    writeFileSync(other + '.line', JSON.stringify({ model: { display_name: 'Z' } }))
    sw.watch('a', other)
    expect(sw.getMeta('a')!.model).toBe('Z')
  })
})

describe('DailyTokenCounter', () => {
  const PROJECTS = join(homedir(), '.claude', 'projects')
  let changes: DailyTokens[]
  let c: DailyTokenCounter
  const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
  const asst = (id: string | undefined, usage: object | undefined, ts = iso(), extra: object = {}) => ({
    type: 'assistant',
    timestamp: ts,
    ...extra,
    message: { ...(id ? { id } : {}), ...(usage ? { usage } : {}) }
  })
  const jl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
  const file = (rel: string, content: string) => {
    const p = join(PROJECTS, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
    return p
  }
  const U = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }

  beforeEach(() => {
    rmSync(join(homedir(), '.claude'), { recursive: true, force: true })
    changes = []
    c = new DailyTokenCounter((t) => changes.push({ ...t }))
  })
  afterEach(() => {
    c.stop()
    vi.useRealTimers()
  })

  it('starts at zero with the ISO day start', () => {
    const t = c.get()
    expect(t).toMatchObject({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0 })
    const d = new Date(t.day)
    const local = new Date()
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([local.getFullYear(), local.getMonth(), local.getDate(), 0, 0])
  })

  it('with no projects dir: scan notifies zero once', () => {
    c.scan()
    expect(changes).toHaveLength(1)
    expect(changes[0].total).toBe(0)
  })

  it('sums the four usage fields and total', () => {
    file('p1/s1.jsonl', jl(asst('m1', U)))
    c.scan()
    expect(c.get()).toMatchObject({ input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100, messages: 1 })
    expect(changes.at(-1)!.total).toBe(100)
  })

  it('counts each message.id once even across lines and files', () => {
    file('p1/s1.jsonl', jl(asst('m1', U), asst('m1', U), asst('m2', U)))
    file('p1/s2.jsonl', jl(asst('m1', U)))
    c.scan()
    expect(c.get().messages).toBe(2)
    expect(c.get().total).toBe(200)
  })

  it('falls back to requestId then uuid as the key; no key means always counted', () => {
    file(
      'p1/s1.jsonl',
      jl(
        asst(undefined, U, iso(), { requestId: 'r1' }),
        asst(undefined, U, iso(), { requestId: 'r1' }),
        asst(undefined, U, iso(), { uuid: 'u1' }),
        asst(undefined, U, iso(), { uuid: 'u1' }),
        asst(undefined, U),
        asst(undefined, U)
      )
    )
    c.scan()
    expect(c.get().messages).toBe(4)
  })

  it('only counts assistant entries with usage', () => {
    file('p1/s1.jsonl', jl({ type: 'user', timestamp: iso(), message: { usage: U } }, asst('m1', undefined), asst('m2', U)))
    c.scan()
    expect(c.get().messages).toBe(1)
  })

  it('only counts timestamps from today (local time)', () => {
    const start = new Date(c.get().day).getTime()
    file(
      'p1/s1.jsonl',
      jl(
        asst('old', U, new Date(start - 1000).toISOString()),
        asst('start', U, new Date(start).toISOString()),
        asst('now', U, iso()),
        asst('bad', U, 'no-date')
      )
    )
    c.scan()
    expect(c.get().messages).toBe(2)
  })

  it('missing or non-numeric usage fields count as 0', () => {
    file('p1/s1.jsonl', jl(asst('m1', { input_tokens: 5, output_tokens: 'x', cache_read_input_tokens: null })))
    c.scan()
    expect(c.get()).toMatchObject({ input: 5, output: 0, cacheWrite: 0, cacheRead: 0, total: 5 })
  })

  it('includes subagent files (project/session/subagents/x.jsonl) but not deeper ones', () => {
    file('p1/sess/subagents/agent-1.jsonl', jl(asst('sub1', U)))
    file('p1/a/b/c/too-deep.jsonl', jl(asst('deep', U)))
    c.scan()
    expect(c.get().messages).toBe(1)
  })

  it('ignores files not modified today and non-jsonl files', () => {
    const p = file('p1/old.jsonl', jl(asst('m1', U)))
    const old = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(p, old, old)
    file('p1/notes.txt', jl(asst('m2', U)))
    c.scan()
    expect(c.get().messages).toBe(0)
  })

  it('reads incrementally: only appended data on later scans', () => {
    const p = file('p1/s1.jsonl', jl(asst('m1', U)))
    c.scan()
    c.scan()
    expect(c.get().messages).toBe(1)
    appendFileSync(p, jl(asst('m2', U)))
    c.scan()
    expect(c.get().messages).toBe(2)
    expect(c.get().total).toBe(200)
  })

  it('handles a line split across scans', () => {
    const line = JSON.stringify(asst('m1', U))
    const p = file('p1/s1.jsonl', line.slice(0, 30))
    c.scan()
    expect(c.get().messages).toBe(0)
    appendFileSync(p, line.slice(30) + '\n')
    c.scan()
    expect(c.get().messages).toBe(1)
  })

  it('skips invalid JSON lines without breaking the rest', () => {
    file('p1/s1.jsonl', '{"usage": broken\n' + jl(asst('m1', U)))
    c.scan()
    expect(c.get().messages).toBe(1)
  })

  it('a truncated file is read again from the start (messages already seen are not double counted)', () => {
    const p = file('p1/s1.jsonl', jl(asst('m1', U), asst('m2', U)))
    c.scan()
    writeFileSync(p, jl(asst('m3', U)))
    c.scan()
    expect(c.get().messages).toBe(3)
    expect(c.get().total).toBe(300)
  })

  it('onChange fires only when the total changes (plus the initial zero)', () => {
    c.scan()
    expect(changes).toHaveLength(1)
    c.scan()
    expect(changes).toHaveLength(2) // sigue en 0: se vuelve a avisar
    const p = file('p1/s1.jsonl', jl(asst('m1', U)))
    c.scan()
    expect(changes).toHaveLength(3)
    c.scan()
    expect(changes).toHaveLength(3) // sin cambios y total != 0
    appendFileSync(p, jl(asst('m2', U)))
    c.scan()
    expect(changes).toHaveLength(4)
  })

  it('resets on day change', () => {
    file('p1/s1.jsonl', jl(asst('m1', U)))
    c.scan()
    expect(c.get().total).toBe(100)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 36 * 3_600_000)
    c.scan()
    expect(c.get().total).toBe(0)
    expect(c.get().messages).toBe(0)
    expect(new Date(c.get().day).getTime()).toBe(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime())
  })

  it('start() scans immediately and then on an interval; stop() halts it', async () => {
    const p = file('p1/s1.jsonl', jl(asst('m1', U)))
    c.start(100)
    expect(c.get().messages).toBe(1)
    appendFileSync(p, jl(asst('m2', U)))
    await vi.waitFor(() => expect(c.get().messages).toBe(2), { timeout: 3000, interval: 50 })
    c.stop()
    appendFileSync(p, jl(asst('m3', U)))
    await new Promise((r) => setTimeout(r, 400))
    expect(c.get().messages).toBe(2)
  })
})
