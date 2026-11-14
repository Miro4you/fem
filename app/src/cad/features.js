// Features der Konstruktion: Bezeichnungen, Vorgaben, Umwandlung für den Kern.
import { kernelSketch, newSketch, STD_PLANES, addPoint, addEnt, addCon, basis, to2d, to3d, v3 } from './sketch.js'

export const FEATURE_LABEL = {
  sketch: 'Skizze',
  extrude: 'Extrudieren',
  revolve: 'Drehen',
  hole: 'Bohrung',
  fillet: 'Verrunden',
  chamfer: 'Fase',
  pattern: 'Muster',
  mirror: 'Spiegeln',
  removefaces: 'Flächen entfernen',
  moveface: 'Fläche verschieben',
  shell: 'Schale',
  boolean: 'Boolesch',
  movebody: 'Körper verschieben',
  import: 'Teil einfügen',
  align: 'Ausrichten',
  rib: 'Rippe',
  draft: 'Formschräge',
  stdpart: 'Normteil',
  split: 'Teilen',
  sweep: 'Sweep',
  loft: 'Loft',
  refillet: 'Radius ändern',
  rehole: 'Bohrung ändern',
}

// Durchgangsbohrungen nach DIN EN 20273 (mittel) und Senkungen für Zylinderkopf (ISO 4762) / Senkkopf (ISO 10642)
// Durchgangslöcher nach ISO 273 (fein / mittel / grob), Kernloch für Gewinde (Regelgewinde, ISO 2306),
// Senkungen für Zylinderschrauben (DIN 974-1, ISO 4762) und Senkschrauben (ISO 15065, 90°)
/// Gewindegrößen der Normteile (Schraube, Mutter, Scheibe)
export const STD_PART_SIZES = ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16', 'M20']

export const HOLE_SIZES = [
  { name: 'M2', d: 2.4, fine: 2.2, coarse: 2.6, tap: 1.6, cb: 4.4, cbT: 2.2, cs: 4.4 },
  { name: 'M2,5', d: 2.9, fine: 2.7, coarse: 3.1, tap: 2.05, cb: 5.5, cbT: 2.7, cs: 5.5 },
  { name: 'M3', d: 3.4, fine: 3.2, coarse: 3.6, tap: 2.5, cb: 6.5, cbT: 3.3, cs: 6.9 },
  { name: 'M4', d: 4.5, fine: 4.3, coarse: 4.8, tap: 3.3, cb: 8, cbT: 4.4, cs: 9.2 },
  { name: 'M5', d: 5.5, fine: 5.3, coarse: 5.8, tap: 4.2, cb: 10, cbT: 5.4, cs: 11.5 },
  { name: 'M6', d: 6.6, fine: 6.4, coarse: 7, tap: 5, cb: 11, cbT: 6.4, cs: 13.7 },
  { name: 'M8', d: 9, fine: 8.4, coarse: 10, tap: 6.8, cb: 15, cbT: 8.6, cs: 18.3 },
  { name: 'M10', d: 11, fine: 10.5, coarse: 12, tap: 8.5, cb: 18, cbT: 10.6, cs: 22.7 },
  { name: 'M12', d: 13.5, fine: 13, coarse: 14.5, tap: 10.2, cb: 20, cbT: 12.6, cs: 27.2 },
  { name: 'M16', d: 17.5, fine: 17, coarse: 18.5, tap: 14, cb: 26, cbT: 16.6, cs: 34.5 },
  { name: 'M20', d: 22, fine: 21, coarse: 24, tap: 17.5, cb: 33, cbT: 20.6, cs: 41.5 },
  { name: 'M24', d: 26, fine: 25, coarse: 28, tap: 21, cb: 40, cbT: 24.6, cs: 0 },
]

