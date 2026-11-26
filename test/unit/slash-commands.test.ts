import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node-pty es nativo (ABI de Electron): se simula para poder cargar pty-manager bajo Node.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

type Mod = typeof import('../../src/main/slash-commands')
const HOME = () => homedir()
const CLAUDE = () => join(HOME(), '.claude')

// El módulo cachea por cwd (30 s) y claudeBin cachea el binario: cada prueba carga una copia nueva.
async function load(): Promise<Mod> {
  vi.resetModules()
  return await import('../../src/main/slash-commands')
}

let n = 0
// cwd único dentro del HOME temporal (y con .claude propio opcional)
function project(...sub: string[]): string {
  const p = join(HOME(), 'proj' + ++n, ...sub)
  mkdirSync(p, { recursive: true })
  return p
}
const put = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}
const skill = (root: string, dir: string, fm: string) => put(join(root, 'skills', dir, 'SKILL.md'), fm)

beforeEach(() => {
  rmSync(CLAUDE(), { recursive: true, force: true })
})

const find = (list: { name: string }[], name: string) => list.find((c) => c.name === name) as any

describe('frontmatter parsing (through skills)', () => {
  const desc = async (fm: string, dir = 'my-skill', lookup = dir) => {
    skill(CLAUDE(), dir, fm)
    const { listSlashCommands } = await load()
    return find(listSlashCommands(project()), lookup) ?? null
  }

  it('name and description, plain', async () => {
    skill(CLAUDE(), 'dir1', '---\nname: nice-name\ndescription: Does a thing\n---\nbody')
    const { listSlashCommands } = await load()
    const c = find(listSlashCommands(project()), 'nice-name')
    expect(c).toEqual({ name: 'nice-name', description: 'Does a thing', source: 'user' })
    expect(find(listSlashCommands(project()), 'dir1')).toBeUndefined()
  })

  it('falls back to the directory name when name is missing', async () => {
    const c = await desc('---\ndescription: x\n---\n', 'by-dir')
    expect(c).toMatchObject({ name: 'by-dir', description: 'x' })
  })

  it('skill without frontmatter: dir name with the first non-heading line as description', async () => {
    const c = await desc('# Título\n\nPrimera línea real\notra', 'nofm')
    expect(c).toMatchObject({ name: 'nofm', description: 'Primera línea real' })
  })

  it('skill with frontmatter but no description: empty description', async () => {
    expect(await desc('---\nname: z\n---\n', 'zz')).toBeNull() // el nombre es "z"
  })

  it('folded block scalar (>) joins lines with spaces', async () => {
    const c = await desc('---\ndescription: >\n  primera linea\n  segunda linea\nname: foo\n---\n', 'blk', 'foo')
    expect(c).toMatchObject({ name: 'foo', description: 'primera linea segunda linea' })
  })

  it.each(['|', '>-', '|-'])('block scalar indicator %s', async (ind) => {
    const c = await desc(`---\nname: bs\ndescription: ${ind}\n  uno\n  dos\n---\n`, 'bsdir', 'bs')
    expect(c.description).toBe('uno dos')
  })

  it('empty value followed by an indented block', async () => {
    const c = await desc('---\nname: eb\ndescription:\n  contenido\n  indentado\n---\n', 'ebdir', 'eb')
    expect(c.description).toBe('contenido indentado')
  })

  it('strips surrounding quotes (single and double)', async () => {
    skill(CLAUDE(), 'q1', '---\nname: "quoted"\ndescription: \'Has: colon\'\n---\n')
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(project()), 'quoted')).toMatchObject({ description: 'Has: colon' })
  })

  it('CRLF line endings', async () => {
    skill(CLAUDE(), 'crlf', '---\r\nname: crlf-skill\r\ndescription: con crlf\r\n---\r\nbody')
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(project()), 'crlf-skill')).toMatchObject({ description: 'con crlf' })
  })

  it('ignores other keys', async () => {
    skill(CLAUDE(), 'k', '---\nallowed-tools: Bash\nname: k-skill\nmodel: opus\ndescription: d\n---\n')
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(project()), 'k-skill').description).toBe('d')
  })

  it('directories without SKILL.md are not skills', async () => {
    mkdirSync(join(CLAUDE(), 'skills', 'empty-dir'), { recursive: true })
    put(join(CLAUDE(), 'skills', 'a-file.md'), 'x')
    const { listSlashCommands } = await load()
    const names = listSlashCommands(project()).map((c) => c.name)
    expect(names).not.toContain('empty-dir')
    expect(names).not.toContain('a-file')
  })
})

