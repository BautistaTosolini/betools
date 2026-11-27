import { useState } from 'react'
import type { Session } from '../../../shared/types'

interface Props {
  session: Session
  // Nombre de la sesión como en la barra lateral (tickets y resumen), para mostrar de dónde sale el traspaso.
  tickets: string[]
  summary: string
  busy: boolean
  onClose(): void
}

// Continuar en una sesión nueva: se indica en qué va a trabajar la nueva. Al confirmar, el diálogo se cierra y
// el traspaso sigue en segundo plano (en cola si Claude está ocupado), con su estado en la sesión.
export function HandoffDialog({ session, tickets, summary, busy, onClose }: Props) {
  const [focus, setFocus] = useState('')
  const [title, setTitle] = useState(tickets.length ? tickets.join(' ') + ' ' : '')
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    if (!focus.trim()) return
    try {
      await window.clawhip.handoff(session.id, focus, title)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal handoff" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="handoff-head">
          <span className="menu-badge">Handoff</span>
          <h2>Continue in a new session</h2>
          <div className="handoff-from">
            <span className="muted">from</span>
            {tickets.map((k) => (
              <span key={k} className="ticket">
                {k}
              </span>
            ))}
            <span className="handoff-from-name">{summary}</span>
          </div>
        </div>

        <ol className="handoff-steps">
          <li>
            <b>1</b> This session writes a handoff with only what the new one needs
          </li>
          <li>
            <b>2</b> It is saved in <code>~/.claude/handoffs</code>, outside the repository
          </li>
          <li>
            <b>3</b> A new session in the same directory starts from it
          </li>
        </ol>

        <div className="field">
          <span>What will the new session work on?</span>
          <textarea
            className="handoff-focus"
            autoFocus
            rows={3}
            value={focus}
            placeholder="e.g. the Mongo connection of the extraction pipeline"
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void start()
              }
            }}
          />
        </div>
        <div className="field">
          <span>
            Title <span className="muted small">ticket and summary · optional</span>
          </span>
          <input value={title} placeholder="OPS-123 task summary" onChange={(e) => setTitle(e.target.value)} />
        </div>

        {busy && (
          <p className="handoff-note">
            Claude is busy in this session. The handoff is queued and sent when it finishes; you can cancel it from
            the session.
          </p>
        )}
        {error && <p className="error">{error}</p>}

        <div className="handoff-foot">
          <span className="muted small">Folder variables are inherited · this session’s own variables are not copied</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!focus.trim()} onClick={start} title="Ctrl+Enter">
            {busy ? 'Queue handoff' : 'Hand off'}
          </button>
        </div>
      </div>
    </div>
  )
}