/// Bohrungsdurchmesser zur Norm-Größe: Durchgang (fein/mittel/grob) oder Gewinde-Kernloch
export function holeDiameter(h, kind = 'clear', fit = 'medium') {
  if (!h) return null
  if (kind === 'tap') return h.tap
  return fit === 'fine' ? h.fine : fit === 'coarse' ? h.coarse : h.d
}

/// Zahl aus einem Eingabefeld; auch einfache Rechnungen wie `10+5`, `2*12`, `(40-8)/2` (Komma oder Punkt)
export const num = (v) => {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim().replace(/,/g, '.')
  const n = Number(s)
  if (s !== '' && Number.isFinite(n)) return n
  const r = evalExpr(s)
  return Number.isFinite(r) ? r : NaN
}

/// + − × ÷ und Klammern, sonst nichts (kein eval)
export function evalExpr(s) {
  const t = s.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
  let i = 0
  const peek = () => t[i]
  const number = () => {
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(t.slice(i))
    if (!m) throw new Error('Zahl erwartet')
    i += m[0].length
    return Number(m[0])
  }
  const factor = () => {
    if (peek() === '-') {
      i++
      return -factor()
    }
    if (peek() === '+') {
      i++
      return factor()
    }
    if (peek() === '(') {
      i++
      const v = expr()
      if (peek() !== ')') throw new Error(') fehlt')
      i++
      return v
    }
    return number()
  }
  const term = () => {
    let v = factor()
    while (peek() === '*' || peek() === '/') v = t[i++] === '*' ? v * factor() : v / factor()
    return v
  }
  const expr = () => {
    let v = term()
    while (peek() === '+' || peek() === '-') v = t[i++] === '+' ? v + term() : v - term()
    return v
  }
  try {
    if (!t) return NaN
    const v = expr()
    return i === t.length ? v : NaN
  } catch {
    return NaN
  }
}

/// Zahl für ein Eingabefeld (deutsches Komma, ohne überflüssige Stellen)
export const fmtField = (v) => String(Math.round(v * 1e6) / 1e6).replace('.', ',')

let counter = 1
export const featureId = (features) => {
  const max = Math.max(0, ...features.map((f) => f.id))
  counter = Math.max(counter, max + 1)
  return counter++
}

/// Name mit laufender Nummer (Skizze 1, Extrudieren 2 …)
export function featureName(features, type) {
  const base = FEATURE_LABEL[type]
  let k = 1
  while (features.some((f) => f.name === `${base} ${k}`)) k++
  return `${base} ${k}`
}

export function defaults(type) {
  switch (type) {
    case 'sketch':
      return { sketch: newSketch(STD_PLANES.XY, { std: 'XY' }) }
    case 'extrude':
      return { sketch: null, regions: null, useFills: true, mode: 'add', depth: '10', flip: false, symmetric: false, through: false }
    case 'revolve':
      return { sketch: null, regions: null, useFills: true, axis: null, angle: '360', mode: 'add', symmetric: false }
    case 'hole':
      return { sketch: null, size: 'M6', diameter: '6.6', through: true, depth: '10', tip: true, flip: false, sink: { kind: 'none', d: '11', depth: '6.4', angle: '90' } }
    case 'fillet':
      return { edges: [], radius: '2' }
    case 'chamfer':
      return { edges: [], distance: '1' }
    case 'pattern':
      return { kind: 'linear', features: [], dir: { axis: 'X' }, flip: false, count: '3', spacing: '20', two: false, dir2: { axis: 'Y' }, flip2: false, count2: '2', spacing2: '20', axis: { axis: 'Z' }, angle: '360' }
    case 'mirror':
      return { features: [], plane: { std: 'YZ' } }
    case 'removefaces':
      return { faces: [] }
    case 'moveface':
      return { faces: [], distance: '2' }
    case 'shell':
      return { faces: [], thickness: '2' }
    case 'boolean':
      return { op: 'union', targets: [], tools: [], keepTools: false }
    case 'align':
      return { moving: null, target: null, offset: '0' }
    case 'rib':
      return { sketch: null, thickness: '3' }
    case 'draft':
      return { faces: [], plane: { std: 'XY' }, angle: '3', flip: false }
    case 'stdpart':
      return { kind: 'bolt', size: 'M8', length: '30' }
    case 'split':
      return { plane: { std: 'YZ' }, keep: 'front' }
    case 'movebody':
      return { body: null, dx: '0', dy: '0', dz: '0', axis: 'z', angle: '0', copy: false }
    case 'sweep':
      return { sketch: null, path: null, mode: 'add' }
    case 'loft':
      return { sketches: [], mode: 'add', ruled: false }
    default:
      return {}
  }
}

