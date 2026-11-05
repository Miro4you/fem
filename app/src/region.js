// Wirkbereiche (Kreis, Rechteck, Wellenabschnitt) – gleiche Felder wie `Region` im Rechenkern.

export const add = (a, b) => a.map((v, k) => v + b[k])
export const sub = (a, b) => a.map((v, k) => v - b[k])
export const scale = (a, s) => a.map((v) => v * s)
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const norm = (a) => Math.hypot(a[0], a[1], a[2])
export const unit = (a) => scale(a, 1 / (norm(a) || 1))

export const SHAPES = {
  circle: 'Kreis',
  rect: 'Rechteck',
  band: 'Wellen-/Bohrungsabschnitt',
}

/// Ebenenbasis: n (Normale), u (möglichst entlang uHint), v = n × u
export function planeBasis(normal, uHint) {
  const n = unit(normal)
  let u = uHint ? sub(uHint, scale(n, dot(uHint, n))) : [0, 0, 0]
  if (norm(u) < 1e-6) {
    // Koordinatenachse, die am wenigsten parallel zur Normale ist
    const k = [0, 1, 2].reduce((best, i) => (Math.abs(n[i]) < Math.abs(n[best]) ? i : best), 0)
    const e = [0, 0, 0]
    e[k] = 1
    u = sub(e, scale(n, dot(e, n)))
  }
  u = unit(u)
  return { n, u, v: cross(n, u) }
}

// gezeichnete Maße auf 0,1 mm (Richtungen auf 6 Stellen)
const round = (x) => Math.round(x * 10) / 10 || 0
const roundDir = (a) => a.map((v) => (Math.abs(v) < 1e-9 ? 0 : Number(v.toPrecision(6))))
const roundVec = (a) => a.map(round)

/// Lage auf einer Zylinderfläche: axial s (ab origin) und Winkel φ in Grad (ab reference)
export function cylCoords(cyl, p) {
  const a = unit(cyl.axis)
  const d = sub(p, cyl.origin)
  const s = dot(d, a)
  const e1 = unit(sub(cyl.reference, scale(a, dot(cyl.reference, a))))
  const e2 = cross(a, e1)
  const r = sub(d, scale(a, s))
  return { s, phi: (Math.atan2(dot(r, e2), dot(r, e1)) * 180) / Math.PI }
}

/// Bereich aus einem Mausziehen von p0 nach p1 (beide im Raum, auf der Fläche bzw. ihrer Ebene)
export function regionFromDrag(shape, { p0, p1, normal, right }, cyl) {
  if (shape === 'circle') {
    const { n } = planeBasis(normal)
    const d = sub(p1, p0)
    const r = norm(sub(d, scale(n, dot(d, n))))
    return { shape, center: roundVec(p0), normal: roundDir(n), radius: Math.max(round(r), 0.1) }
  }
  if (shape === 'rect') {
    const { n, u, v } = planeBasis(normal, right)
    const d = sub(p1, p0)
    const center = add(p0, scale(d, 0.5))
    return {
      shape, center: roundVec(center), normal: roundDir(n), u: roundDir(u),
      width: Math.max(round(Math.abs(dot(d, u))), 0.1), height: Math.max(round(Math.abs(dot(d, v))), 0.1),
    }
  }
  // Wellenabschnitt: axial von–bis; Umfang nur, wenn deutlich quer gezogen wurde
  const a = cylCoords(cyl, p0)
  const b = cylCoords(cyl, p1)
  let dphi = ((b.phi - a.phi + 540) % 360) - 180
  const full = Math.abs(dphi) < 20
  const [from, to] = full ? [0, 360] : dphi > 0 ? [a.phi, a.phi + dphi] : [a.phi + dphi, a.phi]
  return {
    shape: 'band', origin: roundDir(cyl.origin), axis: roundDir(cyl.axis), reference: roundDir(cyl.reference),
    start: round(Math.max(0, Math.min(a.s, b.s))), end: round(Math.min(cyl.length, Math.max(a.s, b.s))),
    angle_from: Math.round(from), angle_to: Math.round(to),
  }
}

/// Mittelpunkt des Bereichs (für Lastpfeile); bei Wellen auf der Mantelfläche
export function regionAnchor(region, cyl) {
  if (region.shape !== 'band') return region.center
  const a = unit(region.axis)
  const s = (Number(region.start) + Number(region.end)) / 2
  const mid = ((Number(region.angle_from) + Number(region.angle_to)) / 2) * (Math.PI / 180)
  const e1 = unit(sub(region.reference, scale(a, dot(region.reference, a))))
  const e2 = cross(a, e1)
  const full = Math.abs(region.angle_to - region.angle_from) >= 360
  const r = full ? 0 : cyl?.radius ?? 0
  return add(add(region.origin, scale(a, s)), add(scale(e1, r * Math.cos(mid)), scale(e2, r * Math.sin(mid))))
}

