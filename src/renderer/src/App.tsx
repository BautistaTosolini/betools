import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Folder, SessionStatus, Session } from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { NewSessionDialog } from './components/NewSessionDialog'
import { Resizer } from './components/Resizer'
import { ArtifactsPanel } from './components/ArtifactsPanel'
import { ImportDialog } from './components/ImportDialog'
import { Kebab } from './components/Kebab'
import { Rail } from './components/Rail'
import { EnvDialog } from './components/EnvDialog'
import { CommandsDialog } from './components/CommandsDialog'
import type { EnvScope } from '../../shared/types'
import type { DiscoveredSession } from '../../shared/types'
import { FolderDialog } from './components/FolderDialog'
import { folderFor, groupSessions, NO_FOLDER_COLOR, sessionLabel, textOn } from './grouping'

const api = window.clawhip

// Ancho de los paneles laterales; se recuerda por equipo (conveniencia, no estado crítico).
function loadWidth(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return v > 0 ? v : fallback
  } catch {
    return fallback
  }
}
function loadFlag(key: string, fallback: string | null): string | null {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}
function saveFlag(key: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, v)
  } catch {
    // sin storage: no pasa nada
  }
}
function saveWidth(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v))
  } catch {
    // sin storage: no pasa nada
  }
}
const clamp = (v: number) => Math.min(600, Math.max(160, v))
const RAIL_W = 44

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, SessionStatus>>({})
  const [folders, setFolders] = useState<Folder[]>([])
  const [titles, setTitles] = useState<Record<string, string | null>>({})
  // undefined = cerrado; null = sesión sin carpeta; Folder = sesión en esa carpeta
  const [newIn, setNewIn] = useState<Folder | null | undefined>(undefined)
  // undefined = cerrado; null = carpeta nueva; Folder = editar
  const [folderEdit, setFolderEdit] = useState<Folder | null | undefined>(undefined)
  // Pestaña activa por sesión y terminales de shell ya abiertas (quedan montadas).
  const [tabs, setTabs] = useState<Record<string, 'claude' | 'shell'>>({})
  const [shellOpen, setShellOpen] = useState<Set<string>>(new Set())
  const [commandsFor, setCommandsFor] = useState<Folder | null>(null)
  const showTab = (id: string, tab: 'claude' | 'shell') => {
    setTabs((t) => ({ ...t, [id]: tab }))
    if (tab === 'shell') setShellOpen((s) => (s.has(id) ? s : new Set(s).add(id)))
  }
  const runCommand = (id: string, command: string) => {
    showTab(id, 'shell')
    api.runCommand(id, command)
  }
  const [envFor, setEnvFor] = useState<{ title: string; scope: EnvScope; sessionId?: string } | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [leftW, setLeftW] = useState(() => loadWidth('leftW2', 320))
  const [rightW, setRightW] = useState(() => loadWidth('rightW', 280))
  // Paneles laterales abiertos/cerrados y carpeta agrandada (se recuerdan por equipo).
  const [leftOpen, setLeftOpenRaw] = useState(() => loadFlag('leftOpen', '1') === '1')
  const [rightOpen, setRightOpenRaw] = useState(() => loadFlag('rightOpen', '1') === '1')
  const [focusId, setFocusIdRaw] = useState<string | null>(() => loadFlag('focusFolder', null))
  const setLeftOpen = (v: boolean) => {
    setLeftOpenRaw(v)
    saveFlag('leftOpen', v ? '1' : '0')
  }
  const setRightOpen = (v: boolean) => {
    setRightOpenRaw(v)
    saveFlag('rightOpen', v ? '1' : '0')
  }
  const setFocusId = (v: string | null) => {
    setFocusIdRaw(v)
    saveFlag('focusFolder', v)
  }

  const refresh = useCallback(async () => {
    const state = await api.listSessions()
    setSessions(state.sessions)
    setFolders(state.folders)
    setSelectedId(state.selectedId)
    setStatus(state.status)
    setTitles(state.titles)
  }, [])

  useEffect(() => {
    refresh()
    const offStatus = api.onStatus((id, st) => setStatus((prev) => ({ ...prev, [id]: st })))
    // Selección desde afuera (clic en una notificación o en la bandeja).
    const offSelect = api.onSelect((id) => setSelectedId(id))
    const offTitle = api.onTitle((id, t) => setTitles((prev) => ({ ...prev, [id]: t })))
    return () => {
      offStatus()
      offSelect()
      offTitle()
    }
  }, [refresh])

  const allGroups = useMemo(() => groupSessions(sessions, folders), [sessions, folders])
  // Si la carpeta agrandada ya no existe, se vuelve a la vista completa.
  const focused = folders.find((f) => f.id === focusId) ?? null
  const groups = useMemo(
    () => (focused ? allGroups.filter((g) => g.folder?.id === focused.id) : allGroups),
    [allGroups, focused]
  )
  // Orden visual (por carpeta), que es el que siguen Ctrl+1..9 y Ctrl+Tab.
  const ordered = useMemo(() => groups.flatMap((g) => g.sessions), [groups])
  const shortcutOf = useCallback((id: string) => {
    const i = ordered.findIndex((s) => s.id === id)
    return i >= 0 && i < 9 ? i + 1 : null
  }, [ordered])

  const select = useCallback((id: string) => {
    setSelectedId(id)
    api.selectSession(id)
  }, [])

  // Ctrl+1..9: ir a la sesión N. Ctrl+Shift+N: nueva sesión.
  // En captura para ganarle a xterm; Ctrl+número no tiene uso en Claude Code.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return
      if (e.key === '`' && selectedId) {
        e.preventDefault()
        e.stopPropagation()
        showTab(selectedId, (tabs[selectedId] ?? 'claude') === 'claude' ? 'shell' : 'claude')
        return
      }
      if (e.key === 'Tab' && ordered.length > 1) {
        e.preventDefault()
        e.stopPropagation()
        const i = ordered.findIndex((s) => s.id === selectedId)
        const next = ordered[(i + (e.shiftKey ? -1 : 1) + ordered.length) % ordered.length]
        select(next.id)
      } else if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
        const s = ordered[Number(e.key) - 1]
        if (s) {
          e.preventDefault()
          e.stopPropagation()
          select(s.id)
        }
      } else if (e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        e.stopPropagation()
        const cur = sessions.find((x) => x.id === selectedId)
        setNewIn(cur ? (folderFor(cur, folders) ?? null) : null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ordered, sessions, folders, selectedId, select, tabs])

  const create = async (cwd: string, name: string, title: string) => {
    const s = await api.createSession(cwd, name, title)
    setNewIn(undefined)
    setSessions((prev) => [...prev, s])
    setSelectedId(s.id)
  }

  const importSession = async (d: DiscoveredSession) => {
    const name = d.title.length > 40 ? d.title.slice(0, 40) + '…' : d.title
    const s = await api.importSession(d.id, d.cwd, name)
    setShowImport(false)
    setSessions((prev) => [...prev, s])
    select(s.id)
  }

  const close = async (id: string) => {
    const s = sessions.find((x) => x.id === id)
    if (!s) return
    const ok = window.confirm(
      `¿Cerrar la sesión "${titles[id] ?? s.name}"?\n\nSe termina el proceso y sale de la lista. El historial de Claude no se borra; se puede retomar con claude --resume ${s.id}.`
    )
    if (!ok) return
    await api.closeSession(id)
    await refresh()
  }

  const saveFolder = async (data: Omit<Folder, 'id'>) => {
    if (folderEdit) await api.updateFolder(folderEdit.id, data)
    else await api.createFolder(data)
    setFolderEdit(undefined)
    await refresh()
  }

  const toggleFolder = async (f: Folder) => {
    setFolders((prev) => prev.map((x) => (x.id === f.id ? { ...x, collapsed: !x.collapsed } : x)))
    await api.updateFolder(f.id, { collapsed: !f.collapsed })
  }

  const selected = sessions.find((s) => s.id === selectedId)
  const selFolder = selected ? folderFor(selected, folders) : undefined
  const selColor = selFolder?.color ?? NO_FOLDER_COLOR
  const selTitle = sessionLabel(selected ? titles[selected.id] : null, selected?.name ?? '')

  const waitingCount = sessions.filter((x) => status[x.id] === 'waiting').length
  const workingCount = sessions.filter((x) => status[x.id] === 'working').length

  return (
    <div className="app">
      <header className="page-header">
        <h1>clawhip</h1>
        <span className="page-sub">
          {sessions.length} sesiones · {folders.length} carpetas
          {workingCount > 0 && <> · <span className="txt-working">{workingCount} trabajando</span></>}
          {waitingCount > 0 && <> · <span className="txt-waiting">{waitingCount} esperan tu respuesta</span></>}
        </span>
        <div className="page-actions">
          <button onClick={() => setShowImport(true)}>Importar sesión</button>
          <button className="primary" onClick={() => setFolderEdit(null)}>
            <span className="plus">+</span> Nueva carpeta
          </button>
        </div>
      </header>

      <div className="layout" style={{
          gridTemplateColumns: `${leftOpen ? leftW : RAIL_W}px 16px minmax(0, 1fr) 16px ${rightOpen ? rightW : RAIL_W}px`
        }}>
        {leftOpen ? (
          <Sidebar
            groups={groups}
            selectedId={selectedId}
            status={status}
            titles={titles}
            shortcutOf={shortcutOf}
            onSelect={select}
            onNew={(f) => setNewIn(f ?? null)}
            onNewFolder={() => setFolderEdit(null)}
            onEditFolder={(f) => setFolderEdit(f)}
            onToggleFolder={toggleFolder}
            onImport={() => setShowImport(true)}
            onClose={close}
            onSetTitle={(id, t) => api.setTitle(id, t)}
            focused={focused}
            onFocus={(f) => setFocusId(f?.id ?? null)}
            onCollapse={() => setLeftOpen(false)}
            onMoveFolder={async (f, d) => {
              await api.moveFolder(f.id, d)
              await refresh()
            }}
            onFolderCommands={(f) => setCommandsFor(f)}
            onFolderEnv={(f) => setEnvFor({ title: `Variables de la carpeta ${f.name}`, scope: { kind: 'folder', id: f.id } })}
            onDeleteFolder={async (f) => {
              if (!window.confirm(`¿Borrar la carpeta "${f.name}"?\n\nSus sesiones no se cierran: pasan a "Sin carpeta".`)) return
              await api.deleteFolder(f.id)
              if (focusId === f.id) setFocusId(null)
              await refresh()
            }}
          />
        ) : (
          <Rail
            side="left"
            label={focused ? focused.name : 'Sesiones'}
            onOpen={() => setLeftOpen(true)}
            sessions={ordered}
            folders={folders}
            selectedId={selectedId}
            status={status}
            titles={titles}
            onSelect={select}
          />
        )}
        {leftOpen ? (
          <Resizer
            onDrag={(dx) =>
              setLeftW((w) => {
                const v = clamp(w + dx)
                saveWidth('leftW2', v)
                return v
              })
            }
          />
        ) : (
          <div />
        )}
        <main className="card center" style={{ ['--fc' as string]: selColor }}>
          {selected ? (
            <header className="card-header center-header">
              <span className="grip">⠿</span>
              <div className="center-title">
                <div className="center-line">
                  {selTitle.ticket && (
                    <span className="ticket" style={{ background: selColor, color: textOn(selColor) }}>
                      {selTitle.ticket}
                    </span>
                  )}
                  <h2 className="center-summary">{selTitle.summary ?? selected.name}</h2>
                </div>
                <div className="center-meta">
                  {selFolder && <span className="folder-tag">{selFolder.name}</span>}
                  <span>{selected.cwd.replace(/^\/home\/[^/]+/, '~')}</span>
                </div>
              </div>
              <Kebab
                items={[
                  {
                    label: 'Variables de entorno…',
                    onClick: () =>
                      setEnvFor({
                        title: `Variables de ${selTitle.ticket ?? selTitle.summary ?? selected.name}`,
                        scope: { kind: 'session', id: selected.id },
                        sessionId: selected.id
                      })
                  },
                  {
                    label: 'Reiniciar sesión',
                    onClick: () => {
                      if (window.confirm('¿Reiniciar la sesión?\n\nSe retoma con --resume; si Claude estaba trabajando, esa tarea se corta.'))
                        api.restartSession(selected.id)
                    }
                  },
                  { label: 'Abrir carpeta de trabajo', onClick: () => api.openArtifact(selected.cwd) },
                  { label: 'Copiar ID de sesión', onClick: () => api.writeClipboard(selected.id) },
                  { label: 'Copiar comando de resume', onClick: () => api.writeClipboard(`claude --resume ${selected.id}`) },
                  { label: 'Cerrar sesión', onClick: () => close(selected.id), danger: true }
                ]}
              />
            </header>
          ) : (
            <header className="card-header">
              <span className="grip">⠿</span>
              <h2>Sesión</h2>
            </header>
          )}
          {selected && (
            <div className="tabbar">
              <button className={`tab ${(tabs[selected.id] ?? 'claude') === 'claude' ? 'on' : ''}`} onClick={() => showTab(selected.id, 'claude')}>
                Claude
              </button>
              <button className={`tab ${tabs[selected.id] === 'shell' ? 'on' : ''}`} onClick={() => showTab(selected.id, 'shell')} title="Ctrl+` alterna">
                Terminal
              </button>
              <span style={{ flex: 1 }} />
              {selFolder && (
                <Kebab
                  title="Comandos guardados de la carpeta"
                  label="▶ Comandos"
                  items={[
                    ...(selFolder.commands ?? []).map((c) => ({
                      label: c.name ? `${c.name}  ·  ${c.command}` : c.command,
                      onClick: () => runCommand(selected.id, c.command)
                    })),
                    { label: 'Editar comandos de la carpeta…', onClick: () => setCommandsFor(selFolder) }
                  ]}
                />
              )}
            </div>
          )}
          <div className="terminals">
            {sessions.map((s) => (
              <TerminalView key={s.id} id={s.id} visible={s.id === selectedId && (tabs[s.id] ?? 'claude') === 'claude'} />
            ))}
            {sessions
              .filter((s) => shellOpen.has(s.id))
              .map((s) => (
                <TerminalView key={'shell:' + s.id} id={'shell:' + s.id} visible={s.id === selectedId && tabs[s.id] === 'shell'} />
              ))}
            {!selected && (
              <div className="placeholder">
                <p>No hay ninguna sesión seleccionada.</p>
                <button className="primary" onClick={() => setFolderEdit(null)}>
                  <span className="plus">+</span> Crear una carpeta de cliente
                </button>
              </div>
            )}
          </div>
        </main>
        {rightOpen ? (
          <Resizer
            onDrag={(dx) =>
              setRightW((w) => {
                const v = clamp(w - dx)
                saveWidth('rightW', v)
                return v
              })
            }
          />
        ) : (
          <div />
        )}
        {rightOpen ? (
          <ArtifactsPanel session={selected} onCollapse={() => setRightOpen(false)} />
        ) : (
          <Rail side="right" label="Artefactos" onOpen={() => setRightOpen(true)} />
        )}
      </div>
      {showImport && <ImportDialog onImport={importSession} onCancel={() => setShowImport(false)} />}
      {newIn !== undefined && (
        <NewSessionDialog folder={newIn ?? undefined} onCreate={create} onCancel={() => setNewIn(undefined)} />
      )}
      {commandsFor && <CommandsDialog folder={commandsFor} onSaved={refresh} onClose={() => setCommandsFor(null)} />}
      {envFor && <EnvDialog {...envFor} onClose={() => setEnvFor(null)} />}
      {folderEdit !== undefined && (
        <FolderDialog
          folder={folderEdit ?? undefined}
          usedColors={folders.map((f) => f.color)}
          onSave={saveFolder}
          onDelete={
            folderEdit
              ? async () => {
                  await api.deleteFolder(folderEdit.id)
                  setFolderEdit(undefined)
                  await refresh()
                }
              : undefined
          }
          onCancel={() => setFolderEdit(undefined)}
        />
      )}
    </div>
  )
}
