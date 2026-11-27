import { describe, expect, it } from 'vitest'
import { basePathFor, folderFor, groupSessions, parseTitle, sessionLabel, textOn } from '../../src/renderer/src/grouping'
import type { Folder, Session } from '../../src/shared/types'

const folder = (id: string, path: string, extraPaths?: string[]): Folder => ({ id, name: id, path, extraPaths }) as Folder
const session = (id: string, cwd: string): Session => ({ id, name: id, cwd, createdAt: '', lastActiveAt: '' })

describe('folders', () => {
  const clients = folder('clients', '/w/clients')
  const acme = folder('acme', '/w/clients/acme/', ['/w/infra/acme'])
  const folders = [clients, acme]

  it('picks the folder with the longest matching path, including extra paths', () => {
    expect(folderFor(session('a', '/w/clients/acme/api'), folders)?.id).toBe('acme')
    expect(folderFor(session('b', '/w/clients/globex'), folders)?.id).toBe('clients')
    expect(folderFor(session('c', '/w/infra/acme/tf'), folders)?.id).toBe('acme')
    expect(folderFor(session('d', '/w/clientsX'), folders)).toBeUndefined()
    expect(folderFor(session('e', '/w/clients'), folders)?.id).toBe('clients')
  })

  it('returns the base path used for the relative display', () => {
    expect(basePathFor('/w/infra/acme/tf', acme)).toBe('/w/infra/acme')
    expect(basePathFor('/w/clients/acme', acme)).toBe('/w/clients/acme')
    expect(basePathFor('/other', acme)).toBeNull()
  })

  it('groups in folder order and puts loose sessions last, only if any', () => {
    const groups = groupSessions([session('a', '/w/clients/acme/x'), session('b', '/tmp'), session('c', '/w/clients/q')], folders)
    expect(groups.map((g) => [g.folder?.id ?? null, g.sessions.map((s) => s.id)])).toEqual([
      ['clients', ['c']],
      ['acme', ['a']],
      [null, ['b']]
    ])
    expect(groupSessions([session('a', '/w/clients/x')], folders).map((g) => g.folder?.id)).toEqual(['clients', 'acme'])
  })
})

describe('titles with Jira keys', () => {
  it.each([
    ['ACME-43 deploy codebuild', 'ACME-43', ['ACME-43'], 'deploy codebuild'],
    ['ACME-43 ACME-46 deploy codebuild', 'ACME-43', ['ACME-43', 'ACME-46'], 'deploy codebuild'],
    ['OPS-1526, OPS-1588: fabric', 'OPS-1526', ['OPS-1526', 'OPS-1588'], 'fabric'],
    ['ops-1526 conexiones', 'OPS-1526', ['OPS-1526'], 'conexiones'],
    ['GLX-14', 'GLX-14', ['GLX-14'], null],
    ['GLX-14 GLX-14 dup', 'GLX-14', ['GLX-14'], 'dup']
  ])('%s', (title, ticket, tickets, summary) => {
    expect(parseTitle(title)).toEqual({ ticket, tickets, summary })
  })

  it('treats titles without a key as summary only', () => {
    expect(parseTitle('arreglar el build')).toEqual({ ticket: null, tickets: [], summary: 'arreglar el build' })
    expect(parseTitle('')).toEqual({ ticket: null, tickets: [], summary: null })
    expect(parseTitle(null)).toEqual({ ticket: null, tickets: [], summary: null })
  })

  it('falls back to the session name when there is no title', () => {
    expect(sessionLabel(null, 'OPS-1 importar')).toEqual({ ticket: 'OPS-1', tickets: ['OPS-1'], summary: 'importar', fallback: true })
    expect(sessionLabel('Plataforma de datos', 'x')).toMatchObject({ summary: 'Plataforma de datos', fallback: false })
  })
})

describe('textOn', () => {
  it('chooses dark text on light colors and light text on dark ones', () => {
    expect(textOn('#ffffff')).toBe('#111')
    expect(textOn('#000000')).toBe('#fff')
    expect(textOn('e5c07b')).toBe('#111')
    expect(textOn('bad')).toBe('#fff')
  })
})
