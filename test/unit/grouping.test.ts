import { describe, expect, it } from 'vitest'
import { basePathFor, folderFor, groupSessions, parseTitle, sessionLabel, textOn } from '../../src/renderer/src/grouping'
import type { Folder, Session } from '../../src/shared/types'

const folder = (id: string, path: string, extraPaths?: string[]): Folder => ({ id, name: id, path, extraPaths }) as Folder
const session = (id: string, cwd: string): Session => ({ id, name: id, cwd, createdAt: '', lastActiveAt: '' })

describe('folders', () => {
  const clients = folder('clients', '/w/clients')
  const vemo = folder('vemo', '/w/clients/vemo/', ['/w/infra/vemo'])
  const folders = [clients, vemo]

  it('picks the folder with the longest matching path, including extra paths', () => {
    expect(folderFor(session('a', '/w/clients/vemo/api'), folders)?.id).toBe('vemo')
    expect(folderFor(session('b', '/w/clients/nivii'), folders)?.id).toBe('clients')
    expect(folderFor(session('c', '/w/infra/vemo/tf'), folders)?.id).toBe('vemo')
    expect(folderFor(session('d', '/w/clientsX'), folders)).toBeUndefined()
    expect(folderFor(session('e', '/w/clients'), folders)?.id).toBe('clients')
  })

  it('returns the base path used for the relative display', () => {
    expect(basePathFor('/w/infra/vemo/tf', vemo)).toBe('/w/infra/vemo')
    expect(basePathFor('/w/clients/vemo', vemo)).toBe('/w/clients/vemo')
    expect(basePathFor('/other', vemo)).toBeNull()
  })

  it('groups in folder order and puts loose sessions last, only if any', () => {
    const groups = groupSessions([session('a', '/w/clients/vemo/x'), session('b', '/tmp'), session('c', '/w/clients/q')], folders)
    expect(groups.map((g) => [g.folder?.id ?? null, g.sessions.map((s) => s.id)])).toEqual([
      ['clients', ['c']],
      ['vemo', ['a']],
      [null, ['b']]
    ])
    expect(groupSessions([session('a', '/w/clients/x')], folders).map((g) => g.folder?.id)).toEqual(['clients', 'vemo'])
  })
})

describe('titles with Jira keys', () => {
  it.each([
    ['SURT-43 deploy codebuild', 'SURT-43', ['SURT-43'], 'deploy codebuild'],
    ['SURT-43 SURT-46 deploy codebuild', 'SURT-43', ['SURT-43', 'SURT-46'], 'deploy codebuild'],
    ['VE-1526, VE-1588: fabric', 'VE-1526', ['VE-1526', 'VE-1588'], 'fabric'],
    ['ve-1526 conexiones', 'VE-1526', ['VE-1526'], 'conexiones'],
    ['NIVII-14', 'NIVII-14', ['NIVII-14'], null],
    ['NIVII-14 NIVII-14 dup', 'NIVII-14', ['NIVII-14'], 'dup']
  ])('%s', (title, ticket, tickets, summary) => {
    expect(parseTitle(title)).toEqual({ ticket, tickets, summary })
  })

  it('treats titles without a key as summary only', () => {
    expect(parseTitle('arreglar el build')).toEqual({ ticket: null, tickets: [], summary: 'arreglar el build' })
    expect(parseTitle('')).toEqual({ ticket: null, tickets: [], summary: null })
    expect(parseTitle(null)).toEqual({ ticket: null, tickets: [], summary: null })
  })

  it('falls back to the session name when there is no title', () => {
    expect(sessionLabel(null, 'VE-1 importar')).toEqual({ ticket: 'VE-1', tickets: ['VE-1'], summary: 'importar', fallback: true })
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
