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

export function EnvDialog({ title, scope, sessionId, onClose }: Props) {
  const [inherited, setInherited] = useState<{ label: string; vars: EnvVarMeta[] } | undefined>()
  const [dirty, setDirty] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    window.clawhip.envLayers(sessionId).then((layers) => {
      const folder = layers.find((l) => l.scope.kind === 'folder')
      setInherited(folder ? { label: folder.label, vars: folder.vars } : undefined)
    })
    window.clawhip.isRunning(sessionId).then(setRunning)
  }, [sessionId])

  const restart = async () => {
    if (!sessionId) return
    if (!window.confirm('¿Reiniciar la sesión para aplicar las variables?\n\nSe retoma la conversación con --resume; si Claude estaba trabajando, esa tarea se corta.')) return
    await window.clawhip.restartSession(sessionId)
    setDirty(false)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{title}</h2>
        <p className="muted small">
          Se pasan como variables de entorno al proceso de Claude. Los valores nunca se muestran: solo se pueden reemplazar o
          borrar. Claude recibe la instrucción de usarlas solo por nombre y se le bloquean los comandos que vuelcan el entorno
          (env, printenv…), pero eso no impide que un comando puntual las imprima.
        </p>
        <EnvEditor scope={scope} inherited={inherited} onChange={() => setDirty(true)} />
        {dirty && (sessionId ? running : true) && (
          <div className="env-apply">
            {sessionId
              ? 'La sesión está abierta: toma los cambios al reiniciarla.'
              : 'Las sesiones abiertas de esta carpeta toman los cambios al reiniciarlas (⋮ de la sesión → Reiniciar).'}
            {sessionId && (
              <button className="primary" onClick={restart}>
                Reiniciar sesión
              </button>
            )}
          </div>
        )}
        <div className="actions">
          <button onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  )
}
