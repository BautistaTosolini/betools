import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hintKeys, KEYS, parseDialog, parseMenu, textAnswerKeys, type Menu } from '../../src/renderer/src/menu-parser'
import { keyToTerm, moveToRow, switchTab } from '../../src/renderer/src/panel-nav'

// Pantallas reales de Claude Code 2.1.332 (100×40), capturadas con un emulador headless.
const fx = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures', f), 'utf8')) as Record<string, string[]>
const ask = fx('screens-ask.json')
const perm = fx('screens-perm.json')
const panels = fx('screens-panels.json')

const menuOf = (lines: string[]): Menu => {
  const d = parseDialog(lines)
  if (d?.kind !== 'menu') throw new Error(`expected a menu, got ${d?.kind}`)
  return d.menu
}

describe('AskUserQuestion with "Type something." (real screens)', () => {
  it('keeps every option although "4. Chat about this" sits below another divider', () => {
    const m = menuOf(ask.start)
    expect(m.options.map((o) => [o.n, o.label])).toEqual([[1, 'Red'], [2, 'Blue'], [3, 'Type something.'], [4, 'Chat about this']])
    expect(m.options[0].detail).toEqual(['Warm'])
    expect(m.header.map((l) => l.trim())).toContain('Which color do you want?')
    expect(m.header.join('\n')).not.toMatch(/ask me/)
  })

  it('finds the text option, also once something is typed in it', () => {
    expect(menuOf(ask.start).input).toEqual({ kind: 'type', n: 3 })
    expect(menuOf(ask.onType).input).toEqual({ kind: 'type', n: 3 })
    const typed = menuOf(ask.typed)
    expect(typed.options[2]).toMatchObject({ label: 'hola', selected: true })
    expect(typed.input).toEqual({ kind: 'type', n: 3 })
  })

  it('a written answer moves to "Type something.", types it and only then presses Enter', () => {
    expect(textAnswerKeys(menuOf(ask.start), 'quiero verde')).toEqual([KEYS.down, KEYS.down, 'quiero verde', KEYS.enter])
    expect(textAnswerKeys(menuOf(ask.onType), 'verde')).toEqual(['verde', KEYS.enter])
  })

  it('joins a multi-line answer, since the option is a single line', () => {
    expect(textAnswerKeys(menuOf(ask.start), 'uno\n  dos ')?.at(-2)).toBe('uno dos')
  })
})

describe('permission prompt with "Tab to amend" (real screens)', () => {
  it('reads the four options and the command as header', () => {
    const m = menuOf(perm.start)
    expect(m.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and always allow access to /tmp from this project',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No'
    ])
    expect(m.header.join('\n')).toContain('touch /tmp/should-not-run-xyz')
  })

  it('a written answer always rejects with feedback: No, then Tab, then the text', () => {
    expect(textAnswerKeys(menuOf(perm.start), 'usa otro archivo')).toEqual([KEYS.down, KEYS.down, KEYS.down, KEYS.tab, 'usa otro archivo', KEYS.enter])
    expect(textAnswerKeys(menuOf(perm.onNo), 'x')).toEqual([KEYS.tab, 'x', KEYS.enter])
  })

  it('does not press Tab again when "No, and tell Claude…" is already open', () => {
    expect(menuOf(perm.amending).options[3].label).toBe('No, and tell Claude what to do differently')
    expect(textAnswerKeys(menuOf(perm.amending), 'x')).toEqual(['x', KEYS.enter])
    expect(textAnswerKeys(menuOf(perm.amendTyped), 'x')).toEqual(['x', KEYS.enter])
  })

  it('offers Tab as an extra key while the hint shows it', () => {
    expect(hintKeys(menuOf(perm.start).hint)).toEqual([{ label: 'Tab', keys: [KEYS.tab], title: 'amend' }])
  })
})

describe('menus without a text answer', () => {
  it('returns null so nothing gets confirmed by accident', () => {
    const m = menuOf(panels.model)
    expect(m.input).toBeUndefined()
    expect(textAnswerKeys(m, 'hola')).toBeNull()
  })
})

describe('command panels (real screens)', () => {
  it.each(['usage', 'stats', 'status', 'config', 'configDown', 'mcp', 'export', 'permissions', 'hooks', 'memory', 'help', 'resume', 'theme', 'plugin', 'skills', 'tasks'])(
    '/%s is a panel, without the conversation above it',
    (name) => {
      const d = parseDialog(panels[name])
      expect(d?.kind).toBe('panel')
      if (d?.kind !== 'panel') return
      const top = panels[name].findIndex((l, i) => i >= d.panel.top - 1 && /^▔{8,}/.test(l))
      expect(top).toBe(d.panel.top - 1)
      expect(d.panel.lines.join('\n')).not.toMatch(/▔|Claude Code v2|Kept model/)
    }
  )

  it('/model is still a menu (numbered) with its extra key "s"', () => {
    const m = menuOf(panels.model)
    expect(m.options.map((o) => o.label.split(/\s{2,}/)[0])).toEqual(['Default (recommended)', 'Opus ✔', 'Fable', 'Sonnet', 'Haiku'])
    expect(m.options[1].selected).toBe(true)
    expect(m.header.join('\n')).not.toMatch(/Claude Code v2/)
    expect(hintKeys(m.hint)).toEqual([{ label: 's', keys: ['s'], title: 'use this session only' }])
  })

  it('reads the tabs of the Settings panel (the first word is the title)', () => {
    const d = parseDialog(panels.config)
    if (d?.kind !== 'panel') throw new Error('panel expected')
    expect(d.panel.tabs.map((t) => t.label)).toEqual(['Status', 'Config', 'Usage', 'Stats'])
    expect(d.panel.lines[d.panel.tabs[0].row].slice(d.panel.tabs[1].col)).toMatch(/^Config/)
  })

  it('reads the hint and its extra keys', () => {
    const d = parseDialog(panels.skills)
    if (d?.kind !== 'panel') throw new Error('panel expected')
    expect(d.panel.hint).toBe('↑/↓ to navigate · Space to change · / to search · t to sort · Esc to close')
    expect(hintKeys(d.panel.hint).map((k) => [k.label, k.keys[0], k.title])).toEqual([
      ['Space', ' ', 'change'],
      ['/', '/', 'search'],
      ['t', 't', 'sort']
    ])
  })

  it('the normal prompt is not a dialog', () => {
    expect(parseDialog(panels.prompt)).toBeNull()
  })

  it('a closed panel (prompt box below the ▔ line) is not a dialog', () => {
    const lines = [...panels.config.slice(0, 10), '─'.repeat(100), '❯ ', '─'.repeat(100)]
    expect(parseDialog(lines)).toBeNull()
  })

  it('parseMenu keeps working on its own for screens without a panel', () => {
    expect(parseMenu(ask.start)?.options).toHaveLength(4)
  })
})

