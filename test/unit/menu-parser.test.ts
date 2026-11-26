import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMenu } from '../../src/renderer/src/menu-parser'

// Pantallas reales de Claude Code 2.1.332 capturadas con un emulador headless (test/fixtures/screens-*.json):
// cada archivo es { paso: líneas de la pantalla }.
const fixture = (name: string): Record<string, string[]> =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures', name), 'utf8'))

const RULE = '─'.repeat(80)

describe('parseMenu: numbered menus', () => {
  const permission = [
    '● Voy a borrar la carpeta de build.',
    '',
    RULE,
    ' Bash command',
    '',
    '   rm -rf build',
    '   Remove build dir',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for rm commands in /tmp/x",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend'
  ]

  it('reads a permission prompt: header, options, cursor and hint', () => {
    const m = parseMenu(permission)!
    expect(m).not.toBeNull()
    expect(m.form).toBeUndefined()
    expect(m.options.map((o) => [o.n, o.label, o.selected])).toEqual([
      [1, 'Yes', true],
      [2, "Yes, and don't ask again for rm commands in /tmp/x", false],
      [3, 'No, and tell Claude what to do differently (esc)', false]
    ])
    expect(m.hint).toBe('Esc to cancel · Tab to amend')
    // Lo que está arriba de la línea divisoria es conversación, no diálogo.
    expect(m.header.join('\n')).not.toContain('Voy a borrar')
    expect(m.header).toContain('Bash command')
    expect(m.header).toContain('  rm -rf build')
    expect(m.header[m.header.length - 1]).toBe('Do you want to proceed?')
  })

  it('attaches indented descriptions to the previous option', () => {
    const m = parseMenu([
      RULE,
      ' ☐ Región  ☐ Entorno  ✔ Submit',
      '',
      '¿En qué región?',
      '',
      '❯ 1. us-east-1',
      '     Virginia, la más barata',
      '  2. sa-east-1',
      '     San Pablo',
      '  3. Type something.',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel'
    ])!
    expect(m.options).toHaveLength(3)
    expect(m.options[0].detail).toEqual(['Virginia, la más barata'])
    expect(m.options[1].detail).toEqual(['San Pablo'])
    expect(m.header[0].trim()).toBe('☐ Región  ☐ Entorno  ✔ Submit')
  })

  it('reads multi-select checkboxes', () => {
    const m = parseMenu([
      RULE,
      'Qué entornos?',
      '❯ 1. [x] dev',
      '  2. [ ] stg',
      '  3. [✔] prd',
      '',
      'Enter to confirm · Space to toggle · Esc to cancel'
    ])!
    expect(m.options.map((o) => o.checked)).toEqual([true, false, true])
  })

  it('accepts a menu with no hint line when a cursor and two options are at the bottom', () => {
    const m = parseMenu([
      RULE,
      'Review your answers',
      '',
      ' ● ¿Región?',
      '   → us-east-1',
      '',
      'Ready to submit your answers?',
      '',
      '❯ 1. Submit answers',
      '  2. Cancel',
      ''
    ])!
    expect(m).not.toBeNull()
    expect(m.hint).toBe('')
    expect(m.options.map((o) => o.label)).toEqual(['Submit answers', 'Cancel'])
  })

  it('returns null for a normal prompt screen', () => {
    expect(
      parseMenu(['● Listo, terminé.', '', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'])
    ).toBeNull()
  })

  it('does not take the user prompt "❯ 1. algo" above as the dialog start', () => {
    const m = parseMenu([
      '❯ 1. haz esto primero',
      '',
      RULE,
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      'Esc to cancel'
    ])!
    expect(m.options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })
})

describe('parseMenu: unnumbered menus (real screen)', () => {
  const shots = fixture('screens-mcp-approval.json')

  it('reads the "New MCP server found" options, which have no numbers', () => {
    const m = parseMenu(shots.start)!
    expect(m.options.map((o) => o.label)).toEqual([
      'Use this MCP server',
      'Use this and all future MCP servers in this project',
      'Continue without using this MCP server'
    ])
    expect(m.options.map((o) => o.n)).toEqual([1, 2, 3])
    expect(m.options.findIndex((o) => o.selected)).toBe(2)
    expect(m.header[0]).toBe('New MCP server found in this project: fake')
    expect(m.hint).toBe('Enter to confirm · Esc to reject')
  })

  it('follows the cursor after moving down (wraps to the first option)', () => {
    const m = parseMenu(shots.down)!
    expect(m.options.findIndex((o) => o.selected)).toBe(0)
  })
})

describe('parseMenu: MCP elicitation forms (real screens)', () => {
  const single = fixture('screens-form-enum.json')
  const multi = fixture('screens-form-multi.json')

  it('reads the initial form: message as header, one required choice field, no options', () => {
    const m = parseMenu(single.start)!
    expect(m.form).toBeDefined()
    expect(m.options).toEqual([])
    expect(m.header[0]).toBe('MCP server “fake” requests your input')
    expect(m.header).toContain('… (+2 more lines)')
    const [f] = m.form!.fields
    expect(m.form!.fields).toHaveLength(1)
    expect(f).toMatchObject({ label: 'Decision', value: '', status: 'required', focused: true, expanded: false, kind: 'choice' })
    expect(f.desc).toEqual(['Approve or reject this sensitive operation.'])
    expect(m.form!.button).toBeNull()
  })

  it('reads the expanded choices and the cursor', () => {
    const m = parseMenu(single.expanded)!
    const f = m.form!.fields[0]
    expect(f.expanded).toBe(true)
    expect(f.choices).toEqual([
      { label: 'Approve', cursor: true, on: false },
      { label: 'Reject', cursor: false, on: false }
    ])
    expect(parseMenu(single.cursorDown)!.form!.fields[0].choices.map((c) => c.cursor)).toEqual([false, true])
  })

  it('after picking with Enter the value is set and the focus moves to the buttons', () => {
    const m = parseMenu(single.picked)!
    expect(m.form!.fields[0]).toMatchObject({ value: 'Reject', status: 'done', focused: false, expanded: false })
    expect(m.form!.button).toBe('accept')
  })

  it('reads a form with choice, boolean and text fields', () => {
    const m = parseMenu(multi.start)!
    expect(m.form!.fields.map((f) => [f.label, f.status, f.focused])).toEqual([
      ['Decision', 'required', true],
      ['Confirm', '', false],
      ['Name', '', false]
    ])
    expect(m.form!.fields[1].desc).toEqual(['Are you sure?'])
  })

  it('knows the kind of the focused field and keeps values of the others', () => {
    const b = parseMenu(multi.boolFocused)!.form!
    expect(b.fields[1]).toMatchObject({ focused: true, kind: 'bool', value: '☐' })
    const on = parseMenu(multi.boolOn)!.form!
    expect(on.fields[1]).toMatchObject({ value: '☒', status: 'done' })
    const t = parseMenu(multi.textFocused)!.form!
    expect(t.fields[2]).toMatchObject({ focused: true, kind: 'text', value: '' })
    // El sí/no ya marcado sigue siendo "bool" aunque no tenga el foco.
    expect(t.fields[1]).toMatchObject({ kind: 'bool', value: '☒' })
    expect(parseMenu(multi.textTyped)!.form!.fields[2]).toMatchObject({ value: 'hola', status: 'done' })
  })

  it('reads which button has the focus', () => {
    expect(parseMenu(multi.buttonsAccept)!.form!.button).toBe('accept')
    expect(parseMenu(multi.buttonsDecline)!.form!.button).toBe('decline')
    expect(parseMenu(multi.buttonsDecline)!.form!.fields.every((f) => !f.focused)).toBe(true)
  })
})
