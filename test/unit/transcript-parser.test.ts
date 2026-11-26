import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTERRUPTED, TranscriptParser } from '../../src/main/transcript-parser'

const TS = '2026-01-01T10:00:00.000Z'

// Helpers para construir líneas del transcript
const jl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
const user = (content: unknown, extra: object = {}) => ({ type: 'user', timestamp: TS, message: { role: 'user', content }, ...extra })
const asst = (content: unknown[], extra: object = {}, msg: object = {}) => ({
  type: 'assistant',
  timestamp: TS,
  message: { id: 'm1', role: 'assistant', content, ...msg },
  ...extra
})
const sys = (subtype: string, extra: object = {}) => ({ type: 'system', subtype, timestamp: TS, ...extra })

function parse(...objs: unknown[]): TranscriptParser {
  const p = new TranscriptParser()
  p.push(Buffer.from(jl(...objs)))
  return p
}

describe('push: chunking', () => {
  it('returns false for empty chunks, invalid JSON and blank lines', () => {
    const p = new TranscriptParser()
    expect(p.push(Buffer.from(''))).toBe(false)
    expect(p.push(Buffer.from('not json\n\n{broken\n'))).toBe(false)
    expect(p.items).toEqual([])
  })

  it('handles a line split across chunks', () => {
    const p = new TranscriptParser()
    const data = Buffer.from(jl(user('hola mundo')))
    p.push(data.subarray(0, 20))
    expect(p.items).toHaveLength(0)
    p.push(data.subarray(20))
    expect(p.items.map((i) => i.text)).toEqual(['hola mundo'])
  })

  it('handles a split in the middle of a multi-byte UTF-8 character', () => {
    const p = new TranscriptParser()
    const data = Buffer.from(jl(user('canción 日本 😀')))
    const idx = data.indexOf(Buffer.from('😀')) + 2 // a mitad de los 4 bytes del emoji
    p.push(data.subarray(0, idx))
    p.push(data.subarray(idx))
    expect(p.items[0].text).toBe('canción 日本 😀')
  })

  it('keeps a trailing incomplete line until its newline arrives', () => {
    const p = new TranscriptParser()
    const line = JSON.stringify(user('uno'))
    p.push(Buffer.from(line))
    expect(p.items).toHaveLength(0)
    p.push(Buffer.from('\n'))
    expect(p.items).toHaveLength(1)
  })

  it('processes several lines in one chunk', () => {
    const p = parse(user('a'), user('b'), user('c'))
    expect(p.items.map((i) => i.text)).toEqual(['a', 'b', 'c'])
  })

  it('returns true when something changed (title, model)', () => {
    const p = new TranscriptParser()
    expect(p.push(Buffer.from(jl({ type: 'ai-title', aiTitle: 'x' })))).toBe(true)
    expect(p.push(Buffer.from(jl(asst([], {}, { model: 'claude-x' }))))).toBe(true)
    expect(p.push(Buffer.from(jl(asst([], {}, { model: 'claude-x' }))))).toBe(false)
  })
})

