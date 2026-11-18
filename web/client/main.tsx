import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '../../src/renderer/src/styles.css'
import './web.css'
import { createWsApi } from './ws-api'

// La API tiene que existir antes de cargar los componentes (algunos la leen al importarse).
;(window as any).clawhip = createWsApi()
const { WebApp } = await import('./WebApp')
createRoot(document.getElementById('root')!).render(<WebApp />)
