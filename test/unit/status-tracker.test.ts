import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StatusTracker, buildSettings, userStatusLine } from '../../src/main/status-tracker'
import type { SessionStatus } from '../../src/shared/types'

const tmp = () => mkdtempSync(join(tmpdir(), 'st-'))
const settings = (secrets = false) => JSON.parse(buildSettings(secrets))

// Ejecuta un comando de hook como lo hace Claude Code: sh -c con el payload por stdin.
function runHook(command: string, stdin: string, env: Record<string, string>): string {
  return execFileSync('sh', ['-c', command], { input: stdin, env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' })
}
const hookCmd = (event: string) => settings().hooks[event][0].hooks[0].command as string
const words = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])

describe('buildSettings', () => {
  it('has the expected hooks', async () => {
    const s = settings()
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    for (const ev of Object.keys(s.hooks)) {
      expect(s.hooks[ev]).toHaveLength(1)
      expect(s.hooks[ev][0].hooks[0].type).toBe('command')
    }
  })

  it('statusLine is a command with refreshInterval', async () => {
    const sl = settings().statusLine
    expect(sl.type).toBe('command')
    expect(sl.refreshInterval).toBe(30)
    expect(typeof sl.command).toBe('string')
  })

  it('permissions.deny only with secrets', async () => {
    expect(settings(false).permissions).toBeUndefined()
    const d = settings(true).permissions.deny as string[]
    expect(d).toEqual(expect.arrayContaining(['Bash(env)', 'Bash(printenv)', 'Bash(cat /proc/self/environ)']))
    expect(d.every((x) => x.startsWith('Bash('))).toBe(true)
  })

  it('returns valid JSON string', async () => {
    expect(typeof buildSettings(true)).toBe('string')
  })
})

describe('hook commands executed with sh', () => {
  let file: string
  let env: Record<string, string>
  beforeEach(() => {
    file = join(tmp(), 's.status')
    env = { CLAWHIP_STATUS_FILE: file }
  })

  it.each([
    ['SessionStart', 'idle'],
    ['UserPromptSubmit', 'working'],
    ['PostToolUse', 'working'],
    ['Stop', 'done']
  ])('%s appends "%s"', (event, word) => {
    runHook(hookCmd(event), '{"hook_event_name":"x"}', env)
    expect(words(file)).toEqual([word])
    runHook(hookCmd(event), '', env)
    expect(words(file)).toEqual([word, word])
  })

  const notif = (message: string, extra: object = {}) => JSON.stringify({ hook_event_name: 'Notification', message, ...extra })

  it.each([
    ['permission_prompt type', notif('Claude needs your attention', { notification_type: 'permission_prompt' }), ['waiting']],
    ['elicitation_dialog type', notif('Pick one', { notification_type: 'elicitation_dialog' }), ['waiting']],
    ['needs your permission message', notif('Claude needs your permission to use Bash'), ['waiting']],
    ['idle_prompt type', notif('Claude is waiting for your input', { notification_type: 'idle_prompt' }), ['idle_prompt']],
    ['unrelated notification', notif('Auth succeeded', { notification_type: 'auth_success' }), []],
    ['empty payload', '', []]
  ])('Notification: %s', (_n, payload, expected) => {
    const out = runHook(hookCmd('Notification'), payload, env)
    expect(out).toBe('')
    expect(words(file)).toEqual(expected)
  })

  it('Notification exits 0 even on an unrelated payload', async () => {
    expect(() => runHook(hookCmd('Notification'), 'basura', env)).not.toThrow()
  })

  it('Notification with a big payload does not break the pipe', async () => {
    const big = notif('x'.repeat(500_000), { notification_type: 'permission_prompt' })
    runHook(hookCmd('Notification'), big, env)
    expect(words(file)).toEqual(['waiting'])
  })

  it('hooks work when the status file path contains spaces', async () => {
    const f = join(tmp(), 'dir con espacios', 's.status')
    mkdirSync(join(f, '..'), { recursive: true })
    runHook(hookCmd('Stop'), '', { CLAWHIP_STATUS_FILE: f })
    expect(words(f)).toEqual(['done'])
  })
})

