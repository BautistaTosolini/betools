// Un único listener IPC por canal que reparte la salida a la terminal de cada sesión.
type Handler = (data: string) => void
const dataHandlers = new Map<string, Handler>()
const exitHandlers = new Map<string, (code: number) => void>()

window.clawhip.onData((id, data) => dataHandlers.get(id)?.(data))
window.clawhip.onExit((id, code) => exitHandlers.get(id)?.(code))

export function subscribe(id: string, onData: Handler, onExit: (code: number) => void): () => void {
  dataHandlers.set(id, onData)
  exitHandlers.set(id, onExit)
  return () => {
    if (dataHandlers.get(id) === onData) dataHandlers.delete(id)
    if (exitHandlers.get(id) === onExit) exitHandlers.delete(id)
  }
}

// Reinicio desde main (p. ej. para aplicar variables de entorno): la terminal se limpia.
const resetHandlers = new Map<string, () => void>()
window.clawhip.onReset((id) => resetHandlers.get(id)?.())
export function onReset(id: string, cb: () => void): () => void {
  resetHandlers.set(id, cb)
  return () => {
    if (resetHandlers.get(id) === cb) resetHandlers.delete(id)
  }
}
