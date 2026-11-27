import { describe, expect, it } from 'vitest'
import { applyShortcut, shortcutFor, type Edit } from '../../src/renderer/src/md-shortcuts'

// Aplica el atajo y devuelve el texto con la selección marcada entre [ ].
function run(kind: string, marked: string): string {
  const start = marked.indexOf('[')
  const end = marked.indexOf(']') - 1
  const text = marked.replace('[', '').replace(']', '')
  const e = applyShortcut(kind, text, start, end) as Edit
  const out = text.slice(0, e.from) + e.insert + text.slice(e.to)
  return out.slice(0, e.selStart) + '[' + out.slice(e.selStart, e.selEnd) + ']' + out.slice(e.selEnd)
}

const key = (k: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

describe('shortcutFor', () => {
  it('recognizes the formatting shortcuts and nothing else', () => {
    expect(shortcutFor(key('b'))).toBe('b')
    expect(shortcutFor(key('B'))).toBe('b')
    expect(shortcutFor(key('i'))).toBe('i')
    expect(shortcutFor(key('e'))).toBe('e')
    expect(shortcutFor(key('k'))).toBe('k')
    expect(shortcutFor(key('X', { shiftKey: true }))).toBe('x')
    expect(shortcutFor(key('s'))).toBeNull()
    expect(shortcutFor(key('b', { ctrlKey: false }))).toBeNull()
    expect(shortcutFor(key('b', { altKey: true }))).toBeNull()
    expect(shortcutFor(key('b', { shiftKey: true }))).toBeNull()
  })
})

describe('applyShortcut', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(run('b', 'hola [mundo] fin')).toBe('hola **[mundo]** fin')
    expect(run('i', 'hola [mundo] fin')).toBe('hola *[mundo]* fin')
    expect(run('e', 'run [npm test]')).toBe('run `[npm test]`')
    expect(run('x', '[viejo]')).toBe('~~[viejo]~~')
  })

  it('with nothing selected leaves the cursor between the marks', () => {
    expect(run('b', 'hola []')).toBe('hola **[]**')
  })

  it('removes the format when it is already there (marks outside or inside the selection)', () => {
    expect(run('b', 'hola **[mundo]** fin')).toBe('hola [mundo] fin')
    expect(run('b', 'hola [**mundo**] fin')).toBe('hola [mundo] fin')
    expect(run('i', 'hola *[mundo]* fin')).toBe('hola [mundo] fin')
    expect(run('e', '`[x]`')).toBe('[x]')
  })

  it('italic does not mistake bold for italic', () => {
    expect(run('i', 'hola **[mundo]** fin')).toBe('hola ***[mundo]*** fin')
    expect(run('i', 'hola [**mundo**] fin')).toBe('hola *[**mundo**]* fin')
  })

  it('Ctrl+K makes a link and selects what is left to type', () => {
    expect(run('k', 'ver [la guía] acá')).toBe('ver [la guía]([url]) acá')
    expect(run('k', 'ver []')).toBe('ver [[text]](url)')
    expect(run('k', 'ver [https://example.com/x]')).toBe('ver [[]](https://example.com/x)')
  })
})
