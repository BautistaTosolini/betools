import { Kebab } from './Kebab'
import { stepZoom, useZoom, type ZoomKind } from '../zoom'

const pct = (v: number) => `${Math.round(v * 100)}%`

function Row({ kind, label, keys }: { kind: ZoomKind; label: string; keys: string }) {
  const v = useZoom(kind)
  return (
    <div className="zoom-row">
      <span className="zoom-label">
        {label}
        <small>{keys}</small>
      </span>
      <button className="key" onClick={() => stepZoom(kind, -1)} title="Zoom out">−</button>
      <button className="key zoom-val" onClick={() => stepZoom(kind, 0)} title="Reset to 100%">{pct(v)}</button>
      <button className="key" onClick={() => stepZoom(kind, 1)} title="Zoom in">+</button>
    </div>
  )
}

// Indicador en la barra de título: muestra el zoom si no es 100 % y abre los controles.
export function ZoomControl() {
  const app = useZoom('app')
  const chat = useZoom('chat')
  const changed = app !== 1 || chat !== 1
  return (
    <Kebab title="Zoom" label={changed ? `${pct(app)}${chat !== 1 ? ` · chat ${pct(chat)}` : ''}` : 'Zoom'}>
      <div className="zoom-menu">
        <div className="menu-title">Zoom</div>
        <Row kind="app" label="Whole window" keys="Ctrl + / − / 0" />
        <Row kind="chat" label="Chat only" keys="Ctrl+Shift + / − / 0 · Ctrl+wheel on chat" />
      </div>
    </Kebab>
  )
}
