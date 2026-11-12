// Skizzen: Datenmodell, Zeichenhilfen, Bedingungen und Maße, Umwandlung für den Kern.
//
// Eine Skizze liegt in einer Ebene { origin, normal, u } (lokale Koordinaten u, v in mm).
// pts: { id: { x, y, fix } }   ents: [{ id, t: line|circle|arc|point, a, b, c, r, cons (Hilfslinie), fix }]
// cons: [{ id, t, … }] – Bedingungen (h, v, co, on, par, perp, eq, tan, mid, sym) und Maße (dist, dx, dy, dpl, rad, dia, ang)
import { solve, DIM_TYPES } from './solver.js'

export const STD_PLANES = {
  XY: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0] },
  XZ: { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0] },
  YZ: { origin: [0, 0, 0], normal: [1, 0, 0], u: [0, 1, 0] },
}

export const CON_LABEL = {
  h: 'Waagrecht',
  v: 'Senkrecht',
  co: 'Deckungsgleich',
  on: 'Punkt auf',
  par: 'Parallel',
  perp: 'Rechtwinklig',
  eq: 'Gleich',
  tan: 'Tangential',
  mid: 'Mittelpunkt',
  sym: 'Symmetrisch',
  dist: 'Abstand',
  dx: 'Abstand waagrecht',
  dy: 'Abstand senkrecht',
  dpl: 'Abstand Punkt–Linie',
  rad: 'Radius',
  dia: 'Durchmesser',
  ang: 'Winkel',
}

// kurze Zeichen an den Elementen
export const CON_GLYPH = { h: '—', v: '|', co: '•', on: '◦', par: '∥', perp: '⊥', eq: '=', tan: 'T', mid: '½', sym: '⇋' }

export const newSketch = (plane, planeRef) => ({ plane, planeRef, pts: {}, ents: [], cons: [], next: 1 })

// --- Vektoren in 3D ---------------------------------------------------------------------------
export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => {
    const n = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / n, a[1] / n, a[2] / n]
  },
}

/// Ebene → Basis (u, v, n) wie im Kern
export function basis(plane) {
  const n = v3.unit(plane.normal)
  let u = plane.u ?? [0, 0, 0]
  u = v3.sub(u, v3.mul(n, v3.dot(u, n)))
  if (v3.norm(u) < 1e-9) {
    const k = [0, 1, 2].reduce((a, i) => (Math.abs(n[i]) < Math.abs(n[a]) ? i : a), 0)
    const e = [0, 0, 0]
    e[k] = 1
    u = v3.sub(e, v3.mul(n, v3.dot(e, n)))
  }
  u = v3.unit(u)
  return { o: plane.origin, u, v: v3.cross(n, u), n }
}

export const to3d = (plane, [x, y]) => {
  const b = basis(plane)
  return v3.add(v3.add(b.o, v3.mul(b.u, x)), v3.mul(b.v, y))
}

export const to2d = (plane, p) => {
  const b = basis(plane)
  const d = v3.sub(p, b.o)
  return [v3.dot(d, b.u), v3.dot(d, b.v)]
}

// --- Elemente anlegen -------------------------------------------------------------------------

const nid = (sk, pre) => `${pre}${sk.next++}`

export function addPoint(sk, [x, y], fix = false, wanted = null) {
  const id = wanted && !sk.pts[wanted] ? wanted : nid(sk, 'p')
  sk.pts[id] = { x, y, fix }
  return id
}

export function addEnt(sk, ent) {
  const e = { id: nid(sk, 'e'), ...ent }
  sk.ents.push(e)
  return e
}

export function addCon(sk, con) {
  const c = { id: nid(sk, 'c'), ...con }
  sk.cons.push(c)
  return c
}

export const P = (sk, id) => [sk.pts[id].x, sk.pts[id].y]

