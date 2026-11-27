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
  stopped: 'Not started',
  idle: 'Waiting for a prompt',
  working: 'Working…',
  waiting: 'Needs your input',
  done: 'Done',
  exited: 'Process exited'
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
          <button className="btn-sm back" onClick={() => props.onFocus(null)} title="Show all folders">
            ← All
          </button>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="Edit folder" onClick={() => props.onEditFolder(focused)}>
            ✎
          </button>
          <button className="icon-btn" title="Collapse panel" onClick={props.onCollapse}>
            «
          </button>
          <div className="focus-title">
            <span className="folder-dot big" />
            <h2>{focused.name}</h2>
          </div>
          <span className="focus-path">{short(focused.path)}</span>
          <button className="primary focus-new" onClick={() => props.onNew(focused)}>
            <span className="plus">+</span> New session in {focused.name}
          </button>
        </header>
      ) : (
        <header className="card-header">
          <span className="grip">⠿</span>
          <h2>Sessions</h2>
          <span style={{ flex: 1 }} />
          <button className="btn-sm ghost" onClick={() => props.onNew()} title="New session outside a folder (Ctrl+Shift+N)">
            New session
          </button>
          <Kebab title="Settings">
            <SettingsMenu />
          </Kebab>
          <button className="icon-btn" title="Collapse panel" onClick={props.onCollapse}>
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
                <span className="group-name">{folder?.name ?? 'No folder'}</span>
                <span className="group-count">{sessions.length}</span>
                {collapsed && attention > 0 && <span className="group-alert">{attention}!</span>}
                <span style={{ flex: 1 }} />
                {folder && (
                  <div className="folder-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title={`New session in ${folder.name}`} onClick={() => props.onNew(folder)}>
                      +
                    </button>
                    <Kebab
                      title="Folder actions"
                      items={[
                        { label: 'New session', onClick: () => props.onNew(folder) },
                        { label: 'Expand (show only this folder)', onClick: () => props.onFocus(folder) },
                        { label: 'Edit name, color and paths…', onClick: () => props.onEditFolder(folder) },
                        { label: 'Environment variables…', onClick: () => props.onFolderEnv(folder) },
                        { label: 'Commands…', onClick: () => props.onFolderCommands(folder) },
                        ...(gi > 0 ? [{ label: 'Move up', onClick: () => props.onMoveFolder(folder, -1) }] : []),
                        ...(gi < folderCount - 1 ? [{ label: 'Move down', onClick: () => props.onMoveFolder(folder, 1) }] : []),
                        { label: 'Delete folder', onClick: () => props.onDeleteFolder(folder), danger: true }
                      ]}
                    />
                  </div>
                )}
              </div>}

              {!collapsed && (
                <ul className="session-list">
                  {sessions.map((s) => {
                    const st = status[s.id] ?? 'stopped'
                    const { ticket, tickets, summary, fallback } = sessionLabel(titles[s.id], s.name)
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
                        title={`${s.cwd}\n${STATUS_LABEL[st]}\nDouble-click to edit ticket and summary`}
                      >
                        <span className={`dot ${st}`}>{st === 'waiting' ? '!' : ''}</span>
                        <div className="session-body">
                          {(ticket || st === 'working' || st === 'waiting' || st === 'done') && (
                            <div className="session-top">
                              {tickets.map((k) => (
                                <span key={k} className="ticket">
                                  {k}
                                </span>
                              ))}
                              {(st === 'working' || st === 'waiting' || st === 'done') && (
                                <span className={`status ${st}`}>{STATUS_LABEL[st]}</span>
                              )}
                            </div>
                          )}
                        {editing === s.id ? (
                          <input
                            autoFocus
                            value={draft}
                            placeholder="OPS-123 task summary  ·  OPS-123 OPS-130 summary"
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commit(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commit(s.id)
                              if (e.key === 'Escape') setEditing(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <p className={`summary ${fallback ? 'no-title' : ''}`} title={fallback ? 'No title from Warp or Claude: showing the name it was imported with' : undefined}>
                            {summary ?? s.name}
                          </p>
                        )}
                          {sub && <span className="session-cwd">{sub}</span>}
                        </div>
                        <div className="session-side">
                          {n !== null && <span className="shortcut">^{n}</span>}
                          <button
                            className="icon-btn close"
                            title="Close session"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onClose(s.id)
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    )
                  })}
                  {folder && sessions.length === 0 && (
                    <li className="empty" onClick={() => props.onNew(folder)}>
                      No sessions. <a>Create one</a>
                    </li>
                  )}
                </ul>
              )}
            </section>
          )
        })}
        {groups.length === 0 && (
          <p className="empty pad">
            Create a folder per client with <b>New folder</b>, or bring in an existing session with <b>Import session</b>.
          </p>
        )}
      </div>
    </aside>
  )
}
