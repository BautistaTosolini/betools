import type { ConversationItem } from '../shared/types'

// Traspaso de contexto a una sesión nueva ("Continue in new session"). Se le pide a la sesión actual un traspaso
// enfocado en lo que va a hacer la nueva (no un resumen de todo), se toma su respuesta del historial y la sesión
// nueva arranca con ese texto como primer mensaje. El traspaso también queda guardado en un archivo, fuera del
// repo de la sesión.

// Pedido para la sesión actual. `token` identifica el mensaje en el historial para leer la respuesta que sigue.
export function handoffRequest(focus: string, token: string): string {
  return [
    `[betools handoff ${token}] Another Claude Code session, in this same directory, will take over part of this work.`,
    `It will work on: ${focus.trim()}`,
    '',
    'Reply with a handoff for that session, in Markdown, and nothing else. Include only the context it needs for that ' +
      'point, not a summary of everything we did: the goal, the current state, decisions taken and why, relevant ' +
      'files, commands and resources, and open questions or next steps. Do not include secret values. Do not run ' +
      'tools or change anything for this.'
  ].join('\n')
}

// Respuesta de Claude al pedido: el texto que escribió después del mensaje con el token. null mientras no haya.
export function handoffReply(items: ConversationItem[], token: string): string | null {
  let at = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user' && items[i].text.includes(`[betools handoff ${token}]`)) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const text = items
    .slice(at + 1)
    .filter((it) => it.kind === 'assistant')
    .map((it) => it.text.trim())
    .filter(Boolean)
    .join('\n\n')
  return text || null
}

// Archivo guardado: el traspaso con de dónde viene y para qué.
export function handoffFile(o: { from: string; fromId: string; focus: string; text: string; at: string }): string {
  return `<!-- betools handoff · from "${o.from}" (${o.fromId}) · ${o.at} -->\n\n# Handoff: ${o.focus.trim()}\n\n${o.text.trim()}\n`
}

// Primer mensaje de la sesión nueva.
export function handoffPrompt(o: { from: string; focus: string; text: string; file: string }): string {
  return [
    `This session continues work handed off from another session ("${o.from}"). Its handoff (also saved in ${o.file}):`,
    '',
    o.text.trim(),
    '',
    '---',
    `Work on: ${o.focus.trim()}`,
    'Start by saying in a few lines what you understood and your first step, and wait for my go-ahead.'
  ].join('\n')
}
