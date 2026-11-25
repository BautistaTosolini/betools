import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type { SlashCommand } from '../shared/types'
import { claudeBin } from './claude-paths'
import { cleanEnv } from './pty-manager'

// Comandos y skills para el autocompletado de Rendered.
// 1) Lista completa: la del mensaje "init" de Claude Code en modo stream-json (incluye skills propias del
//    binario, de claude.ai y prompts de MCP). Para que no haya llamada al modelo (costaría tokens), la API
//    apunta a un puerto local cerrado: Claude emite "init" antes de llamar, la llamada falla y se mata el
//    proceso. Sin guardar sesión ni correr hooks.
// 2) Descripciones (y respaldo si lo anterior falla), leyendo los mismos lugares que lee Claude Code:
// - comandos propios de Claude Code (lista fija, abajo)
// - skills y comandos del usuario (~/.claude) y del proyecto (.claude en el cwd y sus carpetas padre)
// - skills y comandos de los plugins habilitados (installed_plugins.json + enabledPlugins)
// Referencias: https://code.claude.com/docs/en/slash-commands · https://code.claude.com/docs/en/skills

// Comandos propios de Claude Code que se usan en la TUI. Sacados de las definiciones del binario 2.1.332
// (sin los ocultos ni los que dependen de una función experimental); los que solo existen en modo interactivo
// (resume, theme, login…) no vienen en el "init", así que esta lista es la única fuente para ellos.
const BUILTIN: [string, string][] = [
  ['add-dir', 'Add a working directory'],
  ['advisor', 'Let Claude consult a stronger model at key moments'],
  ['agents', 'Manage subagents'],
  ['artifacts', 'Browse your published and shared artifacts'],
  ['autocompact', 'Set how full the context gets before auto-summarizing'],
  ['background', 'Send this session to the background and free the terminal'],
  ['branch', 'Create a branch of the current conversation at this point'],
  ['btw', 'Ask a side question without interrupting Claude'],
  ['cd', 'Move this session to a new working directory'],
  ['clear', 'Start a new session with empty context'],
  ['color', 'Set the prompt bar color for this session'],
  ['compact', 'Free up context by summarizing the conversation so far'],
  ['config', 'Open settings'],
  ['context', 'Show current context usage'],
  ['copy', 'Copy the last response to clipboard (/copy 2 for the one before)'],
  ['diff', 'Show the changes made in this session'],
  ['effort', "Set the model's effort level"],
  ['exit', 'Exit Claude Code'],
  ['export', 'Export this session to a file or clipboard'],
  ['fast', 'Toggle fast mode'],
  ['feedback', 'Send feedback to Anthropic or report a bug'],
  ['focus', 'Toggle focus view: just your prompt, summary, and response'],
  ['fork', 'Start a background agent with the full conversation'],
  ['goal', 'Set a goal Claude checks before stopping'],
  ['help', 'Show help and available commands'],
  ['hooks', 'View hook configurations for tool events'],
  ['ide', 'Manage IDE integrations and show status'],
  ['init', 'Create a CLAUDE.md for the project'],
  ['insights', 'Generate a report analyzing your Claude Code sessions'],
  ['install-github-app', 'Set up Claude GitHub Actions for a repository'],
  ['login', 'Sign in to your Anthropic account'],
  ['logout', 'Sign out from your Anthropic account'],
  ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit CLAUDE.md files and memory settings'],
  ['mobile', 'Show QR code to download the Claude mobile app'],
  ['model', 'Set the AI model for Claude Code'],
  ['output-style', 'List output styles or switch to one'],
  ['permissions', 'Manage allow and deny tool permission rules'],
  ['plan', 'Turn on plan mode or view the plan'],
  ['plugin', 'Manage Claude Code plugins'],
  ['privacy-settings', 'View and update your privacy settings'],
  ['recap', 'Generate a one-line session recap now'],
  ['reload-plugins', 'Activate pending plugin changes in the current session'],
  ['reload-skills', 'Pick up skills added or changed on disk during this session'],
  ['remote-control', 'Use this session from claude.ai and the phone'],
  ['rename', 'Rename the current conversation'],
  ['resume', 'Resume another conversation'],
  ['security-review', 'Security review of the pending changes'],
  ['session', 'Show cloud session URL and QR code'],
  ['skills', 'List available skills'],
  ['status', 'Show version, account, model, MCP servers, and setup warnings'],
  ['tasks', "View and manage this session's background work"],
  ['terminal-setup', 'Set up terminal key bindings'],
  ['theme', 'Change the theme'],
  ['tui', 'Set the terminal UI renderer (classic | fullscreen)'],
  ['upgrade', 'Upgrade your plan for higher rate limits'],
  ['usage', 'Show session cost, plan usage, and activity stats'],
  ['version', "Show this session's version"],
  ['workflows', 'Browse running and completed workflows']
]

// name y description del frontmatter YAML (incluye descripciones en bloque con > o |).
function frontmatter(file: string): { name?: string; description?: string } {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: { name?: string; description?: string } = {}
  if (!m) {
    // Comandos sin frontmatter: la primera línea con texto sirve de descripción.
    const first = text.split('\n').find((l) => l.trim() && !l.startsWith('#'))
    if (first) out.description = first.trim()
    return out
  }
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    let v = kv[2].trim()
    if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      v = block.join(' ')
    }
    out[kv[1] as 'name' | 'description'] = v.replace(/^["']|["']$/g, '')
  }
  return out
}

function dirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

