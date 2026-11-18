import { useCallback, useEffect, useState } from 'react'
import type { DiscoveredSession, Session, SessionStatus } from '../../src/shared/types'
import { TerminalView } from '../../src/renderer/src/components/TerminalView'
import { ImportDialog } from '../../src/renderer/src/components/ImportDialog'
import { EnvDialog } from '../../src/renderer/src/components/EnvDialog'
import { Kebab } from '../../src/renderer/src/components/Kebab'
import { STATUS_LABEL } from '../../src/renderer/src/components/Sidebar'
import { NewSessionWeb } from './NewSessionWeb'

const api = (window as any).clawhip
const short = (p: string, home: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p)

export function WebApp() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, SessionStatus>>({})
  const [home, setHome] = useState('')
  const [tabs, setTabs] = useState<Record<string, 'claude' | 'shell'>>({})
  const [shellOpen, setShellOpen] = useState<Set<string>>(new Set())
  const [showNew, setShowNew] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [envFor, setEnvFor] = useState<Session | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [connected, setConnected] = useState(true)
  // En pantallas angostas el selector es un panel que se abre y cierra.
  const [listOpen, setListOpen] = useState(false)

  const refresh = useCallback(async () => {
    const st = await api.listSessions()
    setSessions(st.sessions)
    setSelectedId((cur: string | null) => (cur && st.sessions.some((s: Session) => s.id === cur) ? cur : st.selectedId))
    setStatus(st.status)
  }, [])

  useEffect(() => {
    refresh()
    api.homeDir().then(setHome)
    const offs = [
      api.onStatus((id: string, st: SessionStatus) => setStatus((p) => ({ ...p, [id]: st }))),
      api.onSessionsChanged(() => refresh()),
      api.onConnection((s: string) => setConnected(s === 'open'))
    ]
    return () => offs.forEach((o: () => void) => o())
  }, [refresh])

  const select = (id: string) => {
    setSelectedId(id)
    setListOpen(false)
    api.selectSession(id)
  }
  const showTab = (id: string, tab: 'claude' | 'shell') => {
    setTabs((t) => ({ ...t, [id]: tab }))
    if (tab === 'shell') setShellOpen((s) => (s.has(id) ? s : new Set(s).add(id)))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && e.key === '`' && selectedId) {
        e.preventDefault()
        e.stopPropagation()
        showTab(selectedId, (tabs[selectedId] ?? 'claude') === 'claude' ? 'shell' : 'claude')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectedId, tabs])

  const close = async (s: Session) => {
    if (!window.confirm(`¿Cerrar la sesión "${s.name}"?\n\nSe termina el proceso y sale de la lista. El historial de Claude no se borra.`)) return
    await api.closeSession(s.id)
    await refresh()
  }
  const commitRename = async (id: string) => {
    setEditing(null)
    if (draft.trim()) {
      await api.renameSession(id, draft)
      await refresh()
    }
  }
  const importSession = async (d: DiscoveredSession) => {
    const name = d.title.length > 60 ? d.title.slice(0, 60) + '…' : d.title
    const s = await api.importSession(d.id, d.cwd, name)
    setShowImport(false)
    await refresh()
    select(s.id)
  }

  const selected = sessions.find((s) => s.id === selectedId)
  const waiting = sessions.filter((s) => status[s.id] === 'waiting').length

  return (
    <div className="app web">
      <header className="page-header">
        <button className="icon-btn menu-toggle" onClick={() => setListOpen((v) => !v)} title="Sesiones">
          ☰
        </button>
        <h1>clawhip</h1>
        <span className="page-sub">
          {sessions.length} sesiones{waiting > 0 && <> · <span className="txt-waiting">{waiting} esperan tu respuesta</span></>}
          {!connected && <> · <span className="txt-waiting">reconectando…</span></>}
        </span>
        <div className="page-actions">
          <button onClick={() => setShowImport(true)}>Importar</button>
          <button className="primary" onClick={() => setShowNew(true)}>
            <span className="plus">+</span> Nueva sesión
          </button>
        </div>
      </header>

      <div className="layout web-layout">
        <aside className={`card sidebar ${listOpen ? 'open' : ''}`}>
          <header className="card-header">
            <span className="grip">⠿</span>
            <h2>Sesiones</h2>
          </header>
          <ul className="session-list web-list">
            {sessions.map((s) => {
              const st = status[s.id] ?? 'stopped'
              return (
                <li
                  key={s.id}
                  className={`session ${s.id === selectedId ? 'selected' : ''}`}
                  style={{ ['--fc' as string]: '#d97757' }}
                  onClick={() => select(s.id)}
                  onDoubleClick={() => {
                    setEditing(s.id)
                    setDraft(s.name)
                  }}
                  title={`${s.cwd}\nDoble clic para renombrar`}
                >
                  <div className="session-top">
                    <span className={`status ${st}`}>
                      <span className={`dot ${st}`}>{st === 'waiting' ? '!' : ''}</span>
                      {STATUS_LABEL[st]}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button
                      className="icon-btn close"
                      title="Cerrar sesión"
                      onClick={(e) => {
                        e.stopPropagation()
                        close(s)
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {editing === s.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(s.id)
                        if (e.key === 'Escape') setEditing(null)
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <p className="summary">{s.name}</p>
                  )}
                  <span className="session-cwd">{short(s.cwd, home)}</span>
                </li>
              )
            })}
            {sessions.length === 0 && (
              <li className="empty">
                No hay sesiones. Crea una con <b>Nueva sesión</b> o trae una existente con <b>Importar</b>.
              </li>
            )}
          </ul>
        </aside>
        {listOpen && <div className="sidebar-backdrop" onClick={() => setListOpen(false)} />}

        <main className="card center" style={{ ['--fc' as string]: '#d97757' }}>
          {selected ? (
            <header className="card-header center-header">
              <span className="grip">⠿</span>
              <div className="center-title">
                <h2 className="center-summary">{selected.name}</h2>
                <div className="center-meta">
                  <span>{short(selected.cwd, home)}</span>
                </div>
              </div>
              <Kebab
                items={[
                  { label: 'Variables de entorno…', onClick: () => setEnvFor(selected) },
                  {
                    label: 'Reiniciar sesión',
                    onClick: () => {
                      if (window.confirm('¿Reiniciar la sesión?\n\nSe retoma con --resume; si Claude estaba trabajando, esa tarea se corta.'))
                        api.restartSession(selected.id)
                    }
                  },
                  { label: 'Copiar comando de resume', onClick: () => api.writeClipboard(`claude --resume ${selected.id}`) },
                  { label: 'Cerrar sesión', onClick: () => close(selected), danger: true }
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
                <button className="primary" onClick={() => setShowNew(true)}>
                  <span className="plus">+</span> Nueva sesión
                </button>
              </div>
            )}
          </div>
        </main>
      </div>

      {showNew && (
        <NewSessionWeb
          home={home}
          onCreate={async (cwd, name) => {
            const s = await api.createSession(cwd, name)
            setShowNew(false)
            await refresh()
            select(s.id)
          }}
          onCancel={() => setShowNew(false)}
        />
      )}
      {showImport && <ImportDialog onImport={importSession} onCancel={() => setShowImport(false)} />}
      {envFor && (
        <EnvDialog title={`Variables de ${envFor.name}`} scope={{ kind: 'session', id: envFor.id }} sessionId={envFor.id} onClose={() => setEnvFor(null)} />
      )}
    </div>
  )
}
