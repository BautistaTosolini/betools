import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDialog, type Panel } from '../../src/renderer/src/menu-parser'
import { panelBlocks, panelHint, type Block } from '../../src/renderer/src/panel-blocks'

// Pantallas reales de Claude Code 2.1.332 (con datos ficticios).
const screens = JSON.parse(readFileSync('test/fixtures/screens-panels.json', 'utf8'))
const panelOf = (k: string): Panel => {
  const lines = Array.isArray(screens[k]) ? screens[k] : screens[k].lines
  const d = parseDialog(lines)
  if (d?.kind !== 'panel') throw new Error(`${k} is not a panel`)
  return d.panel
}
const blocksOf = (k: string): Block[] => {
  const p = panelOf(k)
  return panelBlocks(p.lines, { tabsRow: p.tabs[0]?.row, hint: p.hint })
}
const of = <K extends Block['kind']>(bs: Block[], kind: K) => bs.filter((b): b is Extract<Block, { kind: K }> => b.kind === kind)

describe('panelBlocks', () => {
  it('/usage: one bar per limit, with its title and reset time', () => {
    const bars = of(blocksOf('usage'), 'bar')
    expect(bars.map((b) => [b.label, b.pct])).toEqual([
      ['Current session', 10],
      ['Current week (all models)', 15],
      ['Current week (Fable)', 0]
    ])
    expect(bars[0].note).toBe('Resets 2:20pm (America/Argentina/Cordoba)')
  })

  it('/usage: rows the terminal wrapped are joined, and the loose scroll arrow is dropped', () => {
    const bs = blocksOf('usage')
    expect(of(bs, 'pair').find((b) => b.left === '92%')?.right).toBe(
      'Check which models your subagents use · share covers whole sessions, not only subagents'
    )
    expect(of(bs, 'item')).toEqual([])
  })

  it('/status: label and value, with a long path joined', () => {
    const kv = of(blocksOf('status'), 'kv')
    expect(kv[0]).toMatchObject({ key: 'Version', value: '2.1.332' })
    expect(kv.find((b) => b.key === 'cwd')?.value).toMatch(/scratchpad\/elic\/work$/)
  })

  it('/status: the key help is taken out as the hint even if the dialog parser missed it', () => {
    const p = panelOf('status')
    expect(panelHint(p.lines, p.hint)).toBe('←/→ to switch · Esc to close')
    expect(of(blocksOf('status'), 'text').some((b) => b.text.includes('Esc to close'))).toBe(false)
  })

  it('/config: search box, settings with on/off and the cursor, and "more"', () => {
    const bs = blocksOf('config')
    expect(of(bs, 'search')[0].text).toBe('Search settings…')
    const items = of(bs, 'item')
    expect(items[0]).toMatchObject({ name: 'Auto-compact', cursor: true, on: true })
    expect(items.find((i) => i.name === 'Reduce motion')).toMatchObject({ on: false })
    expect(items.find((i) => i.name === 'Time format')).toMatchObject({ value: 'auto ›' })
    expect(of(bs, 'more')[0].text).toBe('↓ 17 more')
  })

  it('/mcp: status icons per server', () => {
    const items = of(blocksOf('mcp'), 'item')
    expect(items.find((i) => i.name === 'claude.ai Notion')).toMatchObject({ icon: 'ok', value: '77 tools' })
    expect(items.find((i) => i.name === 'claude.ai Atlassian Rovo')).toMatchObject({ icon: 'warn', value: 'needs sign-in' })
    expect(items.find((i) => i.name === 'plugin:acmecorp-devops:gcp')).toMatchObject({ icon: 'error' })
    expect(items.find((i) => i.name === 'aws-mcp')).toMatchObject({ icon: 'pending', cursor: true })
  })

  it('/stats: the activity chart stays as one drawing with its months and legend', () => {
    const art = of(blocksOf('stats'), 'art')
    expect(art).toHaveLength(1)
    expect(art[0].lines[0]).toMatch(/Nov Dec Jan/)
    expect(art[0].lines.at(-1)).toMatch(/Less ░ ▒ ▓ █ More/)
  })

  it('every block keeps the screen row it came from (for clicks)', () => {
    const p = panelOf('config')
    for (const b of panelBlocks(p.lines, { tabsRow: p.tabs[0]?.row, hint: p.hint })) {
      if (b.kind === 'item') expect(p.lines[b.row]).toContain(b.name)
    }
  })
})