describe('statusLine command executed with sh', () => {
  const cmd = () => settings().statusLine.command as string
  let dir: string
  let file: string
  beforeEach(() => {
    dir = tmp()
    file = join(dir, 's.status')
  })

  it('writes the stdin JSON to "$CLAWHIP_STATUS_FILE.line" atomically', async () => {
    const payload = JSON.stringify({ model: { display_name: 'Opus' }, context_window: { used_percentage: 12 } })
    const out = runHook(cmd(), payload, { CLAWHIP_STATUS_FILE: file })
    expect(out).toBe('')
    expect(readFileSync(file + '.line', 'utf8')).toBe(payload)
    expect(existsSync(file + '.line.tmp')).toBe(false)
  })

  it('overwrites the previous content', async () => {
    runHook(cmd(), '{"a":1}', { CLAWHIP_STATUS_FILE: file })
    runHook(cmd(), '{"b":2}', { CLAWHIP_STATUS_FILE: file })
    expect(readFileSync(file + '.line', 'utf8')).toBe('{"b":2}')
  })

  it('does not run a user status line when BETOOLS_USER_STATUSLINE is unset or empty', async () => {
    const out = runHook(cmd(), '{}', { CLAWHIP_STATUS_FILE: file, BETOOLS_USER_STATUSLINE: '' })
    expect(out).toBe('')
  })

  it('runs the user status line with BETOOLS=1 and the same stdin; its stdout is the output', async () => {
    const marker = join(dir, 'marker')
    const user = `cat > "${marker}"; printf 'B=%s' "$BETOOLS"`
    const payload = '{"model":{"id":"m"}}'
    const out = runHook(cmd(), payload, { CLAWHIP_STATUS_FILE: file, BETOOLS_USER_STATUSLINE: user })
    expect(out).toBe('B=1')
    expect(readFileSync(marker, 'utf8')).toBe(payload)
    expect(readFileSync(file + '.line', 'utf8')).toBe(payload)
  })

  it('exits 0 even when the user status line fails', async () => {
    expect(() => runHook(cmd(), '{}', { CLAWHIP_STATUS_FILE: file, BETOOLS_USER_STATUSLINE: 'exit 3' })).not.toThrow()
  })

  it('BETOOLS=1 is visible to the user command', async () => {
    const out = runHook(cmd(), '{}', { CLAWHIP_STATUS_FILE: file, BETOOLS_USER_STATUSLINE: 'echo "[${BETOOLS:-no}]"' })
    expect(out.trim()).toBe('[1]')
  })
})

describe('userStatusLine', () => {
  const sf = () => join(homedir(), '.claude', 'settings.json')
  beforeEach(() => rmSync(join(homedir(), '.claude'), { recursive: true, force: true }))
  const write = (o: unknown) => {
    mkdirSync(join(homedir(), '.claude'), { recursive: true })
    writeFileSync(sf(), typeof o === 'string' ? o : JSON.stringify(o))
  }

  it('returns the command from ~/.claude/settings.json', async () => {
    write({ statusLine: { type: 'command', command: 'echo hola' } })
    expect(userStatusLine()).toBe('echo hola')
  })

  it('returns "" with no file, invalid JSON, other type or missing command', async () => {
    expect(userStatusLine()).toBe('')
    write('{ no json')
    expect(userStatusLine()).toBe('')
    write({ statusLine: { type: 'static', command: 'x' } })
    expect(userStatusLine()).toBe('')
    write({ statusLine: { type: 'command' } })
    expect(userStatusLine()).toBe('')
    write({})
    expect(userStatusLine()).toBe('')
  })
})

