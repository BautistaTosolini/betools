import { useEffect, useState } from 'react'

interface Props {
  home: string
  onCreate(cwd: string, name: string): Promise<void>
  onCancel(): void
}

// Sesión nueva en la versión web: no hay selector de carpetas nativo, se autocompleta desde el servidor.
export function NewSessionWeb({ home, onCreate, onCancel }: Props) {
  const [cwd, setCwd] = useState(home ? home + '/' : '')
  const [name, setName] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => (window as any).clawhip.completeDir(cwd).then(setOptions), 150)
    return () => clearTimeout(t)
  }, [cwd])

  const submit = async () => {
    const dir = cwd.replace(/\/+$/, '') || '/'
    try {
      await onCreate(dir, name.trim() || dir.split('/').filter(Boolean).pop() || dir)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) submit()
        }}
      >
        <h2>Nueva sesión</h2>
        <label>
          Carpeta de trabajo
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} list="dir-options" spellCheck={false} autoFocus />
          <datalist id="dir-options">
            {options.map((o) => (
              <option key={o} value={o + '/'} />
            ))}
          </datalist>
        </label>
        <label>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="El de la carpeta" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onCancel}>Cancelar</button>
          <button className="primary" onClick={submit}>
            Crear
          </button>
        </div>
      </div>
    </div>
  )
}