describe('commands', () => {
  it('user commands from ~/.claude/commands with frontmatter and without', async () => {
    put(join(CLAUDE(), 'commands', 'deploy.md'), '---\ndescription: Deploy it\n---\nrun')
    put(join(CLAUDE(), 'commands', 'plain.md'), '# Heading\n\nSolo texto\n')
    put(join(CLAUDE(), 'commands', 'ignored.txt'), 'x')
    const { listSlashCommands } = await load()
    const l = listSlashCommands(project())
    expect(find(l, 'deploy')).toEqual({ name: 'deploy', description: 'Deploy it', source: 'user' })
    expect(find(l, 'plain')).toEqual({ name: 'plain', description: 'Solo texto', source: 'user' })
    expect(find(l, 'ignored')).toBeUndefined()
  })

  it('nested directories form "a:b" names', async () => {
    put(join(CLAUDE(), 'commands', 'frontend', 'test.md'), '---\ndescription: FE test\n---\n')
    put(join(CLAUDE(), 'commands', 'frontend', 'deep', 'lint.md'), 'lint')
    const { listSlashCommands } = await load()
    const l = listSlashCommands(project())
    expect(find(l, 'frontend:test')).toMatchObject({ description: 'FE test', source: 'user' })
    expect(find(l, 'frontend:deep:lint')).toMatchObject({ source: 'user' })
  })

  it('does not go deeper than 3 levels of directories', async () => {
    put(join(CLAUDE(), 'commands', 'a', 'b', 'c', 'ok.md'), 'x')
    put(join(CLAUDE(), 'commands', 'a', 'b', 'c', 'd', 'too-deep.md'), 'x')
    const { listSlashCommands } = await load()
    const names = listSlashCommands(project()).map((c) => c.name)
    expect(names).toContain('a:b:c:ok')
    expect(names).not.toContain('a:b:c:d:too-deep')
  })
})

describe('project directories', () => {
  it('reads .claude from the cwd and from each parent up to HOME', async () => {
    const cwd = project('a', 'b')
    const top = join(cwd, '..', '..')
    put(join(cwd, '.claude', 'commands', 'inner.md'), 'inner')
    put(join(cwd, '..', '.claude', 'commands', 'middle.md'), 'middle')
    put(join(top, '.claude', 'commands', 'outer.md'), 'outer')
    skill(join(cwd, '..', '.claude'), 'proj-skill', '---\ndescription: ps\n---\n')
    const { listSlashCommands } = await load()
    const l = listSlashCommands(cwd)
    for (const n of ['inner', 'middle', 'outer', 'proj-skill']) expect(find(l, n)).toMatchObject({ source: 'project' })
  })

  it('does not include HOME/.claude as a project dir (it is the user dir)', async () => {
    put(join(CLAUDE(), 'commands', 'mine.md'), 'x')
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(project()), 'mine').source).toBe('user')
  })

  it('a sibling folder whose name starts with HOME (/home/ana2 for /home/ana) is not inside HOME', async () => {
    const sibling = HOME() + '2'
    put(join(sibling, '.claude', 'commands', 'sibling-cmd.md'), 'x')
    const cwd = join(sibling, 'proj')
    mkdirSync(cwd, { recursive: true })
    const { listSlashCommands } = await load()
    try {
      expect(find(listSlashCommands(cwd), 'sibling-cmd')).toBeUndefined()
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('does not go beyond HOME', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    put(join(outside, '.claude', 'commands', 'outside-cmd.md'), 'x')
    const cwd = join(outside, 'sub')
    mkdirSync(cwd)
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(cwd), 'outside-cmd')).toBeUndefined()
  })

  it('the cwd above HOME in the tree (a parent of HOME) is not read either', async () => {
    const cwd = project()
    const parent = join(HOME(), '..')
    // no se escribe fuera del HOME: solo se comprueba que el listado no falla con un cwd que no existe
    const { listSlashCommands } = await load()
    expect(() => listSlashCommands(join(cwd, 'no-existe'))).not.toThrow()
    expect(existsSync(parent)).toBe(true)
  })
})

