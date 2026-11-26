import { KEYS } from './menu-parser'

// Navegación por los paneles de Claude Code (/config, /mcp, /plugin…) a partir de la pantalla: se manda una flecha,
// se espera el redibujo y se mira dónde quedó el cursor, hasta llegar a la fila pedida. No depende del formato de
// cada panel (filas de una o dos líneas, separadores que no se pueden elegir).
export interface PanelIO {
  cursor(): number | null // fila de pantalla del elemento enfocado
  send(keys: string): void
  wait(): Promise<void> // hasta el próximo redibujo
}

export async function moveToRow(io: PanelIO, target: number, max = 80): Promise<boolean> {
  let cur = io.cursor()
  if (cur === null) return false
  for (let i = 0; i < max; i++) {
    if (cur === target) return true
    const down = target > cur
    io.send(down ? KEYS.down : KEYS.up)
    await io.wait()
    const next = io.cursor()
    // No se movió (tope de la lista) o dio la vuelta: no se puede llegar.
    if (next === null || next === cur || (down ? next < cur : next > cur)) return false
    if (down ? next > target : next < target) {
      // Se pasó: la fila pedida es la segunda línea de un elemento (p. ej. la descripción de un plugin).
      if (down) {
        io.send(KEYS.up)
        await io.wait()
      }
      return true
    }
    cur = next
  }
  return false
}

// Cambia de pestaña (Settings: Status/Config/Usage…): prueba con Tab y, si no cambia, con las flechas.
export async function switchTab(io: { active(): number; send(keys: string): void; wait(): Promise<void> }, target: number, count: number): Promise<boolean> {
  let key: string = KEYS.tab
  for (let i = 0; i < count * 2 + 2; i++) {
    const cur = io.active()
    if (cur === target) return true
    if (cur < 0) return false
    if (key !== KEYS.tab) key = target > cur ? KEYS.right : KEYS.left
    io.send(key)
    await io.wait()
    // Tab no cambió de pestaña (el foco estaba en otra parte): se pasa a las flechas.
    if (io.active() === cur && key === KEYS.tab) key = target > cur ? KEYS.right : KEYS.left
  }
  return io.active() === target
}

// Tecla del teclado → secuencia para la terminal, cuando el foco está en un panel. null: no se reenvía.
export function keyToTerm(e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  if (e.metaKey) return null
  const named: Record<string, string> = {
    ArrowUp: KEYS.up,
    ArrowDown: KEYS.down,
    ArrowLeft: KEYS.left,
    ArrowRight: KEYS.right,
    Enter: KEYS.enter,
    Escape: KEYS.esc,
    Backspace: '\x7f',
    Delete: '\x1b[3~',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~'
  }
  if (e.key === 'Tab') return e.shiftKey ? '\x1b[Z' : KEYS.tab
  if (named[e.key]) return (e.altKey ? '\x1b' : '') + named[e.key]
  if (e.ctrlKey && !e.shiftKey && /^[a-z]$/i.test(e.key)) {
    // Ctrl+C y Ctrl+V quedan para copiar y pegar en Rendered.
    if (/^[cv]$/i.test(e.key)) return null
    return String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96)
  }
  if (e.key.length === 1 && !e.ctrlKey) return (e.altKey ? '\x1b' : '') + e.key
  return null
}
