// Draftpad-Zeichnung (.draftpad.json, Format „skizzen-cad“) als Skizze übernehmen.
//
// Draftpad: Millimeter, y nach unten; Bögen mit start/sweep (Bogenmaß, positiv = im Uhrzeigersinn am Bildschirm).
// Skizze: y nach oben, Bögen gegen den Uhrzeigersinn von a nach b.
import { addPoint, addEnt, addCon } from './sketch.js'
import { solve } from './solver.js'

const GEO = new Set(['line', 'arc', 'circle'])

/// Datei prüfen und Ebenen mit Inhalt auflisten
export function readDraftpad(text) {
  let d
  try {
    d = JSON.parse(text)
  } catch {
    throw new Error('Keine gültige Draftpad-Datei (JSON)')
  }
  if (d?.format !== 'skizzen-cad' || !Array.isArray(d.entities) || !Array.isArray(d.layers)) throw new Error('Keine Draftpad-Zeichnung (Format „skizzen-cad“)')
  const layers = d.layers.map((l) => {
    const ents = d.entities.filter((e) => e.layerId === l.id)
    const count = (k) => ents.filter((e) => e.kind === k).length
    return { id: l.id, name: l.name || 'Ebene', visible: l.visible !== false, lines: count('line'), arcs: count('arc') + count('circle'), hatches: count('hatch'), strokes: count('stroke') }
  })
  return { doc: d, layers }
}

/// Vorschlag: sichtbare Ebenen mit Linien; gibt es eine „Reinzeichnung“, nur diese (die Skizze liegt meist darunter)
export function defaultLayers(layers) {
  const geo = layers.filter((l) => l.lines + l.arcs > 0)
  const clean = geo.filter((l) => /rein/i.test(l.name) && l.visible)
  if (clean.length) return new Set(clean.map((l) => l.id))
  const vis = geo.filter((l) => l.visible)
  return new Set((vis.length ? vis : geo).map((l) => l.id))
}

const flip = (p) => [p.x, -p.y]

/// Grundelemente (Skizzenkoordinaten) der gewählten Ebenen
function primitives(doc, layerIds) {
  const out = []
  for (const e of doc.entities) {
    if (!layerIds.has(e.layerId) || !GEO.has(e.kind)) continue
    const lt = e.style?.lineType ?? 'solid'
    const cons = e.axis || lt === 'dashdot' || lt === 'dashdotdot' || lt === 'dashed'
    if (e.kind === 'line') out.push({ did: e.id, t: 'line', a: flip(e.a), b: flip(e.b), cons, axis: !!e.axis, hidden: lt === 'dashed' })
    else if (e.kind === 'circle') out.push({ did: e.id, t: 'circle', c: flip(e.c), r: e.r, cons, mark: !!e.mark })
    else {
      const c = flip(e.c)
      const s = -e.start
      const w = -e.sweep
      // gegen den Uhrzeigersinn: von min(s, s+w) nach max(s, s+w)
      const a0 = Math.min(s, s + w)
      const a1 = Math.max(s, s + w)
      if (Math.abs(a1 - a0) >= 2 * Math.PI - 1e-9) out.push({ did: e.id, t: 'circle', c, r: e.r, cons })
      else out.push({ did: e.id, t: 'arc', c, r: e.r, a: [c[0] + e.r * Math.cos(a0), c[1] + e.r * Math.sin(a0)], b: [c[0] + e.r * Math.cos(a1), c[1] + e.r * Math.sin(a1)], cons })
    }
  }
  // Freihand-Striche, die an beiden Enden an Konturen anschließen (z. B. Bruchlinien), schließen eine Kontur:
  // als Linienzug übernehmen. Freie Notizen und Pfeile bleiben weg.
  const ends = out.flatMap((p) => (p.t === 'line' || p.t === 'arc' ? (p.cons ? [] : [p.a, p.b]) : []))
  const lines = out.filter((p) => p.t === 'line' && !p.cons)
  const near = (q) => {
    const tol = 1.0
    if (ends.some((e) => Math.hypot(e[0] - q[0], e[1] - q[1]) <= tol)) return true
    return lines.some((l) => {
      const dx = l.b[0] - l.a[0]
      const dy = l.b[1] - l.a[1]
      const L2 = dx * dx + dy * dy || 1
      const t = Math.max(0, Math.min(1, ((q[0] - l.a[0]) * dx + (q[1] - l.a[1]) * dy) / L2))
      return Math.hypot(l.a[0] + t * dx - q[0], l.a[1] + t * dy - q[1]) <= tol
    })
  }
  for (const e of doc.entities) {
    if (e.kind !== 'stroke' || !layerIds.has(e.layerId) || (e.pts?.length ?? 0) < 4) continue
    const pts = []
    for (let i = 0; i + 1 < e.pts.length; i += 2) pts.push([e.pts[i], -e.pts[i + 1]])
    if (!near(pts[0]) || !near(pts[pts.length - 1])) continue
    const simple = simplify(pts, 0.15)
    for (let i = 0; i + 1 < simple.length; i++) out.push({ did: `${e.id}_${i}`, t: 'line', a: simple[i], b: simple[i + 1], cons: false, stroke: true })
  }
  return out
}

