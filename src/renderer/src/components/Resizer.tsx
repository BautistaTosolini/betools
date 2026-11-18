interface Props {
  onDrag(deltaX: number): void
}

// Barra vertical arrastrable entre paneles.
export function Resizer({ onDrag }: Props) {
  const start = (e: React.MouseEvent) => {
    e.preventDefault()
    let last = e.clientX
    const move = (ev: MouseEvent) => {
      onDrag(ev.clientX - last)
      last = ev.clientX
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className="resizer" onMouseDown={start} />
}