describe('hintKeys', () => {
  it('maps named keys, ctrl+letter and ←/→, and skips navigate/confirm/cancel/editor', () => {
    const k = hintKeys('Ctrl+A to show all projects · ←/→ to adjust · Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to close')
    expect(k).toEqual([
      { label: 'Ctrl+A', keys: ['\x01'], title: 'show all projects' },
      { label: '←', keys: [KEYS.left], title: 'adjust' },
      { label: '→', keys: [KEYS.right], title: 'adjust' }
    ])
  })
})

// Lista simulada: el cursor de la terminal está en la fila del elemento enfocado.
function fakeList(rows: number[], start: number, opts: { wrap?: boolean } = {}) {
  let i = rows.indexOf(start)
  const sent: string[] = []
  return {
    sent,
    io: {
      cursor: () => rows[i],
      send: (k: string) => {
        sent.push(k)
        if (k === KEYS.down) i = i + 1 < rows.length ? i + 1 : opts.wrap ? 0 : i
        if (k === KEYS.up) i = i > 0 ? i - 1 : opts.wrap ? rows.length - 1 : i
      },
      wait: async () => {}
    },
    at: () => rows[i]
  }
}

describe('moveToRow', () => {
  it('moves down and up to a row', async () => {
    const l = fakeList([8, 9, 10, 11, 12], 8)
    expect(await moveToRow(l.io, 11)).toBe(true)
    expect(l.at()).toBe(11)
    expect(await moveToRow(l.io, 9)).toBe(true)
    expect(l.sent).toEqual([KEYS.down, KEYS.down, KEYS.down, KEYS.up, KEYS.up])
  })

  it('skips lines that cannot be selected (separators, descriptions)', async () => {
    const l = fakeList([8, 9, 11, 12], 8) // la fila 10 es un texto ("Thinking can't be turned off")
    expect(await moveToRow(l.io, 12)).toBe(true)
    expect(l.at()).toBe(12)
  })

  it('clicking the second line of a two-line item selects that item', async () => {
    const l = fakeList([10, 12, 14], 10) // elementos de dos líneas (nombre y descripción)
    expect(await moveToRow(l.io, 13)).toBe(true)
    expect(l.at()).toBe(12)
    const u = fakeList([10, 12, 14], 14)
    expect(await moveToRow(u.io, 11)).toBe(true)
    expect(u.at()).toBe(10)
  })

  it('stops when the cursor does not move or wraps around', async () => {
    const stuck = fakeList([8, 9], 9)
    expect(await moveToRow(stuck.io, 20)).toBe(false)
    const wrap = fakeList([8, 9], 9, { wrap: true })
    expect(await moveToRow(wrap.io, 20)).toBe(false)
    expect(wrap.sent).toEqual([KEYS.down])
  })
})

describe('switchTab', () => {
  it('uses Tab and falls back to the arrows when Tab does not switch', async () => {
    let active = 0
    const sent: string[] = []
    const io = { active: () => active, send: (k: string) => { sent.push(k); if (k === KEYS.tab) active = (active + 1) % 4 }, wait: async () => {} }
    expect(await switchTab(io, 2, 4)).toBe(true)
    expect(sent).toEqual([KEYS.tab, KEYS.tab])

    let a2 = 0
    const sent2: string[] = []
    const io2 = { active: () => a2, send: (k: string) => { sent2.push(k); if (k === KEYS.right) a2++; if (k === KEYS.left) a2-- }, wait: async () => {} }
    expect(await switchTab(io2, 2, 4)).toBe(true)
    expect(sent2).toEqual([KEYS.tab, KEYS.right, KEYS.right])
  })
})

describe('keyToTerm', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
    keyToTerm({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
  it('forwards text, editing and navigation keys', () => {
    expect(k('a')).toBe('a')
    expect(k('/')).toBe('/')
    expect(k(' ')).toBe(' ')
    expect(k('Backspace')).toBe('\x7f')
    expect(k('Enter')).toBe('\r')
    expect(k('Escape')).toBe('\x1b')
    expect(k('Tab')).toBe('\t')
    expect(k('Tab', { shiftKey: true })).toBe('\x1b[Z')
    expect(k('ArrowDown')).toBe(KEYS.down)
    expect(k('a', { ctrlKey: true })).toBe('\x01')
  })
  it('keeps Ctrl+C / Ctrl+V for copy and paste, and ignores modifiers alone', () => {
    expect(k('c', { ctrlKey: true })).toBeNull()
    expect(k('v', { ctrlKey: true })).toBeNull()
    expect(k('Shift', { shiftKey: true })).toBeNull()
    expect(k('Control', { ctrlKey: true })).toBeNull()
  })
})
