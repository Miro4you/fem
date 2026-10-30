import { BANDS, cssBandColor } from '../colormap.js'
import { fmt } from '../format.js'

// Farbskala mit festen Bändern, oben = größter Wert
export default function Legend({ display, quantity }) {
  const { min, max, reverse } = display
  const step = (max - min) / BANDS
  const rows = []
  for (let i = BANDS - 1; i >= 0; i--) {
    const band = reverse ? BANDS - 1 - i : i
    rows.push(
      <div key={i} className="legend-row">
        <span className="legend-swatch" style={{ background: cssBandColor(band) }} />
        <span className="legend-val">{fmt(min + (i + 1) * step)}</span>
      </div>,
    )
  }
  return (
    <div className="legend">
      <div className="legend-title">
        {quantity.label}
        {quantity.unit && <em> [{quantity.unit}]</em>}
      </div>
      {rows}
      <div className="legend-row last">
        <span className="legend-swatch empty" />
        <span className="legend-val">{fmt(min)}</span>
      </div>
      {quantity.unit === '' && max >= 10 && <div className="legend-note">ab 10 abgeschnitten</div>}
    </div>
  )
}
