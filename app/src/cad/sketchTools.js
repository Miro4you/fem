// Zusätzliche Skizzenwerkzeuge: Ecke verrunden, Langloch, Vieleck, Rechteck aus der Mitte.
// Alle arbeiten auf einer Kopie der Skizze (structuredClone vorher) und legen Elemente samt Bedingungen an,
// so dass der Löser die Form hält (Tangenten, gleiche Radien, gleiche Seiten …).
import { addPoint, addEnt, addCon, P, pointAt } from './sketch.js'

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const mul = (a, k) => [a[0] * k, a[1] * k]
const len = (a) => Math.hypot(a[0], a[1])
const unit = (a) => {
  const l = len(a)
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0]
}
const cross = (a, b) => a[0] * b[1] - a[1] * b[0]

const NICE_R = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100]

/// Linien, die an einem Punkt enden (auch über „deckungsgleich“ verbundene Punkte)
export function cornerLines(sk, ptId) {
  const ids = new Set([ptId])
  for (const c of sk.cons) if (c.t === 'co' && (c.a === ptId || c.b === ptId)) ids.add(c.a === ptId ? c.b : c.a)
  return sk.ents.filter((e) => e.t === 'line' && !e.cons && (ids.has(e.a) || ids.has(e.b))).map((e) => ({ e, end: ids.has(e.a) ? e.a : e.b }))
}

/// sinnvoller Vorschlag für den Radius an einer Ecke (glatter Wert, ≤ 1/3 der kürzeren Linie)
export function suggestFilletRadius(sk, ptId) {
  const ls = cornerLines(sk, ptId)
  if (ls.length !== 2) return null
  const short = Math.min(...ls.map(({ e }) => len(sub(P(sk, e.a), P(sk, e.b)))))
  const want = short / 4
  return [...NICE_R].reverse().find((r) => r <= want) ?? short / 4
}

/// Ecke zwischen zwei Linien mit Radius r verrunden. Die Ecke bleibt als Hilfspunkt stehen (Maße daran bleiben gültig).
/// → { sketch, arc } oder { error }
/// Lage der Verrundung (ohne die Skizze zu ändern) → { l1, l2, Pc, T1, T2, C } oder { error }
export function filletGeom(sk, ptId, r) {
  const ls = cornerLines(sk, ptId)
  if (ls.length !== 2) return { error: 'Verrunden: eine Ecke anklicken, an der genau zwei Linien zusammenkommen' }
  const [l1, l2] = ls
  const Pc = P(sk, l1.end)
  const far = (l) => P(sk, l.end === l.e.a ? l.e.b : l.e.a)
  const u1 = unit(sub(far(l1), Pc))
  const u2 = unit(sub(far(l2), Pc))
  const cosA = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))
  const ang = Math.acos(cosA)
  if (ang < 1e-3 || Math.PI - ang < 1e-3) return { error: 'Verrunden: die Linien liegen auf einer Geraden' }
  const t = r / Math.tan(ang / 2)
  const L1 = len(sub(far(l1), Pc))
  const L2 = len(sub(far(l2), Pc))
  if (!(r > 0) || t >= L1 - 1e-9 || t >= L2 - 1e-9) return { error: `Verrunden: R ${String(r).replace('.', ',')} ist zu groß für diese Ecke` }
  const T1 = add(Pc, mul(u1, t))
  const T2 = add(Pc, mul(u2, t))
  const C = add(Pc, mul(unit(add(u1, u2)), r / Math.sin(ang / 2)))
  return { l1, l2, Pc, T1, T2, C }
}

/// Bogenpunkte der Verrundung für die Vorschau
export function filletPreview(sk, ptId, r, n = 24) {
  const g = filletGeom(sk, ptId, r)
  if (g.error) return null
  let a0 = Math.atan2(g.T1[1] - g.C[1], g.T1[0] - g.C[0])
  let a1 = Math.atan2(g.T2[1] - g.C[1], g.T2[0] - g.C[0])
  if (cross(sub(g.T1, g.C), sub(g.T2, g.C)) < 0) [a0, a1] = [a1, a0]
  while (a1 <= a0) a1 += 2 * Math.PI
  return Array.from({ length: n + 1 }, (_, i) => [g.C[0] + r * Math.cos(a0 + ((a1 - a0) * i) / n), g.C[1] + r * Math.sin(a0 + ((a1 - a0) * i) / n)])
}

