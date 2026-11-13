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

// --- Trimmen ----------------------------------------------------------------------------------

const TAU = 2 * Math.PI
const wrap = (a) => ((a % TAU) + TAU) % TAU

/// Schnittpunkte zweier Elemente (Linie/Kreis/Bogen) → [[x, y], …]
function intersectEnts(sk, e, f) {
  const out = []
  const onArc = (g, q) => {
    if (g.t !== 'arc') return true
    const [cx, cy] = P(sk, g.c)
    const [a0, a1] = arcAngles(sk, g)
    let ang = Math.atan2(q[1] - cy, q[0] - cx)
    while (ang < a0 - 1e-9) ang += TAU
    return ang <= a1 + 1e-9
  }
  const segT = (g, q) => {
    const [ax, ay] = P(sk, g.a)
    const [bx, by] = P(sk, g.b)
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2
    return L2 ? ((q[0] - ax) * (bx - ax) + (q[1] - ay) * (by - ay)) / L2 : -1
  }
  const onSeg = (g, q) => {
    const t = segT(g, q)
    return t >= -1e-9 && t <= 1 + 1e-9
  }
  const isRound = (g) => g.t === 'circle' || g.t === 'arc'
  if (e.t === 'line' && f.t === 'line') {
    const [ax, ay] = P(sk, e.a)
    const [bx, by] = P(sk, e.b)
    const [cx, cy] = P(sk, f.a)
    const [dx, dy] = P(sk, f.b)
    const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
    if (Math.abs(den) < 1e-12) return out
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den
    const q = [ax + t * (bx - ax), ay + t * (by - ay)]
    if (t >= -1e-9 && t <= 1 + 1e-9 && onSeg(f, q)) out.push(q)
    return out
  }
  if (e.t === 'line' || f.t === 'line') {
    const [l, c] = e.t === 'line' ? [e, f] : [f, e]
    if (!isRound(c)) return out
    const [ax, ay] = P(sk, l.a)
    const [bx, by] = P(sk, l.b)
    const [cx, cy] = P(sk, c.c)
    const r = radiusOf(sk, c)
    const dx = bx - ax
    const dy = by - ay
    const A = dx * dx + dy * dy
    const B = 2 * ((ax - cx) * dx + (ay - cy) * dy)
    const C = (ax - cx) ** 2 + (ay - cy) ** 2 - r * r
    const disc = B * B - 4 * A * C
    if (A === 0 || disc < -1e-12) return out
    const sq = Math.sqrt(Math.max(0, disc))
    for (const t of disc < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
      const q = [ax + t * dx, ay + t * dy]
      if (t >= -1e-9 && t <= 1 + 1e-9 && onArc(c, q)) out.push(q)
    }
    return out
  }
  if (isRound(e) && isRound(f)) {
    const [x0, y0] = P(sk, e.c)
    const [x1, y1] = P(sk, f.c)
    const r0 = radiusOf(sk, e)
    const r1 = radiusOf(sk, f)
    const d = Math.hypot(x1 - x0, y1 - y0)
    if (d < 1e-12 || d > r0 + r1 + 1e-9 || d < Math.abs(r0 - r1) - 1e-9) return out
    const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d)
    const h = Math.sqrt(Math.max(0, r0 * r0 - a * a))
    const mx = x0 + (a * (x1 - x0)) / d
    const my = y0 + (a * (y1 - y0)) / d
    for (const s of h < 1e-12 ? [0] : [1, -1]) {
      const q = [mx + (s * h * (y1 - y0)) / d, my - (s * h * (x1 - x0)) / d]
      if (onArc(e, q) && onArc(f, q)) out.push(q)
    }
  }
  return out
}

/// Parameter eines Punkts auf einem Element: Linie 0…1, Kreis 0…2π (Winkel), Bogen 0…Öffnungswinkel
function paramOf(sk, e, q) {
  if (e.t === 'line') {
    const [ax, ay] = P(sk, e.a)
    const [bx, by] = P(sk, e.b)
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2
    return L2 ? ((q[0] - ax) * (bx - ax) + (q[1] - ay) * (by - ay)) / L2 : 0
  }
  const [cx, cy] = P(sk, e.c)
  const ang = Math.atan2(q[1] - cy, q[0] - cx)
  if (e.t === 'circle') return wrap(ang)
  const [a0] = arcAngles(sk, e)
  return wrap(ang - a0)
}

