import { useState } from 'react'
import type { Folder, Session, SessionStatus } from '../../../shared/types'
import { basePathFor, NO_FOLDER_COLOR, sessionLabel, textOn, type Group } from '../grouping'
import { SettingsMenu } from './SettingsMenu'
import { Kebab } from './Kebab'

interface Props {
  groups: Group[]
  selectedId: string | null
  status: Record<string, SessionStatus>
  titles: Record<string, string | null>
  shortcutOf: (id: string) => number | null
  onSelect(id: string): void
  onNew(folder?: Folder): void
  onNewFolder(): void
  onEditFolder(folder: Folder): void
  onToggleFolder(folder: Folder): void
  onImport(): void
  onClose(id: string): void
  onSetTitle(id: string, title: string): void
  // Carpeta agrandada: el panel muestra solo esa carpeta.
  focused: Folder | null
  onFocus(folder: Folder | null): void
  onCollapse(): void
  onMoveFolder(folder: Folder, delta: -1 | 1): void
  onDeleteFolder(folder: Folder): void
  onFolderEnv(folder: Folder): void
  onFolderCommands(folder: Folder): void
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  stopped: 'Sin iniciar',
  idle: 'Esperando un prompt',
  working: 'Trabajando…',
  waiting: 'Necesita tu respuesta',
  done: 'Terminó',
  exited: 'Proceso terminado'
}

const short = (p: string) => p.replace(/^\/home\/[^/]+/, '~')

// Ruta de la sesión relativa a la carpeta (si es la raíz, no se muestra).
function relCwd(s: Session, folder: Folder | null): string | null {
  if (!folder) return short(s.cwd)
  const base = basePathFor(s.cwd, folder)
  // Si cae por un path adicional, se muestra la ruta completa para que se note.
  if (!base || base !== folder.path.replace(/\/+$/, '')) return short(s.cwd)
  return s.cwd === base ? null : s.cwd.slice(base.length + 1)
}

