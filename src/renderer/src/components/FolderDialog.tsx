import { useEffect, useState } from 'react'
import type { Folder, FolderSuggestion } from '../../../shared/types'
import { PALETTE } from '../grouping'

interface Props {
  folder?: Folder
  usedColors: string[]
  onSave(data: Omit<Folder, 'id'>): Promise<void>
  onDelete?(): Promise<void>
  onCancel(): void
}

const short = (p: string) => p.replace(/^\/home\/[^/]+/, '~')

export function FolderDialog({ folder, usedColors, onSave, onDelete, onCancel }: Props) {
  const [name, setName] = useState(folder?.name ?? '')
  const [path, setPath] = useState(folder?.path ?? '')
  const [color, setColor] = useState(folder?.color ?? PALETTE.find((c) => !usedColors.includes(c)) ?? PALETTE[0])
  const [extra, setExtra] = useState<string[]>(folder?.extraPaths ?? [])
  const [extraSugg, setExtraSugg] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<FolderSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!folder) window.clawhip.suggestFolders().then(setSuggestions)
  }, [folder])

  // Paths adicionales sugeridos según tus sesiones (…/clients/<nombre> en otras ubicaciones).
  useEffect(() => {
    const t = setTimeout(() => {
      window.clawhip.suggestExtraPaths(name, [path, ...extra]).then(setExtraSugg)
    }, 300)
    return () => clearTimeout(t)
  }, [name, path, extra])

  const addExtra = async (p?: string) => {
    const dir = p ?? (await window.clawhip.pickFolder())
    if (dir && dir !== path && !extra.includes(dir)) setExtra([...extra, dir])
  }

  const choosePath = (p: string, n?: string) => {
    setPath(p)
    if (!name || name === p.split('/').filter(Boolean).pop()) setName(n ?? p.split('/').filter(Boolean).pop() ?? '')
  }

  const pick = async () => {
    const dir = await window.clawhip.pickFolder()
    if (dir) choosePath(dir)
  }

  const submit = async () => {
    if (!path) return setError('Choose the client working path.')
    try {
      await onSave({ name: name.trim(), path, color, extraPaths: extra })
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
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'text') submit()
        }}
      >
        <h2>{folder ? 'Edit folder' : 'New folder'}</h2>
        {suggestions.length > 0 && (
          <div className="suggestions">
            <span className="muted small">Clients found in ~/workdir:</span>
            <div className="chips">
              {suggestions.map((s) => (
                <button
                  key={s.path}
                  className={`chip ${path === s.path ? 'on' : ''}`}
                  title={s.path}
                  onClick={() => choosePath(s.path, s.name)}
                >
                  {s.name} <span className="muted">{short(s.path).split('/').slice(-3, -2)[0]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <label>
          Working path (new sessions start here)
          <div className="row">
            <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/…/workdir/infra/clients/acme" />
            <button onClick={pick}>Browse…</button>
          </div>
        </label>
        <div className="field">
          <span>
            Extra paths <span className="muted small">(sessions from an old folder layout or repos elsewhere)</span>
          </span>
          {extra.map((p) => (
            <div className="row extra-row" key={p}>
              <span className="extra-path">{short(p)}</span>
              <button className="icon-btn" title="Remove" onClick={() => setExtra(extra.filter((x) => x !== p))}>
                ×
              </button>
            </div>
          ))}
          <div className="chips">
            {extraSugg.map((p) => (
              <button key={p} className="chip" title={`Add ${p}`} onClick={() => addExtra(p)}>
                + {short(p)}
              </button>
            ))}
            <button className="chip" onClick={() => addExtra()}>
              Browse other…
            </button>
          </div>
        </div>
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Client name" />
        </label>
        <div className="field">
          <span className="muted">Color</span>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`swatch ${color === c ? 'on' : ''}`}
                style={{ background: c }}
                title={usedColors.includes(c) && c !== folder?.color ? 'Already used by another folder' : c}
                onClick={() => setColor(c)}
              />
            ))}
            <label className="swatch custom" title="Custom color" style={{ background: PALETTE.includes(color) ? undefined : color }}>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              {PALETTE.includes(color) ? '…' : ''}
            </label>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {onDelete && (
            <button
              className="danger"
              onClick={() => {
                if (window.confirm(`Delete the folder "${folder?.name}"?\n\nIts sessions stay open and move to "No folder".`)) onDelete()
              }}
            >
              Delete folder
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>
            {folder ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