/// Punkte, die zu einem Element gehören
export function entPoints(e) {
  if (e.t === 'line') return [e.a, e.b]
  if (e.t === 'circle') return [e.c]
  if (e.t === 'arc') return [e.c, e.a, e.b]
  return [e.p]
}

export function radiusOf(sk, e) {
  if (e.t === 'circle') return e.r
  if (e.t === 'arc') return Math.hypot(sk.pts[e.a].x - sk.pts[e.c].x, sk.pts[e.a].y - sk.pts[e.c].y)
  return 0
}

/// Abstand eines Punkts von einem Element (2D)
export function distTo(sk, e, [x, y]) {
  if (e.t === 'point') return Math.hypot(x - sk.pts[e.p].x, y - sk.pts[e.p].y)
  if (e.t === 'line') {
    const [ax, ay] = P(sk, e.a)
    const [bx, by] = P(sk, e.b)
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0
    return Math.hypot(x - ax - t * dx, y - ay - t * dy)
  }
  const [cx, cy] = P(sk, e.c)
  const r = radiusOf(sk, e)
  const d = Math.abs(Math.hypot(x - cx, y - cy) - r)
  if (e.t === 'circle') return d
  const [a0, a1] = arcAngles(sk, e)
  let ang = Math.atan2(y - cy, x - cx)
  while (ang < a0) ang += 2 * Math.PI
  if (ang <= a1) return d
  return Math.min(Math.hypot(x - sk.pts[e.a].x, y - sk.pts[e.a].y), Math.hypot(x - sk.pts[e.b].x, y - sk.pts[e.b].y))
}

export function arcAngles(sk, e) {
  const [cx, cy] = P(sk, e.c)
  const a0 = Math.atan2(sk.pts[e.a].y - cy, sk.pts[e.a].x - cx)
  let a1 = Math.atan2(sk.pts[e.b].y - cy, sk.pts[e.b].x - cx)
  while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI
  return [a0, a1]
}

/// Linienzug eines Elements zum Zeichnen (2D-Punkte)
export function polyline(sk, e, n = 64) {
  if (e.t === 'line') return [P(sk, e.a), P(sk, e.b)]
  if (e.t === 'point') return [P(sk, e.p)]
  const [cx, cy] = P(sk, e.c)
  const r = radiusOf(sk, e)
  const [a0, a1] = e.t === 'circle' ? [0, 2 * Math.PI] : arcAngles(sk, e)
  const k = Math.max(8, Math.ceil((n * (a1 - a0)) / (2 * Math.PI)))
  return Array.from({ length: k + 1 }, (_, i) => {
    const t = a0 + ((a1 - a0) * i) / k
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
  })
}

/// Mitte eines Elements (für Zeichen und Maßbeschriftung)
export function midOf(sk, e) {
  if (e.t === 'line') {
    const [ax, ay] = P(sk, e.a)
    const [bx, by] = P(sk, e.b)
    return [(ax + bx) / 2, (ay + by) / 2]
  }
  if (e.t === 'point') return P(sk, e.p)
  const [cx, cy] = P(sk, e.c)
  const r = radiusOf(sk, e)
  if (e.t === 'circle') return [cx + r * Math.SQRT1_2, cy + r * Math.SQRT1_2]
  const [a0, a1] = arcAngles(sk, e)
  const m = (a0 + a1) / 2
  return [cx + r * Math.cos(m), cy + r * Math.sin(m)]
}

// --- Bedingungen ------------------------------------------------------------------------------

/// Löst die Skizze und gibt eine neue zurück (Original bleibt). → { sketch, info }
export function solved(sk, opts) {
  const s = structuredClone(sk)
  const info = solve(s, opts)
  return { sketch: info.ok ? s : sk, info }
}