const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }

/// Richtung aus einer Auswahl: Hauptachse, gerade Kante, ebene Fläche (Normale) oder Zylinder (Achse)
export function dirOf(ref) {
  if (!ref) return null
  if (ref.axis) return AXES[ref.axis]
  if (ref.edge) return ref.edge.dir
  if (ref.face?.normal) return ref.face.normal
  if (ref.face?.axis) return ref.face.axis
  return null
}

/// Drehachse aus einer Auswahl: Hauptachse durch den Ursprung, Kreiskante oder Zylinderfläche
export function axisOf(ref) {
  if (!ref) return null
  if (ref.axis) return { point: [0, 0, 0], dir: AXES[ref.axis] }
  if (ref.edge?.center) return { point: ref.edge.center, dir: ref.edge.axis }
  if (ref.edge) return { point: ref.edge.mid, dir: ref.edge.dir }
  if (ref.face?.axis) return { point: ref.face.origin, dir: ref.face.axis }
  return null
}

export function planeOf(ref) {
  if (!ref) return null
  if (ref.std) return STD_PLANES[ref.std]
  if (ref.face?.normal) return { origin: ref.face.point ?? ref.face.center, normal: ref.face.normal }
  return null
}

/// Was fehlt noch, bevor das Feature gebaut werden kann? (leer = in Ordnung)
export function problemOf(f, features) {
  const has = (id) => features.some((g) => g.id === id && g.type === 'sketch')
  const pos = (v) => num(v) > 0
  switch (f.type) {
    case 'sketch':
      return f.sketch?.ents.length ? null : 'Skizze ist leer'
    case 'extrude':
      if (!has(f.sketch)) return 'Skizze wählen'
      if (Array.isArray(f.regions) && !f.regions.length) return 'Flächen der Skizze im Bild anklicken'
      return f.through || f.upto || pos(f.depth) ? null : 'Tiefe > 0 angeben'
    case 'revolve':
      if (!has(f.sketch)) return 'Skizze wählen'
      if (Array.isArray(f.regions) && !f.regions.length) return 'Flächen der Skizze im Bild anklicken'
      if (!f.axis) return 'Drehachse wählen (Linie der Skizze)'
      return pos(f.angle) ? null : 'Winkel > 0 angeben'
    case 'hole':
      if (!has(f.sketch)) return 'Skizze mit Bohrpunkten wählen'
      return pos(f.diameter) && (f.through || pos(f.depth)) ? null : 'Durchmesser und Tiefe angeben'
    case 'fillet':
      return !f.edges.length ? 'Kanten im Bild wählen' : pos(f.radius) ? null : 'Radius > 0 angeben'
    case 'chamfer':
      return !f.edges.length ? 'Kanten im Bild wählen' : pos(f.distance) ? null : 'Breite > 0 angeben'
    case 'pattern':
      if (f.features !== 'body' && !f.features.length) return 'Features wählen (oder ganzen Körper)'
      if (!(num(f.count) >= 2)) return 'Anzahl ≥ 2'
      if (f.kind === 'linear') return dirOf(f.dir) && pos(f.spacing) ? null : 'Richtung und Abstand angeben'
      return axisOf(f.axis) && pos(f.angle) ? null : 'Achse und Winkel angeben'
    case 'mirror':
      if (f.features !== 'body' && !f.features.length) return 'Features wählen (oder ganzen Körper)'
      return planeOf(f.plane) ? null : 'Spiegelebene wählen'
    case 'removefaces':
      return f.faces.length ? null : 'Flächen im Bild wählen'
    case 'moveface':
      return !f.faces.length ? 'Ebene Flächen im Bild wählen' : num(f.distance) ? null : 'Abstand angeben'
    case 'sweep':
      if (!f.sketch) return 'Profil-Skizze wählen'
      return f.path && f.path !== f.sketch ? null : 'Pfad-Skizze wählen (eine andere Skizze)'
    case 'loft':
      return (f.sketches ?? []).length >= 2 ? null : 'mindestens zwei Skizzen wählen'
    case 'shell':
      return !f.faces.length ? 'Flächen wählen, die offen bleiben (z. B. Deckel)' : num(f.thickness) > 0 ? null : 'Wandstärke angeben'
    case 'import':
      return f.text ? null : 'STEP-Datei fehlt'
    case 'split':
      return planeOf(f.plane) ? null : 'Ebene wählen'
    case 'stdpart':
      return f.kind !== 'bolt' || pos(f.length) ? null : 'Schraubenlänge angeben'
    case 'draft':
      if (!f.faces.length) return 'Seitenflächen im Bild wählen'
      if (!planeOf(f.plane)) return 'neutrale Ebene wählen'
      return num(f.angle) ? null : 'Winkel angeben'
    case 'rib':
      if (!has(f.sketch)) return 'Skizze mit der Rippenlinie wählen'
      return pos(f.thickness) ? null : 'Dicke > 0 angeben'
    case 'align':
      return f.moving && f.target ? null : !f.moving ? 'Fläche am Körper anklicken, der bewegt wird' : 'Zielfläche am anderen Körper anklicken'
    case 'movebody':
      if (!f.body) return 'Körper im Bild anklicken'
      return num(f.dx) || num(f.dy) || num(f.dz) || num(f.angle) ? null : 'Weg (x, y, z) oder Winkel angeben'
    case 'boolean':
      if (!f.targets?.length) return f.op === 'union' ? 'Körper im Bild anklicken (mindestens zwei)' : 'Zielkörper im Bild anklicken'
      return f.tools?.length ? null : f.op === 'union' ? 'noch einen Körper anklicken' : 'Werkzeugkörper anklicken'
    case 'refillet':
      if (!f.surfaces?.length) return 'Radius- oder Bohrungsfläche im Bild wählen'
      return num(f.radius) >= 0 ? null : 'Radius angeben'
    case 'rehole':
      if (!f.surfaces?.length) return 'Bohrungsfläche im Bild wählen'
      return num(f.diameter) >= 0 ? null : 'Durchmesser angeben'
    default:
      return null
  }
}

