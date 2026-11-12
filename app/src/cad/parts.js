// Teile aus einer Draftpad-Skizze vorschlagen: je Schraffur-Gruppe ein Körper (Drehen um eine Achse oder Extrudieren).
import { defaults, featureId } from './features.js'
import { fillLoops } from './draftpad.js'

function signedArea(lp) {
  let a = 0
  for (let i = 0; i + 1 < lp.length; i++) a += lp[i][0] * lp[i + 1][1] - lp[i + 1][0] * lp[i][1]
  return a / 2
}

// Polygon an der Halbebene n·(p − o) ≥ 0 abschneiden (Sutherland–Hodgman)
function clip(lp, o, n) {
  const side = (p) => (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1]
  const out = []
  for (let i = 0; i + 1 < lp.length; i++) {
    const a = lp[i]
    const b = lp[i + 1]
    const sa = side(a)
    const sb = side(b)
    if (sa >= 0) out.push(a)
    if (sa >= 0 !== sb >= 0) {
      const t = sa / (sa - sb)
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
    }
  }
  if (out.length) out.push(out[0])
  return out
}

// Fläche einer Schraffur auf einer Seite der Geraden (größte Schleife außen, die anderen Löcher)
function areaOnSide(loops, o, n) {
  const sorted = [...loops].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  return sorted.reduce((sum, lp, k) => sum + (k ? -1 : 1) * Math.abs(signedArea(clip(lp, o, n))), 0)
}

/// Schraffur-Gruppen einer Skizze: [{ group, label, fills: [loops…], area }]
export function fillGroups(sk) {
  const map = new Map()
  for (const f of sk.fills ?? []) {
    const g = Array.isArray(f) ? 'alle' : (f.group ?? 'alle')
    if (!map.has(g)) map.set(g, { group: g, label: Array.isArray(f) ? 'Schraffur' : f.label, fills: [], area: 0 })
    const e = map.get(g)
    const loops = fillLoops(f)
    e.fills.push(loops)
    const sorted = [...loops].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
    e.area += sorted.reduce((a, lp, k) => a + (k ? -1 : 1) * Math.abs(signedArea(lp)), 0)
  }
  return [...map.values()]
}

/// Achsen der Skizze (aus Draftpad markiert), längste zuerst: [{ id, a, b, len }]
function axesOf(sk) {
  const P = (id) => [sk.pts[id].x, sk.pts[id].y]
  return sk.ents
    .filter((e) => e.t === 'line' && e.axis)
    .map((e) => ({ id: e.id, a: P(e.a), b: P(e.b), len: Math.hypot(P(e.b)[0] - P(e.a)[0], P(e.b)[1] - P(e.a)[1]) }))
    .sort((x, y) => y.len - x.len)
}

/// Liegt die Gruppe symmetrisch zu einer Achse (Schnitt eines Drehteils)? → längste solche Achse
export function symmetryAxis(sk, g) {
  for (const ax of axesOf(sk)) {
    const d = [(ax.b[0] - ax.a[0]) / ax.len, (ax.b[1] - ax.a[1]) / ax.len]
    const n = [-d[1], d[0]]
    let left = 0
    let right = 0
    for (const loops of g.fills) {
      left += areaOnSide(loops, ax.a, n)
      right += areaOnSide(loops, ax.a, [-n[0], -n[1]])
    }
    if (left > 0 && right > 0 && Math.min(left, right) / Math.max(left, right) > 0.75) return ax.id
  }
  return null
}

/// Vorschläge für den Teile-Dialog
export function suggestParts(sk) {
  const groups = fillGroups(sk)
  const xs = Object.values(sk.pts).map((p) => p.x)
  const ys = Object.values(sk.pts).map((p) => p.y)
  const span = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 20
  const depth = String(Math.max(5, Math.round(span / 4)))
  return groups
    .sort((a, b) => b.area - a.area)
    .map((g, i) => {
      const axis = symmetryAxis(sk, g)
      return { group: g.group, label: g.label, count: g.fills.length, on: true, name: `Teil ${i + 1}`, kind: axis ? 'revolve' : 'extrude', axis, depth }
    })
}

/// Features für die gewählten Teile (alle mode „new“, je Teil ein benannter Körper)
export function partFeatures(features, sketchId, rows, subtract = true) {
  const list = [...features]
  const out = []
  for (const r of rows) {
    if (!r.on) continue
    const id = featureId(list)
    const f = {
      ...defaults(r.kind),
      id,
      type: r.kind,
      name: r.name,
      sketch: sketchId,
      regions: null,
      useFills: true,
      fillGroup: r.group,
      mode: 'new',
      bodyName: r.name,
      subtract,
    }
    if (r.kind === 'revolve') Object.assign(f, { axis: r.axis, angle: '360' })
    else Object.assign(f, { depth: r.depth, symmetric: true })
    list.push(f)
    out.push(f)
  }
  return out
}