/// Wert eines Maßes in der aktuellen Skizze messen
export function measure(sk, c) {
  const ent = (id) => sk.ents.find((e) => e.id === id)
  switch (c.t) {
    case 'dist': {
      const [ax, ay] = P(sk, c.a)
      const [bx, by] = P(sk, c.b)
      return Math.hypot(bx - ax, by - ay)
    }
    case 'dx':
      return Math.abs(sk.pts[c.b].x - sk.pts[c.a].x)
    case 'dy':
      return Math.abs(sk.pts[c.b].y - sk.pts[c.a].y)
    case 'dpl': {
      const e = ent(c.e)
      const [ax, ay] = P(sk, e.a)
      const [bx, by] = P(sk, e.b)
      const [px, py] = P(sk, c.p)
      return Math.abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / (Math.hypot(bx - ax, by - ay) || 1)
    }
    case 'rad':
      return radiusOf(sk, ent(c.e))
    case 'dia':
      return 2 * radiusOf(sk, ent(c.e))
    case 'ang': {
      const d = (e) => [sk.pts[e.b].x - sk.pts[e.a].x, sk.pts[e.b].y - sk.pts[e.a].y]
      const [ux, uy] = d(ent(c.e1))
      const [wx, wy] = d(ent(c.e2))
      const f = (c.f1 ?? 1) * (c.f2 ?? 1)
      return Math.abs((Math.atan2(f * (ux * wy - uy * wx), f * (ux * wx + uy * wy)) * 180) / Math.PI)
    }
    default:
      return null
  }
}

export const isDim = (c) => DIM_TYPES.has(c.t)

/// Elemente löschen (mit Punkten, die sonst niemand nutzt, und Bedingungen, die sich darauf beziehen)
export function removeItems(sk, { ents = [], cons = [], pts = [] }) {
  const s = structuredClone(sk)
  const goneE = new Set(ents)
  const goneP = new Set(pts)
  // Punkt löschen = Elemente daran löschen
  for (const e of s.ents) if (entPoints(e).some((p) => goneP.has(p))) goneE.add(e.id)
  s.ents = s.ents.filter((e) => !goneE.has(e.id))
  const used = new Set(s.ents.flatMap(entPoints))
  for (const id of Object.keys(s.pts)) if (!used.has(id)) goneP.add(id)
  for (const id of goneP) delete s.pts[id]
  const goneC = new Set(cons)
  const refs = (c) => ['a', 'b', 'p', 'q'].map((k) => c[k]).filter(Boolean)
  const erefs = (c) => ['e', 'e1', 'e2'].map((k) => c[k]).filter(Boolean)
  s.cons = s.cons.filter((c) => !goneC.has(c.id) && refs(c).every((p) => s.pts[p]) && erefs(c).every((e) => s.ents.some((x) => x.id === e)))
  return s
}

/// Welche Bedingungen passen zur Auswahl? → Liste { t, label, con }
export function applicableCons(sk, sel) {
  const ents = sel.ents.map((id) => sk.ents.find((e) => e.id === id)).filter(Boolean)
  const lines = ents.filter((e) => e.t === 'line')
  const rounds = ents.filter((e) => e.t === 'circle' || e.t === 'arc')
  const pts = [...sel.pts, ...ents.filter((e) => e.t === 'point').map((e) => e.p)]
  const out = []
  const add = (t, con) => out.push({ t, label: CON_LABEL[t], con: { t, ...con } })
  const onlyLines = ents.length === lines.length
  if (!pts.length && onlyLines && lines.length >= 1) {
    for (const t of ['h', 'v']) out.push({ t, label: CON_LABEL[t], multi: lines.map((l) => ({ t, a: l.a, b: l.b })) })
  }
  if (pts.length === 2 && !ents.filter((e) => e.t !== 'point').length) {
    add('h', { a: pts[0], b: pts[1] })
    add('v', { a: pts[0], b: pts[1] })
    add('co', { a: pts[0], b: pts[1] })
  }
  if (lines.length === 2 && ents.length === 2 && !sel.pts.length) {
    add('par', { e1: lines[0].id, e2: lines[1].id })
    add('perp', { e1: lines[0].id, e2: lines[1].id })
    add('eq', { e1: lines[0].id, e2: lines[1].id })
  }
  if (rounds.length === 2 && ents.length === 2) {
    add('eq', { e1: rounds[0].id, e2: rounds[1].id })
    add('tan', { e1: rounds[0].id, e2: rounds[1].id })
  }
  if (lines.length === 1 && rounds.length === 1 && ents.length === 2) add('tan', { e1: lines[0].id, e2: rounds[0].id })
  const nonPointEnts = ents.filter((e) => e.t !== 'point')
  if (pts.length === 1 && nonPointEnts.length === 1) {
    add('on', { p: pts[0], e: nonPointEnts[0].id })
    if (nonPointEnts[0].t === 'line') add('mid', { p: pts[0], e: nonPointEnts[0].id })
  }
  if (pts.length === 2 && lines.length === 1 && nonPointEnts.length === 1) add('sym', { p: pts[0], q: pts[1], e: lines[0].id })
  return out
}

