import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

// Visor de documentos: solo Markdown, hasta 5 MB.
const DOC_EXTS = new Set(['.md', '.markdown', '.mdx'])
const DOC_MAX = 5 * 1024 * 1024

// Prefijo del error cuando el archivo cambió en disco desde la versión que se editaba.
export const DOC_CONFLICT = 'CONFLICT:'

export function readDoc(path: string): { text: string; mtime: number } {
  if (!DOC_EXTS.has(extname(path).toLowerCase())) throw new Error('Only Markdown files can be opened in betools.')
  const st = statSync(path)
  if (!st.isFile()) throw new Error(`Not a file: ${path}`)
  if (st.size > DOC_MAX) throw new Error('The file is too large to preview (over 5 MB).')
  return { text: readFileSync(path, 'utf8'), mtime: st.mtimeMs }
}

// Guarda un .md editado en el visor. `expected` es el mtime de la versión que se editaba: si el archivo cambió
// después (p. ej. Claude lo editó), no se pisa y el error empieza con CONFLICT:. Con null se guarda igual (la
// interfaz lo usa tras confirmar que se reemplaza). Devuelve la versión guardada, como readDoc.
export function writeDoc(path: string, text: string, expected: number | null): { text: string; mtime: number } {
  if (!DOC_EXTS.has(extname(path).toLowerCase())) throw new Error('Only Markdown files can be edited in betools.')
  if (Buffer.byteLength(text, 'utf8') > DOC_MAX) throw new Error('The document is too large to save (over 5 MB).')
  // Se escribe en el destino real: si es un symlink, el link sigue apuntando al mismo archivo.
  const real = realpathSync(path)
  const st = statSync(real)
  if (!st.isFile()) throw new Error(`Not a file: ${path}`)
  // Tolerancia de 1 ms: el mtime viaja como número de JS.
  if (expected !== null && Math.abs(st.mtimeMs - expected) > 1) {
    throw new Error(`${DOC_CONFLICT} The file changed on disk since you started editing.`)
  }
  // Escritura atómica: temporal en la misma carpeta con los permisos del original, y rename. Así un lector
  // (Claude, el watcher) nunca ve el archivo a medio escribir.
  const tmp = join(dirname(real), `.${basename(real)}.betools-${process.pid}.tmp`)
  try {
    writeFileSync(tmp, text, 'utf8')
    chmodSync(tmp, st.mode & 0o7777)
    renameSync(tmp, real)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return readDoc(path)
}
