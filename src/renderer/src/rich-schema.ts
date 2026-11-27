import { getSchema, type AnyExtension, type JSONContent } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import type { Canon } from './md-merge'

// Extensiones del editor visual de Markdown. Las usan el editor y la normalización de bloques (md-merge), así
// los dos entienden el Markdown igual. Los links no se abren con un clic: se edita el texto (Ctrl+clic abre).
export function richExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image
  ]
}

// Un salto de línea simple dentro de un párrafo (línea cortada a mano) se ve como un espacio, igual que en la
// vista renderizada. Los bloques de código conservan sus saltos.
function joinSoftBreaks(node: JSONContent): JSONContent {
  if (node.type === 'codeBlock') return node
  if (node.type === 'text' && node.text?.includes('\n')) return { ...node, text: node.text.replace(/ *\n */g, ' ') }
  return node.content ? { ...node, content: node.content.map(joinSoftBreaks) } : node
}

// Markdown -> documento del editor, y md -> md como lo escribiría el editor (para comparar bloques). Los dos
// pasan por el mismo camino, así un bloque no tocado sale igual en ambos. Sin DOM.
export function makeRich(extensions: AnyExtension[] = richExtensions()): { parse(md: string): JSONContent; canon: Canon } {
  const schema = getSchema(extensions)
  const md = new MarkdownManager({ extensions })
  const parse = (src: string) => schema.nodeFromJSON(joinSoftBreaks(md.parse(src))).toJSON() as JSONContent
  return { parse, canon: (src) => md.serialize(parse(src)) }
}

export const makeCanon = (extensions?: AnyExtension[]): Canon => makeRich(extensions).canon