// gewählte Kante für den Kern: Mitte, Richtung, Art (Linie/Kreis), Länge bzw. Radius
// --- Bezüge folgen der Skizze ------------------------------------------------------------------------------
// Ein gewählter Bezug (Kante, Fläche) merkt sich beim Bestätigen den Skizzenpunkt, auf den er senkrecht zur
// Skizzenebene fällt: Ecke (senkrechte Kante), Kreismitte (Bohrung, Zapfen), Bohrpunkt oder Linienmitte (Seitenfläche,
// Kante oben/unten). Ändert sich die Skizze, wird der Bezug um die Verschiebung dieses Punkts mitgeführt, bevor der Kern
// ihn sucht – so springt eine Verrundung nicht auf die nächstbeste Kante, wenn ein Maß davor geändert wird.
const ANCHOR_TOL = 1e-3

function anchorPos(sk, a) {
  if (a.p != null) {
    const q = sk.pts?.[a.p]
    return q ? to3d(sk.plane, [q.x, q.y]) : null
  }
  if (a.l) {
    const [p1, p2] = a.l.map((id) => sk.pts?.[id])
    return p1 && p2 ? to3d(sk.plane, [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2]) : null
  }
  return null
}

/// Anker eines Punkts im Raum: Skizzenpunkt oder Linienmitte einer der Skizzen, auf die er senkrecht fällt (spätere Skizze gewinnt)
export function anchorFor(features, p) {
  if (!Array.isArray(p) || p.length !== 3) return null
  let best = null
  for (const f of features) {
    if (f.type !== 'sketch' || f.suppressed || !f.sketch?.plane || !f.sketch.pts) continue
    const sk = f.sketch
    const q = to2d(sk.plane, p)
    const cands = []
    for (const e of sk.ents ?? []) {
      if (e.cons) continue
      if (e.t === 'point') cands.push({ p: e.p })
      else if (e.t === 'line') cands.push({ p: e.a }, { p: e.b }, { l: [e.a, e.b] })
      else if (e.t === 'circle') cands.push({ p: e.c })
      else if (e.t === 'arc') cands.push({ p: e.c }, { p: e.a }, { p: e.b })
    }
    for (const c of cands) {
      const at = anchorPos(sk, c)
      if (!at) continue
      const [x, y] = to2d(sk.plane, at)
      const dist = Math.hypot(x - q[0], y - q[1])
      if (dist < ANCHOR_TOL && (!best || dist <= best.dist)) best = { dist, f, a: { s: f.id, ...c, at } }
    }
  }
  if (!best) return null
  // Höhe innerhalb einer Extrusion dieser Skizze: ändert sich die Tiefe, wandert der Bezug anteilig mit (Deckel ganz)
  const b = basis(best.f.sketch.plane)
  const hz = v3.dot(v3.sub(p, best.a.at), b.n)
  for (const g of features) {
    if (g.type !== 'extrude' || g.sketch !== best.f.id || g.suppressed || g.through || g.upto) continue
    const d = num(g.depth)
    if (!(d > 0)) continue
    const lo = g.symmetric ? -d / 2 : g.flip ? -d : 0
    const hi = g.symmetric ? d / 2 : g.flip ? 0 : d
    if (hz >= lo - ANCHOR_TOL && hz <= hi + ANCHOR_TOL && Math.abs(hz) > ANCHOR_TOL) return { ...best.a, x: g.id, hz, d0: d }
  }
  return best.a
}

