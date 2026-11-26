import { useEffect, useState } from 'react'
import type { EnvScope, EnvVarMeta } from '../../../shared/types'
import { EnvEditor } from './EnvEditor'

interface Props {
  title: string
  scope: EnvScope
  // Para una sesión: se muestran las variables heredadas de su carpeta y se ofrece reiniciar.
  sessionId?: string
  // Para una carpeta: cuántas sesiones abiertas tiene (para el aviso de reinicio).
  onClose(): void
}

// Escritorio: el proceso principal reinicia solo las sesiones afectadas. Web: reinicio manual.
const AUTO_RESTART = !!(window.clawhip as { autoRestart?: boolean }).autoRestart

export function EnvDialog({ title, scope, sessionId, onClose }: Props) {
  const [inherited, setInherited] = useState<{ scope: EnvScope; label: string; vars: EnvVarMeta[] } | undefined>()
  const [dirty, setDirty] = useState(false)
  const [running, setRunning] = useState(false)
  // Sube con cada cambio: mover una variable cambia también la lista heredada de la carpeta.
  const [rev, setRev] = useState(0)

  useEffect(() => {
    if (!sessionId) return
    window.clawhip.envLayers(sessionId).then((layers) => {
      const folder = layers.find((l) => l.scope.kind === 'folder')
      setInherited(folder ? { scope: folder.scope, label: folder.label, vars: folder.vars } : undefined)
    })
    window.clawhip.isRunning(sessionId).then(setRunning)
  }, [sessionId, rev])

  const restart = async () => {
    if (!sessionId) return
    if (!window.confirm('Restart the session to apply the variables?\n\nThe conversation resumes with --resume; if Claude was working, that task is interrupted.')) return
    await window.clawhip.restartSession(sessionId)
    setDirty(false)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{title}</h2>
        <p className="muted small">
          They are passed to the Claude process as environment variables. Secret values are never shown: you can only replace or
          delete them. Claude is told to use them by name only, and commands that dump the environment (env, printenv…) are
          blocked, but that does not stop a specific command from printing them.
        </p>
        <EnvEditor scope={scope} inherited={inherited} onChange={() => {
            setDirty(true)
            setRev((r) => r + 1)
          }} />
        {dirty && AUTO_RESTART && (
          <div className="env-apply">
            {sessionId
              ? 'The session restarts automatically to apply the change. If Claude is working or waiting for you, it restarts when it finishes.'
              : 'Running sessions in this folder restart automatically. Busy ones (working or waiting for you) restart when Claude finishes.'}
          </div>
        )}
        {dirty && !AUTO_RESTART && (sessionId ? running : true) && (
          <div className="env-apply">
            {sessionId
              ? 'The session is running: it picks up the changes when restarted.'
              : 'Running sessions in this folder pick up the changes when restarted (session ⋮ → Restart).'}
            {sessionId && (
              <button className="primary" onClick={restart}>
                Restart session
              </button>
            )}
          </div>
        )}
        <div className="actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
