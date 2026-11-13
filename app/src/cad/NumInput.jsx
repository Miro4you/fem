import { useEffect, useRef } from 'react'
import { num, fmtField } from './features.js'

/// Zahlenfeld: Mausrad/Pfeiltasten ±1 (Umschalt ±0,1, Strg ±10), Rechnungen wie 10+5 werden beim Verlassen ausgerechnet
export default function NumInput({ value, onChange, disabled, title, min = null, step = 1, className, autoFocus, onBlur, onEscape }) {
  const ref = useRef(null)
  const cb = useRef({})
  cb.current = { value, onChange, min, step }
  const bump = (dir, e) => {
    const { value: v, onChange: set, min: lo, step: st } = cb.current
    const cur = num(v)
    if (!Number.isFinite(cur)) return
    const k = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey || e.altKey ? 10 : 1
    let n = Math.round((cur + dir * st * k) * 1e6) / 1e6
    if (lo != null) n = Math.max(lo, n)
    set(fmtField(n))
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Mausrad nur im gewählten Feld (sonst würde Blättern in der Seitenleiste Werte ändern)
    const wheel = (e) => {
      if (document.activeElement !== el || el.disabled) return
      e.preventDefault()
      bump(e.deltaY < 0 ? 1 : -1, e)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const settle = () => {
    const v = String(value ?? '')
    if (/[-+*/()×÷−]/.test(v.replace(/^-/, '')) && Number.isFinite(num(v))) onChange(fmtField(num(v)))
  }
  return (
    <input
      ref={ref}
      className={className}
      value={value}
      title={title ?? 'Mausrad oder ↑/↓: ±1 (Umschalt ±0,1, Strg ±10) · Rechnen geht auch, z. B. 10+5'}
      disabled={disabled}
      inputMode="decimal"
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.target.select()}
      autoFocus={autoFocus}
      onBlur={() => {
        settle()
        onBlur?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          bump(e.key === 'ArrowUp' ? 1 : -1, e)
        } else if (e.key === 'Enter') settle()
        else if (e.key === 'Escape') onEscape?.()
      }}
    />
  )
}