// Bezugspunkt einer Kante/Fläche für den Anker: Kreiskante über ihre Mitte, sonst Kantenmitte bzw. Flächenmitte
const refPoint = (r) => (r?.kind === 'circle' && r.center ? r.center : r?.mid ?? r?.center)

/// Bezüge eines Features beim Bestätigen verankern (vorhandene Anker bleiben; false = geprüft, keiner)
export function anchorRefs(f, before) {
  const one = (r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r) || r.anchor != null) return r
    const pt = refPoint(r)
    if (!pt) return r
    return { ...r, anchor: anchorFor(before, pt) ?? false }
  }
  const out = { ...f }
  for (const k of ['edges', 'faces', 'targets', 'tools']) if (Array.isArray(f[k])) out[k] = f[k].map(one)
  for (const k of ['upto', 'at', 'moving', 'target', 'body']) if (f[k] && typeof f[k] === 'object' && !Array.isArray(f[k])) out[k] = one(f[k])
  return out
}

// Lage eines Bezugs mit der Verschiebung seines Ankers seit dem Wählen
function follow(r, key, features) {
  const a = r?.anchor
  const v = r?.[key]
  if (!a || !Array.isArray(v) || !features) return v
  const f = features.find((g) => g.id === a.s && g.type === 'sketch' && !g.suppressed)
  const now = f?.sketch ? anchorPos(f.sketch, a) : null
  if (!now) return v
  let out = v.map((x, i) => x + now[i] - a.at[i])
  if (a.x != null && a.d0 > 0) {
    const g = features.find((h) => h.id === a.x && h.type === 'extrude')
    const d1 = num(g?.depth)
    if (g && !g.through && !g.upto && d1 > 0 && Math.abs(d1 - a.d0) > 1e-12) {
      const n = basis(f.sketch.plane).n
      out = out.map((x, i) => x + n[i] * a.hz * (d1 / a.d0 - 1))
    }
  }
  return out
}