export function Sidebar(props: Props) {
  const { groups, selectedId, status, titles, shortcutOf, focused } = props
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const folderCount = groups.filter((g) => g.folder).length

  const commit = (id: string) => {
    props.onSetTitle(id, draft)
    setEditing(null)
  }

  return (
    <aside className="card sidebar" style={focused ? { ['--fc' as string]: focused.color } : undefined}>
      {focused ? (
        <header className="card-header focus-header">
          <button className="btn-sm back" onClick={() => props.onFocus(null)} title="Ver todas las carpetas">
            ← Todas
          </button>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="Editar carpeta" onClick={() => props.onEditFolder(focused)}>
            ✎
          </button>
          <button className="icon-btn" title="Cerrar panel" onClick={props.onCollapse}>
            «
          </button>
          <div className="focus-title">
            <span className="folder-dot big" />
            <h2>{focused.name}</h2>
          </div>
          <span className="focus-path">{short(focused.path)}</span>
          <button className="primary focus-new" onClick={() => props.onNew(focused)}>
            <span className="plus">+</span> Nueva sesión en {focused.name}
          </button>
        </header>
      ) : (
        <header className="card-header">
          <span className="grip">⠿</span>
          <h2>Sesiones</h2>
          <span style={{ flex: 1 }} />
          <button className="btn-sm" onClick={() => props.onNew()} title="Nueva sesión fuera de una carpeta (Ctrl+Shift+N)">
            Nueva sesión
          </button>
          <Kebab title="Ajustes">
            <SettingsMenu />
          </Kebab>
          <button className="icon-btn" title="Cerrar panel" onClick={props.onCollapse}>
            «
          </button>
        </header>
      )}

      <div className="groups">
        {groups.map(({ folder, sessions }, gi) => {
          const color = folder?.color ?? NO_FOLDER_COLOR
          const collapsed = !focused && !!folder?.collapsed
          const attention = sessions.filter((s) => status[s.id] === 'waiting').length
          return (
            <section key={folder?.id ?? 'none'} className="group" style={{ ['--fc' as string]: color }}>
              {!focused && <div className="group-header" onClick={() => folder && props.onToggleFolder(folder)} title={folder ? folder.path : undefined}>
                <span className="caret">{folder ? (collapsed ? '▸' : '▾') : ''}</span>
                <span className="folder-dot" />
                <span className="group-name">{folder?.name ?? 'Sin carpeta'}</span>
                <span className="group-count">{sessions.length}</span>
                {collapsed && attention > 0 && <span className="group-alert">{attention}!</span>}
                <span style={{ flex: 1 }} />
                {folder && (
                  <div className="folder-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title={`Nueva sesión en ${folder.name}`} onClick={() => props.onNew(folder)}>
                      +
                    </button>
                    <Kebab
                      title="Acciones de la carpeta"
                      items={[
                        { label: 'Nueva sesión', onClick: () => props.onNew(folder) },
                        { label: 'Agrandar (ver solo esta carpeta)', onClick: () => props.onFocus(folder) },
                        { label: 'Editar nombre, color y paths…', onClick: () => props.onEditFolder(folder) },
                        { label: 'Variables de entorno…', onClick: () => props.onFolderEnv(folder) },
                        { label: 'Comandos…', onClick: () => props.onFolderCommands(folder) },
                        ...(gi > 0 ? [{ label: 'Subir', onClick: () => props.onMoveFolder(folder, -1) }] : []),
                        ...(gi < folderCount - 1 ? [{ label: 'Bajar', onClick: () => props.onMoveFolder(folder, 1) }] : []),
                        { label: 'Borrar carpeta', onClick: () => props.onDeleteFolder(folder), danger: true }
                      ]}
                    />
                  </div>
                )}
              </div>}

              {!collapsed && (
                <ul className="session-list">
                  {sessions.map((s) => {
                    const st = status[s.id] ?? 'stopped'
                    const { ticket, summary, fallback } = sessionLabel(titles[s.id], s.name)
                    const sub = relCwd(s, folder)
                    const n = shortcutOf(s.id)
                    return (
                      <li
                        key={s.id}
                        className={`session ${s.id === selectedId ? 'selected' : ''}`}
                        onClick={() => props.onSelect(s.id)}
                        onDoubleClick={() => {
                          setEditing(s.id)
                          setDraft(titles[s.id] ?? '')
                        }}
                        title={`${s.cwd}\n${STATUS_LABEL[st]}\nDoble clic para editar ticket y resumen`}
                      >
                        <div className="session-top">
                          {ticket ? (
                            <span className="ticket" style={{ background: color, color: textOn(color) }}>
                              {ticket}
                            </span>
                          ) : (
                            <span className="ticket none">sin ticket</span>
                          )}
                          <span className={`status ${st}`}>
                            <span className={`dot ${st}`}>{st === 'waiting' ? '!' : ''}</span>
                            {st === 'working' || st === 'waiting' || st === 'done' ? STATUS_LABEL[st] : ''}
                          </span>
                          <span style={{ flex: 1 }} />
                          {n !== null && <span className="shortcut">^{n}</span>}
                          <button
                            className="icon-btn close"
                            title="Cerrar sesión"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onClose(s.id)
                            }}
                          >
                            ×
                          </button>
                        </div>
                        {editing === s.id ? (
                          <input
                            autoFocus
                            value={draft}
                            placeholder="VE-123 resumen de la tarea"
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commit(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commit(s.id)
                              if (e.key === 'Escape') setEditing(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <p className={`summary ${fallback ? 'no-title' : ''}`} title={fallback ? 'Sin título de Warp ni de Claude: se muestra el nombre con que se importó' : undefined}>
                            {summary ?? s.name}
                          </p>
                        )}
                        {sub && <span className="session-cwd">{sub}</span>}
                      </li>
                    )
                  })}
                  {folder && sessions.length === 0 && (
                    <li className="empty" onClick={() => props.onNew(folder)}>
                      Sin sesiones. <a>Crear una</a>
                    </li>
                  )}
                </ul>
              )}
            </section>
          )
        })}
        {groups.length === 0 && (
          <p className="empty pad">
            Crea una carpeta por cliente con <b>Nueva carpeta</b>, o trae una sesión existente con <b>Importar sesión</b>.
          </p>
        )}
      </div>
    </aside>
  )
}
