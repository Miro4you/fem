// Eingabehilfen beim Skizzieren (wie in Draftpad): Rasten von Länge und Winkel, Maßanzeige am Zeiger,
// eingetippte Werte. Alles in Skizzenkoordinaten (mm, y nach oben).
import { num } from './features.js'

const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]

/// Rastschritt für Längen: der kleinste „glatte“ Wert, der mindestens ~6 Bildpunkte lang ist
export function lengthStep(mmPerPx) {
  const want = mmPerPx * 6
  return NICE.find((s) => s >= want) ?? 1000
}

const fmt = (v) => String(Math.round(v * 1000) / 1000).replace('.', ',')
const deg = (r) => (r * 180) / Math.PI

/// Punkt vom Anker aus so legen, dass Winkel (5°-Schritte, waagrecht/senkrecht bevorzugt) und Länge rasten.
/// → { at, hv: 'h' | 'v' | null }
export function snapFrom(anchor, q, { step, angleStep = 5, free = false, hvTol = 4 }) {
  const dx = q[0] - anchor[0]
  const dy = q[1] - anchor[1]
  const L = Math.hypot(dx, dy)
  if (L < 1e-9) return { at: q, hv: null }
  let a = Math.atan2(dy, dx)
  const ad = deg(a)
  // waagrecht/senkrecht in ±hvTol° (wird später zur Bedingung)
  const near = (target) => Math.abs(((ad - target + 540) % 360) - 180) <= hvTol
  let hv = null
  if (near(0) || near(180)) hv = 'h'
  else if (near(90) || near(-90)) hv = 'v'
  if (free) {
    if (hv === 'h') return { at: [q[0], anchor[1]], hv }
    if (hv === 'v') return { at: [anchor[0], q[1]], hv }
    return { at: q, hv: null }
  }
  if (hv === 'h') a = Math.abs(ad) < 90 ? 0 : Math.PI
  else if (hv === 'v') a = ad > 0 ? Math.PI / 2 : -Math.PI / 2
  else a = (Math.round(ad / angleStep) * angleStep * Math.PI) / 180
  const len = step > 0 ? Math.max(step, Math.round(L / step) * step) : L
  return { at: [anchor[0] + len * Math.cos(a), anchor[1] + len * Math.sin(a)], hv }
}

/// Rechteck: Breite und Höhe rasten
export function snapRect(a, q, { step, free = false }) {
  if (free || !(step > 0)) return q
  const r = (v) => Math.sign(v) * Math.max(step, Math.round(Math.abs(v) / step) * step)
  return [a[0] + r(q[0] - a[0]), a[1] + r(q[1] - a[1])]
}

/// Rechteck aus der Mitte: ganze Breite und Höhe rasten
export function snapRectCenter(m, q, { step, free = false }) {
  if (free || !(step > 0)) return q
  const r = (v) => (Math.sign(v) || 1) * (Math.max(step, Math.round((2 * Math.abs(v)) / step) * step) / 2)
  return [m[0] + r(q[0] - m[0]), m[1] + r(q[1] - m[1])]
}

/// Vieleck: Schlüsselweite (gerade Eckenzahl) bzw. Umkreis-Ø glatt, Drehung in 15°-Schritten
export function snapPolygon(c, q, { step, free = false, n = 6 }) {
  const dx = q[0] - c[0]
  const dy = q[1] - c[1]
  const R = Math.hypot(dx, dy)
  if (free || !(step > 0) || R < 1e-9) return q
  const k = n % 2 === 0 ? 2 * Math.cos(Math.PI / n) : 2
  const size = Math.max(step, Math.round((R * k) / step) * step)
  const a = (Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) / 15) * 15 * Math.PI) / 180
  return [c[0] + (size / k) * Math.cos(a), c[1] + (size / k) * Math.sin(a)]
}

/// Langloch: Breite aus dem Abstand des Zeigers zur Mittellinie (glatt)
export function slotWidth(a, b, q, { step, free = false }) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = Math.hypot(dx, dy) || 1
  const d = Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / L
  const w = 2 * d
  if (free || !(step > 0)) return Math.max(w, 1e-6)
  return Math.max(step, Math.round(w / step) * step)
}

