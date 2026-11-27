import { useState } from 'react'
import type { Session } from '../../../shared/types'

interface Props {
  session: Session
  // Nombre de la sesión como en la barra lateral, y sus tickets (para proponer el título de la nueva).
  label: string
  tickets: string[]
  onDone(session: Session): void
  onClose(): void
}

// Continuar en una sesión nueva: la sesión actual escribe un traspaso enfocado en lo que se le indica y la nueva
// (mismo directorio y carpeta) arranca con él como primer mensaje.
export function HandoffDialog({ session, label, tickets, onDone, onClose }: Props) {
  const [focus, setFocus] = useState('')
  const [title, setTitle] = useState(tickets.length ? tickets.join(' ') + ' ' : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (!focus.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onDone(await window.clawhip.handoff(session.id, focus, title))
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      if (msg !== 'Cancelled.') setError(msg)
      setBusy(false)
    }
  }

  const cancel = () => {
    if (busy) void window.clawhip.cancelHandoff(session.id)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : cancel}>
      <div className="modal handoff" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && !busy && cancel()}>
        <h2>Continue in a new session</h2>
        <p className="muted small">
          “{label}” writes a handoff with only the context needed for what you ask, and a new session in the same
          directory starts from it. The handoff is saved in <code>~/.claude/handoffs</code>, outside the repository.
        </p>
        <label>
          What will the new session work on?
          <textarea
            autoFocus
            rows={3}
            value={focus}
            disabled={busy}
            placeholder="e.g. the Mongo connection of the extraction pipeline"
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void start()
              }
            }}
          />
        </label>
        <label>
          Title of the new session <span className="muted small">· ticket and summary, optional</span>
          <input value={title} disabled={busy} placeholder="OPS-123 task summary" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p className="muted small">Folder variables are inherited; variables of this session only are not copied.</p>
        {busy && <p className="handoff-wait">Claude is writing the handoff… you can follow it in Rendered.</p>}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={cancel}>Cancel</button>
          <button className="primary" disabled={!focus.trim() || busy} onClick={start}>
            {busy ? 'Writing handoff…' : 'Hand off'}
          </button>
        </div>
      </div>
    </div>
  )
}
