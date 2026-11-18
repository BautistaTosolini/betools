import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'

const OPTIONS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'autostart', label: 'Abrir al iniciar sesión', hint: 'Arranca oculta en la bandeja' },
  { key: 'closeToTray', label: 'Cerrar a la bandeja', hint: 'La X oculta la ventana; las sesiones siguen' },
  { key: 'notifications', label: 'Notificaciones', hint: 'Cuando una sesión termina o pide permiso' },
  { key: 'eagerStart', label: 'Levantar todas al abrir', hint: 'Si no, cada una arranca al seleccionarla' }
]

export function SettingsMenu() {
  const [s, setS] = useState<Settings | null>(null)

  useEffect(() => {
    window.clawhip.getSettings().then(setS)
  }, [])

  if (!s) return null
  return (
    <>
      <div className="settings">
        <div className="menu-title">Ajustes</div>
        {OPTIONS.map((o) => (
          <label key={o.key} className="check">
            <input
              type="checkbox"
              checked={s[o.key]}
              onChange={async (e) => setS(await window.clawhip.updateSettings({ [o.key]: e.target.checked }))}
            />
            <span>
              {o.label}
              <small>{o.hint}</small>
            </span>
          </label>
        ))}
        <p className="muted small">
          Atajos: Ctrl+1..9 ir a sesión · Ctrl+Tab siguiente · Ctrl+Shift+N nueva · Ctrl+Shift+C/V copiar/pegar
        </p>
      </div>
    </>
  )
}
