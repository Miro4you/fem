// Geometrie anpassen: Änderungen anlegen, für den Rechenkern aufbereiten, Flächen nach einer Änderung wiederfinden.
import { dot, sub, unit, scale, norm, cross } from './region.js'

export const GEO_OPS = {
  fillet: 'Radius ändern',
  hole: 'Bohrung ändern',
  add: 'Material hinzufügen',
  cut: 'Material entfernen',
}

let nextGeoId = 1
export const geoId = () => nextGeoId++

// zwei Zylinder auf derselben Achse mit gleichem Radius (z. B. Bohrung aus zwei Halbflächen)
function coaxial(a, b) {
  if (Math.abs(a.radius - b.radius) > 1e-3 * Math.max(a.radius, 1)) return false
  const ax = unit(a.axis)
  if (Math.abs(Math.abs(dot(ax, unit(b.axis))) - 1) > 1e-6) return false
  const d = sub(b.origin, a.origin)
  return norm(sub(d, scale(ax, dot(d, ax)))) < 1e-3 * Math.max(a.radius, 1)
}

/// Aus einer angeklickten Zylinderfläche: Bohrung (voller Umfang, Material außen) oder Radius
export function opFromSurface(tag, surfaceInfo) {
  const info = surfaceInfo.get(tag)
  const c = info?.cylinder
  if (!c) return { error: 'Bitte eine Radius- oder Bohrungsfläche anklicken (zylindrische Fläche).' }
  const parts = [...surfaceInfo.values()].filter((s) => s.cylinder && coaxial(c, s.cylinder))
  const area = parts.reduce((a, s) => a + s.area, 0)
  const full = Math.abs(area - 2 * Math.PI * c.radius * c.length) < 0.03 * area
  const centers = parts.map((s) => s.center)
  const r = Number(c.radius.toFixed(2))
  if (full && c.hole) {
    return { id: geoId(), op: 'hole', enabled: true, surfaces: centers, tags: parts.map((s) => s.tag), axis: c.axis, origin: c.origin, diameter: String(2 * r), was: 2 * r }
  }
  return { id: geoId(), op: 'fillet', enabled: true, surfaces: centers, tags: parts.map((s) => s.tag), axis: c.axis, radius: String(r), was: r, convex: !c.hole }
}

export const newSketchOp = (op, shape) => ({ id: geoId(), op, shape, enabled: true, sketch: null, height: '5', depth: '5', through: true })

const num = (v) => (Array.isArray(v) ? v.map(Number) : Number(v))

/// Änderung für den Rechenkern (nur Zahlen, nur benötigte Felder)
export function opPayload(o) {
  if (o.op === 'fillet') return { op: 'fillet', surfaces: o.surfaces, axis: o.axis, radius: num(o.radius) }
  if (o.op === 'hole') return { op: 'hole', surfaces: o.surfaces, axis: o.axis, origin: o.origin, diameter: num(o.diameter) }
  const sk = Object.fromEntries(Object.entries(o.sketch).map(([k, v]) => [k, k === 'shape' ? v : num(v)]))
  if (o.op === 'add') return { op: 'add', sketch: sk, height: num(o.height) }
  return { op: 'cut', sketch: sk, depth: o.through ? null : num(o.depth) }
}

/// Fehlende Angaben einer Änderung (leer = in Ordnung)
export function opProblem(o) {
  if ((o.op === 'add' || o.op === 'cut') && !o.sketch) return 'Skizze auf eine Fläche zeichnen'
  const bad = (v) => !(Number(v) >= 0) || v === ''
  if (o.op === 'fillet' && bad(o.radius)) return 'Radius angeben'
  if (o.op === 'hole' && bad(o.diameter)) return 'Durchmesser angeben'
  if (o.op === 'add' && !(Number(o.height) > 0)) return 'Höhe > 0 angeben'
  if (o.op === 'cut' && !o.through && !(Number(o.depth) > 0)) return 'Tiefe > 0 angeben'
  return null
}

// gleiche Flächenart: Ebene mit gleicher Normale bzw. Zylinder mit gleichem Radius und paralleler Achse
function sameKind(a, b) {
  if (a.normal && b.normal) return dot(a.normal, b.normal) > 0.999
  if (a.cylinder && b.cylinder) {
    const ra = a.cylinder.radius
    const rb = b.cylinder.radius
    return Math.abs(ra - rb) <= 0.01 * Math.max(ra, rb) && Math.abs(dot(unit(a.cylinder.axis), unit(b.cylinder.axis))) > 0.999
  }
  return !a.normal && !a.cylinder && !b.normal && !b.cylinder
}

/// Flächen nach einer Geometrieänderung wiederfinden: gleiche Art (Ebene mit gleicher Normale bzw.
/// Zylinder mit gleichem Radius), nächster Schwerpunkt. Ergebnis: alte Nummer → neue Nummer oder null.
export function remapSurfaces(oldSurfs, newSurfs) {
  const map = new Map()
  for (const a of oldSurfs) {
    let best = null
    let bestD = Infinity
    for (const b of newSurfs) {
      if (!sameKind(a, b)) continue
      const d = norm(sub(b.center, a.center))
      if (d < bestD) (best = b), (bestD = d)
    }
    map.set(a.tag, best && bestD < Math.max(0.5, 0.3 * Math.sqrt(a.area)) ? best.tag : null)
  }
  return map
}

/// Drehachse beschreiben („um z“)
export function axisLabel(a) {
  const k = [0, 1, 2].find((i) => Math.abs(Math.abs(a[i]) - 1) < 1e-6)
  return k == null ? 'schräg' : 'xyz'[k]
}

export { cross }