describe('StatusTracker', () => {
  const WAIT = { timeout: 5000, interval: 50 }
  let dir: string
  let calls: [string, SessionStatus, SessionStatus][]
  let tr: StatusTracker
  beforeEach(() => {
    dir = join(tmp(), 'nested', 'status')
    calls = []
    tr = new StatusTracker(dir, (id, next, prev) => calls.push([id, next, prev]))
  })
  afterEach(() => {
    for (const id of ['a', 'b']) tr.forget(id)
  })
  const settle = () => new Promise((r) => setTimeout(r, 250)) // fs.watchFile fija su estado base de forma asíncrona
  const send = (file: string, ...w: string[]) => appendFileSync(file, w.join('\n') + '\n')

  it('creates the directory; unknown sessions are "stopped"', async () => {
    expect(existsSync(dir)).toBe(true)
    expect(tr.get('zzz')).toBe('stopped')
  })

  it('start() creates an empty file, returns its path and sets idle', async () => {
    const f = tr.start('a')
    await settle()
    expect(f).toBe(join(dir, 'a.status'))
    expect(readFileSync(f, 'utf8')).toBe('')
    expect(tr.get('a')).toBe('idle')
    expect(calls).toEqual([['a', 'idle', 'stopped']])
  })

  it('transitions working -> waiting -> working -> done', async () => {
    const f = tr.start('a')
    await settle()
    send(f, 'working')
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
    send(f, 'waiting')
    await vi.waitFor(() => expect(tr.get('a')).toBe('waiting'), WAIT)
    send(f, 'working')
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
    send(f, 'done')
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
    expect(calls.map((c) => [c[1], c[2]])).toEqual([
      ['idle', 'stopped'],
      ['working', 'idle'],
      ['waiting', 'working'],
      ['working', 'waiting'],
      ['done', 'working']
    ])
  })

  it('processes several words appended at once and ignores unknown ones', async () => {
    const f = tr.start('a')
    await settle()
    send(f, 'working', 'basura', 'done')
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
    expect(calls.map((c) => c[1])).toEqual(['idle', 'working', 'done'])
  })

  it('does not notify when the state does not change', async () => {
    const f = tr.start('a')
    await settle()
    send(f, 'working')
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
    send(f, 'working')
    send(f, 'working', 'done')
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
    expect(calls.map((c) => c[1])).toEqual(['idle', 'working', 'done'])
  })

  it('idle_prompt resets working and waiting to idle only', async () => {
    const f = tr.start('a')
    await settle()
    send(f, 'working')
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
    send(f, 'idle_prompt')
    await vi.waitFor(() => expect(tr.get('a')).toBe('idle'), WAIT)

    send(f, 'waiting')
    await vi.waitFor(() => expect(tr.get('a')).toBe('waiting'), WAIT)
    send(f, 'idle_prompt')
    await vi.waitFor(() => expect(tr.get('a')).toBe('idle'), WAIT)

    send(f, 'done')
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
    const n = calls.length
    send(f, 'idle_prompt')
    await new Promise((r) => setTimeout(r, 1000))
    expect(tr.get('a')).toBe('done')
    expect(calls).toHaveLength(n)
  })

  it('seen() turns done into idle and does nothing otherwise', async () => {
    const f = tr.start('a')
    await settle()
    tr.seen('a')
    expect(calls).toHaveLength(1)
    send(f, 'working')
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
    tr.seen('a')
    expect(tr.get('a')).toBe('working')
    send(f, 'done')
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
    tr.seen('a')
    expect(tr.get('a')).toBe('idle')
    expect(calls.at(-1)).toEqual(['a', 'idle', 'done'])
  })

  it('interrupted() resets working/waiting to idle only', async () => {
    const f = tr.start('a')
    await settle()
    send(f, 'working')
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
    tr.interrupted('a')
    expect(tr.get('a')).toBe('idle')
    send(f, 'waiting')
    await vi.waitFor(() => expect(tr.get('a')).toBe('waiting'), WAIT)
    tr.interrupted('a')
    expect(tr.get('a')).toBe('idle')
    send(f, 'done')
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
    tr.interrupted('a')
    expect(tr.get('a')).toBe('done')
  })

  it('exited() stops tracking and sets "exited"; later words are ignored', async () => {
    const f = tr.start('a')
    await settle()
    tr.exited('a')
    expect(tr.get('a')).toBe('exited')
    expect(calls.at(-1)).toEqual(['a', 'exited', 'idle'])
    send(f, 'working')
    await new Promise((r) => setTimeout(r, 1000))
    expect(tr.get('a')).toBe('exited')
  })

  it('forget() drops the state without notifying', async () => {
    tr.start('a')
    const n = calls.length
    tr.forget('a')
    expect(tr.get('a')).toBe('stopped')
    expect(calls).toHaveLength(n)
  })

  it('restart via start() truncates the file and resets the offset', async () => {
    const f = tr.start('a')
    await settle()
    send(f, 'working', 'working', 'done')
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
    const f2 = tr.start('a')
    await settle()
    expect(f2).toBe(f)
    expect(tr.get('a')).toBe('idle')
    send(f2, 'working')
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
  })

  it('tracks sessions independently', async () => {
    const fa = tr.start('a')
    await settle()
    const fb = tr.start('b')
    send(fa, 'working')
    send(fb, 'done')
    await vi.waitFor(() => expect([tr.get('a'), tr.get('b')]).toEqual(['working', 'done']), WAIT)
  })

  it('works end to end with the real hook commands', async () => {
    const f = tr.start('a')
    await settle()
    runHook(hookCmd('UserPromptSubmit'), '', { CLAWHIP_STATUS_FILE: f })
    await vi.waitFor(() => expect(tr.get('a')).toBe('working'), WAIT)
    runHook(hookCmd('Notification'), '{"notification_type":"permission_prompt"}', { CLAWHIP_STATUS_FILE: f })
    await vi.waitFor(() => expect(tr.get('a')).toBe('waiting'), WAIT)
    runHook(hookCmd('Stop'), '', { CLAWHIP_STATUS_FILE: f })
    await vi.waitFor(() => expect(tr.get('a')).toBe('done'), WAIT)
  })
})