export function filletCorner(sk0, ptId, r) {
  const sk = structuredClone(sk0)
  const g = filletGeom(sk, ptId, r)
  if (g.error) return g
  const { l1, l2, Pc, T1, T2, C } = g
  const t1 = addPoint(sk, T1)
  const t2 = addPoint(sk, T2)
  const c = addPoint(sk, C)
  // Linien an den Berührpunkten enden lassen
  for (const [l, tp] of [
    [l1, t1],
    [l2, t2],
  ]) {
    const e = sk.ents.find((x) => x.id === l.e.id)
    if (e.a === l.end) e.a = tp
    else e.b = tp
  }
  // Bogen gegen den Uhrzeigersinn: von T1 nach T2, wenn T1 → T2 um den Mittelpunkt links herum geht
  const ccw = cross(sub(T1, C), sub(T2, C)) > 0
  const arc = addEnt(sk, { t: 'arc', c, a: ccw ? t1 : t2, b: ccw ? t2 : t1 })
  addCon(sk, { t: 'tan', e1: l1.e.id, e2: arc.id, quiet: true })
  addCon(sk, { t: 'tan', e1: l2.e.id, e2: arc.id, quiet: true })
  // die alte Ecke als Hilfspunkt auf beiden Linien (virtuelle Spitze)
  const used = sk.ents.some((e) => e.t === 'point' && e.p === l1.end)
  if (!used) addEnt(sk, { t: 'point', p: l1.end, cons: true })
  addCon(sk, { t: 'on', p: l1.end, e: l1.e.id, quiet: true })
  addCon(sk, { t: 'on', p: l1.end, e: l2.e.id, quiet: true })
  if (l2.end !== l1.end) {
    if (!sk.ents.some((e) => e.t === 'point' && e.p === l2.end)) addEnt(sk, { t: 'point', p: l2.end, cons: true })
    addCon(sk, { t: 'on', p: l2.end, e: l1.e.id, quiet: true })
    addCon(sk, { t: 'on', p: l2.end, e: l2.e.id, quiet: true })
  }
  const mid = add(C, mul(unit(sub(Pc, C)), r))
  const dim = addCon(sk, { t: 'rad', e: arc.id, v: r, at: add(mid, mul(unit(sub(Pc, C)), r * 0.8 + 1e-9)) })
  return { sketch: sk, arc, dim }
}

/// Langloch aus zwei Mittelpunkten und Radius. hits: Fang der Mittelpunkte (für vorhandene Punkte)
/// → { sketch, dims } – dims: { dist?: Mittenabstand, width?: Breite }
export function addSlot(sk, A, B, r, opts = {}) {
  const { hitA = null, hitB = null, dist = null, width = null, construction = false } = opts
  const d = unit(sub(B, A))
  const n = [-d[1], d[0]]
  const c1 = pointAt(sk, A, hitA)
  const c2 = pointAt(sk, B, hitB)
  const p1 = addPoint(sk, add(A, mul(n, r)))
  const p2 = addPoint(sk, add(B, mul(n, r)))
  const p3 = addPoint(sk, sub(B, mul(n, r)))
  const p4 = addPoint(sk, sub(A, mul(n, r)))
  const cons = construction || undefined
  const top = addEnt(sk, { t: 'line', a: p1, b: p2, cons })
  const bot = addEnt(sk, { t: 'line', a: p3, b: p4, cons })
  const arc2 = addEnt(sk, { t: 'arc', c: c2, a: p3, b: p2, cons })
  const arc1 = addEnt(sk, { t: 'arc', c: c1, a: p1, b: p4, cons })
  const axis = addEnt(sk, { t: 'line', a: c1, b: c2, cons: true })
  for (const l of [top, bot]) for (const a of [arc1, arc2]) addCon(sk, { t: 'tan', e1: l.id, e2: a.id, quiet: true })
  addCon(sk, { t: 'eq', e1: arc1.id, e2: arc2.id, quiet: true })
  if (Math.abs(d[1]) < 1e-9) addCon(sk, { t: 'h', a: c1, b: c2 })
  else if (Math.abs(d[0]) < 1e-9) addCon(sk, { t: 'v', a: c1, b: c2 })
  const gap = opts.gap ?? 5
  if (dist) addCon(sk, { t: 'dist', a: c1, b: c2, v: dist, label: 'Mittenabstand', at: add(mul(add(A, B), 0.5), mul(n, -(r + gap))) })
  if (width) addCon(sk, { t: 'dpl', p: p4, e: top.id, v: width, label: 'Breite', at: add(B, mul(d, r + gap)) })
  return { top, bot, arc1, arc2, axis }
}