const edgeHint = (x, features) => ({
  mid: follow(x, 'mid', features),
  dir: x.dir,
  kind: x.kind,
  radius: x.radius,
  length: x.length,
  ...(x.kind === 'circle' && x.center ? { center: follow(x, 'center', features), axis: x.axis } : {}),
})

// gewählte Fläche für den Kern: Schwerpunkt und Art (damit sie nach Änderungen davor wiedergefunden wird)
const faceHint = (x, features) => ({ center: follow(x, 'center', features), kind: x.kind, normal: x.normal, axis: x.axis, radius: x.radius, ...(x.kind === 'cylinder' && x.hole != null ? { hole: x.hole } : {}) })

// Auswahl über Schraffuren: eine Gruppe (Teil aus Draftpad) oder alle schraffierten Flächen
const fillsArg = (f) => (f.regions != null ? false : f.fillGroup ? { group: f.fillGroup } : f.useFills !== false)

/// Feature für den Kern (nur Zahlen)
export function kernelFeature(f, features) {
  const sk = (id) => features.find((g) => g.id === id)
  switch (f.type) {
    case 'sketch':
      return kernelSketch(f.id, f.sketch)
    case 'extrude':
      return { id: f.id, type: 'extrude', sketch: f.sketch, regions: f.regions, fills: fillsArg(f), bodyName: f.bodyName || undefined, subtract: f.subtract !== false, mode: f.mode, depth: num(f.depth), dir: f.flip ? -1 : 1, symmetric: !!f.symmetric, through: !!f.through && !f.upto, ...(f.upto ? { upto: faceHint(f.upto, features) } : {}) }
    case 'revolve': {
      const s = sk(f.sketch)?.sketch
      const line = s?.ents.find((e) => e.id === f.axis)
      const axis = line ? { a: [s.pts[line.a].x, s.pts[line.a].y], b: [s.pts[line.b].x, s.pts[line.b].y] } : null
      return { id: f.id, type: 'revolve', sketch: f.sketch, regions: f.regions, fills: fillsArg(f), bodyName: f.bodyName || undefined, subtract: f.subtract !== false, axis, angle: num(f.angle), mode: f.mode, symmetric: !!f.symmetric }
    }
    case 'hole':
      return {
        id: f.id,
        type: 'hole',
        sketch: f.sketch,
        diameter: num(f.diameter),
        through: !!f.through,
        depth: num(f.depth),
        tip: f.tip !== false,
        flip: !!f.flip,
        sink: { kind: f.sink.kind, d: num(f.sink.d), depth: num(f.sink.depth), angle: num(f.sink.angle) },
      }
    case 'fillet':
      return { id: f.id, type: 'fillet', edges: f.edges.map((x) => edgeHint(x, features)), radius: num(f.radius) }
    case 'chamfer':
      return { id: f.id, type: 'chamfer', edges: f.edges.map((x) => edgeHint(x, features)), distance: num(f.distance) }
    case 'pattern': {
      const out = { id: f.id, type: 'pattern', kind: f.kind, features: f.features, count: num(f.count) }
      if (f.kind === 'linear') {
        const d = dirOf(f.dir)
        out.dir = f.flip ? d.map((x) => -x) : d
        out.spacing = num(f.spacing)
        if (f.two && dirOf(f.dir2)) {
          const d2 = dirOf(f.dir2)
          out.dir2 = f.flip2 ? d2.map((x) => -x) : d2
          out.count2 = num(f.count2)
          out.spacing2 = num(f.spacing2)
        }
      } else {
        out.axis = axisOf(f.axis)
        out.angle = num(f.angle)
      }
      return out
    }
    case 'mirror':
      return { id: f.id, type: 'mirror', features: f.features, plane: planeOf(f.plane) }
    case 'removefaces':
      return { id: f.id, type: 'removefaces', faces: f.faces.map((x) => faceHint(x, features)) }
    case 'moveface':
      return { id: f.id, type: 'moveface', faces: f.faces.map((x) => faceHint(x, features)), distance: num(f.distance) }
    case 'sweep':
      return { id: f.id, type: 'sweep', sketch: f.sketch, path: f.path, mode: f.mode, bodyName: f.bodyName || undefined, subtract: f.subtract !== false }
    case 'loft':
      return { id: f.id, type: 'loft', sketches: f.sketches, ruled: !!f.ruled, mode: f.mode, bodyName: f.bodyName || undefined, subtract: f.subtract !== false }
    case 'shell':
      return { id: f.id, type: 'shell', faces: f.faces.map((x) => faceHint(x, features)), thickness: num(f.thickness) }
    case 'split':
      return { id: f.id, type: 'split', plane: planeOf(f.plane), keep: f.keep }
    case 'stdpart':
      return { id: f.id, type: 'stdpart', kind: f.kind, size: f.size, length: num(f.length), name: f.bodyName, at: f.at ? faceHint(f.at, features) : null, otherSide: !!f.otherSide }
    case 'draft':
      return { id: f.id, type: 'draft', faces: f.faces.map((x) => faceHint(x, features)), plane: planeOf(f.plane), angle: num(f.angle), flip: !!f.flip }
    case 'rib':
      return { id: f.id, type: 'rib', sketch: f.sketch, thickness: num(f.thickness) }
    case 'align':
      return { id: f.id, type: 'align', moving: f.moving ? faceHint(f.moving, features) : null, target: f.target ? faceHint(f.target, features) : null, offset: num(f.offset) || 0 }
    case 'import':
      return { id: f.id, type: 'import', key: f.key, name: f.name, text: f.text }
    case 'movebody':
      return { id: f.id, type: 'movebody', body: f.body ? faceHint(f.body, features) : null, d: [num(f.dx) || 0, num(f.dy) || 0, num(f.dz) || 0], axis: f.axis, angle: num(f.angle) || 0, copy: !!f.copy }
    case 'boolean':
      return { id: f.id, type: 'boolean', op: f.op, targets: f.targets.map((x) => faceHint(x, features)), tools: f.tools.map((x) => faceHint(x, features)), keepTools: !!f.keepTools }
    case 'refillet':
      return { id: f.id, type: 'refillet', surfaces: f.surfaces, axis: f.axis, radius: num(f.radius) }
    case 'rehole':
      return { id: f.id, type: 'rehole', surfaces: f.surfaces, axis: f.axis, origin: f.origin, diameter: num(f.diameter) }
    default:
      return null
  }
}