describe('user messages', () => {
  it('string content', () => {
    const p = parse(user('  hola  '))
    expect(p.items).toEqual([{ kind: 'user', text: 'hola', at: TS }])
  })

  it('array content with text and image', () => {
    const p = parse(user([{ type: 'text', text: 'mira esto' }, { type: 'image', source: {} }]))
    expect(p.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'mira esto'],
      ['user', '[image]']
    ])
  })

  it('skips empty text', () => {
    expect(parse(user('   ')).items).toEqual([])
  })

  it('skips isMeta messages', () => {
    expect(parse(user('meta', { isMeta: true })).items).toEqual([])
  })

  it('isCompactSummary produces a summary item', () => {
    const p = parse(user('long summary...', { isCompactSummary: true }))
    expect(p.items).toEqual([{ kind: 'summary', text: 'Conversation compacted', at: TS }])
  })

  it('command-name and command-args produce a command item', () => {
    const p = parse(user('<command-message>x</command-message><command-name>/model</command-name><command-args> opus </command-args>'))
    expect(p.items).toEqual([{ kind: 'command', text: '/model opus', at: TS }])
  })

  it('command without args', () => {
    const p = parse(user('<command-name>/clear</command-name><command-args></command-args>'))
    expect(p.items[0].text).toBe('/clear')
  })

  it('bash-input produces "! cmd"', () => {
    const p = parse(user('<bash-input>ls -la</bash-input>'))
    expect(p.items).toEqual([{ kind: 'command', text: '! ls -la', at: TS }])
  })

  it.each(['<local-command-stdout>x</local-command-stdout>', '<bash-stdout>x</bash-stdout>', '<system-reminder>x</system-reminder>', '<command-foo>x'])(
    'skips internal tags: %s',
    (t) => {
      expect(parse(user(t)).items).toEqual([])
    }
  )

  it('interruption becomes a summary INTERRUPTED', () => {
    const p = parse(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))
    expect(p.items).toEqual([{ kind: 'summary', text: INTERRUPTED, at: TS }])
    expect(INTERRUPTED).toBe('Interrupted by user')
  })

  it('queued_command attachment with human origin becomes a user item', () => {
    const p = parse({ type: 'attachment', timestamp: TS, attachment: { type: 'queued_command', prompt: '  sigue  ', origin: { kind: 'human' } } })
    expect(p.items).toEqual([{ kind: 'user', text: 'sigue', at: TS }])
  })

  it('queued_command with humanTurn also counts; other origins do not', () => {
    const p = parse(
      { type: 'attachment', timestamp: TS, attachment: { type: 'queued_command', prompt: 'a', humanTurn: true } },
      { type: 'attachment', timestamp: TS, attachment: { type: 'queued_command', prompt: 'b', origin: { kind: 'task-notification' } } }
    )
    expect(p.items.map((i) => i.text)).toEqual(['a'])
  })

  it('task-notification becomes a notice, done by default', () => {
    const p = parse(user('<task-notification><status>completed</status><summary>Build ok</summary></task-notification>'))
    expect(p.items).toEqual([{ kind: 'notice', level: 'done', text: 'Build ok', at: TS }])
  })

  it.each(['failed', 'error', 'killed', 'stopped'])('task-notification with status %s is an error', (status) => {
    const p = parse(user(`<task-notification><status>${status}</status><summary>Algo</summary></task-notification>`))
    expect(p.items[0]).toMatchObject({ kind: 'notice', level: 'error', text: 'Algo' })
  })

  it('task-notification without summary yields nothing', () => {
    expect(parse(user('<task-notification><status>completed</status></task-notification>')).items).toEqual([])
  })

  it('uses the current time when the entry has no timestamp', () => {
    const p = parse({ type: 'user', message: { content: 'x' } })
    expect(Date.parse(p.items[0].at)).toBeGreaterThan(Date.now() - 5000)
  })
})

describe('AskUserQuestion answers', () => {
  it('toolUseResult.answers produces an answers item', () => {
    const p = parse(
      user([{ type: 'tool_result', tool_use_id: 'zz', content: 'ok' }], { toolUseResult: { answers: { '¿Color?': 'rojo', '¿N?': 3 } } })
    )
    const item = p.items.find((i) => i.kind === 'answers')!
    expect(JSON.parse(item.text)).toEqual([
      { q: '¿Color?', a: 'rojo' },
      { q: '¿N?', a: '3' }
    ])
  })

  it('empty or array answers are ignored', () => {
    expect(parse(user('x', { toolUseResult: { answers: {} } })).items.filter((i) => i.kind === 'answers')).toEqual([])
    expect(parse(user('x', { toolUseResult: { answers: ['a'] } })).items.filter((i) => i.kind === 'answers')).toEqual([])
  })
})