/// regelmäßiges n-Eck: Mittelpunkt, ein Eckpunkt. Hilfskreis durch die Ecken, alle Seiten gleich lang.
/// size: Schlüsselweite (gerades n) bzw. Umkreis-Ø (ungerades n) als Maß
export function addPolygon(sk, C, V, n, { hitC = null, size = null, construction = false } = {}) {
  const R = len(sub(V, C))
  const a0 = Math.atan2(V[1] - C[1], V[0] - C[0])
  const c = pointAt(sk, C, hitC)
  const circ = addEnt(sk, { t: 'circle', c, r: R, cons: true })
  const ids = []
  for (let i = 0; i < n; i++) {
    const a = a0 + (2 * Math.PI * i) / n
    const id = addPoint(sk, [C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)])
    ids.push(id)
    addCon(sk, { t: 'on', p: id, e: circ.id, quiet: true })
  }
  const cons = construction || undefined
  const lines = ids.map((id, i) => addEnt(sk, { t: 'line', a: id, b: ids[(i + 1) % n], cons }))
  for (let i = 1; i < n; i++) addCon(sk, { t: 'eq', e1: lines[0].id, e2: lines[i].id, quiet: true })
  // eine Seite waagrecht/senkrecht, wenn sie (fast) so liegt
  const tol = (2 * Math.PI) / 180
  for (const l of lines) {
    const p = P(sk, l.a)
    const q = P(sk, l.b)
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0])
    const m = ((ang % Math.PI) + Math.PI) % Math.PI
    if (m < tol || Math.PI - m < tol) {
      addCon(sk, { t: 'h', a: l.a, b: l.b })
      break
    }
    if (Math.abs(m - Math.PI / 2) < tol) {
      addCon(sk, { t: 'v', a: l.a, b: l.b })
      break
    }
  }
  if (size) {
    if (n % 2 === 0) {
      const opp = lines[n / 2]
      addCon(sk, { t: 'dpl', p: lines[0].a, e: opp.id, v: size, label: 'Schlüsselweite', at: add(C, mul([Math.cos(a0 + Math.PI / n), Math.sin(a0 + Math.PI / n)], R * 1.25)) })
    } else addCon(sk, { t: 'dia', e: circ.id, v: size, label: 'Umkreis', at: add(C, [R * 0.75, R * 0.75]) })
  }
  return { lines, circ }
}

/// Schlüsselweite / Umkreis zu einem Umkreisradius (Anzeige am Zeiger)
export const polygonSize = (n, R) => (n % 2 === 0 ? 2 * R * Math.cos(Math.PI / n) : 2 * R)
export const polygonRadius = (n, size) => (n % 2 === 0 ? size / (2 * Math.cos(Math.PI / n)) : size / 2)

