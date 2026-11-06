import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

// Aufklappmenü in der Kopfleiste; schließt bei Klick daneben oder Esc
export function Menu({ label, title, align = 'left', className = 'btn ghost', children, disabled }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const off = (e) => !box.current?.contains(e.target) && setOpen(false)
    const esc = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', off)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', off)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="menu-box" ref={box}>
      <button className={className} title={title} disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className={'menu ' + align} role="menu" onClick={(e) => e.target.closest('[data-close]') && setOpen(false)}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  )
}

/// Menüeintrag: schließt das Menü nach dem Klick
export function MenuItem({ onClick, disabled, children, hint, sub }) {
  return (
    <button className="mi" role="menuitem" data-close disabled={disabled} onClick={onClick}>
      <span>
        {children}
        {sub && <small>{sub}</small>}
      </span>
      {hint && <em>{hint}</em>}
    </button>
  )
}

export const MenuSep = () => <div className="sep" />