describe('local_command system entries', () => {
  const lc = (content: string) => sys('local_command', { content })

  it('command entry', () => {
    const p = parse(lc('<command-name>/context</command-name><command-args>a b</command-args>'))
    expect(p.items).toEqual([{ kind: 'command', text: '/context a b', at: TS }])
  })

  it('stdout is attached to the previous command with NUL and ANSI is stripped', () => {
    const p = parse(lc('<command-name>/context</command-name>'), lc('<local-command-stdout>\x1b[1mHola\x1b[0m mundo</local-command-stdout>'))
    expect(p.items).toHaveLength(1)
    expect(p.items[0].text).toBe('/context\u0000Hola mundo')
  })

  it('stderr is attached too', () => {
    const p = parse(lc('<command-name>/x</command-name>'), lc('<local-command-stderr>boom</local-command-stderr>'))
    expect(p.items[0].text).toBe('/x\u0000boom')
  })

  it('a second output is not attached again', () => {
    const p = parse(
      lc('<command-name>/x</command-name>'),
      lc('<local-command-stdout>uno</local-command-stdout>'),
      lc('<local-command-stdout>dos</local-command-stdout>')
    )
    expect(p.items[0].text).toBe('/x\u0000uno')
  })

  it('stdout without previous command is dropped', () => {
    expect(parse(lc('<local-command-stdout>huérfano</local-command-stdout>')).items).toEqual([])
  })

  it('empty stdout is ignored', () => {
    const p = parse(lc('<command-name>/x</command-name>'), lc('<local-command-stdout>  </local-command-stdout>'))
    expect(p.items[0].text).toBe('/x')
  })

  it('stdout after a non-command item is dropped', () => {
    const p = parse(user('hola'), lc('<local-command-stdout>x</local-command-stdout>'))
    expect(p.items.map((i) => i.text)).toEqual(['hola'])
  })
})

describe('system notices', () => {
  it('away_summary becomes Recap and strips the turn-off hint', () => {
    const p = parse(sys('away_summary', { content: 'Trabajaste en X. (turn off recaps in /config)' }))
    expect(p.items[0]).toEqual({ kind: 'notice', level: 'info', text: 'Recap: Trabajaste en X.', at: TS })
  })

  it('informational', () => {
    expect(parse(sys('informational', { content: 'Aviso' })).items[0]).toMatchObject({ kind: 'notice', level: 'info', text: 'Aviso' })
  })

  it.each([
    [13_000, 'Worked for 13s'],
    [400, 'Worked for 0s'],
    [59_400, 'Worked for 59s'],
    [60_000, 'Worked for 1m 0s'],
    [125_000, 'Worked for 2m 5s'],
    [3_600_000, 'Worked for 1h 0m'],
    [3_725_000, 'Worked for 1h 2m']
  ])('turn_duration %i ms', (ms, text) => {
    expect(parse(sys('turn_duration', { durationMs: ms })).items[0]).toMatchObject({ kind: 'notice', level: 'done', text })
  })

  it('stop_hook_summary with errors', () => {
    const p = parse(sys('stop_hook_summary', { hookErrors: ['fallo uno', 'fallo dos'] }))
    expect(p.items[0]).toMatchObject({ kind: 'notice', level: 'error', text: 'Stop hook error: fallo uno · fallo dos' })
  })

  it('stop_hook_summary without errors produces nothing', () => {
    expect(parse(sys('stop_hook_summary', { hookErrors: [] })).items).toEqual([])
    expect(parse(sys('stop_hook_summary')).items).toEqual([])
  })

  it('model_refusal_fallback is a warning', () => {
    expect(parse(sys('model_refusal_fallback', { content: 'Cambio de modelo' })).items[0]).toMatchObject({ level: 'warn', text: 'Cambio de modelo' })
  })

  it('any subtype containing "error" is an error notice', () => {
    expect(parse(sys('api_error', { content: 'Rate limit' })).items[0]).toMatchObject({ level: 'error', text: 'Rate limit' })
  })

  it('unknown subtype produces nothing', () => {
    expect(parse(sys('whatever', { content: 'x' })).items).toEqual([])
  })
})

