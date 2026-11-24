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
import { UsageBar } from './components/UsageBar'
import { ConversationView } from './components/ConversationView'
import { ZoomControl } from './components/ZoomControl'
import { stepZoom, zoomKeyDir } from './zoom'
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
type Tab = 'rendered' | 'shell' | 'claude'
const TAB_ORDER: Tab[] = ['rendered', 'shell', 'claude']
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
  // Pestaña por defecto: Rendered. Orden: Rendered → Terminal → CLI.
  const [tabs, setTabs] = useState<Record<string, Tab>>({})
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [shellOpen, setShellOpen] = useState<Set<string>>(new Set())
  const [commandsFor, setCommandsFor] = useState<Folder | null>(null)
  const tabOf = (id: string): Tab => tabs[id] ?? 'rendered'
  const showTab = (id: string, tab: Tab) => {
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
    api.pendingRestarts().then((ids) => setPending(new Set(ids)))
    const offPending = api.onPendingRestart((id, on) =>
      setPending((prev) => {
        const next = new Set(prev)
        if (on) next.add(id)
        else next.delete(id)
        return next
      })
    )
    return () => {
      offPending()
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
      // Zoom: Ctrl +/−/0 toda la ventana; con Shift, solo el chat.
      const dir = zoomKeyDir(e)
      if (dir !== null) {
        e.preventDefault()
        e.stopPropagation()
        stepZoom(e.shiftKey ? 'chat' : 'app', dir)
        return
      }
      if (!e.ctrlKey || e.altKey) return
      if (e.key === '`' && selectedId) {
        e.preventDefault()
        e.stopPropagation()
        const i = TAB_ORDER.indexOf(tabOf(selectedId))
        showTab(selectedId, TAB_ORDER[(i + (e.shiftKey ? TAB_ORDER.length - 1 : 1)) % TAB_ORDER.length])
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

  // Ctrl+rueda: sobre la columna central, zoom del chat; en el resto, de toda la ventana.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return
      e.preventDefault()
      e.stopPropagation()
      const inChat = (e.target as HTMLElement | null)?.closest?.('.terminals')
      stepZoom(inChat ? 'chat' : 'app', e.deltaY < 0 ? 1 : -1)
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

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
      `Close the session "${titles[id] ?? s.name}"?\n\nThe process stops and the session leaves the list. Claude's history is not deleted; you can resume it with claude --resume ${s.id}.`
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
        <div className="brand">
          <span className="brand-mark" />
          <h1>betools</h1>
        </div>
        {workingCount > 0 && <span className="pill working">{workingCount} working</span>}
        {waitingCount > 0 && <span className="pill waiting">{waitingCount} need input</span>}
        {/* Centrada sobre la columna de la terminal (mismos anchos que la grilla, +1 px del separador); con mínimos
            para no pisar el nombre ni los botones cuando un panel está cerrado o angosto. */}
        <div className="usage-slot" style={{ left: Math.max((leftOpen ? leftW : RAIL_W) + 1, 200), right: Math.max((rightOpen ? rightW : RAIL_W) + 1, 250) }}>
          <UsageBar sessionId={selectedId} />
        </div>
        <div className="page-actions">
          <ZoomControl />
          <button className="ghost" onClick={() => setShowImport(true)}>Import session</button>
          <button className="ghost" onClick={() => setFolderEdit(null)}>
            <span className="plus">+</span> New folder
          </button>
        </div>
      </header>

      <div className="layout" style={{
          gridTemplateColumns: `${leftOpen ? leftW : RAIL_W}px 1px minmax(0, 1fr) 1px ${rightOpen ? rightW : RAIL_W}px`
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
            onFolderEnv={(f) => setEnvFor({ title: `Variables for folder ${f.name}`, scope: { kind: 'folder', id: f.id } })}
            onDeleteFolder={async (f) => {
              if (!window.confirm(`Delete the folder "${f.name}"?\n\nIts sessions stay open and move to "No folder".`)) return
              await api.deleteFolder(f.id)
              if (focusId === f.id) setFocusId(null)
              await refresh()
            }}
          />
        ) : (
          <Rail
            side="left"
            label={focused ? focused.name : 'Sessions'}
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
                    <span className="ticket">
                      {selTitle.ticket}
                    </span>
                  )}
                  <h2 className="center-summary">{selTitle.summary ?? selected.name}</h2>
                </div>
                <div className="center-meta">
                  {selFolder && <span className="folder-tag">{selFolder.name}</span>}
                  <span>{selected.cwd.replace(/^\/home\/[^/]+/, '~')}</span>
                  {pending.has(selected.id) && (
                    <span className="txt-waiting" title="Environment variables changed while Claude was busy">
                      ⟳ restarts when Claude finishes
                    </span>
                  )}
                </div>
              </div>
              <Kebab
                items={[
                  {
                    label: 'Environment variables…',
                    onClick: () =>
                      setEnvFor({
                        title: `Variables for ${selTitle.ticket ?? selTitle.summary ?? selected.name}`,
                        scope: { kind: 'session', id: selected.id },
                        sessionId: selected.id
                      })
                  },
                  {
                    label: 'Restart session',
                    onClick: () => {
                      if (window.confirm('Restart the session?\n\nIt resumes with --resume; if Claude was working, that task is interrupted.'))
                        api.restartSession(selected.id)
                    }
                  },
                  { label: 'Open working directory', onClick: () => api.openArtifact(selected.cwd) },
                  { label: 'Copy session ID', onClick: () => api.writeClipboard(selected.id) },
                  { label: 'Copy resume command', onClick: () => api.writeClipboard(`claude --resume ${selected.id}`) },
                  { label: 'Close session', onClick: () => close(selected.id), danger: true }
                ]}
              />
            </header>
          ) : (
            <header className="card-header">
              <span className="grip">⠿</span>
              <h2>Session</h2>
            </header>
          )}
          {selected && (
            <div className="tabbar">
              {TAB_ORDER.map((t) => (
                <button key={t} className={`tab ${tabOf(selected.id) === t ? 'on' : ''}`} onClick={() => showTab(selected.id, t)} title="Ctrl+` cycles tabs">
                  {t === 'rendered' ? 'Rendered' : t === 'shell' ? 'Terminal' : 'CLI'}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              {selFolder && (
                <Kebab
                  title="Saved folder commands"
                  label="▶ Commands"
                  items={[
                    ...(selFolder.commands ?? []).map((c) => ({
                      label: c.name ? `${c.name}  ·  ${c.command}` : c.command,
                      onClick: () => runCommand(selected.id, c.command)
                    })),
                    { label: 'Edit folder commands…', onClick: () => setCommandsFor(selFolder) }
                  ]}
                />
              )}
            </div>
          )}
          <div className="terminals">
            {sessions.map((s) => (
              <TerminalView key={s.id} id={s.id} visible={s.id === selectedId && tabOf(s.id) === 'claude'} active={s.id === selectedId} />
            ))}
            {sessions
              .filter((s) => shellOpen.has(s.id))
              .map((s) => (
                <TerminalView key={'shell:' + s.id} id={'shell:' + s.id} visible={s.id === selectedId && tabOf(s.id) === 'shell'} />
              ))}
            {selected && (
              <ConversationView
                key={selected.id}
                id={selected.id}
                active
                visible={tabOf(selected.id) === 'rendered'}
                status={status[selected.id] ?? 'stopped'}
                onReply={() => showTab(selected.id, 'claude')}
              />
            )}
            {!selected && (
              <div className="placeholder">
                <p>No session selected.</p>
                <button className="primary" onClick={() => setFolderEdit(null)}>
                  <span className="plus">+</span> Create a client folder
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
          <Rail side="right" label="Artifacts" onOpen={() => setRightOpen(true)} />
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
