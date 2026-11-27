import { useState } from 'react'
import type { Folder, SavedCommand } from '../../../shared/types'

interface Props {
  // Carpeta de la sesión (o la elegida en la barra lateral); null = solo los globales.
  folder: Folder | null
  folders: Folder[]
  global: SavedCommand[]
  onSaved(): void
  onClose(): void
}

const newId = () => Math.random().toString(36).slice(2, 10)
const GLOBAL = 'global'

// Comandos guardados: los globales se ofrecen en todas las sesiones y los de una carpeta, en las sesiones de esa
// carpeta. Se corren con ▶ Commands en la terminal de la sesión, con sus variables. Cada uno se puede mover a
// global o a otra carpeta; todo se guarda junto con Save.
export function CommandsDialog({ folder, folders, global, onSaved, onClose }: Props) {
  const [lists, setLists] = useState<Record<string, SavedCommand[]>>(() => ({
    [GLOBAL]: global,
    ...Object.fromEntries(folders.map((f) => [f.id, f.commands ?? []]))
  }))
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const nameOf = (key: string) => (key === GLOBAL ? 'Global' : (folders.find((f) => f.id === key)?.name ?? key))
  const update = (key: string, id: string, patch: Partial<SavedCommand>) =>
    setLists((l) => ({ ...l, [key]: l[key].map((r) => (r.id === id ? { ...r, ...patch } : r)) }))
  const remove = (key: string, id: string) => setLists((l) => ({ ...l, [key]: l[key].filter((r) => r.id !== id) }))
  const add = (key: string) => setLists((l) => ({ ...l, [key]: [...l[key], { id: newId(), name: '', command: '' }] }))
  const move = (from: string, to: string, row: SavedCommand) => {
    setLists((l) => ({ ...l, [from]: l[from].filter((r) => r.id !== row.id), [to]: [...l[to], row] }))
    setNote(`Moved “${row.name || row.command}” to ${nameOf(to)}.`)
  }

  const save = async () => {
    try {
      const { [GLOBAL]: g, ...byFolder } = lists
      await window.clawhip.saveCommands(g, byFolder)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const section = (key: string) => (
    <section className="cmd-section" key={key}>
      <h3>
        {key === GLOBAL ? (
          <>
            Global <span className="muted small">· every session</span>
          </>
        ) : (
          <>
            <span style={{ color: folder?.color }}>{nameOf(key)}</span> <span className="muted small">· sessions in this folder</span>
          </>
        )}
      </h3>
      <ul className="cmd-list">
        {lists[key].map((r) => (
          <li key={r.id}>
            <input value={r.name} placeholder="Name" onChange={(e) => update(key, r.id, { name: e.target.value })} />
            <input
              className="mono"
              value={r.command}
              placeholder="aws sso login --profile $AWS_PROFILE"
              spellCheck={false}
              onChange={(e) => update(key, r.id, { command: e.target.value })}
            />
            <select
              className="btn-sm env-move"
              value=""
              aria-label="Move to"
              onChange={(e) => e.target.value && move(key, e.target.value, r)}
            >
              <option value="">Move to…</option>
              {[GLOBAL, ...folders.map((f) => f.id)]
                .filter((k) => k !== key)
                .map((k) => (
                  <option key={k} value={k}>
                    {k === GLOBAL ? 'Global' : `folder ${nameOf(k)}`}
                  </option>
                ))}
            </select>
            <button className="icon-btn" title="Remove" onClick={() => remove(key, r.id)}>
              ×
            </button>
          </li>
        ))}
        {lists[key].length === 0 && <li className="empty muted small">No commands.</li>}
      </ul>
      <button className="cmd-add" onClick={() => add(key)}>
        <span className="plus">+</span> Add command
      </button>
    </section>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Commands</h2>
        <p className="muted small">
          They run from ▶ Commands in the Terminal tab of the session, with its environment variables. Global ones are
          offered in every session; folder ones, in the sessions of that folder. For AWS SSO, set <code>AWS_PROFILE</code>{' '}
          as a visible folder variable and save <code>aws sso login</code>. Do not write secrets here: use variables (
          <code>$NAME</code>).
        </p>
        {folder && section(folder.id)}
        {section(GLOBAL)}
        {note && <p className="muted small">{note}</p>}
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