describe('assistant content', () => {
  it('text blocks with the same message.id are merged into one item', () => {
    const p = parse(asst([{ type: 'text', text: 'Uno' }]), asst([{ type: 'text', text: 'Dos' }]))
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ kind: 'assistant', text: 'Uno\n\nDos', msgId: 'm1' })
  })

  it('different message.id are not merged', () => {
    const p = parse(asst([{ type: 'text', text: 'Uno' }], {}, { id: 'a' }), asst([{ type: 'text', text: 'Dos' }], {}, { id: 'b' }))
    expect(p.items).toHaveLength(2)
  })

  it('no msgId: not merged', () => {
    const p = parse(
      { type: 'assistant', timestamp: TS, message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', timestamp: TS, message: { content: [{ type: 'text', text: 'b' }] } }
    )
    expect(p.items).toHaveLength(2)
  })

  it('ignores blank text blocks', () => {
    expect(parse(asst([{ type: 'text', text: '  ' }])).items).toEqual([])
  })

  it('keeps only non-empty thinking blocks', () => {
    const p = parse(asst([{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: ' pienso ' }]))
    expect(p.items).toEqual([{ kind: 'thinking', text: 'pienso', at: TS, msgId: 'm1' }])
  })

  it('thinking followed by text of the same message stay separate items', () => {
    const p = parse(asst([{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }]))
    expect(p.items.map((i) => i.kind)).toEqual(['thinking', 'assistant'])
  })
})

