import { useEffect, useRef, useState } from 'react'
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

// Edición: solo en la versión Rust (window.clawhip.writeDoc). En Electron el visor queda de solo lectura.
const CAN_EDIT = typeof api.writeDoc === 'function'

// Borrador en edición de cada archivo. Vive fuera del componente: al cambiar de sesión las pestañas se desmontan
// y lo escrito sin guardar no se pierde. base = mtime de la versión sobre la que se edita (null = pisar al guardar).
interface Draft {
  text: string
  base: number | null
}
const drafts = new Map<string, Draft>()

// Visor de un .md abierto como pestaña. Se actualiza solo cuando el archivo cambia. En la versión Rust se puede
// editar con la vista previa al lado; al guardar no se pisa un cambio hecho en disco mientras tanto (p. ej. Claude).
export function DocView({ path, cwd, visible, onOpenDoc }: { path: string; cwd: string; visible: boolean; onOpenDoc(path: string): void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updated, setUpdated] = useState<number | null>(null)
  const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(path) ?? null)
  // El archivo cambió en disco mientras había cambios sin guardar.
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const zoom = useZoom('chat')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<string | null>(null)
  textRef.current = text
  const draftRef = useRef(draft)
  draftRef.current = draft

  const setDraft = (d: Draft | null) => {
    if (d) drafts.set(path, d)
    else drafts.delete(path)
    draftRef.current = d
    setDraftState(d)
  }
  const dirty = !!draft && draft.text !== text

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
        const cur = draftRef.current
        if (cur) {
          // Sin cambios propios, el borrador sigue al archivo. Con cambios, se avisa (salvo que sea el mismo texto,
          // como el eco de un guardado propio).
          if (cur.text === textRef.current || cur.text === d.text) setDraft({ text: d.text, base: d.mtime })
          else if (cur.base !== null) setConflict(true)
        }
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

  const startEdit = () => {
    if (text === null) return
    setDraft({ text, base: updated })
    setConflict(false)
    requestAnimationFrame(() => editorRef.current?.focus())
  }

  const save = async () => {
    const d = draftRef.current
    if (!d || !api.writeDoc || saving) return
    setSaving(true)
    try {
      const r = await api.writeDoc(path, d.text, d.base)
      setText(r.text)
      setUpdated(r.mtime)
      setError(null)
      setConflict(false)
      // Lo escrito mientras se guardaba queda como cambio pendiente sobre la versión nueva.
      setDraft({ text: draftRef.current?.text ?? r.text, base: r.mtime })
    } catch (e) {
      const m = errMsg(e)
      if (m.startsWith('CONFLICT:')) setConflict(true)
      else setError(m)
    } finally {
      setSaving(false)
    }
  }

  const done = () => {
    if (dirty && !window.confirm('Discard the unsaved changes to this file?')) return
    setDraft(null)
    setConflict(false)
  }

  // Conflicto: quedarse con la versión del disco (se pierde lo propio) o con la propia (el próximo guardado pisa).
  const takeDisk = () => {
    if (text !== null) setDraft({ text, base: updated })
    setConflict(false)
  }
  const keepMine = () => {
    const d = draftRef.current
    if (d) setDraft({ text: d.text, base: null })
    setConflict(false)
  }

  // Ctrl+S guarda; Tab inserta dos espacios en vez de sacar el foco del editor.
  const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
      return
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: a, selectionEnd: b, value } = el
      const next = value.slice(0, a) + '  ' + value.slice(b)
      setDraft({ text: next, base: draftRef.current?.base ?? null })
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
    }
  }

  // La vista previa sigue el scroll del editor, en proporción.
  const syncScroll = () => {
    const ed = editorRef.current
    const pv = previewRef.current
    if (!ed || !pv) return
    const max = ed.scrollHeight - ed.clientHeight
    pv.scrollTop = max > 0 ? (ed.scrollTop / max) * (pv.scrollHeight - pv.clientHeight) : 0
  }

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
        {draft && <span className={`doc-state ${dirty ? 'dirty' : ''}`}>{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>}
        <span style={{ flex: 1 }} />
        {CAN_EDIT && draft && (
          <>
            <button className="btn-sm primary" disabled={!dirty || saving} onClick={() => void save()} title="Save (Ctrl+S)">
              Save
            </button>
            <button className="btn-sm" onClick={done}>
              Done
            </button>
          </>
        )}
        {CAN_EDIT && !draft && (
          <button className="btn-sm" disabled={text === null} onClick={startEdit} title="Edit with live preview">
            Edit
          </button>
        )}
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
      {conflict && (
        <div className="doc-conflict" role="alert">
          <span>The file changed on disk while you were editing.</span>
          <span style={{ flex: 1 }} />
          <button className="btn-sm" onClick={takeDisk}>
            Load the disk version
          </button>
          <button className="btn-sm" onClick={keepMine}>
            Keep mine (overwrite on save)
          </button>
        </div>
      )}
      <div className={draft ? 'doc-split' : 'doc-body'}>
        {draft && (
          <textarea
            ref={editorRef}
            className="doc-editor"
            spellCheck={false}
            value={draft.text}
            onChange={(e) => setDraft({ text: e.target.value, base: draftRef.current?.base ?? null })}
            onKeyDown={onEditorKey}
            onScroll={syncScroll}
            aria-label="Markdown source"
          />
        )}
        <div className="doc-scroll" ref={previewRef} onClick={onClick}>
          {error && <p className="error small doc-error">{error}</p>}
          {text === null && !error && <p className="muted pad">Loading…</p>}
          {text !== null && (
            <article className="doc" style={{ zoom }}>
              <Markdown text={draft ? draft.text : text} />
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
