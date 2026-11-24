import type { Session, SessionStatus } from '../../../shared/types'
import { folderFor, NO_FOLDER_COLOR, sessionLabel } from '../grouping'
import type { Folder } from '../../../shared/types'

interface Props {
  side: 'left' | 'right'
  label: string
  onOpen(): void
  // Solo el riel izquierdo: accesos rápidos a las sesiones.
  sessions?: Session[]
  folders?: Folder[]
  selectedId?: string | null
  status?: Record<string, SessionStatus>
  titles?: Record<string, string | null>
  onSelect?(id: string): void
  badge?: number
}

// Panel lateral cerrado: una franja angosta para volver a abrirlo.
export function Rail({ side, label, onOpen, sessions = [], folders = [], selectedId, status = {}, titles = {}, onSelect, badge }: Props) {
  return (
    <aside className={`card rail ${side}`}>
      <button className="icon-btn rail-open" title={`Show ${label.toLowerCase()}`} onClick={onOpen}>
        {side === 'left' ? '»' : '«'}
      </button>
      <div className="rail-items">
        {sessions.map((s) => {
          const color = folderFor(s, folders)?.color ?? NO_FOLDER_COLOR
          const st = status[s.id] ?? 'stopped'
          const { ticket, summary } = sessionLabel(titles[s.id], s.name)
          return (
            <button
              key={s.id}
              className={`rail-session ${s.id === selectedId ? 'selected' : ''}`}
              style={{ ['--fc' as string]: color }}
              title={[ticket, summary ?? s.name].filter(Boolean).join(' — ')}
              onClick={() => onSelect?.(s.id)}
            >
              <span className={`dot ${st}`}>{st === 'waiting' ? '!' : ''}</span>
            </button>
          )
        })}
      </div>
      <button className="rail-label" onClick={onOpen} title={`Show ${label.toLowerCase()}`}>
        {label}
        {!!badge && <span className="rail-badge">{badge}</span>}
      </button>
    </aside>
  )
}
