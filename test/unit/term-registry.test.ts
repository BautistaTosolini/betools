import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { dimMask, onScreen, readActivity, readCliInput, readLive, readQueued, registerTerm, screenLines } from '../../src/renderer/src/term-registry'

// La pantalla se arma con una terminal headless real (misma lógica de buffer que la de la app) y secuencias
// ANSI como las de Claude Code (p. ej. texto atenuado con ESC[2m).
const RULE = '─'.repeat(60)
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((f) => f()))

async function screen(lines: string[], id = 'x', rows = 20): Promise<Terminal> {
  const term = new Terminal({ cols: 60, rows, allowProposedApi: true })
  await new Promise<void>((r) => term.write(lines.join('\r\n'), r))
  cleanups.push(registerTerm(id, term as never))
  return term
}

describe('screen reading', () => {
  it('returns the visible lines and notifies listeners on writes', async () => {
    const term = await screen(['hola', 'mundo'])
    expect(screenLines('x').slice(0, 2)).toEqual(['hola', 'mundo'])
    expect(screenLines('missing')).toEqual([])
    let n = 0
    cleanups.push(onScreen('x', () => n++))
    await new Promise<void>((r) => term.write('!', r))
    expect(n).toBeGreaterThan(0)
  })

  it('marks dim cells', async () => {
    await screen([`❯ ${DIM('Try "fix lint"')}`])
    const mask = dimMask('x', 0)
    expect(mask[0]).toBe(false)
    expect(mask[2]).toBe(true)
  })
})

describe('readCliInput', () => {
  it('treats the dim placeholder of an empty prompt as empty', async () => {
    await screen(['● listo', RULE, `❯ ${DIM('Try "how do I log an error?"')}`, RULE, '  ⏵⏵ auto mode on'])
    expect(readCliInput('x')).toEqual({ text: '', lines: 1, collapsed: false })
  })

  it('reads typed text, including several lines', async () => {
    await screen(['● listo', RULE, '❯ primera línea', '  segunda línea', RULE])
    expect(readCliInput('x')).toEqual({ text: 'primera línea\nsegunda línea', lines: 2, collapsed: false })
  })

  it('flags pasted blocks and images that cannot be read back as text', async () => {
    await screen([RULE, '❯ mira [Pasted text #1 +20 lines] y [Image #2]', RULE])
    expect(readCliInput('x')?.collapsed).toBe(true)
  })

  it('returns null when there is no prompt box (e.g. a dialog is open)', async () => {
    await screen([RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'])
    expect(readCliInput('x')).toBeNull()
  })
})

describe('readQueued', () => {
  it('reads messages sent while Claude works, single and multi-line', async () => {
    await screen([
      '✻ Pondering… (3s)',
      '❯ revisa también los tests',
      '  ⎿ Queued · Claude reads it next',
      '❯ y después',
      '  el README',
      '  ⎿ Queued',
      RULE,
      '❯ ',
      RULE
    ])
    expect(readQueued('x')).toEqual(['revisa también los tests', 'y después\nel README'])
  })
})

describe('readActivity', () => {
  it('reads the spinner line with detail and the tip below it', async () => {
    await screen(['✶ Harmonizing… (11m 26s · ↓ 57.5k tokens)', '  ⎿  Tip: Use /btw for side questions', RULE, '❯ ', RULE])
    expect(readActivity('x')).toEqual({ label: 'Harmonizing…', detail: '11m 26s · ↓ 57.5k tokens', tip: 'Tip: Use /btw for side questions' })
  })

  it('returns null without a spinner line', async () => {
    await screen(['● Listo.', RULE, '❯ ', RULE])
    expect(readActivity('x')).toBeNull()
  })
})

describe('readLive', () => {
  const working = [
    '● Voy a revisar el código.',
    '',
    '✻ Pondering… (12s · ↓ 300 tokens · esc to interrupt)',
    '  ⎿  ☒ Leer el parser',
    '     ☐ Agregar la zona en vivo',
    '',
    '  ● Explore(Buscar componentes) · 3 tool uses',
    '  ⎿  Tip: Use /btw to ask a side question',
    '❯ mensaje encolado',
    '  ⎿ Queued · Claude reads it next',
    RULE,
    '❯ ',
    RULE,
    '  ⏵⏵ auto mode on · 1 background task',
    '  ? for shortcuts'
  ]

  it('returns what is drawn between the activity line and the prompt, without tip or queued messages', async () => {
    await screen(working)
    expect(readLive('x')).toEqual({
      lines: ['⎿  ☒ Leer el parser', '   ☐ Agregar la zona en vivo', '', '● Explore(Buscar componentes) · 3 tool uses'],
      footer: ['⏵⏵ auto mode on · 1 background task']
    })
  })

  it('returns only the footer when Claude is idle', async () => {
    await screen(['● Listo.', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'])
    expect(readLive('x')).toEqual({ lines: [], footer: ['⏵⏵ auto mode on (shift+tab to cycle)'] })
  })

  it('returns null when a dialog replaces the prompt', async () => {
    await screen([RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'])
    expect(readLive('x')).toBeNull()
  })
})
