import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Claude Code guarda cada sesión en ~/.claude/projects/<cwd codificado>/<sessionId>.jsonl,
// donde todo carácter no alfanumérico del cwd se reemplaza por "-".
export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`)
}

// El transcript no siempre está donde indica el cwd: si la carpeta del proyecto se movió o la
// sesión cambió de directorio, el .jsonl queda en otra carpeta de ~/.claude/projects.
// Se busca primero en la ubicación esperada y después por ID en todas.
export function findTranscript(cwd: string, sessionId: string): string | null {
  const expected = transcriptPath(cwd, sessionId)
  if (existsSync(expected)) return expected
  const root = join(homedir(), '.claude', 'projects')
  try {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    // sin ~/.claude/projects
  }
  return null
}

export function transcriptExists(cwd: string, sessionId: string): boolean {
  return findTranscript(cwd, sessionId) !== null
}

// Si la app se lanza desde el escritorio o el autostart, el PATH no incluye lo que agrega
// el perfil del usuario (~/.local/bin, nvm, etc.). Se resuelve una vez con un login shell.
let cached: string | null = null
export function claudeBin(): string {
  if (cached) return cached
  if (process.env.CLAWHIP_CLAUDE_BIN) return (cached = process.env.CLAWHIP_CLAUDE_BIN)
  try {
    const shell = process.env.SHELL || '/bin/bash'
    const out = execFileSync(shell, ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 })
    const path = out.trim().split('\n').pop()
    if (path && existsSync(path)) return (cached = path)
  } catch {
    // se usa el fallback
  }
  const fallback = join(homedir(), '.local', 'bin', 'claude')
  return (cached = existsSync(fallback) ? fallback : 'claude')
}
