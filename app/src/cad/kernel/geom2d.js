// Ebene Hilfsrechnungen für Skizzen (ohne Geometriekern) – entsprechen den Funktionen in cad.py.
// Skizzenelemente: { t: 'line', a, b } | { t: 'circle', c, r } | { t: 'arc', c, a, b } (Bogen gegen den Uhrzeigersinn a → b)

export const TWO_PI = 2 * Math.PI
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])

export function arcAngles(e) {
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0])
  let a1 = Math.atan2(e.b[1] - e.c[1], e.b[0] - e.c[0])
  while (a1 <= a0 + 1e-12) a1 += TWO_PI
  return [a0, a1]
}

export const entRadius = (e) => (e.t === 'circle' ? e.r : dist(e.a, e.c))

export function distToEnt(p, e) {
  if (e.t === 'line') {
    const d = [e.b[0] - e.a[0], e.b[1] - e.a[1]]
    const L2 = d[0] * d[0] + d[1] * d[1]
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - e.a[0]) * d[0] + (p[1] - e.a[1]) * d[1]) / L2))
    return dist(p, [e.a[0] + d[0] * t, e.a[1] + d[1] * t])
  }
  const r = entRadius(e)
  if (e.t === 'circle') return Math.abs(dist(p, e.c) - r)
  const [a0, a1] = arcAngles(e)
  let ang = Math.atan2(p[1] - e.c[1], p[0] - e.c[0])
  while (ang < a0) ang += TWO_PI
  if (ang <= a1) return Math.abs(dist(p, e.c) - r)
  return Math.min(dist(p, e.a), dist(p, e.b))
}

/// Offene Enden weglassen: Linien/Bögen, deren Endpunkt an nichts anderes anschließt
export function pruneOpen(ents, tol) {
  ents = ents.filter((e) => !(e.t === 'line' && dist(e.a, e.b) < tol))
  for (;;) {
    let drop = -1
    for (let i = 0; i < ents.length && drop < 0; i++) {
      const e = ents[i]
      if (e.t === 'circle') continue
      for (const p of [e.a, e.b])
        if (!ents.some((o, j) => j !== i && distToEnt(p, o) < tol)) {
          drop = i
          break
        }
    }
    if (drop < 0) return ents
    ents.splice(drop, 1)
  }
}

/// Schnittpunkte eines waagrechten Strahls ab q nach +x (gerade/ungerade-Regel)
export function crossings(q, ents) {
  let n = 0
  for (const e of ents) {
    if (e.t === 'line') {
      const [[x0, y0], [x1, y1]] = [e.a, e.b]
      if (y0 > q[1] !== y1 > q[1] && x0 + ((q[1] - y0) * (x1 - x0)) / (y1 - y0) > q[0]) n++
      continue
    }
    const r = entRadius(e)
    const dy = q[1] - e.c[1]
    if (Math.abs(dy) >= r) continue
    const dx = Math.sqrt(r * r - dy * dy)
    for (const x of [e.c[0] - dx, e.c[0] + dx]) {
      if (x <= q[0]) continue
      if (e.t === 'arc') {
        const [a0, a1] = arcAngles(e)
        let ang = Math.atan2(dy, x - e.c[0])
        while (ang < a0) ang += TWO_PI
        if (ang > a1) continue
      }
      n++
    }
  }
  return n
}

export function insidePoly(q, loops) {
  let n = 0
  for (const lp of loops)
    for (let k = 0; k < lp.length - 1; k++) {
      const [x0, y0] = lp[k]
      const [x1, y1] = lp[k + 1]
      if (y0 > q[1] !== y1 > q[1] && x0 + ((q[1] - y0) * (x1 - x0)) / (y1 - y0) > q[0]) n++
    }
  return n % 2 === 1
}

/// Ein Punkt sicher im Inneren der Fläche (Schwerpunkt reicht bei Ringen und Sicheln nicht)
export function interiorPoint(loops) {
  const pts = loops.flat()
  const c = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
  if (insidePoly(c, loops)) return c
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  for (const eps of [1e-2, 1e-3, 1e-4])
    for (const lp of loops)
      for (let k = 0; k < lp.length - 1; k += Math.max(1, Math.floor((lp.length - 1) / 16))) {
        const [a, b] = [lp[k], lp[k + 1]]
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        const L = dist(a, b) || 1
        const t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
        for (const s of [1, -1]) {
          const q = [m[0] - s * t[1] * eps * size, m[1] + s * t[0] * eps * size]
          if (insidePoly(q, loops)) return q
        }
      }
  return c
}

export const fillLoops = (x) => (Array.isArray(x) ? x : x.loops)

/// Punkt in einer der Schraffurflächen (je Schraffur gerade/ungerade über ihre Ränder)?
export const inFills = (q, fills, group = null) =>
  (fills ?? []).some((x) => (group == null || (!Array.isArray(x) && x.group === group)) && insidePoly(q, fillLoops(x)))

/// Linienstücke (je Kante ein Linienzug) zu geschlossenen Schleifen verketten
export function chainLoops(segs, tol) {
  const left = segs.filter((s) => s.length >= 2).map((s) => s.slice())
  const loops = []
  while (left.length) {
    const chain = left.shift()
    let grew = true
    while (grew && dist(chain[0], chain[chain.length - 1]) > tol) {
      grew = false
      const end = chain[chain.length - 1]
      for (let i = 0; i < left.length; i++) {
        const s = left[i]
        if (dist(s[0], end) <= tol) chain.push(...s.slice(1))
        else if (dist(s[s.length - 1], end) <= tol) chain.push(...s.slice(0, -1).reverse())
        else continue
        left.splice(i, 1)
        grew = true
        break
      }
    }
    if (chain.length >= 3) {
      chain[chain.length - 1] = chain[0].slice()
      loops.push(chain)
    }
  }
  return loops
}
