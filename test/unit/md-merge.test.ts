import { describe, expect, it } from 'vitest'
import { mergeMarkdown, richUnsupported, splitFrontMatter } from '../../src/renderer/src/md-merge'
import { makeCanon } from '../../src/renderer/src/rich-schema'

// Edición visual: lo que no se tocó se guarda byte a byte igual, aunque el editor escriba otro estilo.
const canon = makeCanon()

// Estilo que el editor no usa: viñetas con *, líneas cortadas a mano, fences ~~~, tablas sin alinear, _énfasis_.
const DOC = `# Plan

Intro con _énfasis_ y una línea
cortada a mano.

* uno, cortado
  en dos líneas
* dos
    * anidado

1) primero
2) segundo

| a | b |
|---|---|
| 1 | 2 |

- [ ] pendiente
- [x] hecho

~~~bash
echo hola
~~~

> cita
> en dos líneas

Fin.
`

// Lo que devolvería el editor tras una edición: el documento normalizado con un cambio.
const edit = (doc: string, from: string, to: string) => {
  const c = canon(doc)
  expect(c).toContain(from)
  return c.replace(from, to)
}

// Lo combinado tiene que decir exactamente lo mismo que lo que devolvió el editor.
const same = (merged: string, edited: string) => expect(canon(merged)).toBe(canon(edited))

const changedLines = (a: string, b: string) => {
  const A = a.split('\n')
  const B = b.split('\n')
  return {
    removed: A.filter((l) => !B.includes(l)),
    added: B.filter((l) => !A.includes(l))
  }
}

describe('mergeMarkdown', () => {
  it('the editor really reformats this document (the merge is needed)', () => {
    expect(canon(DOC)).not.toBe(DOC)
  })

  it('without edits the file stays byte-identical', () => {
    expect(mergeMarkdown(DOC, canon(DOC), canon)).toBe(DOC)
  })

  it('a word edited in a paragraph rewrites only that paragraph', () => {
    const e = edit(DOC, 'Fin.', 'Fin del plan.')
    const out = mergeMarkdown(DOC, e, canon)
    same(out, e)
    expect(changedLines(DOC, out)).toEqual({ removed: ['Fin.'], added: ['Fin del plan.'] })
  })

  it('an edited list item keeps the other items (and their style) as they were', () => {
    // El ítem editado se reescribe entero (con sus subítems) en el estilo del editor; los demás, intactos.
    const e = edit(DOC, '- dos', '- dos y medio')
    const out = mergeMarkdown(DOC, e, canon)
    same(out, e)
    expect(changedLines(DOC, out)).toEqual({ removed: ['* dos', '    * anidado'], added: ['* dos y medio', '  - anidado'] })
    expect(out).toContain('* uno, cortado\n  en dos líneas\n')
    const plain = mergeMarkdown(DOC, edit(DOC, '- uno, cortado en dos líneas', '- uno, editado'), canon)
    expect(changedLines(DOC, plain)).toEqual({ removed: ['* uno, cortado', '  en dos líneas'], added: ['* uno, editado'] })
    // Una lista numerada con ")" sigue con ")": si no, serían dos listas.
    const num = mergeMarkdown(DOC, edit(DOC, '2. segundo', '2. segundo bis'), canon)
    expect(changedLines(DOC, num)).toEqual({ removed: ['2) segundo'], added: ['2) segundo bis'] })
  })

  it('adding and removing blocks leaves the rest untouched', () => {
    const added = mergeMarkdown(DOC, edit(DOC, '# Plan\n', '# Plan\n\nNuevo párrafo.\n'), canon)
    expect(changedLines(DOC, added)).toEqual({ removed: [], added: ['Nuevo párrafo.'] })
    const removed = mergeMarkdown(DOC, edit(DOC, '> cita en dos líneas\n\n', ''), canon)
    expect(changedLines(DOC, removed)).toEqual({ removed: ['> cita', '> en dos líneas'], added: [] })
  })

  it('placeholders like <Cliente> the file already uses stay unescaped in edited text; new ones stay escaped', () => {
    const doc = 'Hola <Cliente>, repo `ctx-<jira-key>`.\n\nOtro.\n'
    const e = edit(doc, 'Otro.', 'Otro &lt;Cliente&gt; y &lt;nuevo&gt;.')
    const out = mergeMarkdown(doc, e, canon)
    same(out, e)
    expect(out).toBe('Hola <Cliente>, repo `ctx-<jira-key>`.\n\nOtro <Cliente> y &lt;nuevo&gt;.\n')
  })

  it('an emptied document is saved empty', () => {
    expect(mergeMarkdown(DOC, '', canon)).toBe('')
  })
})

describe('splitFrontMatter', () => {
  it('separates the YAML front matter so the editor never sees it', () => {
    const md = '---\nname: x\ndescription: y\n---\n# Body\n'
    expect(splitFrontMatter(md)).toEqual({ front: '---\nname: x\ndescription: y\n---\n', body: '# Body\n' })
    expect(splitFrontMatter('# No front\n')).toEqual({ front: '', body: '# No front\n' })
  })
})

describe('richUnsupported', () => {
  it('accepts normal documents, including <placeholders> inside a line', () => {
    expect(richUnsupported('a.md', DOC, canon)).toBeNull()
    expect(richUnsupported('a.md', 'Path `~/x/<cliente>/` y el nombre <Cliente> en texto.\n', canon)).toBeNull()
  })

  it('rejects what the editor would lose: HTML blocks, link definitions and MDX', () => {
    expect(richUnsupported('a.md', '<details>\n<summary>x</summary>\n\nhola\n</details>\n', canon)).toMatch(/HTML/)
    expect(richUnsupported('a.md', 'Ver [docs][1].\n\n[1]: https://example.com\n', canon)).toMatch(/link definitions/)
    expect(richUnsupported('a.mdx', '# x\n', canon)).toMatch(/MDX/)
  })
})
