// Primero: instala window.clawhip en Tauri antes de que App lo lea (en Electron lo pone el preload).
import './tauri-api'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import '@fontsource-variable/inter'
import './styles.css'
import './theme.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
