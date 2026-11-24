import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'

const OPTIONS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'autostart', label: 'Open at login', hint: 'Starts hidden in the tray' },
  { key: 'closeToTray', label: 'Close to tray', hint: 'The X hides the window; sessions keep running' },
  { key: 'notifications', label: 'Notifications', hint: 'When a session finishes or asks for permission' },
  { key: 'eagerStart', label: 'Start all on launch', hint: 'Otherwise each one starts when selected' }
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
        <div className="menu-title">Settings</div>
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
          Shortcuts: Ctrl+1..9 go to session · Ctrl+Tab next · Ctrl+Shift+N new · Ctrl+Shift+C/V copy/paste · Ctrl+Enter newline
        </p>
      </div>
    </>
  )
}