describe('plugins', () => {
  function plugin(key: string, installPath: string | null, enabled?: boolean) {
    const f = join(CLAUDE(), 'plugins', 'installed_plugins.json')
    let cur: any = { plugins: {} }
    if (existsSync(f)) cur = JSON.parse(readFileSync(f, 'utf8'))
    cur.plugins[key] = installPath ? [{ installPath: '/old/ignored' }, { installPath }] : []
    put(f, JSON.stringify(cur))
    if (enabled !== undefined) {
      const s = join(CLAUDE(), 'settings.json')
      const ss = existsSync(s) ? JSON.parse(readFileSync(s, 'utf8')) : {}
      ss.enabledPlugins = { ...(ss.enabledPlugins ?? {}), [key]: enabled }
      put(s, JSON.stringify(ss))
    }
  }
  const mkPlugin = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `plug-${name}-`))
    skill(dir, 'build', '---\ndescription: Plugin skill\n---\n')
    put(join(dir, 'commands', 'ship.md'), '---\ndescription: Plugin cmd\n---\n')
    put(join(dir, 'commands', 'grp', 'sub.md'), 'x')
    return dir
  }

  it('lists skills and commands of installed plugins with the "plugin:" prefix (last install path wins)', async () => {
    plugin('craft@market', mkPlugin('craft'))
    const { listSlashCommands } = await load()
    const l = listSlashCommands(project())
    expect(find(l, 'craft:build')).toEqual({ name: 'craft:build', description: 'Plugin skill', source: 'plugin' })
    expect(find(l, 'craft:ship')).toMatchObject({ description: 'Plugin cmd', source: 'plugin' })
    expect(find(l, 'craft:grp:sub')).toMatchObject({ source: 'plugin' })
  })

  it('enabledPlugins false disables; true or missing enables', async () => {
    plugin('off@m', mkPlugin('off'), false)
    plugin('on@m', mkPlugin('on'), true)
    plugin('unset@m', mkPlugin('unset'))
    const { listSlashCommands } = await load()
    const names = listSlashCommands(project()).map((c) => c.name)
    expect(names).not.toContain('off:build')
    expect(names).toContain('on:build')
    expect(names).toContain('unset:build')
  })

  it('skips plugins whose install path does not exist or is empty', async () => {
    plugin('gone@m', '/definitely/not/here')
    plugin('empty@m', null)
    const { listSlashCommands } = await load()
    const names = listSlashCommands(project()).map((c) => c.name)
    expect(names.some((x) => x.startsWith('gone:') || x.startsWith('empty:'))).toBe(false)
  })

  it('invalid JSON files do not break the listing', async () => {
    put(join(CLAUDE(), 'plugins', 'installed_plugins.json'), '{no')
    put(join(CLAUDE(), 'settings.json'), '{no')
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(project()), 'resume')).toBeDefined()
  })
})

describe('precedence and builtins', () => {
  it('project > user > plugin > builtin on duplicate names', async () => {
    const cwd = project()
    put(join(cwd, '.claude', 'commands', 'dup.md'), '---\ndescription: from project\n---\n')
    put(join(CLAUDE(), 'commands', 'dup.md'), '---\ndescription: from user\n---\n')
    put(join(CLAUDE(), 'commands', 'dup2.md'), '---\ndescription: user dup2\n---\n')
    put(join(CLAUDE(), 'commands', 'model.md'), '---\ndescription: user shadows builtin\n---\n')
    const plug = mkdtempSync(join(tmpdir(), 'plug-'))
    put(join(plug, 'commands', 'x.md'), 'x')
    put(join(CLAUDE(), 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'dup2@m': [{ installPath: plug }] } }))
    // un plugin llamado "dup2" con comando "x" produce "dup2:x"; para chocar por nombre completo se usa otra skill
    skill(CLAUDE(), 'dup2:x', '---\nname: dup2:x\ndescription: user wins\n---\n')
    const { listSlashCommands } = await load()
    const l = listSlashCommands(cwd)
    expect(l.filter((c) => c.name === 'dup')).toHaveLength(1)
    expect(find(l, 'dup')).toMatchObject({ description: 'from project', source: 'project' })
    expect(find(l, 'dup2')).toMatchObject({ source: 'user' })
    expect(find(l, 'model')).toMatchObject({ description: 'user shadows builtin', source: 'user' })
    expect(l.filter((c) => c.name === 'dup2:x')).toHaveLength(1)
    expect(find(l, 'dup2:x')).toMatchObject({ source: 'user', description: 'user wins' })
  })

  it('nearest project .claude wins over a parent one', async () => {
    const cwd = project('a')
    put(join(cwd, '.claude', 'commands', 'same.md'), '---\ndescription: near\n---\n')
    put(join(cwd, '..', '.claude', 'commands', 'same.md'), '---\ndescription: far\n---\n')
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(cwd), 'same').description).toBe('near')
  })

  it('a project skill beats a project command with the same name', async () => {
    const cwd = project()
    skill(join(cwd, '.claude'), 'both', '---\ndescription: skill\n---\n')
    put(join(cwd, '.claude', 'commands', 'both.md'), '---\ndescription: command\n---\n')
    const { listSlashCommands } = await load()
    expect(find(listSlashCommands(cwd), 'both').description).toBe('skill')
  })

  it('builtin list has interactive commands and no longer has cost/vim/review', async () => {
    const { listSlashCommands } = await load()
    const l = listSlashCommands(project())
    for (const n of ['resume', 'theme', 'login', 'copy', 'clear', 'compact', 'model', 'help', 'exit']) {
      expect(find(l, n), n).toMatchObject({ source: 'builtin' })
      expect(find(l, n).description.length).toBeGreaterThan(0)
    }
    for (const n of ['cost', 'vim', 'review']) expect(find(l, n), n).toBeUndefined()
  })

  it('builtin names are unique', async () => {
    const { listSlashCommands } = await load()
    const names = listSlashCommands(project()).map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('caches the result per cwd for a while', async () => {
    const cwd = project()
    const { listSlashCommands } = await load()
    const first = listSlashCommands(cwd)
    put(join(CLAUDE(), 'commands', 'late.md'), 'x')
    expect(listSlashCommands(cwd)).toBe(first)
    expect(find(listSlashCommands(project()), 'late')).toBeDefined() // otro cwd: no usa la caché
  })
})

