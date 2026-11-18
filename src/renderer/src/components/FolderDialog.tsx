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
    if (!path) return setError('Elige el path de trabajo del cliente.')
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
        <h2>{folder ? 'Editar carpeta' : 'Nueva carpeta'}</h2>
        {suggestions.length > 0 && (
          <div className="suggestions">
            <span className="muted small">Clientes encontrados en ~/workdir:</span>
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
          Path de trabajo (las sesiones nuevas arrancan acá)
          <div className="row">
            <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/…/workdir/infra/clients/vemo" />
            <button onClick={pick}>Elegir…</button>
          </div>
        </label>
        <div className="field">
          <span>
            Paths adicionales <span className="muted small">(sesiones de una estructura vieja o repos en otro lado)</span>
          </span>
          {extra.map((p) => (
            <div className="row extra-row" key={p}>
              <span className="extra-path">{short(p)}</span>
              <button className="icon-btn" title="Quitar" onClick={() => setExtra(extra.filter((x) => x !== p))}>
                ×
              </button>
            </div>
          ))}
          <div className="chips">
            {extraSugg.map((p) => (
              <button key={p} className="chip" title={`Agregar ${p}`} onClick={() => addExtra(p)}>
                + {short(p)}
              </button>
            ))}
            <button className="chip" onClick={() => addExtra()}>
              Elegir otro…
            </button>
          </div>
        </div>
        <label>
          Nombre
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del cliente" />
        </label>
        <div className="field">
          <span className="muted">Color</span>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`swatch ${color === c ? 'on' : ''}`}
                style={{ background: c }}
                title={usedColors.includes(c) && c !== folder?.color ? 'Ya lo usa otra carpeta' : c}
                onClick={() => setColor(c)}
              />
            ))}
            <label className="swatch custom" title="Otro color" style={{ background: PALETTE.includes(color) ? undefined : color }}>
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
                if (window.confirm(`¿Borrar la carpeta "${folder?.name}"?\n\nSus sesiones no se cierran: pasan a "Sin carpeta".`)) onDelete()
              }}
            >
              Borrar carpeta
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={onCancel}>Cancelar</button>
          <button className="primary" onClick={submit}>
            {folder ? 'Guardar' : 'Crear'}
          </button>
        </div>
      </div>
    </div>
  )
}
