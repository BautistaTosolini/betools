import { useState } from 'react'
import type { Folder } from '../../../shared/types'

interface Props {
  folder?: Folder
  onCreate(cwd: string, name: string, title: string): Promise<void>
  onCancel(): void
}

export function NewSessionDialog({ folder, onCreate, onCancel }: Props) {
  const [cwd, setCwd] = useState(folder?.path ?? '')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pick = async () => {
    const dir = await window.clawhip.pickFolder()
    if (dir) setCwd(dir)
  }

  const submit = async () => {
    if (!cwd) return setError('Choose a folder.')
    try {
      await onCreate(cwd, folder?.name ?? cwd.split('/').filter(Boolean).pop() ?? '', title)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          // Solo desde un input: en un botón, Enter ya dispara su propio clic.
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) submit()
        }}
      >
        <h2>
          New session
          {folder && (
            <span className="folder-tag" style={{ borderColor: folder.color, color: folder.color }}>
              {folder.name}
            </span>
          )}
        </h2>
        <label>
          Ticket and summary <span className="muted small">(optional; otherwise Claude sets it when it picks up the ticket)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VE-123 rotate certificates" autoFocus />
        </label>
        <label>
          Working directory
          <div className="row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/…/project" />
            <button onClick={pick}>Browse…</button>
          </div>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