describe('tool use / result', () => {
  const tu = (id: string, name: string, input: object) => asst([{ type: 'tool_use', id, name, input }], {}, { id: 'm-' + id })
  const tr = (id: string, content: unknown, extra: object = {}, isError = false) =>
    user([{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }], extra)

  it('tool_use creates a tool item not done', () => {
    const p = parse(tu('t1', 'Read', { file_path: '/a/b.ts' }))
    expect(p.items[0]).toMatchObject({ kind: 'tool', text: 'Read: /a/b.ts' })
    expect(p.items[0].tool).toEqual({ id: 't1', name: 'Read', input: '/a/b.ts', done: false, edits: undefined })
  })

  it('Bash input is formatted "# description\\ncommand"', () => {
    const p = parse(tu('t1', 'Bash', { command: 'ls -la', description: 'Lista' }))
    expect(p.items[0].tool!.input).toBe('# Lista\nls -la')
    expect(p.items[0].text).toBe('Bash: ls -la')
  })

  it('Bash input without description is the bare command', () => {
    expect(parse(tu('t1', 'Bash', { command: 'pwd' })).items[0].tool!.input).toBe('pwd')
  })

  it('other tools show the JSON input; tool without data shows only the name', () => {
    const p = parse(tu('t1', 'Grep', { pattern: 'foo' }), tu('t2', 'Foo', {}))
    expect(JSON.parse(p.items[0].tool!.input)).toEqual({ pattern: 'foo' })
    expect(p.items[0].text).toBe('Grep: foo')
    expect(p.items[1].text).toBe('Foo')
  })

  it('summary collapses whitespace and truncates at 240 chars', () => {
    const p = parse(tu('t1', 'Bash', { command: 'a\n  b' + 'x'.repeat(300) }))
    expect(p.items[0].text.startsWith('Bash: a bxxx')).toBe(true)
    expect(p.items[0].text.endsWith('…')).toBe(true)
    expect(p.items[0].text.length).toBe('Bash: '.length + 241)
  })

  it('server_tool_use also creates an item', () => {
    const p = parse(asst([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }]))
    expect(p.items[0].tool!.name).toBe('web_search')
  })

  it('Edit, MultiEdit and Write produce edits', () => {
    const p = parse(
      tu('e', 'Edit', { file_path: '/x', old_string: 'a', new_string: 'b' }),
      tu('m', 'MultiEdit', { file_path: '/x', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] }),
      tu('w', 'Write', { file_path: '/y', content: 'hola' })
    )
    expect(p.items[0].tool!.edits).toEqual([{ old: 'a', new: 'b' }])
    expect(p.items[1].tool!.edits).toEqual([
      { old: '1', new: '2' },
      { old: '3', new: '4' }
    ])
    expect(p.items[2].tool!.edits).toEqual([{ old: '', new: 'hola' }])
  })

  it('MultiEdit is limited to 20 edits and long strings are clipped', () => {
    const edits = Array.from({ length: 25 }, (_, i) => ({ old_string: String(i), new_string: 'z'.repeat(3500) }))
    const p = parse(tu('m', 'MultiEdit', { file_path: '/x', edits }))
    expect(p.items[0].tool!.edits).toHaveLength(20)
    expect(p.items[0].tool!.edits![0].new).toContain('… (500 more characters)')
  })

  it('tool input is clipped at 4000 characters', () => {
    const p = parse(tu('t', 'Bash', { command: 'x'.repeat(4100) }))
    expect(p.items[0].tool!.input).toContain('… (100 more characters)')
  })

  it('tool_result completes the item (string content)', () => {
    const p = parse(tu('t1', 'Bash', { command: 'echo' }), tr('t1', 'salida'))
    expect(p.items).toHaveLength(1)
    expect(p.items[0].tool).toMatchObject({ done: true, result: 'salida', error: false })
  })

  it('tool_result array content: text blocks and images', () => {
    const p = parse(tu('t1', 'Read', { file_path: '/a' }), tr('t1', [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]))
    expect(p.items[0].tool!.result).toBe('a\n[image]\nb')
  })

  it('is_error sets error', () => {
    const p = parse(tu('t1', 'Bash', { command: 'false' }), tr('t1', 'fail', {}, true))
    expect(p.items[0].tool).toMatchObject({ done: true, error: true, result: 'fail' })
  })

  it('Bash toolUseResult stdout/stderr is preferred over content', () => {
    const p = parse(tu('t1', 'Bash', { command: 'x' }), tr('t1', 'contenido crudo', { toolUseResult: { stdout: 'out', stderr: 'err' } }))
    expect(p.items[0].tool!.result).toBe('out\nerr')
  })

  it('empty stdout/stderr are dropped', () => {
    const p = parse(tu('t1', 'Bash', { command: 'x' }), tr('t1', 'raw', { toolUseResult: { stdout: '  ', stderr: 'solo err' } }))
    expect(p.items[0].tool!.result).toBe('solo err')
  })

  it('toolUseResult without stdout falls back to content', () => {
    const p = parse(tu('t1', 'Read', { file_path: '/a' }), tr('t1', 'raw', { toolUseResult: { file: {} } }))
    expect(p.items[0].tool!.result).toBe('raw')
  })

  it('strips system-reminder and ANSI from results', () => {
    const p = parse(tu('t1', 'Read', { file_path: '/a' }), tr('t1', 'dato\n<system-reminder>\nsecreto\n</system-reminder>\x1b[31m rojo\x1b[0m'))
    expect(p.items[0].tool!.result).toBe('dato\n rojo')
  })

  it('clips results at 6000 characters', () => {
    const p = parse(tu('t1', 'Bash', { command: 'x' }), tr('t1', 'y'.repeat(6050)))
    const r = p.items[0].tool!.result!
    expect(r.startsWith('y'.repeat(6000))).toBe(true)
    expect(r.endsWith('… (50 more characters)')).toBe(true)
  })

  it('a tool_result without a matching tool is ignored', () => {
    const p = parse(tr('nada', 'x'))
    expect(p.items).toEqual([])
  })

  it('a second result for the same id does not change anything', () => {
    const p = parse(tu('t1', 'Bash', { command: 'x' }), tr('t1', 'primero'), tr('t1', 'segundo'))
    expect(p.items[0].tool!.result).toBe('primero')
  })

  it('a tool_result does not create a user item', () => {
    const p = parse(tu('t1', 'Bash', { command: 'x' }), tr('t1', 'ok'))
    expect(p.items.map((i) => i.kind)).toEqual(['tool'])
  })
})