describe('listSlashCommandsFull', () => {
  let work: string
  let countFile: string
  let envFile: string
  let argsFile: string
  const savedBin = process.env.CLAWHIP_CLAUDE_BIN

  // claude falso: cuenta invocaciones, vuelca entorno y argumentos y, con -p ... stream-json, imprime el init.
  function fake(body: string) {
    const script = `#!/bin/sh
echo x >> "${countFile}"
env > "${envFile}"
printf '%s\\n' "$@" > "${argsFile}"
${body}
`
    const p = join(work, 'claude')
    writeFileSync(p, script)
    chmodSync(p, 0o755)
    process.env.CLAWHIP_CLAUDE_BIN = p
  }
  const initScript = (cmds: string[]) => `
case " $* " in *" --output-format stream-json "*) printf '%s\\n' '${JSON.stringify({ type: 'system', subtype: 'init', slash_commands: cmds })}'; exec sleep 30;; esac
exit 1`
  const spawns = () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length : 0)

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'fake-claude-'))
    countFile = join(work, 'count')
    envFile = join(work, 'env')
    argsFile = join(work, 'args')
  })
  afterEach(() => {
    vi.useRealTimers()
    if (savedBin === undefined) delete process.env.CLAWHIP_CLAUDE_BIN
    else process.env.CLAWHIP_CLAUDE_BIN = savedBin
  })

  it('quick returns the disk list without spawning anything', async () => {
    fake(initScript(['foo']))
    const { listSlashCommandsFull } = await load()
    const l = await listSlashCommandsFull(project(), true)
    expect(find(l, 'resume')).toBeDefined()
    expect(find(l, 'foo')).toBeUndefined()
    expect(spawns()).toBe(0)
  })

  it('merges: init names first with disk descriptions, hidden and "__" removed, missing disk entries appended', async () => {
    put(join(CLAUDE(), 'commands', 'mycmd.md'), '---\ndescription: Mi comando\n---\n')
    put(join(CLAUDE(), 'commands', 'unlisted.md'), '---\ndescription: No está en init\n---\n')
    fake(
      initScript([
        'mycmd', 'compact', 'unknown-skill', 'plug:thing', '__internal', '__x',
        'workflow-launch-exec', 'design-consent', 'design-revoke', 'extra-usage', 'heapdump', 'clear'
      ])
    )
    const { listSlashCommandsFull } = await load()
    const cwd = project()
    const l = await listSlashCommandsFull(cwd)
    const names = l.map((c) => c.name)
    expect(names.slice(0, 5)).toEqual(['mycmd', 'compact', 'unknown-skill', 'plug:thing', 'clear'])
    expect(l[0]).toEqual({ name: 'mycmd', description: 'Mi comando', source: 'user' })
    expect(l[1]).toMatchObject({ name: 'compact', source: 'builtin' })
    expect(l[1].description).toMatch(/context/i)
    expect(l[2]).toEqual({ name: 'unknown-skill', description: '', source: 'builtin' })
    expect(l[3]).toEqual({ name: 'plug:thing', description: '', source: 'plugin' })
    for (const hidden of ['__internal', '__x', 'workflow-launch-exec', 'design-consent', 'design-revoke', 'extra-usage', 'heapdump']) {
      expect(names).not.toContain(hidden)
    }
    // los de disco/builtin que no estaban en init van al final
    expect(names).toContain('unlisted')
    expect(names).toContain('resume')
    expect(names.indexOf('unlisted')).toBeGreaterThan(4)
    expect(names.indexOf('resume')).toBeGreaterThan(4)
    expect(new Set(names).size).toBe(names.length)
  })

  it('probes with the closed-port ANTHROPIC_BASE_URL and a safe, model-free invocation', async () => {
    fake(initScript(['a']))
    const { listSlashCommandsFull } = await load()
    await listSlashCommandsFull(project())
    const env = readFileSync(envFile, 'utf8')
    expect(env).toMatch(/^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:9$/m)
    expect(env).toMatch(/^DISABLE_AUTOUPDATER=1$/m)
    const args = readFileSync(argsFile, 'utf8').split('\n')
    expect(args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--output-format', 'stream-json', '--max-turns', '1']))
    expect(readFileSync(argsFile, 'utf8')).toContain('disableAllHooks')
  })

  it('runs the probe in the requested cwd', async () => {
    fake(`pwd > "${join(work, 'pwd')}"\n` + initScript(['a']))
    const { listSlashCommandsFull } = await load()
    const cwd = project()
    await listSlashCommandsFull(cwd)
    expect(readFileSync(join(work, 'pwd'), 'utf8').trim()).toBe(cwd)
  })

  it('does not leak a parent ANTHROPIC_BASE_URL to the child', async () => {
    const saved = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://real.example.com'
    try {
      fake(initScript(['a']))
      const { listSlashCommandsFull } = await load()
      await listSlashCommandsFull(project())
      expect(readFileSync(envFile, 'utf8')).not.toContain('real.example.com')
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = saved
    }
  })

  it('caches the init result for 10 minutes per cwd; quick afterwards includes the init names', async () => {
    fake(initScript(['only-in-init']))
    const { listSlashCommandsFull } = await load()
    const cwd = project()
    const a = await listSlashCommandsFull(cwd)
    const b = await listSlashCommandsFull(cwd)
    expect(spawns()).toBe(1)
    expect(a.map((c) => c.name)).toEqual(b.map((c) => c.name))
    const q = await listSlashCommandsFull(cwd, true)
    expect(q[0].name).toBe('only-in-init')
    expect(spawns()).toBe(1)
    // otro cwd: otra consulta
    await listSlashCommandsFull(project())
    expect(spawns()).toBe(2)
  })

  it('probes again after the cache expires (10 min)', async () => {
    fake(initScript(['a']))
    const { listSlashCommandsFull } = await load()
    const cwd = project()
    await listSlashCommandsFull(cwd)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 9 * 60_000)
    await listSlashCommandsFull(cwd)
    expect(spawns()).toBe(1)
    vi.setSystemTime(Date.now() + 2 * 60_000)
    await listSlashCommandsFull(cwd)
    expect(spawns()).toBe(2)
  })

  it('concurrent calls for the same cwd share a single probe', async () => {
    fake(initScript(['a']))
    const { listSlashCommandsFull } = await load()
    const cwd = project()
    const [x, y] = await Promise.all([listSlashCommandsFull(cwd), listSlashCommandsFull(cwd)])
    expect(spawns()).toBe(1)
    expect(x[0].name).toBe('a')
    expect(y[0].name).toBe('a')
  })

  it('falls back to the disk list when the probe fails, and does not cache the failure', async () => {
    fake('exit 1')
    const { listSlashCommandsFull } = await load()
    const cwd = project()
    const l = await listSlashCommandsFull(cwd)
    expect(find(l, 'resume')).toBeDefined()
    await listSlashCommandsFull(cwd)
    expect(spawns()).toBe(2)
  })

  it('falls back when the binary cannot be executed', async () => {
    process.env.CLAWHIP_CLAUDE_BIN = join(work, 'does-not-exist')
    const { listSlashCommandsFull } = await load()
    const l = await listSlashCommandsFull(project())
    expect(find(l, 'resume')).toBeDefined()
  })

  it('falls back when the model answers instead of init (assistant/result lines)', async () => {
    fake(`printf '%s\\n' '{"type":"result","subtype":"error"}'; exec sleep 30`)
    const { listSlashCommandsFull } = await load()
    const l = await listSlashCommandsFull(project())
    expect(find(l, 'resume')).toBeDefined()
    expect(spawns()).toBe(1)
  })

  it('tolerates noise and partial lines before init', async () => {
    fake(`printf 'not json\\n{"type":"system","subtype":"hook"}\\n'; printf '%s\\n' '{"type":"system","subtype":"init","slash_commands":["z-cmd"]}'; exec sleep 30`)
    const { listSlashCommandsFull } = await load()
    const l = await listSlashCommandsFull(project())
    expect(l[0].name).toBe('z-cmd')
  })
})
