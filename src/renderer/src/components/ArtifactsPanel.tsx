import { useEffect, useMemo, useState } from 'react'
import type { Artifact, Session } from '../../../shared/types'

const api = window.clawhip

interface Props {
  session: Session | undefined
  onCollapse(): void
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })
function ago(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']
  ]
  let v = s
  for (const [k, unit] of steps) {
    if (Math.abs(v) < k) return rtf.format(Math.round(v), unit)
    v /= k
  }
  return ''
}

// Ruta del directorio relativa al cwd de la sesión si está adentro; si no, abreviada con ~.
function displayDir(path: string, cwd: string): string {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  if (dir === cwd) return '.'
  if (dir.startsWith(cwd + '/')) return dir.slice(cwd.length + 1)
  return dir.replace(/^\/home\/[^/]+/, '~')
}

const BADGE_COLORS: Record<string, string> = {
  pdf: '#e06c75', html: '#d19a66', htm: '#d19a66', md: '#61afef', docx: '#4f8cc9', xlsx: '#4fbf7f',
  pptx: '#d97757', csv: '#4fbf7f', png: '#c678dd', jpg: '#c678dd', jpeg: '#c678dd', svg: '#c678dd'
}

export function ArtifactsPanel({ session, onCollapse }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [onlyDocs, setOnlyDocs] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    setArtifacts([])
    setError(null)
    if (!session) return
    const id = session.id
    // Al seleccionar la sesión (o volver a la ventana) se pide la lista de nuevo para refrescar
    // qué archivos siguen existiendo.
    const load = () => api.listArtifacts(id).then(setArtifacts)
    load()
    const off = api.onArtifacts((sid, list) => sid === id && setArtifacts(list))
    window.addEventListener('focus', load)
    return () => {
      off()
      window.removeEventListener('focus', load)
    }
  }, [session?.id])

  // Refresca los "hace X min" cada 30 s.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const visible = useMemo(() => (onlyDocs ? artifacts.filter((a) => a.isDocument) : artifacts), [artifacts, onlyDocs])

  const open = async (a: Artifact) => {
    setError(null)
    try {
      await api.openArtifact(a.path)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  return (
    <aside className="card artifacts">
      <header className="card-header">
        <span className="grip">⠿</span>
        <h2>Artefactos</h2>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="Cerrar panel" onClick={onCollapse}>
          »
        </button>
        <div className="seg">
          <button className={onlyDocs ? 'on' : ''} onClick={() => setOnlyDocs(true)}>
            Documentos {artifacts.filter((a) => a.isDocument).length}
          </button>
          <button className={!onlyDocs ? 'on' : ''} onClick={() => setOnlyDocs(false)}>
            Todos {artifacts.length}
          </button>
        </div>
      </header>
      <ul className="artifact-list">
        {visible.map((a) => {
          const ext = a.ext.replace('.', '') || '—'
          return (
            <li
              key={a.path}
              className={`artifact ${a.exists ? '' : 'missing'}`}
              onClick={() => a.exists && open(a)}
              title={`${a.path}\n${a.sources.join(' + ')}${a.sources.includes('Bash') ? ' (detectado en un comando)' : ''}${a.exists ? '' : '\nEl archivo ya no existe'}`}
            >
              <span className="badge" style={{ background: BADGE_COLORS[ext] ?? 'var(--panel-2)' }}>
                {ext.slice(0, 4)}
              </span>
              <div className="artifact-text">
                <span className="artifact-name">{a.name}</span>
                <span className="artifact-meta">
                  {[session && displayDir(a.path, session.cwd), ago(a.lastAt)].filter((x) => x && x !== '.').join(' · ')}
                </span>
              </div>
              <div className="artifact-actions">
                <button
                  className="icon-btn"
                  title="Mostrar en carpeta"
                  disabled={!a.exists}
                  onClick={(e) => {
                    e.stopPropagation()
                    api.revealArtifact(a.path)
                  }}
                >
                  ↗
                </button>
                <button
                  className="icon-btn"
                  title="Copiar ruta"
                  onClick={(e) => {
                    e.stopPropagation()
                    api.writeClipboard(a.path)
                  }}
                >
                  ⧉
                </button>
              </div>
            </li>
          )
        })}
        {session && visible.length === 0 && (
          <li className="empty">
            {artifacts.length === 0
              ? 'Esta sesión todavía no generó archivos.'
              : 'No hay documentos. Mira la pestaña "Todos".'}
          </li>
        )}
      </ul>
      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </aside>
  )
}