// Linienzug vereinfachen (Douglas–Peucker)
function simplify(pts, tol) {
  if (pts.length < 3) return pts
  const [a, b] = [pts[0], pts[pts.length - 1]]
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = Math.hypot(dx, dy) || 1
  let worst = 0
  let k = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * (pts[i][0] - a[0]) - dx * (pts[i][1] - a[1])) / L
    if (d > worst) {
      worst = d
      k = i
    }
  }
  if (worst <= tol) return [a, b]
  const left = simplify(pts.slice(0, k + 1), tol)
  return [...left.slice(0, -1), ...simplify(pts.slice(k), tol)]
}

const PATTERN_NAME = { diag: 'Schraffur 45°', diag2: 'Schraffur −45°', cross: 'Kreuzschraffur', steel: 'Stahl', plastic: 'Kunststoff', dots: 'Punkte' }

function polyArea(lp) {
  let a = 0
  for (let i = 0; i + 1 < lp.length; i++) a += lp[i][0] * lp[i + 1][1] - lp[i + 1][0] * lp[i][1]
  return Math.abs(a) / 2
}

/// Schraffurflächen in Skizzenkoordinaten, je Schraffur { loops, group, label }.
/// Gruppe = gleiches Muster, gleicher Winkel, gleicher Abstand, gleiche Farbe – in technischen Zeichnungen ist das
/// ein Teil. Schraffuren auf ausgeblendeten Ebenen, die genauso auf einer sichtbaren liegen, zählen nur einmal.
function fillsOf(doc) {
  const vis = new Map(doc.layers.map((l) => [l.id, l.visible !== false]))
  const lname = new Map(doc.layers.map((l) => [l.id, l.name || 'Ebene']))
  const all = []
  for (const e of doc.entities) {
    if (e.kind !== 'hatch') continue
    const loops = (e.loops ?? [])
      .map((lp) => {
        const pts = []
        for (let i = 0; i + 1 < lp.length; i += 2) pts.push([lp[i], -lp[i + 1]])
        if (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) pts.push([...pts[0]])
        return pts
      })
      .filter((lp) => lp.length >= 4)
    if (!loops.length) continue
    const xs = loops[0].map((p) => p[0])
    const ys = loops[0].map((p) => p[1])
    const key = `${e.pattern ?? 'diag'}|${e.angle ?? 0}|${e.spacing ?? 0}|${e.style?.color ?? ''}`
    const label = `${PATTERN_NAME[e.pattern] ?? e.pattern ?? 'Schraffur'}${e.angle ? ` (+${e.angle}°)` : ''}, Abstand ${String(e.spacing ?? '–').replace('.', ',')} mm`
    all.push({ loops, key, label, layer: lname.get(e.layerId), visible: vis.get(e.layerId), area: polyArea(loops[0]), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
  }
  // Doppel weglassen: ausgeblendete Schraffur mit (fast) gleicher Lage und Fläche wie eine sichtbare
  const same = (a, b) => Math.abs(a.area - b.area) <= 0.03 * Math.max(a.area, b.area) && a.box.every((v, i) => Math.abs(v - b.box[i]) <= 0.5)
  const keep = all.filter((h) => h.visible || !all.some((o) => o !== h && o.visible && same(h, o)))
  return keep.map((h) => ({ loops: h.loops, group: h.key, label: h.label, layer: h.layer }))
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])

/// Zeichnung in die Skizze übernehmen.
/// opts: { layers: Set, tol (mm, Punkte zusammenführen), center (Mitte auf den Ursprung), fixed (Geometrie fest),
///         fills (schraffierte Flächen als Material vorwählen), scale }
/// → { sketch, stats: { lines, arcs, circles, merged, cons, solved } }
export function importDraftpad(sk0, doc, opts) {
  const tol = opts.tol ?? 0.3
  const k = opts.scale ?? 1
  let prims = primitives(doc, opts.layers)
  if (!prims.length) throw new Error('Auf den gewählten Ebenen sind keine Linien, Bögen oder Kreise')
  // Maßstab und Lage
  const all = prims.flatMap((p) => (p.t === 'line' ? [p.a, p.b] : [[p.c[0] - p.r, p.c[1] - p.r], [p.c[0] + p.r, p.c[1] + p.r]]))
  const lo = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))]
  const hi = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))]
  const off = opts.offset ?? (opts.center ? [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2] : [0, 0])
  const tr = (p) => [(p[0] + off[0]) * k, (p[1] + off[1]) * k]
  prims = prims.map((p) => (p.t === 'line' ? { ...p, a: tr(p.a), b: tr(p.b) } : p.t === 'circle' ? { ...p, c: tr(p.c), r: p.r * k } : { ...p, c: tr(p.c), a: tr(p.a), b: tr(p.b), r: p.r * k }))

  // doppelte Elemente (Skizze und Reinzeichnung übereinander) nur einmal
  const key = (p) =>
    p.t === 'line'
      ? [p.a, p.b].map((q) => q.map((v) => Math.round(v / tol)).join(',')).sort().join('|')
      : `${p.t}:${p.c.map((v) => Math.round(v / tol)).join(',')}:${Math.round(p.r / tol)}` + (p.t === 'arc' ? `:${p.a.map((v) => Math.round(v / tol))}` : '')
  const seen = new Map()
  for (const p of prims) {
    if (p.t === 'line' && dist(p.a, p.b) < tol) continue
    const kk = key(p)
    const old = seen.get(kk)
    if (!old || (old.cons && !p.cons)) seen.set(kk, p)
  }
  prims = [...seen.values()]

  // Endpunkte zusammenführen (Lücken bis tol)
  const s = structuredClone(sk0)
  const pts = [] // { at, id }
  const grid = new Map()
  const cell = (q) => `${Math.floor(q[0] / tol)},${Math.floor(q[1] / tol)}`
  let merged = 0
  const stable = !!opts.stableIds
  const pointFor = (q, fix = false, wanted = null) => {
    const [cx, cy] = cell(q).split(',').map(Number)
    let best = null
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const c of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const d = dist(c.at, q)
          if (d <= tol && (!best || d < best.d)) best = { c, d }
        }
    if (best) {
      if (best.d > 0) merged++
      return best.c.id
    }
    const id = addPoint(s, q, fix, stable ? wanted : null)
    const c = { at: q, id }
    pts.push(c)
    const kk = cell(q)
    if (!grid.has(kk)) grid.set(kk, [])
    grid.get(kk).push(c)
    return id
  }
  const fixed = !!opts.fixed
  const made = []
  for (const p of prims) {
    let e
    const sid = (suffix) => (stable && p.did ? `d_${p.did}${suffix}` : null)
    const ent = (x) => addEnt(s, stable && p.did && !s.ents.some((o) => o.id === `d_${p.did}`) ? { ...x, id: `d_${p.did}` } : x)
    if (p.t === 'line') e = ent({ t: 'line', a: pointFor(p.a, fixed, sid('_a')), b: pointFor(p.b, fixed, sid('_b')), cons: p.cons || undefined, axis: p.axis || undefined })
    else if (p.t === 'circle') {
      e = ent({ t: 'circle', c: pointFor(p.c, fixed, sid('_c')), r: p.r, cons: p.cons || undefined, fix: fixed || undefined })
      // Kreis mit Achsenkreuz: Mitte als Punkt (Bohrpunkt für „Bohrung“)
      if (p.mark && opts.markPoints !== false) addEnt(s, { t: 'point', p: e.c, ...(stable && p.did ? { id: `d_${p.did}_m` } : {}) })
    }
    else e = ent({ t: 'arc', c: pointFor(p.c, fixed, sid('_c')), a: pointFor(p.a, fixed, sid('_a')), b: pointFor(p.b, fixed, sid('_b')), cons: p.cons || undefined })
    made.push(e)
  }
  // zusammengeführte Punkte liegen etwas daneben: auf den Mittelwert setzen
  // (Mittelpunkt bleibt; bei Bögen erzwingt der Löser gleichen Abstand)

  // offene Enden auf Linien in der Nähe (T-Stoß) anheften
  const lines = made.filter((e) => e.t === 'line')
  const useCount = new Map()
  for (const e of made) for (const id of e.t === 'line' ? [e.a, e.b] : e.t === 'arc' ? [e.a, e.b] : []) useCount.set(id, (useCount.get(id) ?? 0) + 1)
  let tees = 0
  const P = (id) => [s.pts[id].x, s.pts[id].y]
  for (const [id, n] of useCount) {
    if (n !== 1) continue
    const q = P(id)
    let best = null
    for (const l of lines) {
      if (l.a === id || l.b === id || l.cons) continue
      const a = P(l.a)
      const b = P(l.b)
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const L2 = dx * dx + dy * dy
      if (!L2) continue
      const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2
      if (t <= 0 || t >= 1) continue
      const f = [a[0] + t * dx, a[1] + t * dy]
      const d = dist(f, q)
      if (d <= tol && (!best || d < best.d)) best = { l, f, d }
    }
    if (best) {
      if (!fixed) addCon(s, { t: 'on', p: id, e: best.l.id })
      s.pts[id].x = best.f[0]
      s.pts[id].y = best.f[1]
      tees++
    }
  }

  // Bedingungen erkennen: waagrecht/senkrecht, tangentiale Übergänge Linie–Bogen
  let cons = 0
  if (!fixed) {
    for (const l of lines) {
      const a = P(l.a)
      const b = P(l.b)
      const L = dist(a, b)
      if (Math.abs(a[1] - b[1]) < 1e-3 * Math.max(L, 1)) {
        addCon(s, { t: 'h', a: l.a, b: l.b })
        cons++
      } else if (Math.abs(a[0] - b[0]) < 1e-3 * Math.max(L, 1)) {
        addCon(s, { t: 'v', a: l.a, b: l.b })
        cons++
      }
    }
    for (const arc of made.filter((e) => e.t === 'arc')) {
      const c = P(arc.c)
      for (const end of [arc.a, arc.b]) {
        const q = P(end)
        const rad = [q[0] - c[0], q[1] - c[1]]
        const rl = Math.hypot(...rad) || 1
        for (const l of lines) {
          if (l.cons || (l.a !== end && l.b !== end)) continue
          const d = [P(l.b)[0] - P(l.a)[0], P(l.b)[1] - P(l.a)[1]]
          const dl = Math.hypot(...d) || 1
          if (Math.abs((rad[0] * d[0] + rad[1] * d[1]) / (rl * dl)) < 2e-3) {
            addCon(s, { t: 'tan', e1: l.id, e2: arc.id })
            cons++
          }
        }
      }
    }
  }
  if (opts.fills) {
    const fl = fillsOf(doc).map((f) => ({ ...f, loops: f.loops.map((lp) => lp.map(tr)) }))
    if (fl.length) s.fills = [...(s.fills ?? []), ...fl]
  }
  // lösen; klappt es nicht (z. B. widersprüchliche Bedingungen aus ungenauer Zeichnung), Bedingungen weglassen
  let ok = true
  if (!fixed) {
    const t = structuredClone(s)
    const r = solve(t, { analyse: false, maxIter: 40 })
    if (r.ok) Object.assign(s, t)
    else {
      s.cons = s.cons.filter((c) => !sk0.cons.some((o) => o.id === c.id) ? c.t === 'on' : true)
      const t2 = structuredClone(s)
      ok = solve(t2, { analyse: false, maxIter: 40 }).ok
      if (ok) Object.assign(s, t2)
      cons = 0
    }
  }
  return {
    sketch: s,
    stats: {
      lines: made.filter((e) => e.t === 'line').length,
      arcs: made.filter((e) => e.t === 'arc').length,
      circles: made.filter((e) => e.t === 'circle').length,
      merged,
      tees,
      cons,
      solved: ok,
      fills: s.fills?.length ?? 0,
      size: [(hi[0] - lo[0]) * k, (hi[1] - lo[1]) * k],
      offset: off,
    },
  }
}

/// Schleifen einer Schraffur (neue Form { loops } oder alte Form: Liste von Schleifen)
export const fillLoops = (f) => (Array.isArray(f) ? f : f.loops)

/// Ist ein Punkt in einer der Schraffurflächen? (gerade/ungerade je Schraffur)
export function inFills(q, fills, group = null) {
  for (const f of fills ?? []) {
    if (group != null && f.group !== group) continue
    let n = 0
    for (const lp of fillLoops(f))
      for (let i = 0; i < lp.length - 1; i++) {
        const [x0, y0] = lp[i]
        const [x1, y1] = lp[i + 1]
        if (y0 > q[1] !== y1 > q[1] && x0 + ((q[1] - y0) * (x1 - x0)) / (y1 - y0) > q[0]) n++
      }
    if (n % 2) return true
  }
  return false
}
