import { useState } from 'react'
import type { Folder, SavedCommand } from '../../../shared/types'

interface Props {
  folder: Folder
  onSaved(): void
  onClose(): void
}

const newId = () => Math.random().toString(36).slice(2, 10)

// Comandos guardados de una carpeta: se corren con ▶ en la terminal de cualquier sesión de la carpeta.
export function CommandsDialog({ folder, onSaved, onClose }: Props) {
  const [rows, setRows] = useState<SavedCommand[]>(
    folder.commands?.length ? folder.commands : [{ id: newId(), name: 'Login AWS SSO', command: 'aws sso login' }]
  )
  const [error, setError] = useState<string | null>(null)

  const update = (id: string, patch: Partial<SavedCommand>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const save = async () => {
    try {
      await window.clawhip.setFolderCommands(folder.id, rows)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>
          Commands for <span style={{ color: folder.color }}>{folder.name}</span>
        </h2>
        <p className="muted small">
          They run from ▶ Commands in the Terminal tab of any session in the folder, with its environment variables. For
          AWS SSO, set <code>AWS_PROFILE</code> as a visible folder variable and save <code>aws sso login</code>. Do not
          write secrets here: use variables (<code>$NAME</code>).
        </p>
        <ul className="cmd-list">
          {rows.map((r) => (
            <li key={r.id}>
              <input value={r.name} placeholder="Name" onChange={(e) => update(r.id, { name: e.target.value })} />
              <input
                className="mono"
                value={r.command}
                placeholder="aws sso login --profile $AWS_PROFILE"
                spellCheck={false}
                onChange={(e) => update(r.id, { command: e.target.value })}
              />
              <button className="icon-btn" title="Remove" onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <button onClick={() => setRows([...rows, { id: newId(), name: '', command: '' }])}>
          <span className="plus">+</span> Add command
        </button>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
