import { Lexer, type Token, type Tokens } from 'marked'

// Edición visual de Markdown sin reformatear el archivo.
//
// El editor visual (TipTap) vuelve a escribir el Markdown entero con su propio estilo (viñetas, sangrías, líneas
// cortadas a mano, tablas). Para que guardar no cambie lo que no se tocó, se compara bloque a bloque lo que
// devuelve el editor con el original: los bloques iguales (en su forma normalizada) se guardan con su texto
// original exacto, y solo los editados salen del editor. En las listas se hace lo mismo ítem por ítem.

// md -> md normalizado por el editor (parse + serialize con el mismo esquema).
export type Canon = (md: string) => string

interface Block {
  raw: string
  // Separador (líneas vacías) entre el bloque anterior y este, tal como está en el original.
  before: string
  tok: Token
}

const lexer = () => new Lexer({ gfm: true })

// Bloques de primer nivel con su texto fuente exacto. null si los tokens no cubren todo el texto.
function blocks(src: string): { list: Block[]; tail: string } | null {
  const toks = lexer().lex(src)
  if (toks.map((t) => t.raw).join('') !== src) return null
  const list: Block[] = []
  let gap = ''
  for (const t of toks) {
    if (t.type === 'space') {
      gap += t.raw
      continue
    }
    const end = t.raw.match(/\n*$/)![0]
    list.push({ raw: t.raw.slice(0, t.raw.length - end.length), before: gap, tok: t })
    gap = end
  }
  return { list, tail: gap }
}

// Pares [i, j] de la subsecuencia común más larga.
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++])
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

const itemRaws = (t: Tokens.List) => t.items.map((it) => it.raw.replace(/\n+$/, ''))

// Normalización con caché: los bloques del original se normalizan una vez por texto.
function cached(canon: Canon): Canon {
  const memo = new Map<string, string>()
  return (md) => {
    let v = memo.get(md)
    if (v === undefined) memo.set(md, (v = canon(md).trim()))
    return v
  }
}

// Una lista editada: si hay una lista original del mismo tipo con ítems en común, los ítems sin cambios quedan
// con su texto original y solo se reescriben los editados.
function mergeList(orig: Block[], b: Block, canon: Canon): string | null {
  if (b.tok.type !== 'list') return null
  const list = b.tok as Tokens.List
  const ei = itemRaws(list)
  const ek = ei.map((r) => r.trim())
  let best: { oi: string[]; pairs: [number, number][]; loose: boolean } | null = null
  for (const ob of orig) {
    if (ob.tok.type !== 'list' || (ob.tok as Tokens.List).ordered !== list.ordered) continue
    const oi = itemRaws(ob.tok as Tokens.List)
    const pairs = lcs(
      oi.map((r) => canon(r)),
      ek
    )
    if (pairs.length && (!best || pairs.length > best.pairs.length)) best = { oi, pairs, loose: (ob.tok as Tokens.List).loose }
  }
  if (!best) return null
  const { oi, pairs, loose } = best
  const m = new Map(pairs.map(([i, j]) => [j, i]))
  // Los ítems nuevos o editados usan la viñeta (o el delimitador 1. / 1)) del original: si se mezclan, CommonMark
  // corta la lista en dos.
  const marker = oi[0].match(LIST_MARKER)
  const restyle = (r: string) =>
    marker ? r.replace(LIST_MARKER, (_, ind: string, mk: string, sp: string) => ind + sameStyle(mk, marker[2]) + sp) : r
  const merged = ei.map((r, j) => (m.has(j) ? oi[m.get(j)!] : restyle(r))).join(loose ? '\n\n' : '\n')
  // Si por algo la lista combinada no dice lo mismo que la del editor, se usa la del editor entera.
  return canon(merged) === canon(b.raw) ? merged : null
}

const LIST_MARKER = /^(\s*)([*+-]|\d+[.)])(\s+)/
// Mismo tipo de marcador que `like`: el carácter de viñeta, o el delimitador de una lista numerada.
function sameStyle(mk: string, like: string): string {
  if (/^[*+-]$/.test(mk)) return /^[*+-]$/.test(like) ? like : mk
  const num = mk.slice(0, -1)
  return /[.)]$/.test(like) && !/^[*+-]$/.test(like) ? num + like.slice(-1) : mk
}