/// Aktive Features (nicht unterdrückt, vollständig) für den Kern; `upto` = Anzahl Features (Liste) davor
export function kernelFeatures(features, upto = features.length) {
  return features
    .slice(0, upto)
    .filter((f) => !f.suppressed && !problemOf(f, features))
    .map((f) => kernelFeature(f, features))
}

/// Zahlenwerte der Features und Skizzenmaße (für Parameterstudien): [{ key, label, value, set(features, v) }]
export function cadParams(features) {
  const out = []
  for (const f of features) {
    if (f.suppressed) continue
    const field = { stdpart: ['length', 'Länge'], draft: ['angle', 'Winkel'], rib: ['thickness', 'Dicke'], movebody: ['angle', 'Winkel'], extrude: ['depth', 'Tiefe'], revolve: ['angle', 'Winkel'], hole: ['diameter', 'Ø'], fillet: ['radius', 'Radius'], chamfer: ['distance', 'Fase'], moveface: ['distance', 'Abstand'], shell: ['thickness', 'Wandstärke'], refillet: ['radius', 'Radius'], rehole: ['diameter', 'Ø'] }[f.type]
    if (field && !(f.type === 'extrude' && f.through)) out.push({ key: `cad:${f.id}:${field[0]}`, label: `${f.name}: ${field[1]}`, unit: f.type === 'revolve' ? '°' : 'mm', value: num(f[field[0]]) })
    if (f.type === 'pattern') out.push({ key: `cad:${f.id}:count`, label: `${f.name}: Anzahl`, unit: '', value: num(f.count) })
    if (f.type === 'sketch')
      for (const c of f.sketch.cons)
        if (c.v != null) out.push({ key: `cad:${f.id}:con:${c.id}`, label: `${f.name}: ${c.name ?? c.id}`, unit: c.t === 'ang' ? '°' : 'mm', value: c.v })
  }
  return out
}