/// Rechteck um einen Mittelpunkt (Ecke B gegenüber −B); Hilfsdiagonale mit dem Mittelpunkt darauf
export function addCenterRect(sk, M, B, { hitM = null, w = null, h = null, construction = false } = {}) {
  const dx = B[0] - M[0]
  const dy = B[1] - M[1]
  const m = pointAt(sk, M, hitM)
  const a = addPoint(sk, [M[0] - dx, M[1] - dy])
  const b = addPoint(sk, [M[0] + dx, M[1] - dy])
  const c = addPoint(sk, [M[0] + dx, M[1] + dy])
  const d = addPoint(sk, [M[0] - dx, M[1] + dy])
  const cons = construction || undefined
  addEnt(sk, { t: 'line', a, b, cons })
  addEnt(sk, { t: 'line', a: b, b: c, cons })
  addEnt(sk, { t: 'line', a: c, b: d, cons })
  addEnt(sk, { t: 'line', a: d, b: a, cons })
  addCon(sk, { t: 'h', a, b })
  addCon(sk, { t: 'v', a: b, b: c })
  addCon(sk, { t: 'h', a: c, b: d })
  addCon(sk, { t: 'v', a: d, b: a })
  const diag = addEnt(sk, { t: 'line', a, b: c, cons: true })
  addCon(sk, { t: 'mid', p: m, e: diag.id, quiet: true })
  if (!sk.ents.some((e) => e.t === 'point' && e.p === m) && !hitM?.pt) addEnt(sk, { t: 'point', p: m, cons: true })
  if (w) addCon(sk, { t: 'dx', a, b, v: w })
  if (h) addCon(sk, { t: 'dy', a: b, b: c, v: h })
  return { diag }
}

/// Elemente an einer Linie spiegeln: Kopien mit „symmetrisch“ je Punkt (Punkte auf der Linie bleiben dieselben),
/// Kreise mit „gleich“. → { sketch, added: [Element-IDs] } oder { error }
export function mirrorEnts(sk0, entIds, lineId) {
  const sk = structuredClone(sk0)
  const axis = sk.ents.find((e) => e.id === lineId && e.t === 'line')
  if (!axis) return { error: 'Spiegeln: eine gerade Linie als Spiegelachse anklicken' }
  const A = P(sk, axis.a)
  const B = P(sk, axis.b)
  const d = unit(sub(B, A))
  const L = Math.max(1, len(sub(B, A)))
  const reflect = (p) => {
    const t = (p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1]
    const f = [A[0] + d[0] * t, A[1] + d[1] * t]
    return [2 * f[0] - p[0], 2 * f[1] - p[1]]
  }
  const onAxis = (p) => Math.abs(cross(d, sub(p, A))) < 1e-7 * L
  const map = new Map()
  const image = (id) => {
    if (map.has(id)) return map.get(id)
    const p = P(sk, id)
    let q = id
    if (!onAxis(p) && id !== axis.a && id !== axis.b) {
      q = addPoint(sk, reflect(p))
      addCon(sk, { t: 'sym', p: id, q, e: lineId, quiet: true })
    }
    map.set(id, q)
    return q
  }
  const added = []
  for (const id of entIds) {
    const e = sk.ents.find((x) => x.id === id)
    if (!e || e.id === lineId) continue
    if (e.t === 'line') added.push(addEnt(sk, { t: 'line', a: image(e.a), b: image(e.b), cons: e.cons }).id)
    else if (e.t === 'circle') {
      const c = addEnt(sk, { t: 'circle', c: image(e.c), r: e.r, cons: e.cons })
      addCon(sk, { t: 'eq', e1: e.id, e2: c.id, quiet: true })
      added.push(c.id)
    } else if (e.t === 'arc') {
      // Spiegeln dreht den Umlaufsinn: Anfang und Ende tauschen
      added.push(addEnt(sk, { t: 'arc', c: image(e.c), a: image(e.b), b: image(e.a), cons: e.cons, mirrorOf: e.id }).id)
    } else if (e.t === 'point') {
      const q = image(e.p)
      if (q !== e.p) added.push(addEnt(sk, { t: 'point', p: q, cons: e.cons }).id)
    }
  }
  if (!added.length) return { error: 'Spiegeln: erst die Elemente wählen, die gespiegelt werden sollen' }
  return { sketch: sk, added }
}

