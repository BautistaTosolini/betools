import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface KebabItem {
  label: string
  onClick(): void
  danger?: boolean
}

// Menú ⋮ de las tarjetas. Si recibe `children`, muestra ese contenido en vez de una lista.
export function Kebab({
  items,
  children,
  title = 'More actions',
  label
}: {
  items?: KebabItem[]
  children?: ReactNode
  title?: string
  // Si viene, el botón muestra este texto en vez de ⋮.
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="kebab" ref={ref}>
      <button className={label ? 'btn-sm' : 'icon-btn kebab-btn'} title={title} onClick={() => setOpen((v) => !v)}>
        {label ?? '⋮'}
      </button>
      {open && (
        <div className="menu">
          {children ??
            items?.map((it) => (
              <button
                key={it.label}
                className={`menu-item ${it.danger ? 'danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                {it.label}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