/// Trimmen: das angeklickte Stück eines Elements bis zu den nächsten Schnittpunkten mit anderen Elementen
/// entfernen. → { sketch, removed: [[x,y],…] (Linienzug des entfernten Stücks) } oder null
export function trimAt(sk, entId, at) {
  const e = sk.ents.find((x) => x.id === entId)
  if (!e || !['line', 'circle', 'arc'].includes(e.t)) return null
  const len = e.t === 'line' ? 1 : e.t === 'circle' ? TAU : (() => {
    const [a0, a1] = arcAngles(sk, e)
    return a1 - a0
  })()
  const eps = e.t === 'line' ? 1e-6 : 1e-6
  const cuts = []
  for (const f of sk.ents) {
    if (f.id === e.id || f.t === 'point') continue
    for (const q of intersectEnts(sk, e, f)) {
      const t = paramOf(sk, e, q)
      if (e.t !== 'circle' && (t < eps || t > len - eps)) continue // Endpunkte sind keine Schnitte
      if (!cuts.some((c) => Math.abs(c.t - t) < eps)) cuts.push({ t, q, by: f.id })
    }
  }
  cuts.sort((a, b) => a.t - b.t)
  const tc = paramOf(sk, e, at)
  const s = structuredClone(sk)
  const se = s.ents.find((x) => x.id === e.id)
  const keepCons = (ids) => s.cons.filter((c) => !['e', 'e1', 'e2'].some((k) => c[k] && ids.includes(c[k])) || ['par', 'perp', 'h', 'v'].includes(c.t))
  // entferntes Stück zum Anzeigen
  const pieceOf = (t0, t1) => {
    const n = e.t === 'line' ? 1 : 32
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = t0 + ((t1 - t0) * i) / n
      if (e.t === 'line') {
        const [ax, ay] = P(sk, e.a)
        const [bx, by] = P(sk, e.b)
        return [ax + t * (bx - ax), ay + t * (by - ay)]
      }
      const [cx, cy] = P(sk, e.c)
      const r = radiusOf(sk, e)
      const base = e.t === 'arc' ? arcAngles(sk, e)[0] : 0
      return [cx + r * Math.cos(base + t), cy + r * Math.sin(base + t)]
    })
  }
  const newPt = (c) => {
    const id = addPoint(s, c.q)
    addCon(s, { t: 'on', p: id, e: c.by })
    return id
  }
  if (e.t === 'circle') {
    if (cuts.length < 2) return { sketch: removeItems(sk, { ents: [e.id] }), removed: pieceOf(0, TAU) }
    const hi = cuts.find((c) => c.t > tc) ?? cuts[0]
    const lo = [...cuts].reverse().find((c) => c.t < tc) ?? cuts[cuts.length - 1]
    // übrig bleibt der Bogen von hi gegen den Uhrzeigersinn bis lo
    const a = newPt(hi)
    const b = newPt(lo)
    Object.assign(se, { t: 'arc', a, b })
    delete se.r
    delete se.fix
    s.cons = s.cons.map((c) => (c.t === 'dia' && c.e === e.id ? { ...c, t: 'rad', v: c.v / 2 } : c))
    return { sketch: s, removed: pieceOf(lo.t, lo.t + (wrap(hi.t - lo.t) || TAU)) }
  }
  const lo = [...cuts].reverse().find((c) => c.t < tc) ?? null
  const hi = cuts.find((c) => c.t > tc) ?? null
  const removed = pieceOf(lo ? lo.t : 0, hi ? hi.t : len)
  if (!lo && !hi) return { sketch: removeItems(sk, { ents: [e.id] }), removed }
  if (!lo) se.a = newPt(hi)
  else if (!hi) se.b = newPt(lo)
  else {
    const oldB = se.b
    se.b = newPt(lo)
    const start = newPt(hi)
    const second = addEnt(s, { t: e.t, ...(e.t === 'arc' ? { c: e.c } : {}), a: start, b: oldB, ...(e.cons ? { cons: true } : {}) })
    // Richtung bleibt: waagrecht/senkrecht/parallel auch für das zweite Stück
    for (const c of sk.cons) {
      if ((c.t === 'par' || c.t === 'perp') && (c.e1 === e.id || c.e2 === e.id)) addCon(s, { ...c, id: undefined, e1: c.e1 === e.id ? second.id : c.e1, e2: c.e2 === e.id ? second.id : c.e2 })
    }
    if (e.t === 'line') {
      const [ax, ay] = P(sk, e.a)
      const [bx, by] = P(sk, e.b)
      const L = Math.hypot(bx - ax, by - ay) || 1
      if (Math.abs(ay - by) < 1e-6 * L) addCon(s, { t: 'h', a: start, b: oldB })
      else if (Math.abs(ax - bx) < 1e-6 * L) addCon(s, { t: 'v', a: start, b: oldB })
      else addCon(s, { t: 'par', e1: se.id, e2: second.id })
    }
  }
  // Maße/Bedingungen, die sich auf die alte Länge beziehen, passen nicht mehr
  const ends = (c) => (c.a === e.a && c.b === e.b) || (c.a === e.b && c.b === e.a)
  s.cons = keepCons([e.id]).filter((c) => !(['dist', 'dx', 'dy', 'h', 'v'].includes(c.t) && ends(c)))
  if (e.t === 'line') {
    const [ax, ay] = [s.pts[se.a].x, s.pts[se.a].y]
    const [bx, by] = [s.pts[se.b].x, s.pts[se.b].y]
    const L = Math.hypot(bx - ax, by - ay) || 1
    if (Math.abs(ay - by) < 1e-6 * L && !s.cons.some((c) => c.t === 'h' && ((c.a === se.a && c.b === se.b) || (c.a === se.b && c.b === se.a)))) addCon(s, { t: 'h', a: se.a, b: se.b })
    else if (Math.abs(ax - bx) < 1e-6 * L && !s.cons.some((c) => c.t === 'v' && ((c.a === se.a && c.b === se.b) || (c.a === se.b && c.b === se.a)))) addCon(s, { t: 'v', a: se.a, b: se.b })
  }
  return { sketch: removeItems(s, {}), removed }
}