// --- Fangen beim Zeichnen ---------------------------------------------------------------------

/// Fangpunkt in der Nähe von q (2D) suchen: vorhandene Punkte, Bauteilpunkte, Mittelpunkte, Elemente.
/// tol in mm (aus Pixeln umgerechnet). → { at:[x,y], pt?: id, ref?: [x,y] (Bauteilpunkt), ent?: id }
export function snap(sk, q, tol, refs = [], skip = new Set()) {
  let best = null
  const take = (cand, d, prio) => {
    if (d <= tol && (!best || prio < best.prio || (prio === best.prio && d < best.d))) best = { ...cand, d, prio }
  }
  for (const [id, p] of Object.entries(sk.pts)) {
    if (skip.has(id)) continue
    take({ at: [p.x, p.y], pt: id }, Math.hypot(q[0] - p.x, q[1] - p.y), 0)
  }
  for (const r of refs) take({ at: r, ref: r }, Math.hypot(q[0] - r[0], q[1] - r[1]), 1)
  // Mitte einer Linie
  for (const e of sk.ents) {
    if (e.t !== 'line' || skip.has(e.a) || skip.has(e.b)) continue
    const m = midOf(sk, e)
    take({ at: m, mid: e.id }, Math.hypot(q[0] - m[0], q[1] - m[1]), 2)
  }
  if (best) return best
  for (const e of sk.ents) {
    if (e.t === 'point' || entPoints(e).some((p) => skip.has(p))) continue
    const d = distTo(sk, e, q)
    if (d > tol) continue
    take({ at: nearestOn(sk, e, q), ent: e.id }, d, 3)
  }
  return best
}

export function nearestOn(sk, e, [x, y]) {
  if (e.t === 'line') {
    const [ax, ay] = P(sk, e.a)
    const [bx, by] = P(sk, e.b)
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2))
    return [ax + t * dx, ay + t * dy]
  }
  const [cx, cy] = P(sk, e.c)
  const r = radiusOf(sk, e)
  const a = Math.atan2(y - cy, x - cx)
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

/// Punkt für einen Fang anlegen bzw. wiederverwenden; Bauteilpunkte werden feste Punkte.
/// → id des Punkts (und ggf. Bedingung „Punkt auf“ bzw. „Mittelpunkt“)
export function pointAt(sk, at, hit) {
  if (hit?.pt) return hit.pt
  const id = addPoint(sk, hit ? hit.at : at, !!hit?.ref)
  if (hit?.ent) addCon(sk, { t: 'on', p: id, e: hit.ent })
  if (hit?.mid) addCon(sk, { t: 'mid', p: id, e: hit.mid })
  return id
}

/// waagrecht/senkrecht vorschlagen, wenn eine Linie fast so liegt (± 4°)
export function hvHint(a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (Math.hypot(dx, dy) < 1e-9) return null
  const ang = Math.abs(Math.atan2(dy, dx))
  const tol = (4 * Math.PI) / 180
  if (ang < tol || Math.PI - ang < tol) return 'h'
  if (Math.abs(ang - Math.PI / 2) < tol) return 'v'
  return null
}