/// erste Zylinderfläche einer Auswahl
export function selectionCylinder(surfaces, surfaceInfo) {
  for (const t of surfaces) {
    const c = surfaceInfo.get(t)?.cylinder
    if (c) return c
  }
  return null
}

/// Bereich mit Zahlen statt Texteingaben (für den Rechenkern)
export function regionNumbers(r) {
  if (!r) return null
  const out = {}
  for (const [k, v] of Object.entries(r)) out[k] = Array.isArray(v) ? v.map(Number) : k === 'shape' ? v : Number(v)
  return out
}

/// Bezugsrichtung als Text („+x“), falls sie eine Koordinatenachse ist
export function axisName(v) {
  const k = [0, 1, 2].find((i) => Math.abs(Math.abs(v[i]) - 1) < 1e-6)
  return k == null ? null : (v[k] > 0 ? '+' : '−') + 'xyz'[k]
}

/// Raster für die Darstellung des Bereichs im Viewport: Punkte P(i, j), i < nu, j < nv
export function regionGrid(region, cyl, offset) {
  if (region.shape === 'circle') {
    const { n, u, v } = planeBasis(region.normal)
    const c = add(region.center, scale(n, offset))
    const r = Number(region.radius)
    return {
      nu: 2, nv: 65, closed: true,
      P: (i, j) => {
        const t = (j / 64) * 2 * Math.PI
        return add(c, add(scale(u, i * r * Math.cos(t)), scale(v, i * r * Math.sin(t))))
      },
    }
  }
  if (region.shape === 'rect') {
    const { n, u, v } = planeBasis(region.normal, region.u)
    const c = add(region.center, scale(n, offset))
    const w = Number(region.width) / 2
    const h = Number(region.height) / 2
    return {
      nu: 2, nv: 5, closed: true,
      // „Kreis“ mit 4 Ecken, damit Füllung und Umriss gleich gebaut werden
      P: (i, j) => {
        const [su, sv] = [[1, 1], [-1, 1], [-1, -1], [1, -1], [1, 1]][j]
        return add(c, add(scale(u, i * su * w), scale(v, i * sv * h)))
      },
    }
  }
  const a = unit(region.axis)
  const e1 = unit(sub(region.reference, scale(a, dot(region.reference, a))))
  const e2 = cross(a, e1)
  const r = (cyl?.radius ?? 1) + (cyl?.hole ? -offset : offset)
  let [f, t] = [Number(region.angle_from), Number(region.angle_to)]
  const full = Math.abs(t - f) >= 360
  if (full) [f, t] = [0, 360]
  const nv = Math.max(4, Math.ceil(Math.abs(t - f) / 5) + 1)
  return {
    nu: 2, nv, closed: full, band: true,
    P: (i, j) => {
      const s = i === 0 ? Number(region.start) : Number(region.end)
      const phi = ((f + ((t - f) * j) / (nv - 1)) * Math.PI) / 180
      return add(add(region.origin, scale(a, s)), add(scale(e1, r * Math.cos(phi)), scale(e2, r * Math.sin(phi))))
    },
  }
}

/// Netzverfeinerung für einen Wirkbereich (Gmsh-Feld): im Bereich etwa ein Viertel seiner Größe
export function regionRefine(region, cyl, h) {
  const clamp = (v) => Math.max(h / 10, Math.min(h, v))
  if (region.shape === 'circle') {
    const r = Number(region.radius)
    return { type: 'ball', center: region.center.map(Number), radius: 1.4 * r, size: clamp(r / 3) }
  }
  if (region.shape === 'rect') {
    const w = Number(region.width)
    const hh = Number(region.height)
    const size = clamp(Math.min(w, hh) / 4)
    const { n, u, v } = planeBasis(region.normal.map(Number), region.u?.map(Number))
    const c = region.center.map(Number)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const a of [-0.6, 0.6]) for (const b of [-0.6, 0.6]) for (const t of [-2, 2]) {
      const p = add(add(c, scale(u, a * w)), add(scale(v, b * hh), scale(n, t * size)))
      for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], p[k])), (hi[k] = Math.max(hi[k], p[k]))
    }
    return { type: 'box', min: lo, max: hi, size }
  }
  // Wellen-/Bohrungsabschnitt
  const a = unit(region.axis.map(Number))
  const s0 = Number(region.start)
  const s1 = Number(region.end)
  const R = cyl?.radius ?? h
  const len = Math.abs(s1 - s0)
  const size = clamp(Math.min(len / 4, (2 * Math.PI * R) / 24))
  return {
    type: 'cylinder', center: add(region.origin.map(Number), scale(a, Math.min(s0, s1) - size)), axis: scale(a, len + 2 * size),
    radius: R + 2 * size, size,
  }
}
