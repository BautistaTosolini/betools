import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDoc, writeDoc } from '../../src/main/docs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'betools-docs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('writeDoc', () => {
  it('saves and returns the new version', () => {
    const p = join(dir, 'notes.md')
    writeFileSync(p, '# old\n')
    const before = readDoc(p)
    const after = writeDoc(p, '# new\nñ 日本\n', before.mtime)
    expect(after.text).toBe('# new\nñ 日本\n')
    expect(readFileSync(p, 'utf8')).toBe('# new\nñ 日本\n')
    expect(after.mtime).toBe(readDoc(p).mtime)
  })

  it('refuses to overwrite a file changed on disk, unless told to', () => {
    const p = join(dir, 'plan.md')
    writeFileSync(p, 'v1')
    const stale = readDoc(p).mtime
    // Otro proceso (p. ej. Claude) lo cambia después de abrirlo.
    writeFileSync(p, 'v2 from claude')
    utimesSync(p, new Date(), new Date(Date.now() + 5000))
    expect(() => writeDoc(p, 'mine', stale)).toThrow(/^CONFLICT:/)
    expect(readFileSync(p, 'utf8')).toBe('v2 from claude')
    writeDoc(p, 'mine', null)
    expect(readFileSync(p, 'utf8')).toBe('mine')
  })

  it('keeps permissions and symlinks, and leaves no temp files', () => {
    const real = join(dir, 'real.md')
    const link = join(dir, 'link.md')
    writeFileSync(real, 'a')
    chmodSync(real, 0o640)
    symlinkSync(real, link)
    writeDoc(link, 'b', null)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('b')
    expect(statSync(real).mode & 0o777).toBe(0o640)
    expect(readdirSync(dir).sort()).toEqual(['link.md', 'real.md'])
  })

  it('only edits existing Markdown files', () => {
    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'x')
    expect(() => writeDoc(txt, 'y', null)).toThrow('Only Markdown files can be edited in betools.')
    expect(readFileSync(txt, 'utf8')).toBe('x')
    expect(() => writeDoc(join(dir, 'missing.md'), 'y', null)).toThrow(/ENOENT/)
    expect(readdirSync(dir)).toEqual(['a.txt'])
  })
})
