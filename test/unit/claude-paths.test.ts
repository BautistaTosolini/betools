import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findTranscript, projectDir, transcriptExists, transcriptPath } from '../../src/main/claude-paths'

const ROOT = () => join(homedir(), '.claude', 'projects')

beforeEach(() => rmSync(join(homedir(), '.claude'), { recursive: true, force: true }))

describe('projectDir', () => {
  it('replaces every non-alphanumeric character with "-"', () => {
    expect(projectDir('/home/user/my.project_v2')).toBe(join(ROOT(), '-home-user-my-project-v2'))
  })

  it('handles spaces, accents, dots and symbols one by one', () => {
    expect(projectDir('/a b/ñandú/@x#1')).toBe(join(ROOT(), '-a-b--and---x-1'))
  })

  it('keeps letters and digits intact', () => {
    expect(projectDir('Abc123')).toBe(join(ROOT(), 'Abc123'))
  })

  it('is under the temp HOME, never the real one', () => {
    expect(projectDir('/x').startsWith(process.env.HOME!)).toBe(true)
  })
})

describe('transcriptPath', () => {
  it('is projectDir + <id>.jsonl', () => {
    expect(transcriptPath('/a/b', 'abc-1')).toBe(join(ROOT(), '-a-b', 'abc-1.jsonl'))
  })
})

describe('findTranscript / transcriptExists', () => {
  it('returns the expected path when it exists', () => {
    const p = transcriptPath('/a/b', 'id1')
    mkdirSync(projectDir('/a/b'), { recursive: true })
    writeFileSync(p, '')
    expect(findTranscript('/a/b', 'id1')).toBe(p)
    expect(transcriptExists('/a/b', 'id1')).toBe(true)
  })

  it('prefers the expected path over other projects', () => {
    mkdirSync(projectDir('/a/b'), { recursive: true })
    mkdirSync(projectDir('/other'), { recursive: true })
    writeFileSync(transcriptPath('/a/b', 'id1'), '')
    writeFileSync(transcriptPath('/other', 'id1'), '')
    expect(findTranscript('/a/b', 'id1')).toBe(transcriptPath('/a/b', 'id1'))
  })

  it('searches other project dirs by id', () => {
    mkdirSync(projectDir('/moved/here'), { recursive: true })
    const p = transcriptPath('/moved/here', 'id2')
    writeFileSync(p, '')
    expect(findTranscript('/old/place', 'id2')).toBe(p)
    expect(transcriptExists('/old/place', 'id2')).toBe(true)
  })

  it('returns null when it does not exist anywhere', () => {
    mkdirSync(projectDir('/x'), { recursive: true })
    expect(findTranscript('/x', 'nope')).toBeNull()
    expect(transcriptExists('/x', 'nope')).toBe(false)
  })

  it('returns null when ~/.claude/projects does not exist', () => {
    expect(findTranscript('/x', 'nope')).toBeNull()
  })
})

describe('claudeBin', () => {
  const saved = { bin: process.env.CLAWHIP_CLAUDE_BIN, shell: process.env.SHELL }
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.CLAWHIP_CLAUDE_BIN
    else process.env.CLAWHIP_CLAUDE_BIN = saved.bin
    if (saved.shell === undefined) delete process.env.SHELL
    else process.env.SHELL = saved.shell
    vi.resetModules()
  })

  async function load() {
    vi.resetModules()
    return (await import('../../src/main/claude-paths')).claudeBin
  }

  it('honors CLAWHIP_CLAUDE_BIN', async () => {
    process.env.CLAWHIP_CLAUDE_BIN = '/opt/fake/claude'
    const claudeBin = await load()
    expect(claudeBin()).toBe('/opt/fake/claude')
  })

  it('caches the first resolved value', async () => {
    process.env.CLAWHIP_CLAUDE_BIN = '/opt/one/claude'
    const claudeBin = await load()
    expect(claudeBin()).toBe('/opt/one/claude')
    process.env.CLAWHIP_CLAUDE_BIN = '/opt/two/claude'
    expect(claudeBin()).toBe('/opt/one/claude')
    // un módulo nuevo vuelve a leer la variable
    const again = await load()
    expect(again()).toBe('/opt/two/claude')
  })

  it('resolves with a login shell when the variable is not set', async () => {
    delete process.env.CLAWHIP_CLAUDE_BIN
    const dir = mkdtempSync(join(tmpdir(), 'bin-'))
    const fakeClaude = join(dir, 'claude')
    writeFileSync(fakeClaude, '#!/bin/sh\n')
    chmodSync(fakeClaude, 0o755)
    // shell falso: ignora los argumentos e imprime la ruta (con ruido previo, como un perfil ruidoso)
    const shell = join(dir, 'fakeshell')
    writeFileSync(shell, `#!/bin/sh\necho "banner"\necho "${fakeClaude}"\n`)
    chmodSync(shell, 0o755)
    process.env.SHELL = shell
    const claudeBin = await load()
    expect(claudeBin()).toBe(fakeClaude)
  })

  it('falls back to ~/.local/bin/claude when it exists, else to "claude"', async () => {
    delete process.env.CLAWHIP_CLAUDE_BIN
    process.env.SHELL = '/nonexistent/shell'
    let claudeBin = await load()
    expect(claudeBin()).toBe('claude')

    mkdirSync(join(homedir(), '.local', 'bin'), { recursive: true })
    writeFileSync(join(homedir(), '.local', 'bin', 'claude'), '')
    claudeBin = await load()
    expect(claudeBin()).toBe(join(homedir(), '.local', 'bin', 'claude'))
  })
})