// --- Maße -------------------------------------------------------------------------------------

/// Maß aus der Auswahl ableiten. picks: [{pt}|{ent}] (1–2 Stück), at: Ablageort (2D) → con oder null
export function dimFor(sk, picks, at) {
  const ent = (id) => sk.ents.find((e) => e.id === id)
  const ents = picks.filter((p) => p.ent).map((p) => ent(p.ent))
  if (picks.length === 1 && ents[0]) {
    const e = ents[0]
    if (e.t === 'circle') return { t: 'dia', e: e.id }
    if (e.t === 'arc') return { t: 'rad', e: e.id }
    if (e.t === 'line') return dimPoints(sk, e.a, e.b, at)
    if (e.t === 'point') return null
  }
  if (picks.length !== 2) return null
  const asPt = (p) => p.pt ?? (ent(p.ent)?.t === 'point' ? ent(p.ent).p : ent(p.ent)?.t !== 'line' && ent(p.ent)?.c)
  const lines = ents.filter((e) => e.t === 'line')
  if (lines.length === 2) {
    const [l1, l2] = lines
    const d1 = [sk.pts[l1.b].x - sk.pts[l1.a].x, sk.pts[l1.b].y - sk.pts[l1.a].y]
    const d2 = [sk.pts[l2.b].x - sk.pts[l2.a].x, sk.pts[l2.b].y - sk.pts[l2.a].y]
    const cr = (d1[0] * d2[1] - d1[1] * d2[0]) / (Math.hypot(...d1) * Math.hypot(...d2) || 1)
    if (Math.abs(cr) < 1e-6) return { t: 'dpl', p: l1.a, e: l2.id }
    // Winkel zwischen den Linienstücken, auf deren Seite das Maß liegt
    const m1 = midOf(sk, l1)
    const m2 = midOf(sk, l2)
    const side = (l, m) => {
      const a = P(sk, l.a)
      const b = P(sk, l.b)
      const toAt = [at[0] - m[0], at[1] - m[1]]
      return (b[0] - a[0]) * toAt[0] + (b[1] - a[1]) * toAt[1] >= 0 ? 1 : -1
    }
    return { t: 'ang', e1: l1.id, e2: l2.id, f1: side(l1, m1), f2: side(l2, m2) }
  }
  if (lines.length === 1) {
    const other = picks.find((p) => p.pt || ent(p.ent)?.t !== 'line')
    const p = asPt(other)
    return p ? { t: 'dpl', p, e: lines[0].id } : null
  }
  const [a, b] = picks.map(asPt)
  if (!a || !b || a === b) return null
  return dimPoints(sk, a, b, at)
}

// Abstand zweier Punkte: waagrecht, senkrecht oder schräg – je nachdem, wohin das Maß gezogen wird
function dimPoints(sk, a, b, at) {
  const [ax, ay] = P(sk, a)
  const [bx, by] = P(sk, b)
  const inX = at[0] > Math.min(ax, bx) && at[0] < Math.max(ax, bx)
  const inY = at[1] > Math.min(ay, by) && at[1] < Math.max(ay, by)
  if (Math.abs(ay - by) < 1e-9) return { t: 'dx', a, b }
  if (Math.abs(ax - bx) < 1e-9) return { t: 'dy', a, b }
  if (inX && !inY) return { t: 'dx', a, b }
  if (inY && !inX) return { t: 'dy', a, b }
  return { t: 'dist', a, b }
}

