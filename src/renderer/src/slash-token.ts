// Palabra "/algo" donde está el cursor (al principio del texto o después de un espacio), para el autocompletado
// de comandos y skills en cualquier parte del mensaje, no solo cuando el mensaje es solo el comando.
export interface SlashToken {
  start: number // posición de la "/"
  end: number // fin de la palabra
  query: string // lo escrito después de la "/"
}

export function slashAt(text: string, caret: number): SlashToken | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)\/([^\s/]*)$/.exec(before)
  if (!m) return null
  const start = caret - m[2].length - 1
  const rest = /^[^\s]*/.exec(text.slice(caret))?.[0] ?? ''
  // El cursor en medio de algo que no es un comando (p. ej. una ruta "/home/x"): no se ofrece.
  if (rest.includes('/')) return null
  return { start, end: caret + rest.length, query: m[2] + rest }
}

// Reemplaza la palabra por el comando elegido, seguido de un espacio. Devuelve el texto y la nueva posición.
export function applySlash(text: string, tok: SlashToken, name: string): { text: string; caret: number } {
  const ins = `/${name} `
  const after = text.slice(tok.end).replace(/^ /, '')
  return { text: text.slice(0, tok.start) + ins + after, caret: tok.start + ins.length }
}
