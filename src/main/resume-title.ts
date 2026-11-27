import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'

// El título de betools (<TICKET> <resumen>) se escribe también en el historial de Claude, con las mismas líneas
// que deja /rename. Así `claude --resume` lista la sesión con el nombre que se ve en la barra lateral.
// Claude toma la última línea custom-title del final del archivo: se agrega al final y solo si cambió.

const TAIL = 256 * 1024

// Última línea custom-title del final del historial (null si no hay o no existe el archivo).
export function lastCustomTitle(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, TAIL)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l.includes('"custom-title"')) continue
      try {
        const d = JSON.parse(l)
        if (d?.type === 'custom-title' && typeof d.customTitle === 'string') return d.customTitle
      } catch {
        // línea cortada al principio del tramo leído
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

// Escribe el título si el historial existe y su último título es otro. Devuelve si escribió.
// No crea el archivo: una sesión nueva lo recibe cuando Claude empieza a escribir su historial.
export function writeResumeTitle(file: string, sessionId: string, title: string): boolean {
  const t = title.replace(/\s+/g, ' ').trim()
  if (!t || !existsSync(file) || lastCustomTitle(file) === t) return false
  const line = (o: object) => JSON.stringify(o) + '\n'
  appendFileSync(file, line({ type: 'custom-title', customTitle: t, sessionId }) + line({ type: 'agent-name', agentName: t, sessionId }))
  return true
}
