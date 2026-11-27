import { useEffect, useRef, useState } from 'react'

// Confirmaciones con la interfaz de betools en lugar del diálogo del sistema (window.confirm).
// ask() devuelve una promesa: true si se acepta, false si se cancela (botón, Esc o clic afuera).
// El texto sigue la forma de window.confirm: la primera parte es la pregunta y lo que va después de una
// línea en blanco, la explicación.

export interface AskOptions {
  ok?: string
  danger?: boolean
}

type Request = { text: string; opts: AskOptions; resolve(ok: boolean): void }

const queue: Request[] = []
let notify: (() => void) | null = null

export function ask(text: string, opts: AskOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ text, opts, resolve })
    notify?.()
  })
}

// Se monta una vez (en App). Muestra las confirmaciones de a una, por orden.
export function ConfirmHost() {
  const [cur, setCur] = useState<Request | null>(null)
  const okBtn = useRef<HTMLButtonElement>(null)
  const prevFocus = useRef<Element | null>(null)

  useEffect(() => {
    notify = () => setCur((c) => c ?? queue.shift() ?? null)
    notify()
    return () => {
      notify = null
    }
  }, [])

  useEffect(() => {
    if (!cur) return
    prevFocus.current = document.activeElement
    okBtn.current?.focus()
  }, [cur])

  if (!cur) return null

  const finish = (ok: boolean) => {
    cur.resolve(ok)
    const back = prevFocus.current
    setCur(queue.shift() ?? null)
    if (back instanceof HTMLElement && !queue.length) setTimeout(() => back.isConnected && back.focus(), 0)
  }

  const [question, ...rest] = cur.text.split('\n\n')
  const detail = rest.join('\n\n')

  return (
    <div className="modal-backdrop confirm-backdrop" onClick={() => finish(false)}>
      <div
        className="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={question}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            finish(false)
          }
        }}
      >
        <h2>{question}</h2>
        {detail && <p className="confirm-detail">{detail}</p>}
        <div className="actions">
          <button onClick={() => finish(false)}>Cancel</button>
          <button ref={okBtn} className={cur.opts.danger ? 'danger solid' : 'primary'} onClick={() => finish(true)}>
            {cur.opts.ok ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