function skillsIn(root: string, prefix: string, source: SlashCommand['source']): SlashCommand[] {
  return dirs(root)
    .filter((d) => existsSync(join(root, d, 'SKILL.md')))
    .map((d) => {
      const fm = frontmatter(join(root, d, 'SKILL.md'))
      return { name: prefix + (fm.name || d), description: fm.description ?? '', source }
    })
}

// Comandos en .md; las subcarpetas forman el nombre con ":" (commands/frontend/test.md → frontend:test).
function commandsIn(root: string, prefix: string, source: SlashCommand['source']): SlashCommand[] {
  const out: SlashCommand[] = []
  const walk = (dir: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.md')) {
        const name = relative(root, p).slice(0, -3).split(sep).join(':')
        out.push({ name: prefix + name, description: frontmatter(p).description ?? '', source })
      }
    }
  }
  walk(root, 0)
  return out
}

function enabledPlugins(): { name: string; path: string }[] {
  const home = homedir()
  let installed: Record<string, { installPath: string }[]> = {}
  let enabled: Record<string, boolean> = {}
  try {
    installed = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}
  } catch {
    // sin plugins
  }
  try {
    enabled = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins ?? {}
  } catch {
    // sin settings
  }
  return Object.entries(installed)
    .filter(([key]) => enabled[key] !== false)
    .map(([key, list]) => ({ name: key.split('@')[0], path: list[list.length - 1]?.installPath ?? '' }))
    .filter((p) => p.path && existsSync(p.path))
}

// Carpetas .claude del proyecto: la del cwd y las de sus padres hasta el home (sin incluir ~/.claude).
function projectClaudeDirs(cwd: string): string[] {
  const home = homedir()
  const out: string[] = []
  let d = cwd
  while (d.startsWith(home) && d !== home) {
    const c = join(d, '.claude')
    if (existsSync(c) && statSync(c).isDirectory()) out.push(c)
    d = dirname(d)
  }
  return out
}

// Nombres de comandos según el "init" de Claude Code para ese cwd, o null si no se pudo.
function probeInit(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string[] | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(v)
    }
    const child = spawn(
      claudeBin(),
      ['-p', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', 'x'],
      { cwd, env: { ...cleanEnv(), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', DISABLE_AUTOUPDATER: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const timer = setTimeout(() => finish(null), 25_000)
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
          const j = JSON.parse(line)
          if (j.type === 'system' && j.subtype === 'init' && Array.isArray(j.slash_commands)) return finish(j.slash_commands)
          // Por seguridad: si llegara a haber una respuesta del modelo, se corta igual.
          if (j.type === 'assistant' || j.type === 'result') return finish(null)
        } catch {
          // línea parcial o no JSON
        }
      }
    })
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
  })
}

const cache = new Map<string, { at: number; list: SlashCommand[] }>()
const probes = new Map<string, Promise<string[] | null>>()
const probed = new Map<string, { at: number; names: string[] }>()

// Lista para un cwd. Con quick, la del disco al instante (más lo que ya haya dado el init, si está en caché);
// si no, espera el init (unos segundos la primera vez; se cachea 10 minutos).
export async function listSlashCommandsFull(cwd: string, quick = false): Promise<SlashCommand[]> {
  const disk = listSlashCommands(cwd)
  let hit = probed.get(cwd)
  if (quick) return hit ? merge(disk, hit.names) : disk
  if (!hit || Date.now() - hit.at > 10 * 60_000) {
    let p = probes.get(cwd)
    if (!p) {
      p = probeInit(cwd).finally(() => probes.delete(cwd))
      probes.set(cwd, p)
    }
    const names = await p
    if (names) probed.set(cwd, (hit = { at: Date.now(), names }))
  }
  return hit ? merge(disk, hit.names) : disk
}

// Ocultos en la TUI (internos o renombrados) aunque el init los liste.
const HIDDEN = new Set(['workflow-launch-exec', 'design-consent', 'design-revoke', 'extra-usage', 'heapdump'])

function merge(disk: SlashCommand[], initNames: string[]): SlashCommand[] {
  const byName = new Map(disk.map((c) => [c.name, c]))
  const fromInit = initNames
    .filter((n) => !n.startsWith('__') && !HIDDEN.has(n))
    .map((n) => byName.get(n) ?? { name: n, description: '', source: n.includes(':') ? ('plugin' as const) : ('builtin' as const) })
  const names = new Set(fromInit.map((c) => c.name))
  // Comandos interactivos que no aparecen en modo -p (resume, exit, help…), desde la lista fija.
  return [...fromInit, ...disk.filter((c) => !names.has(c.name))]
}

export function listSlashCommands(cwd: string): SlashCommand[] {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < 30_000) return hit.list
  const home = join(homedir(), '.claude')
  const all: SlashCommand[] = [
    ...projectClaudeDirs(cwd).flatMap((d) => [...skillsIn(join(d, 'skills'), '', 'project'), ...commandsIn(join(d, 'commands'), '', 'project')]),
    ...skillsIn(join(home, 'skills'), '', 'user'),
    ...commandsIn(join(home, 'commands'), '', 'user'),
    ...enabledPlugins().flatMap((p) => [
      ...skillsIn(join(p.path, 'skills'), `${p.name}:`, 'plugin'),
      ...commandsIn(join(p.path, 'commands'), `${p.name}:`, 'plugin')
    ]),
    ...BUILTIN.map(([name, description]) => ({ name, description, source: 'builtin' as const }))
  ]
  // Si un nombre se repite, gana el primero (proyecto > usuario > plugin > propio).
  const seen = new Set<string>()
  const list = all.filter((c) => !seen.has(c.name) && seen.add(c.name))
  cache.set(cwd, { at: Date.now(), list })
  return list
}
