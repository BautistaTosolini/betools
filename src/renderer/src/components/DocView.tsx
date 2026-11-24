import { useEffect, useState } from 'react'
import { Markdown } from './Markdown'
import { useZoom } from '../zoom'

const api = window.clawhip

const errMsg = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)

const short = (p: string) => p.replace(/^\/home\/[^/]+/, '~')

// Ruta absoluta de un link relativo dentro del documento (sin query ni ancla).
function resolveLink(href: string, docPath: string): string | null {
  if (!href || href.startsWith('#') || /^[a-z]+:/i.test(href)) return null
  try {
    const base = 'file://' + docPath.slice(0, docPath.lastIndexOf('/') + 1)
    return decodeURIComponent(new URL(href, base).pathname)
  } catch {
    return null
  }
}

// Visor de un .md abierto como pestaña. Se actualiza solo cuando el archivo cambia.
export function DocView({ path, cwd, visible, onOpenDoc }: { path: string; cwd: string; visible: boolean; onOpenDoc(path: string): void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updated, setUpdated] = useState<number | null>(null)
  const zoom = useZoom('chat')

  useEffect(() => {
    let alive = true
    api.readDoc(path).then(
      (d) => alive && (setText(d.text), setUpdated(d.mtime)),
      (e) => alive && setError(errMsg(e))
    )
    api.watchDoc(path)
    const off = api.onDocChanged((p, d) => {
      if (p !== path) return
      if (d) {
        setText(d.text)
        setUpdated(d.mtime)
        setError(null)
      } else setError('The file was deleted or can no longer be read.')
    })
    return () => {
      alive = false
      off()
      api.unwatchDoc(path)
    }
  }, [path])

  // Links: http(s) al navegador; otro .md, como pestaña nueva; el resto, con la app del sistema.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^(https?:|mailto:)/i.test(href)) return void api.openExternal(href)
    const target = resolveLink(href, path)
    if (!target) return
    if (/\.(md|markdown|mdx)$/i.test(target)) onOpenDoc(target)
    else api.openArtifact(target).catch((err) => setError(errMsg(err)))
  }

  if (!visible) return null
  const rel = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : short(path)
  return (
    <div className="doc-wrap">
      <div className="doc-bar">
        <span className="doc-path" title={path}>
          {rel}
        </span>
        {updated && (
          <span className="doc-updated">
            updated {new Date(updated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn-sm ghost" onClick={() => api.writeClipboard(path)}>
          Copy path
        </button>
        <button className="btn-sm ghost" onClick={() => api.revealArtifact(path)}>
          Show in folder
        </button>
        <button className="btn-sm" onClick={() => api.openArtifact(path).catch((err) => setError(errMsg(err)))}>
          Open externally
        </button>
      </div>
      <div className="doc-scroll" onClick={onClick}>
        {error && <p className="error small doc-error">{error}</p>}
        {text === null && !error && <p className="muted pad">Loading…</p>}
        {text !== null && (
          <article className="doc" style={{ zoom }}>
            <Markdown text={text} />
          </article>
        )}
      </div>
    </div>
  )
}