/// Tangentenbogen: Anfang an einem Linien- oder Bogenende (Richtung von dort weiter), Ende frei.
/// → { dir } Richtung am Startpunkt (aus dem Element hinaus) oder null
export function tangentAt(sk, ptId) {
  for (const e of sk.ents) {
    if (e.cons) continue
    if (e.t === 'line' && (e.a === ptId || e.b === ptId)) {
      const p = P(sk, ptId)
      const o = P(sk, e.a === ptId ? e.b : e.a)
      return { dir: unit(sub(p, o)), ent: e.id }
    }
    if (e.t === 'arc' && (e.a === ptId || e.b === ptId)) {
      const c = P(sk, e.c)
      const r = sub(P(sk, ptId), c)
      // gegen den Uhrzeigersinn von a nach b: am Ende b läuft der Bogen in Richtung (−ry, rx) weiter, am Anfang a umgekehrt
      const t = unit([-r[1], r[0]])
      return { dir: e.b === ptId ? t : mul(t, -1), ent: e.id }
    }
  }
  return null
}

/// Bogen von P (Tangente t) nach Q → { c, r, ccw, a0, a1 } oder null (gerade weiter)
export function tangentArc(P0, t, Q) {
  const n = [-t[1], t[0]]
  const d = sub(P0, Q)
  const den = 2 * (n[0] * d[0] + n[1] * d[1])
  if (Math.abs(den) < 1e-9 * Math.max(1, len(d))) return null
  const s = -(d[0] * d[0] + d[1] * d[1]) / den
  const c = add(P0, mul(n, s))
  const ccw = s > 0
  const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0])
  let a0 = ang(ccw ? P0 : Q)
  let a1 = ang(ccw ? Q : P0)
  while (a1 <= a0) a1 += 2 * Math.PI
  return { c, r: Math.abs(s), ccw, a0, a1 }
}

/// Muster in der Skizze: gewählte Elemente als Reihe (dx, dy je Schritt) oder im Kreis (um center, Gesamtwinkel)
/// kopieren. Kopien sind eigenständig (keine Bedingungen zum Original). → { sketch, added } oder { error }
export function patternEnts(sk0, entIds, { kind = 'linear', n = 3, dx = 10, dy = 0, center = [0, 0], angle = 360 } = {}) {
  const sk = structuredClone(sk0)
  const count = Math.round(Number(n) || 0)
  if (count < 2) return { error: 'Muster: Anzahl mindestens 2' }
  const ents = entIds.map((id) => sk.ents.find((e) => e.id === id)).filter(Boolean)
  if (!ents.length) return { error: 'Muster: erst Elemente wählen' }
  const full = Math.abs(Math.abs(angle) - 360) < 1e-9
  const step = kind === 'circular' ? ((angle * Math.PI) / 180) / (full ? count : count - 1) : 0
  const added = []
  for (let k = 1; k < count; k++) {
    const move = (p) => {
      if (kind !== 'circular') return [p[0] + k * dx, p[1] + k * dy]
      const a = k * step
      const x = p[0] - center[0]
      const y = p[1] - center[1]
      return [center[0] + x * Math.cos(a) - y * Math.sin(a), center[1] + x * Math.sin(a) + y * Math.cos(a)]
    }
    const map = new Map()
    const img = (id) => {
      if (!map.has(id)) map.set(id, addPoint(sk, move(P(sk, id))))
      return map.get(id)
    }
    for (const e of ents) {
      if (e.t === 'line') added.push(addEnt(sk, { t: 'line', a: img(e.a), b: img(e.b), cons: e.cons }).id)
      else if (e.t === 'circle') added.push(addEnt(sk, { t: 'circle', c: img(e.c), r: e.r, cons: e.cons }).id)
      else if (e.t === 'arc') added.push(addEnt(sk, { t: 'arc', c: img(e.c), a: img(e.a), b: img(e.b), cons: e.cons }).id)
      else if (e.t === 'point') added.push(addEnt(sk, { t: 'point', p: img(e.p), cons: e.cons }).id)
    }
  }
  return { sketch: sk, added }
}