describe('sidechain', () => {
  it('isSidechain entries are ignored for the conversation', () => {
    const p = parse(user('subagente', { isSidechain: true }), asst([{ type: 'text', text: 'x' }], { isSidechain: true }), user('real'))
    expect(p.items.map((i) => i.text)).toEqual(['real'])
  })

  it('sidechain entries still contribute to artifacts and model', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pcwd-'))
    const p = parse(
      asst([{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: join(cwd, 'a.md') } }], { isSidechain: true, cwd }, { model: 'claude-sub' })
    )
    expect(p.items).toEqual([])
    expect(p.list()).toHaveLength(1)
    expect(p.model()).toBe('claude-sub')
  })
})

describe('takeChangedFrom', () => {
  it('is Infinity initially and after being taken', () => {
    const p = new TranscriptParser()
    expect(p.takeChangedFrom()).toBe(Infinity)
    p.push(Buffer.from(jl(user('a'))))
    expect(p.takeChangedFrom()).toBe(0)
    expect(p.takeChangedFrom()).toBe(Infinity)
  })

  it('returns the index of the first new item', () => {
    const p = parse(user('a'), user('b'))
    p.takeChangedFrom()
    p.push(Buffer.from(jl(user('c'), user('d'))))
    expect(p.takeChangedFrom()).toBe(2)
  })

  it('returns the earlier index when a tool_result updates an earlier item', () => {
    const p = parse(
      asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }]),
      user('b'),
      user('c')
    )
    p.takeChangedFrom()
    p.push(Buffer.from(jl(user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]), user('d'))))
    expect(p.items).toHaveLength(4)
    expect(p.takeChangedFrom()).toBe(0)
  })

  it('merged assistant text touches the existing item index', () => {
    const p = parse(user('a'), asst([{ type: 'text', text: 'x' }]))
    p.takeChangedFrom()
    p.push(Buffer.from(jl(asst([{ type: 'text', text: 'y' }]))))
    expect(p.takeChangedFrom()).toBe(1)
  })
})

describe('title and model', () => {
  it('ai-title alone', () => {
    expect(parse({ type: 'ai-title', aiTitle: '  Titulo IA ' }).title()).toBe('Titulo IA')
  })

  it('custom-title beats ai-title regardless of order', () => {
    expect(parse({ type: 'custom-title', customTitle: 'Mío' }, { type: 'ai-title', aiTitle: 'IA' }).title()).toBe('Mío')
    expect(parse({ type: 'ai-title', aiTitle: 'IA' }, { type: 'custom-title', customTitle: 'Mío' }).title()).toBe('Mío')
  })

  it('empty custom title falls back to the ai title; none gives null', () => {
    expect(parse({ type: 'ai-title', aiTitle: 'IA' }, { type: 'custom-title', customTitle: '  ' }).title()).toBe('IA')
    expect(new TranscriptParser().title()).toBeNull()
  })

  it('model tracks the last assistant model', () => {
    const p = parse(asst([], {}, { model: 'claude-a' }), asst([], {}, { model: 'claude-b' }))
    expect(p.model()).toBe('claude-b')
  })

  it('model ignores <synthetic>', () => {
    const p = parse(asst([], {}, { model: 'claude-a' }), asst([], {}, { model: '<synthetic>' }))
    expect(p.model()).toBe('claude-a')
    expect(new TranscriptParser().model()).toBeNull()
  })

  it('model is read only from assistant entries', () => {
    expect(parse({ type: 'user', timestamp: TS, message: { model: 'x', content: 'a' } }).model()).toBeNull()
  })
})

