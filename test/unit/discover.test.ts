import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { discoverSessions } from '../../src/main/discover'

const ROOT = () => join(homedir(), '.claude', 'projects')
const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const jl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
const userMsg = (text: unknown, cwd?: string, extra: object = {}) => ({ type: 'user', ...(cwd ? { cwd } : {}), message: { content: text }, ...extra })

// Crea un directorio real (sin symlinks: /tmp puede serlo en algunas plataformas)
const realDir = (...parts: string[]) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'disc-')))
  const p = join(base, ...parts)
  mkdirSync(p, { recursive: true })
  return p
}

let t = Date.now() / 1000 - 10_000
function session(projDir: string, id: string, lines: unknown[] | string, mtime?: number): string {
  const dir = join(ROOT(), projDir)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${id}.jsonl`)
  writeFileSync(p, typeof lines === 'string' ? lines : jl(...lines))
  const m = mtime ?? (t += 10)
  utimesSync(p, m, m)
  return p
}

beforeEach(() => {
  rmSync(join(homedir(), '.claude'), { recursive: true, force: true })
  mkdirSync(ROOT(), { recursive: true })
})

describe('discoverSessions basics', () => {
  it('returns [] if ~/.claude/projects does not exist', () => {
    rmSync(join(homedir(), '.claude'), { recursive: true, force: true })
    expect(discoverSessions(new Set())).toEqual([])
  })

  it('returns [] for an empty projects dir', () => {
    expect(discoverSessions(new Set())).toEqual([])
  })

  it('orders most recent first and reports modifiedAt and sizeKb', () => {
    const cwd = realDir('p')
    const d = encode(cwd)
    session(d, 'old', [userMsg('viejo', cwd)], 1_700_000_000)
    session(d, 'new', [userMsg('nuevo', cwd)], 1_700_001_000)
    session(d, 'mid', [userMsg('medio', cwd)], 1_700_000_500)
    const r = discoverSessions(new Set())
    expect(r.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
    expect(r[0].modifiedAt).toBe(new Date(1_700_001_000_000).toISOString())
    expect(r[0].sizeKb).toBe(0)
  })

  it('orders across different project dirs', () => {
    const a = realDir('a')
    const b = realDir('b')
    session(encode(a), 'a1', [userMsg('A', a)], 1_700_000_000)
    session(encode(b), 'b1', [userMsg('B', b)], 1_700_000_900)
    expect(discoverSessions(new Set()).map((s) => s.id)).toEqual(['b1', 'a1'])
  })

  it('rounds sizeKb', () => {
    const cwd = realDir('p')
    session(encode(cwd), 's', [userMsg('x'.repeat(5000), cwd)])
    expect(discoverSessions(new Set())[0].sizeKb).toBe(5)
  })

  it('exclude set removes sessions by id', () => {
    const cwd = realDir('p')
    const d = encode(cwd)
    session(d, 'keep', [userMsg('a', cwd)])
    session(d, 'drop', [userMsg('b', cwd)])
    expect(discoverSessions(new Set(['drop'])).map((s) => s.id)).toEqual(['keep'])
  })

  it('limit is applied after sorting by recency', () => {
    const cwd = realDir('p')
    const d = encode(cwd)
    for (let i = 0; i < 5; i++) session(d, `s${i}`, [userMsg(`m${i}`, cwd)], 1_700_000_000 + i * 100)
    expect(discoverSessions(new Set(), 2).map((s) => s.id)).toEqual(['s4', 's3'])
  })

  it('limit counts only non-excluded sessions', () => {
    const cwd = realDir('p')
    const d = encode(cwd)
    for (let i = 0; i < 4; i++) session(d, `s${i}`, [userMsg(`m${i}`, cwd)], 1_700_000_000 + i * 100)
    expect(discoverSessions(new Set(['s3']), 2).map((s) => s.id)).toEqual(['s2', 's1'])
  })

  it('skips empty files, non-jsonl files, stray files in the root and files without any cwd', () => {
    const cwd = realDir('p')
    const d = encode(cwd)
    session(d, 'empty', '')
    session(d, 'nocwd', [userMsg('hola')])
    session(d, 'ok', [userMsg('hola', cwd)])
    writeFileSync(join(ROOT(), d, 'notes.txt'), 'x')
    writeFileSync(join(ROOT(), 'stray.jsonl'), jl(userMsg('x', cwd)))
    expect(discoverSessions(new Set()).map((s) => s.id)).toEqual(['ok'])
  })
})

describe('title and first prompt', () => {
  const one = (lines: unknown[]) => {
    const cwd = realDir('p')
    session(encode(cwd), 's', lines.map((l: any) => (l.cwd === '@' ? { ...l, cwd } : l)))
    return discoverSessions(new Set())[0]
  }
  const u = (text: unknown, extra: object = {}) => userMsg(text, '@' as any, extra)

  it('uses the first user prompt, whitespace-normalized and cut to 140 chars', () => {
    expect(one([u('  hola\n\n  mundo  ')]).title).toBe('hola mundo')
    expect(one([u('x'.repeat(300))]).title).toBe('x'.repeat(140))
  })

  it('takes the first text of array content', () => {
    expect(one([u([{ type: 'image' }, { type: 'text', text: 'desde array' }])]).title).toBe('desde array')
  })

  it('skips system injected prompts, meta and sidechain messages', () => {
    const r = one([
      u('<command-name>/x</command-name>'),
      u('Caveat: The messages below were generated'),
      u('   '),
      u('meta', { isMeta: true }),
      u('sub', { isSidechain: true }),
      { type: 'assistant', cwd: '@', message: { content: 'respuesta' } },
      u(42),
      u('el verdadero')
    ])
    expect(r.title).toBe('el verdadero')
  })

  it('"(no prompt)" when there is none', () => {
    expect(one([{ type: 'assistant', cwd: '@', message: { content: 'x' } }]).title).toBe('(no prompt)')
  })

  it('ai-title beats the first prompt; the last one wins', () => {
    expect(one([u('prompt'), { type: 'ai-title', aiTitle: 'Uno' }, { type: 'ai-title', aiTitle: 'Dos' }]).title).toBe('Dos')
  })

  it('custom-title beats ai-title regardless of order', () => {
    expect(one([u('p'), { type: 'custom-title', customTitle: 'Mío' }, { type: 'ai-title', aiTitle: 'IA' }]).title).toBe('Mío')
    expect(one([u('p'), { type: 'ai-title', aiTitle: 'IA' }, { type: 'custom-title', customTitle: 'Mío' }]).title).toBe('Mío')
  })

  it('titles come from the tail of big files (> 256 KB)', () => {
    const cwd = realDir('p')
    const filler = 'z'.repeat(1000)
    const lines: unknown[] = [userMsg('primero', cwd)]
    for (let i = 0; i < 400; i++) lines.push({ type: 'assistant', message: { content: filler } })
    lines.push({ type: 'custom-title', customTitle: 'Título final' })
    session(encode(cwd), 'big', lines)
    const r = discoverSessions(new Set())
    expect(r[0].title).toBe('Título final')
    expect(r[0].sizeKb).toBeGreaterThan(256)
  })

  it('big file without titles falls back to the first prompt from the head', () => {
    const cwd = realDir('p')
    const lines: unknown[] = [userMsg('primer prompt', cwd)]
    for (let i = 0; i < 400; i++) lines.push({ type: 'assistant', message: { content: 'z'.repeat(1000) } })
    session(encode(cwd), 'big', lines)
    expect(discoverSessions(new Set())[0].title).toBe('primer prompt')
  })

  it('tolerates corrupt lines', () => {
    const cwd = realDir('p')
    session(encode(cwd), 's', '{roto\n' + jl(userMsg('ok', cwd)) + '{cortada')
    expect(discoverSessions(new Set())[0].title).toBe('ok')
  })
})

describe('cwd resolution', () => {
  it('uses the project dir cwd when it exists and matches the encoding', () => {
    const cwd = realDir('work', 'app')
    session(encode(cwd), 's', [userMsg('x', cwd)])
    expect(discoverSessions(new Set())[0]).toMatchObject({ cwd, cwdExists: true })
  })

  it('prefers the launch directory over a deep cd recorded at the tail', () => {
    const cwd = realDir('work', 'app')
    const deep = join(cwd, 'src', 'deep')
    mkdirSync(deep, { recursive: true })
    session(encode(cwd), 's', [userMsg('x', cwd), { type: 'assistant', cwd: deep, message: { content: 'a' } }])
    expect(discoverSessions(new Set())[0].cwd).toBe(cwd)
  })

  it('when the project dir encoding is ambiguous, still resolves the existing launch dir from the tail', () => {
    // la carpeta de proyecto corresponde al cwd del final (existente)
    const cwd = realDir('work', 'app')
    const gone = join(tmpdir(), 'no-existe-' + Date.now(), 'app')
    session(encode(cwd), 's', [userMsg('x', gone), { type: 'assistant', cwd, message: { content: 'a' } }])
    expect(discoverSessions(new Set())[0]).toMatchObject({ cwd, cwdExists: true })
  })

  it('moved folder: infers the prefix rewrite from another session (…/clients/x -> …/infra/clients/x)', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mv-')))
    const oldRoot = join(base, 'workdir') // ya no existe en su ubicación original
    const newApp = join(base, 'workdir', 'infra', 'clients', 'vemo')
    mkdirSync(newApp, { recursive: true })
    const oldApp = join(oldRoot, 'clients', 'vemo')
    // sesión A: empezó en la ruta vieja y siguió en la nueva; vive en la carpeta de proyecto de la ruta VIEJA
    // (oldApp no existe), así que dirCwd no sirve y hay que reescribir
    session(encode(oldApp), 'a', [userMsg('x', oldApp), { type: 'assistant', cwd: newApp, message: { content: 'a' } }])
    // sesión B: solo conoce la ruta vieja de un subdirectorio
    const oldSub = join(oldApp)
    session(encode(oldSub), 'b', [userMsg('y', oldSub)])
    const r = Object.fromEntries(discoverSessions(new Set()).map((s) => [s.id, s]))
    // A: el cwd final existe y se usa directamente
    expect(r.a).toMatchObject({ cwd: newApp, cwdExists: true })
    // B: la carpeta de proyecto codifica la ruta vieja, que ya no existe; la reescritura sólo se acepta si
    // el candidato codifica igual que la carpeta de proyecto, lo que aquí no ocurre: queda como inexistente
    expect(r.b).toMatchObject({ cwd: oldSub, cwdExists: false })
  })

  it('moved folder: rewrite accepted when the rewritten path matches the project dir', () => {
    // La carpeta de proyecto del .jsonl codifica el path NUEVO (la sesión se lanzó desde allí), pero el
    // primer y el último cwd registrados son rutas internas que ya no existen... y otra sesión enseña el cambio.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'rw-')))
    const newApp = join(base, 'infra', 'clients', 'vemo')
    mkdirSync(join(newApp, 'sub'), { recursive: true })
    const oldApp = join(base, 'clients', 'vemo')
    // enseña el cambio: head en ruta vieja (inexistente), tail en ruta nueva (existente)
    session(encode(oldApp), 'teach', [userMsg('x', oldApp), { type: 'assistant', cwd: newApp, message: { content: 'a' } }])
    // sesión objetivo: vive en la carpeta del path nuevo y todos sus cwd son rutas viejas inexistentes
    const oldSub = join(oldApp, 'sub')
    session(encode(newApp), 'target', [userMsg('y', oldApp), { type: 'assistant', cwd: oldSub, message: { content: 'a' } }])
    const r = Object.fromEntries(discoverSessions(new Set()).map((s) => [s.id, s]))
    // oldApp -> newApp (prefijo común "clients/vemo" de la cola); candidato = newApp/sub no coincide con la
    // carpeta de proyecto (encode(newApp)), pero oldApp -> newApp sí
    expect(r.target).toMatchObject({ cwd: newApp, cwdExists: true })
  })

  it('falls back to the last then the first recorded cwd that exists', () => {
    const first = realDir('first')
    const gone = join(tmpdir(), 'nope-' + Date.now())
    session('-some-unrelated-dir', 's', [userMsg('x', first), { type: 'assistant', cwd: gone, message: { content: 'a' } }])
    expect(discoverSessions(new Set())[0]).toMatchObject({ cwd: first, cwdExists: true })

    const last = realDir('last')
    session('-other-unrelated', 's2', [userMsg('x', first), { type: 'assistant', cwd: last, message: { content: 'a' } }])
    expect(discoverSessions(new Set()).find((s) => s.id === 's2')).toMatchObject({ cwd: last, cwdExists: true })
  })

  it('no existing cwd: returns the last recorded one with cwdExists=false', () => {
    const g1 = '/definitely/not/here/one'
    const g2 = '/definitely/not/here/two'
    session('-x', 's', [userMsg('a', g1), { type: 'assistant', cwd: g2, message: { content: 'a' } }])
    expect(discoverSessions(new Set())[0]).toMatchObject({ cwd: g2, cwdExists: false })
  })

  it('only the head cwd: used as is', () => {
    session('-x', 's', [userMsg('a', '/gone/head')])
    expect(discoverSessions(new Set())[0]).toMatchObject({ cwd: '/gone/head', cwdExists: false })
  })
})