// --- alte Änderungen aus „Geometrie anpassen“ übernehmen ---------------------------------------

/// geoOps (Radius/Bohrung ändern, Material hinzu/weg mit Kreis oder Rechteck) → Features
export function featuresFromGeoOps(ops) {
  const out = []
  let id = 1
  for (const o of ops ?? []) {
    if (!o.enabled) continue
    const n = (v) => num(v)
    if (o.op === 'fillet') out.push({ id: id++, type: 'refillet', name: `Radius ändern ${out.length + 1}`, surfaces: o.surfaces, axis: o.axis, radius: String(o.radius), was: o.was })
    else if (o.op === 'hole') out.push({ id: id++, type: 'rehole', name: `Bohrung ändern ${out.length + 1}`, surfaces: o.surfaces, axis: o.axis, origin: o.origin, diameter: String(o.diameter), was: o.was })
    else if ((o.op === 'add' || o.op === 'cut') && o.sketch) {
      const s = o.sketch
      const center = s.center.map(n)
      const plane = { origin: center, normal: s.normal.map(n), u: s.u?.map(n) }
      const sk = newSketch(plane, { face: { center, normal: plane.normal, point: center } })
      if (s.shape === 'circle') {
        const c = addPoint(sk, [0, 0])
        const e = addEnt(sk, { t: 'circle', c, r: n(s.radius) })
        addCon(sk, { t: 'dia', e: e.id, v: 2 * n(s.radius) })
      } else {
        const w = n(s.width) / 2
        const h = n(s.height) / 2
        const p = [[-w, -h], [w, -h], [w, h], [-w, h]].map((q) => addPoint(sk, q))
        for (let k = 0; k < 4; k++) addEnt(sk, { t: 'line', a: p[k], b: p[(k + 1) % 4] })
      }
      const sid = id++
      out.push({ id: sid, type: 'sketch', name: `Skizze ${sid}`, sketch: sk })
      out.push({
        id: id++,
        type: 'extrude',
        name: o.op === 'add' ? `Material hinzu ${sid}` : `Material weg ${sid}`,
        ...defaults('extrude'),
        sketch: sid,
        mode: o.op,
        depth: String(o.op === 'add' ? o.height : o.depth),
        through: o.op === 'cut' && !!o.through,
        flip: o.op === 'cut',
      })
    }
  }
  return out
}

/// Ebene einer angeklickten ebenen Fläche als Skizzenebene (Ursprung = Fußpunkt des Weltursprungs)
export function planeFromFace(face) {
  const n = face.normal
  const p = face.point ?? face.center
  const d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2]
  const origin = [n[0] * d, n[1] * d, n[2] * d]
  // u: möglichst Welt-x (bzw. y), damit Skizzen „gerade“ liegen
  const cand = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const dot = cand[0] * n[0] + cand[1] * n[1] + cand[2] * n[2]
  const u = [cand[0] - n[0] * dot, cand[1] - n[1] * dot, cand[2] - n[2] * dot]
  return { origin, normal: n, u }
}

export { basis, to2d }