describe('artifacts list()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'part-'))
  const w = (id: string, name: string, input: object, at = TS, extra: object = {}) =>
    asst([{ type: 'tool_use', id, name, input }], { cwd: dir, timestamp: at, ...extra }, { id: 'm-' + id })

  it('Write/Edit/MultiEdit/NotebookEdit register paths with their source', () => {
    const p = parse(
      w('1', 'Write', { file_path: '/p/a.md' }),
      w('2', 'Edit', { file_path: '/p/b.ts' }),
      w('3', 'MultiEdit', { file_path: '/p/c.json' }),
      w('4', 'NotebookEdit', { notebook_path: '/p/d.ipynb' })
    )
    const l = p.list()
    const by = Object.fromEntries(l.map((a) => [a.path, a]))
    expect(by['/p/a.md']).toMatchObject({ name: 'a.md', ext: '.md', sources: ['Write'], isDocument: true, exists: false })
    expect(by['/p/b.ts']).toMatchObject({ sources: ['Edit'], isDocument: false })
    expect(by['/p/c.json'].sources).toEqual(['MultiEdit'])
    expect(by['/p/d.ipynb'].sources).toEqual(['NotebookEdit'])
  })

  it('relative paths resolve against the entry cwd', () => {
    const l = parse(w('1', 'Write', { file_path: 'sub/../informe.pdf' })).list()
    expect(l[0].path).toBe(join(dir, 'informe.pdf'))
  })

  it('relative path without cwd is ignored', () => {
    const l = parse(asst([{ type: 'tool_use', id: '1', name: 'Write', input: { file_path: 'x.md' } }])).list()
    expect(l).toEqual([])
  })

  it('~ is expanded to the home dir', () => {
    const l = parse(w('1', 'Write', { file_path: '~/docs/x.md' })).list()
    expect(l[0].path).toBe(join(homedir(), 'docs', 'x.md'))
  })

  it('paths under ~/.claude/projects are ignored', () => {
    const l = parse(
      w('1', 'Write', { file_path: join(homedir(), '.claude', 'projects', 'p', 'memory', 'm.md') }),
      w('2', 'Write', { file_path: '~/.claude/projects/z.md' }),
      w('3', 'Write', { file_path: join(homedir(), '.claude', 'other.md') })
    ).list()
    expect(l.map((a) => a.path)).toEqual([join(homedir(), '.claude', 'other.md')])
  })

  it('merges sources, firstAt and lastAt for the same path', () => {
    const l = parse(
      w('1', 'Write', { file_path: '/p/a.md' }, '2026-01-01T10:00:00.000Z'),
      w('2', 'Edit', { file_path: '/p/a.md' }, '2026-01-01T11:00:00.000Z'),
      w('3', 'Edit', { file_path: '/p/a.md' }, '2026-01-01T09:00:00.000Z')
    ).list()
    expect(l).toHaveLength(1)
    expect(l[0].sources).toEqual(['Write', 'Edit'])
    expect(l[0].firstAt).toBe('2026-01-01T10:00:00.000Z')
    expect(l[0].lastAt).toBe('2026-01-01T11:00:00.000Z')
  })

  it('sorts by lastAt descending', () => {
    const l = parse(
      w('1', 'Write', { file_path: '/p/old.md' }, '2026-01-01T10:00:00.000Z'),
      w('2', 'Write', { file_path: '/p/new.md' }, '2026-01-03T10:00:00.000Z'),
      w('3', 'Write', { file_path: '/p/mid.md' }, '2026-01-02T10:00:00.000Z')
    ).list()
    expect(l.map((a) => a.name)).toEqual(['new.md', 'mid.md', 'old.md'])
  })

  it('isDocument depends on the extension (case-insensitive)', () => {
    const l = parse(w('1', 'Write', { file_path: '/p/A.PDF' }), w('2', 'Write', { file_path: '/p/b.rs' }), w('3', 'Write', { file_path: '/p/noext' })).list()
    const by = Object.fromEntries(l.map((a) => [a.name, a]))
    expect(by['A.PDF']).toMatchObject({ ext: '.pdf', isDocument: true })
    expect(by['b.rs'].isDocument).toBe(false)
    expect(by['noext']).toMatchObject({ ext: '', isDocument: false })
  })

  it('exists reflects the file system', () => {
    const f = join(dir, 'real.md')
    writeFileSync(f, 'x')
    const l = parse(w('1', 'Write', { file_path: f })).list()
    expect(l[0].exists).toBe(true)
  })

  it('an erroring tool_result undoes the operation', () => {
    const p = parse(
      w('1', 'Write', { file_path: '/p/a.md' }),
      user([{ type: 'tool_result', tool_use_id: '1', content: 'denied', is_error: true }])
    )
    expect(p.list()).toEqual([])
  })

  it('an error only undoes one of several operations on the same path', () => {
    const p = parse(
      w('1', 'Write', { file_path: '/p/a.md' }),
      w('2', 'Edit', { file_path: '/p/a.md' }),
      user([{ type: 'tool_result', tool_use_id: '2', content: 'x', is_error: true }])
    )
    expect(p.list()).toHaveLength(1)
  })

  it('a successful tool_result keeps the artifact', () => {
    const p = parse(w('1', 'Write', { file_path: '/p/a.md' }), user([{ type: 'tool_result', tool_use_id: '1', content: 'ok' }]))
    expect(p.list()).toHaveLength(1)
  })

  describe('Bash heuristic', () => {
    const bash = (cmd: string, at: string) => w('b', 'Bash', { command: cmd }, at)

    it('counts a document that exists with mtime >= timestamp - 2s', () => {
      const f = join(dir, 'reporte.pdf')
      writeFileSync(f, 'x')
      const at = new Date().toISOString()
      const l = parse(bash(`pandoc in.md -o ${f}`, at)).list()
      expect(l).toHaveLength(1)
      expect(l[0]).toMatchObject({ path: f, sources: ['Bash'], isDocument: true, exists: true })
    })

    it('ignores a file older than timestamp - 2s', () => {
      const f = join(dir, 'viejo.pdf')
      writeFileSync(f, 'x')
      const old = new Date(Date.now() - 60_000)
      utimesSync(f, old, old)
      expect(parse(bash(`cat ${f}`, new Date().toISOString())).list()).toEqual([])
    })

    it('tolerates up to 2s of difference', () => {
      const f = join(dir, 'justo.pdf')
      writeFileSync(f, 'x')
      const m = new Date(Date.now() - 1000)
      utimesSync(f, m, m)
      expect(parse(bash(`cat ${f}`, new Date().toISOString())).list()).toHaveLength(1)
    })

    it('ignores files that do not exist', () => {
      expect(parse(bash(`pandoc -o ${join(dir, 'nada.pdf')}`, new Date().toISOString())).list()).toEqual([])
    })

    it('resolves relative paths against cwd, with quotes and ./ prefix', () => {
      const f = join(dir, 'out.html')
      writeFileSync(f, 'x')
      const l = parse(bash(`node gen.js > "./out.html"`, new Date().toISOString())).list()
      expect(l.map((a) => a.path)).toEqual([f])
    })

    it('deduplicates repeated paths and finds several files', () => {
      const a = join(dir, 'a1.png')
      const b = join(dir, 'b1.csv')
      writeFileSync(a, 'x')
      writeFileSync(b, 'x')
      const l = parse(bash(`cp ${a} ${a} && cat ${b}`, new Date().toISOString())).list()
      expect(l.map((x) => x.path).sort()).toEqual([a, b].sort())
    })

    it('extensions outside the Bash list (e.g. .ts) do not count', () => {
      const f = join(dir, 'code.ts')
      writeFileSync(f, 'x')
      expect(parse(bash(`cat ${f}`, new Date().toISOString())).list()).toEqual([])
    })

    it('an error result undoes Bash artifacts', () => {
      const f = join(dir, 'err.pdf')
      writeFileSync(f, 'x')
      const p = parse(bash(`cat ${f}`, new Date().toISOString()), user([{ type: 'tool_result', tool_use_id: 'b', content: 'x', is_error: true }]))
      expect(p.list()).toEqual([])
    })

    it('Bash without command or other tools produce no artifacts', () => {
      expect(parse(w('b', 'Bash', {}), w('g', 'Grep', { pattern: 'x.pdf' })).list()).toEqual([])
    })
  })

  it('tool_use inside a user entry does not register artifacts', () => {
    const l = parse({ type: 'user', timestamp: TS, cwd: dir, message: { content: [{ type: 'tool_use', id: '1', name: 'Write', input: { file_path: '/p/a.md' } }] } }).list()
    expect(l).toEqual([])
  })
})