/// Ankerpunkte eines Maßes zum Zeichnen: { from:[x,y], to:[x,y], label:[x,y] } in Skizzenkoordinaten
export function dimGeometry(sk, c) {
  const ent = (id) => sk.ents.find((e) => e.id === id)
  const off = c.at ?? null
  if (c.t === 'dist' || c.t === 'dx' || c.t === 'dy') {
    let a = P(sk, c.a)
    let b = P(sk, c.b)
    let dir
    if (c.t === 'dx') dir = [1, 0]
    else if (c.t === 'dy') dir = [0, 1]
    else {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    }
    const nrm = [-dir[1], dir[0]]
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const o = off ? (off[0] - mid[0]) * nrm[0] + (off[1] - mid[1]) * nrm[1] : 0
    const proj = (p) => {
      const t = (p[0] - mid[0]) * dir[0] + (p[1] - mid[1]) * dir[1]
      return [mid[0] + dir[0] * t + nrm[0] * o, mid[1] + dir[1] * t + nrm[1] * o]
    }
    const A = proj(a)
    const B = proj(b)
    const along = off ? (off[0] - mid[0]) * dir[0] + (off[1] - mid[1]) * dir[1] : 0
    return { from: A, to: B, ext: [[a, A], [b, B]], label: [(A[0] + B[0]) / 2 + dir[0] * along, (A[1] + B[1]) / 2 + dir[1] * along] }
  }
  if (c.t === 'dpl') {
    const e = ent(c.e)
    const p = P(sk, c.p)
    const q = nearestOnInfinite(sk, e, p)
    return { from: p, to: q, ext: [], label: off ?? [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] }
  }
  if (c.t === 'rad' || c.t === 'dia') {
    const e = ent(c.e)
    const ctr = P(sk, e.c)
    const r = radiusOf(sk, e)
    const t = off ? Math.atan2(off[1] - ctr[1], off[0] - ctr[0]) : Math.PI / 4
    const rim = [ctr[0] + r * Math.cos(t), ctr[1] + r * Math.sin(t)]
    const start = c.t === 'dia' ? [ctr[0] - r * Math.cos(t), ctr[1] - r * Math.sin(t)] : ctr
    return { from: start, to: rim, ext: [], label: off ?? rim }
  }
  if (c.t === 'ang') {
    const l1 = ent(c.e1)
    const l2 = ent(c.e2)
    const m = intersect(sk, l1, l2) ?? midOf(sk, l1)
    return { from: m, to: m, ext: [], label: off ?? [m[0] + 10, m[1] + 10], arc: true }
  }
  return null
}

function nearestOnInfinite(sk, e, [x, y]) {
  const [ax, ay] = P(sk, e.a)
  const [bx, by] = P(sk, e.b)
  const dx = bx - ax
  const dy = by - ay
  const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)
  return [ax + t * dx, ay + t * dy]
}

function intersect(sk, l1, l2) {
  const [ax, ay] = P(sk, l1.a)
  const [bx, by] = P(sk, l1.b)
  const [cx, cy] = P(sk, l2.a)
  const [dx, dy] = P(sk, l2.b)
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
  if (Math.abs(den) < 1e-12) return null
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den
  return [ax + t * (bx - ax), ay + t * (by - ay)]
}

// --- für den Kern -----------------------------------------------------------------------------

/// Skizze als Zahlen: Elemente (ohne Hilfslinien) und Punkte (für Bohrungen)
export function kernelSketch(id, sk) {
  const ents = []
  const pts = []
  for (const e of sk.ents) {
    if (e.t === 'point') {
      pts.push(P(sk, e.p))
      continue
    }
    if (e.cons) continue
    if (e.t === 'line') ents.push({ t: 'line', a: P(sk, e.a), b: P(sk, e.b) })
    else if (e.t === 'circle') ents.push({ t: 'circle', c: P(sk, e.c), r: e.r })
    else ents.push({ t: 'arc', c: P(sk, e.c), a: P(sk, e.a), b: P(sk, e.b) })
  }
  return { id, type: 'sketch', plane: sk.plane, ents, pts, ...(sk.fills?.length ? { fills: sk.fills } : {}) }
}

/// Maße und Werte mit Namen (für Parameterstudien): Skizzenmaße und Zahlen der Features
export function solveSketch(sk) {
  return solved(sk, { analyse: true })
}

export { DIM_TYPES }
