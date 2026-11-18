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
          Comandos de <span style={{ color: folder.color }}>{folder.name}</span>
        </h2>
        <p className="muted small">
          Se corren con ▶ Comandos en la pestaña Terminal de cualquier sesión de la carpeta, con sus variables de entorno. Para
          AWS SSO, define <code>AWS_PROFILE</code> como variable visible de la carpeta y guarda <code>aws sso login</code>. No
          escribas secretos acá: usa variables (<code>$NOMBRE</code>).
        </p>
        <ul className="cmd-list">
          {rows.map((r) => (
            <li key={r.id}>
              <input value={r.name} placeholder="Nombre" onChange={(e) => update(r.id, { name: e.target.value })} />
              <input
                className="mono"
                value={r.command}
                placeholder="aws sso login --profile $AWS_PROFILE"
                spellCheck={false}
                onChange={(e) => update(r.id, { command: e.target.value })}
              />
              <button className="icon-btn" title="Quitar" onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <button onClick={() => setRows([...rows, { id: newId(), name: '', command: '' }])}>
          <span className="plus">+</span> Agregar comando
        </button>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={save}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  )
}