/// Kreis/Bogen: Radius rasten (Durchmesser glatt), Richtung bleibt
export function snapRadius(c, q, { step, free = false }) {
  const dx = q[0] - c[0]
  const dy = q[1] - c[1]
  const r = Math.hypot(dx, dy)
  if (free || !(step > 0) || r < 1e-9) return q
  const d2 = Math.max(step, Math.round((2 * r) / step) * step) / 2
  return [c[0] + (dx / r) * d2, c[1] + (dy / r) * d2]
}

/// Text der Maßanzeige am Zeiger
export function measureText(tool, pts, opts = {}) {
  const n = pts.length
  if ((tool === 'line' && n >= 2) || (tool === 'slot' && n === 2)) {
    const [a, b] = pts.slice(-2)
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    let ang = deg(Math.atan2(b[1] - a[1], b[0] - a[0]))
    if (ang < 0) ang += 360
    return `${fmt(L)} mm · ${fmt(Math.round(ang * 10) / 10)}°`
  }
  if (tool === 'rect' && n === 2) return `${fmt(Math.abs(pts[1][0] - pts[0][0]))} × ${fmt(Math.abs(pts[1][1] - pts[0][1]))} mm`
  if (tool === 'crect' && n === 2) return `${fmt(2 * Math.abs(pts[1][0] - pts[0][0]))} × ${fmt(2 * Math.abs(pts[1][1] - pts[0][1]))} mm`
  if (tool === 'slot' && n === 3) return `Breite ${fmt(opts.width ?? 0)} mm`
  if (tool === 'poly' && n === 2) {
    const k = opts.n ?? 6
    const R = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
    return k % 2 === 0 ? `${k}-Eck · SW ${fmt(2 * R * Math.cos(Math.PI / k))} mm` : `${k}-Eck · Ø ${fmt(2 * R)} mm`
  }
  if (tool === 'sfillet') return opts.radius ? `R ${fmt(opts.radius)} mm` : 'Ecke anklicken'
  if (tool === 'circle' && n === 2) return `Ø ${fmt(2 * Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]))} mm`
  if (tool === 'arc' && n >= 2) {
    const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
    if (n === 2) return `R ${fmt(r)} mm`
    let sw = deg(Math.atan2(pts[2][1] - pts[0][1], pts[2][0] - pts[0][0]) - Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]))
    while (sw <= 0) sw += 360
    return `R ${fmt(r)} mm · ${fmt(Math.round(sw * 10) / 10)}°`
  }
  return null
}

/// Was beim Eintippen erwartet wird (Hinweis im Eingabefeld)
export const TYPE_HINT = {
  line: 'Länge (oder Länge@Winkel), Enter',
  rect: 'Breite x Höhe, Enter',
  crect: 'Breite x Höhe, Enter',
  circle: 'Durchmesser, Enter',
  arc: 'Radius, Enter',
  slot: 'Mittenabstand (oder Länge@Winkel) bzw. Breite, Enter',
  poly: 'Schlüsselweite (ungerade Eckenzahl: Umkreis-Ø), Enter',
  sfillet: 'Radius, Enter – dann Ecken anklicken',
}

/// Eingetippten Text lesen: Linie „50“ oder „50@30“, Rechteck „60x40“ / „60 40“ / „60;40“, Kreis „20“
export function parseTyped(tool, text, nPts = 1) {
  const t = String(text ?? '').trim()
  if (!t) return null
  if (tool === 'slot') return parseTyped(nPts >= 2 ? 'circle' : 'line', t)
  if (tool === 'crect') return parseTyped('rect', t)
  if (tool === 'poly' || tool === 'sfillet') return parseTyped('circle', t)
  if (tool === 'line') {
    const [l, a] = t.split('@')
    const L = num(l)
    if (!(L > 0)) return null
    const A = a != null && a.trim() !== '' ? num(a) : null
    return { length: L, angle: Number.isFinite(A) ? A : null }
  }
  if (tool === 'rect') {
    const parts = t.split(/\s*(?:x|×|;|\s)\s*/i).filter(Boolean)
    const w = num(parts[0])
    const h = parts.length > 1 ? num(parts[1]) : null
    if (!(w > 0) || (h != null && !(h > 0))) return null
    return { w, h }
  }
  if (tool === 'circle' || tool === 'arc') {
    const v = num(t.replace(/^(Ø|R)\s*/i, ''))
    return v > 0 ? { value: v } : null
  }
  return null
}