// original: el Markdown que se cargó en el editor; edited: lo que devuelve el editor ahora.
export function mergeMarkdown(original: string, edited: string, canon: Canon): string {
  const c = cached(canon)
  const O = blocks(original)
  const E = blocks(edited)
  if (!O || !E) return edited
  const match = new Map(
    lcs(
      O.list.map((b) => c(b.raw)),
      E.list.map((b) => b.raw.trim())
    ).map(([i, j]) => [j, i])
  )
  // Marcadores como <Cliente> o <jira-key> que el archivo ya usa en el texto: el editor los escribe escapados
  // (&lt;Cliente&gt;); en lo que se reescribe vuelven a quedar como estaban. Uno nuevo queda escapado.
  const marks = new Set([...original.matchAll(/<([A-Za-z][\w-]*)>/g)].map((m) => m[1]))
  const unescape = (raw: string) => (marks.size ? raw.replace(/&lt;([A-Za-z][\w-]*)&gt;/g, (m, n: string) => (marks.has(n) ? `<${n}>` : m)) : raw)
  let out = ''
  let prev = -2
  E.list.forEach((b, j) => {
    const i = match.get(j)
    // Entre dos bloques que siguen juntos en el original se conserva su separación; si no, una línea vacía.
    const sep = j === 0 ? (i === 0 ? O.list[0].before : '') : i !== undefined && i === prev + 1 ? O.list[i].before : '\n\n'
    out += sep + (i !== undefined ? O.list[i].raw : unescape(mergeList(O.list, b, c) ?? b.raw))
    prev = i ?? -2
  })
  // Sin bloques (documento vacío) queda vacío; si no, termina como el original (o con un salto de línea).
  const merged = E.list.length ? out + (O.tail || '\n') : ''
  // Red de seguridad: el resultado tiene que decir exactamente lo mismo que el editor. Si no, se guarda lo del
  // editor tal cual (con su estilo, pero sin perder ni cambiar nada).
  return c(merged) === c(edited) ? merged : edited
}

// Front matter YAML (---) al principio: el editor no lo muestra y se vuelve a poner tal cual al guardar.
const FRONT = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
export function splitFrontMatter(md: string): { front: string; body: string } {
  const front = md.match(FRONT)?.[0] ?? ''
  return { front, body: md.slice(front.length) }
}

// Palabras (letras y números) con su cantidad: para detectar texto que el editor perdería.
function words(md: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const w of md.match(/[\p{L}\p{N}]+/gu) ?? []) m.set(w, (m.get(w) ?? 0) + 1)
  return m
}

function hasToken(toks: Token[], types: Set<string>): boolean {
  for (const t of toks) {
    if (types.has(t.type)) return true
    const kids = [
      ...((t as { tokens?: Token[] }).tokens ?? []),
      ...((t as Tokens.List).items ?? []),
      ...(((t as Tokens.Table).header ?? []) as { tokens: Token[] }[]).flatMap((c) => c.tokens),
      ...(((t as Tokens.Table).rows ?? []) as { tokens: Token[] }[][]).flat().flatMap((c) => c.tokens)
    ]
    if (kids.length && hasToken(kids as Token[], types)) return true
  }
  return false
}

// Por qué el editor visual no puede editar este documento sin perder algo (null = se puede).
export function richUnsupported(path: string, body: string, canon: Canon): string | null {
  if (/\.mdx$/i.test(path)) return 'MDX files can only be edited as source.'
  if (body.includes('\r')) return 'Files with Windows line endings (CRLF) can only be edited as source.'
  const toks = lexer().lex(body)
  if (toks.map((t) => t.raw).join('') !== body) return 'This file uses Markdown the visual editor cannot keep intact (e.g. link definitions).'
  // HTML en bloque (<details>, <div>…) y definiciones de links no existen en el editor. El HTML dentro de una
  // línea (p. ej. un marcador como <Cliente>) lo decide el chequeo de palabras de abajo.
  if (toks.some((t) => t.type === 'html' || t.type === 'def') || hasToken(toks, new Set(['def'])))
    return 'This file has raw HTML blocks or link definitions: edit it as source.'
  // Red de seguridad general: ninguna palabra del original puede desaparecer al pasar por el editor.
  const after = words(canon(body))
  for (const [w, n] of words(body)) if ((after.get(w) ?? 0) < n) return 'The visual editor would drop part of this file: edit it as source.'
  return null
}
