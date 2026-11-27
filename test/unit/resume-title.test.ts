import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lastCustomTitle, writeResumeTitle } from '../../src/main/resume-title'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resume-title-'))
  file = join(dir, 's1.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const lines = () =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe('writeResumeTitle', () => {
  it('appends the same lines as /rename so claude --resume lists the session with it', () => {
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')
    expect(writeResumeTitle(file, 's1', 'ACME-7  deploy api ')).toBe(true)
    expect(lines().slice(1)).toEqual([
      { type: 'custom-title', customTitle: 'ACME-7 deploy api', sessionId: 's1' },
      { type: 'agent-name', agentName: 'ACME-7 deploy api', sessionId: 's1' }
    ])
    expect(lastCustomTitle(file)).toBe('ACME-7 deploy api')
  })

  it('does not write again when the last title is already that one', () => {
    writeFileSync(file, '')
    writeResumeTitle(file, 's1', 'ACME-7 deploy api')
    expect(writeResumeTitle(file, 's1', 'ACME-7 deploy api')).toBe(false)
    expect(lines()).toHaveLength(2)
  })

  it('writes again when Claude renamed it afterwards (the last one wins)', () => {
    writeFileSync(file, '')
    writeResumeTitle(file, 's1', 'ACME-7 deploy api')
    writeFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'old', sessionId: 's1' }) + '\n', { flag: 'a' })
    expect(lastCustomTitle(file)).toBe('old')
    expect(writeResumeTitle(file, 's1', 'ACME-7 deploy api')).toBe(true)
    expect(lastCustomTitle(file)).toBe('ACME-7 deploy api')
  })

  it('does not create the history of a session that has none yet', () => {
    expect(writeResumeTitle(file, 's1', 'ACME-7 deploy api')).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('ignores an empty title', () => {
    writeFileSync(file, '')
    expect(writeResumeTitle(file, 's1', '   ')).toBe(false)
  })
})

describe('lastCustomTitle', () => {
  it('finds the title at the end of a long history', () => {
    const big = JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) }) + '\n'
    writeFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'first', sessionId: 's1' }) + '\n' + big.repeat(400))
    writeFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'last', sessionId: 's1' }) + '\n', { flag: 'a' })
    expect(lastCustomTitle(file)).toBe('last')
  })

  it('is null without a title or without the file', () => {
    writeFileSync(file, '{"type":"user"}\n')
    expect(lastCustomTitle(file)).toBeNull()
    expect(lastCustomTitle(join(dir, 'missing.jsonl'))).toBeNull()
  })
})
