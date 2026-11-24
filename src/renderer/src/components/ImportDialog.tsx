import { useEffect, useMemo, useState } from 'react'
import type { DiscoveredSession } from '../../../shared/types'

interface Props {
  onImport(s: DiscoveredSession): Promise<void>
  onCancel(): void
}

const short = (p: string) => p.replace(/^\/home\/[^/]+/, '~')
const fmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' })

export function ImportDialog({ onImport, onCancel }: Props) {
  const [items, setItems] = useState<DiscoveredSession[] | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.clawhip.discoverSessions().then(setItems, (e) => setError(String(e)))
  }, [])

  const filtered = useMemo(() => {
    if (!items) return []
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((s) => terms.every((t) => `${s.title} ${s.cwd}`.toLowerCase().includes(t)))
  }, [items, q])

  const pick = async (s: DiscoveredSession) => {
    try {
      await onImport(s)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h2>Import an existing session</h2>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or folder…" />
        <p className="muted small">
          If the session is still open in another terminal, close it there first: two processes on the same session write
          to the same history.
        </p>
        {error && <p className="error">{error}</p>}
        <ul className="import-list">
          {items === null && <li className="empty">Searching sessions…</li>}
          {items && filtered.length === 0 && <li className="empty">No sessions to import.</li>}
          {filtered.map((s) => (
            <li
              key={s.id}
              className={s.cwdExists ? '' : 'disabled'}
              onClick={() => s.cwdExists && pick(s)}
              title={`${s.cwd}\n${s.id}`}
            >
              <span className="import-title">{s.title}</span>
              <span className="import-meta">
                {short(s.cwd)} · {fmt.format(new Date(s.modifiedAt))} · {s.sizeKb} KB
                {!s.cwdExists && ' · working directory no longer exists'}
              </span>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button onClick={onCancel}>Close</button>
        </div>
      </div>
    </div>
  )
}
