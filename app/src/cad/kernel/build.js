// Neuer Geometriekern: OpenCASCADE (WebAssembly, über replicad) – führt die Feature-Liste aus wie cad.py
// und liefert dieselbe Antwort ({ status, volume, bodies, bodies_info, tess, regions }).
// Läuft im Web Worker (worker.js) und in Node (Tests). Vorher: setOC(oc) aus replicad.
import { getOC, cast, makeLine, makeCircle, makeThreePointArc, makePolygon, basicFaceExtrusion, revolution, measureArea, measureShapeVolumeProperties, exportSTEP, Vector, assembleWire, genericSweep, loft } from 'replicad'
import { arcAngles, entRadius, pruneOpen, crossings, insidePoly, interiorPoint, inFills, chainLoops } from './geom2d.js'

export class Problem extends Error {}

// --- Vektoren ---------------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => Math.hypot(a[0], a[1], a[2])
const unit = (a) => mul(a, 1 / (norm(a) || 1))
const dist3 = (a, b) => norm(sub(a, b))

/// Ebene → Ursprung und Basis (wie plane_basis in cad.py bzw. basis in sketch.js)
export function planeBasis(plane) {
  const n = unit(plane.normal)
  let u = plane.u ?? [0, 0, 0]
  u = sub(u, mul(n, dot(u, n)))
  if (norm(u) < 1e-9) {
    const k = [0, 1, 2].reduce((a, i) => (Math.abs(n[i]) < Math.abs(n[a]) ? i : a), 0)
    const e = [0, 0, 0]
    e[k] = 1
    u = sub(e, mul(n, dot(e, n)))
  }
  u = unit(u)
  return { o: plane.origin, u, v: cross(n, u), n }
}
const to3 = (B, [x, y]) => add(add(B.o, mul(B.u, x)), mul(B.v, y))
const to2 = (B, p) => {
  const d = sub(p, B.o)
  return [dot(d, B.u), dot(d, B.v)]
}

// --- Hilfen für OpenCASCADE --------------------------------------------------------------------
const oc = () => getOC()
const tuple = (v) => (Array.isArray(v) ? v : v.toTuple())

function bboxOf(shapes) {
  let lo = [Infinity, Infinity, Infinity]
  let hi = [-Infinity, -Infinity, -Infinity]
  for (const s of shapes) {
    const [a, b] = s.boundingBox.bounds
    lo = lo.map((x, i) => Math.min(x, a[i]))
    hi = hi.map((x, i) => Math.max(x, b[i]))
  }
  return Number.isFinite(lo[0]) ? [lo, hi] : null
}
const boxesTouch = (a, b, tol) => [0, 1, 2].every((i) => a[0][i] <= b[1][i] + tol && b[0][i] <= a[1][i] + tol)
const volumeOf = (s) => measureShapeVolumeProperties(s).volume

/// Boolesche Operation auf beliebigen Formen (auch Flächen) → replicad-Form
function bool(kind, a, b) {
  const O = oc()
  const C = { common: O.BRepAlgoAPI_Common, cut: O.BRepAlgoAPI_Cut, fuse: O.BRepAlgoAPI_Fuse }[kind]
  const op = new C(a.wrapped, b.wrapped, new O.Message_ProgressRange())
  if (!op.IsDone()) {
    op.delete()
    throw new Error(`${kind} fehlgeschlagen`)
  }
  const r = cast(op.Shape())
  op.delete()
  return r
}

const solidsOf = (shape) => (shape.solids ?? []).filter((s) => !s.isNull)

/// mehrere Körper zu einem verschmelzen (Ergebnis: Liste der entstandenen Einzelkörper)
function fuseAll(shapes) {
  if (shapes.length === 1) return [shapes[0]]
  let acc = shapes[0]
  for (const s of shapes.slice(1)) acc = acc.fuse(s)
  return solidsOf(acc)
}

// --- Skizzen ----------------------------------------------------------------------------------

function sketchSize(ents) {
  const xs = []
  const ys = []
  for (const e of ents) {
    if (e.t === 'line') {
      xs.push(e.a[0], e.b[0])
      ys.push(e.a[1], e.b[1])
    } else {
      const r = entRadius(e)
      xs.push(e.c[0] - r, e.c[0] + r)
      ys.push(e.c[1] - r, e.c[1] + r)
    }
  }
  return { lo: [Math.min(...xs), Math.min(...ys)], hi: [Math.max(...xs), Math.max(...ys)] }
}

/// Kante als Linienzug in Skizzenkoordinaten
function edgePolyline2(edge, B) {
  const kind = edge.geomType
  const n = kind === 'LINE' ? 1 : 48
  const out = []
  for (let k = 0; k <= n; k++) out.push(to2(B, tuple(edge.pointAt(k / n))))
  return out
}

/// Alle geschlossenen Bereiche einer Skizze → [{ face, pt, area, loops, evenodd }]
export function sketchRegions(sk) {
  const ents0 = sk.ents ?? []
  if (!ents0.length) return []
  const { lo, hi } = sketchSize(ents0)
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-6)
  const ents = pruneOpen(ents0.map((e) => ({ ...e })), 1e-6 * size + 1e-9)
  if (!ents.length) return []
  const B = planeBasis(sk.plane)
  const O = oc()
  const tools = new O.NCollection_List_TopoDS_Shape()
  for (const e of ents) {
    let edge
    if (e.t === 'line') edge = makeLine(to3(B, e.a), to3(B, e.b))
    else if (e.t === 'circle') edge = makeCircle(e.r, to3(B, e.c), B.n)
    else {
      const [a0, a1] = arcAngles(e)
      const r = entRadius(e)
      const m = (a0 + a1) / 2
      edge = makeThreePointArc(to3(B, e.a), to3(B, [e.c[0] + r * Math.cos(m), e.c[1] + r * Math.sin(m)]), to3(B, e.b))
    }
    tools.Append(edge.wrapped)
  }
  const m = 0.5 * size + 1
  const big = makePolygon([
    [lo[0] - m, lo[1] - m],
    [hi[0] + m, lo[1] - m],
    [hi[0] + m, hi[1] + m],
    [lo[0] - m, hi[1] + m],
  ].map((p) => to3(B, p)))
  const args = new O.NCollection_List_TopoDS_Shape()
  args.Append(big.wrapped)
  const sp = new O.BRepAlgoAPI_Splitter()
  sp.SetArguments(args)
  sp.SetTools(tools)
  sp.Build()
  if (!sp.IsDone() || sp.HasErrors()) {
    sp.delete()
    throw new Problem('Skizze: Die Flächen der Skizze lassen sich nicht bilden')
  }
  const faces = cast(sp.Shape()).faces
  sp.delete()
  const regions = []
  for (const face of faces) {
    const segs = face.edges.map((e) => edgePolyline2(e, B))
    const xs = segs.flat().map((p) => p[0])
    if (Math.min(...xs) < lo[0] - 0.5 * m && Math.max(...xs) > hi[0] + 0.5 * m) continue // Außenbereich
    const loops = chainLoops(segs, 1e-6 * size + 1e-7)
    if (!loops.length) continue
    const pt = interiorPoint(loops)
    regions.push({ face, pt, area: measureArea(face), loops, evenodd: crossings(pt, ents) % 2 === 1 })
  }
  return regions
}

/// Bereiche je Skizze merken (eine geänderte Extrusionstiefe zerlegt die Skizze nicht neu)
const REGION_CACHE = new Map()
function regionsOf(sk) {
  const key = JSON.stringify([sk.plane, sk.ents])
  if (!REGION_CACHE.has(key)) {
    REGION_CACHE.set(key, sketchRegions(sk))
    if (REGION_CACHE.size > 30) REGION_CACHE.delete(REGION_CACHE.keys().next().value)
  }
  // Flächen kopieren: Verschieben/Drehen verbraucht sie
  return REGION_CACHE.get(key).map((r) => ({ ...r, face: r.face.clone() }))
}

/// Gewählte Bereiche der Skizze als Flächen im Raum (Auswahl per Punkt, Schraffur oder gerade/ungerade)
function sketchFaces(sk, picks, what, fills) {
  const regions = regionsOf(sk)
  if (!regions.length) throw new Problem(`${what}: keine geschlossene Kontur – Linien müssen an den Enden zusammenhängen`)
  if (picks != null && picks.length === 0) throw new Problem(`${what}: keine Fläche gewählt – Flächen der Skizze im Bild anklicken`)
  let chosen = null
  if (picks?.length) {
    const pts = picks.map((p) => (Array.isArray(p) ? p : p.pt))
    chosen = regions.filter((r) => pts.some((p) => insidePoly(p, r.loops)))
    const lost = pts.filter((p) => !regions.some((r) => insidePoly(p, r.loops))).length
    if (!chosen.length) throw new Problem(`${what}: die gewählten Flächen gibt es nicht mehr (Skizze geändert?) – im Feature neu wählen`)
    if (lost) throw new Problem(`${what}: ${lost} von ${pts.length} gewählten Flächen gibt es nicht mehr (Skizze geändert?) – im Feature neu wählen`)
  } else if (fills && sk.fills?.length) {
    const group = typeof fills === 'object' ? fills.group : null
    chosen = regions.filter((r) => inFills(r.pt, sk.fills, group))
    if (!chosen.length) {
      if (group != null) throw new Problem(`${what}: Diese Schraffur gibt es in der Skizze nicht mehr – Flächen im Bild wählen`)
      chosen = null
    }
  }
  if (!chosen) chosen = regions.filter((r) => r.evenodd)
  return chosen.map((r) => r.face)
}

// --- Modell -----------------------------------------------------------------------------------

class Model {
  constructor(bodies = []) {
    this.bodies = bodies // [{ shape, name }]
  }
  clone() {
    // gemeinsamer Merkzettel (Netz, Volumen): was später am Original berechnet wird, hat auch die Kopie
    return new Model(this.bodies.map((b) => ({ shape: b.shape.clone(), name: b.name, memo: (b.memo ??= {}) })))
  }
  get shapes() {
    return this.bodies.map((b) => b.shape)
  }
  diag(extra = []) {
    const bb = bboxOf([...this.shapes, ...extra])
    return bb ? dist3(bb[0], bb[1]) : 1
  }
  volume() {
    return this.bodies.reduce((s, b) => s + massOf(b).volume, 0)
  }
}

/// Werkzeugkörper hinzufügen, abziehen oder als neuen Körper stehen lassen
function combine(model, mode, tools, warn, name = null) {
  if (!tools.length) throw new Problem('Es ist kein Körper entstanden')
  if (mode === 'new' || (mode === 'add' && !model.bodies.length)) {
    for (const s of fuseAll(tools)) model.bodies.push({ shape: s, name })
    return
  }
  if (mode === 'add') {
    const tol = 1e-6 * model.diag(tools)
    const tb = bboxOf(tools)
    const near = model.bodies.filter((b) => boxesTouch(bboxOf([b.shape]), tb, tol))
    if (!near.length) {
      for (const s of fuseAll(tools)) model.bodies.push({ shape: s, name: null })
      warn.push('Das neue Material berührt das Bauteil nicht – es ist ein eigener, loser Körper')
      return
    }
    const before = model.bodies.length
    const merged = fuseAll([...near.map((b) => b.shape), ...tools])
    const keepName = near.find((b) => b.name)?.name ?? null
    model.bodies = [...model.bodies.filter((b) => !near.includes(b)), ...merged.map((s) => ({ shape: s, name: keepName }))]
    if (model.bodies.length > before) warn.push('Das neue Material berührt das Bauteil nicht – es ist ein eigener, loser Körper')
    return
  }
  if (mode === 'cut') {
    if (!model.bodies.length) throw new Problem('Entfernen: Es gibt noch keinen Körper')
    const tool = fuseAll(tools).reduce((a, s) => (a ? a.fuse(s) : s), null)
    const vol0 = model.volume()
    const before = model.bodies.length
    const tb = bboxOf([tool])
    const out = []
    for (const b of model.bodies) {
      if (!boxesTouch(bboxOf([b.shape]), tb, 0)) {
        out.push(b)
        continue
      }
      for (const s of solidsOf(b.shape.cut(tool))) out.push({ shape: s, name: b.name })
    }
    model.bodies = out
    if (!out.length) throw new Problem('Entfernen: Es bliebe nichts übrig')
    if (Math.abs(model.volume() - vol0) < 1e-7 * Math.max(vol0, 1e-9)) warn.push('Es wurde nichts entfernt – der Bereich trifft kein Material')
    if (out.length > before) warn.push('Der Schnitt trennt das Bauteil in mehrere Körper')
    return
  }
  throw new Problem(`unbekannte Art „${mode}“`)
}

function sketchOf(f, sketches, what) {
  const sk = sketches.get(f.sketch)
  if (!sk) throw new Problem(`${what}: Skizze fehlt (gelöscht oder unterdrückt?)`)
  return sk
}

// --- Werkzeugkörper ----------------------------------------------------------------------------

function toolsExtrude(model, f, sketches) {
  const sk = sketchOf(f, sketches, 'Extrudieren')
  let faces = sketchFaces(sk, f.regions, 'Extrudieren', f.fills)
  const B = planeBasis(sk.plane)
  const d = f.dir || 1
  const through = !!f.through
  let depth = Number(f.depth) || 0
  if (through) {
    const bb = bboxOf(model.shapes)
    depth = 2 * model.diag(faces) + 2 * (bb ? dist3(B.o, bb[0]) : 0)
  }
  if (depth <= 0) throw new Problem('Extrudieren: Tiefe muss größer als 0 sein')
  let start = 0
  if (f.symmetric) {
    start = through ? -depth : -depth / 2
    if (through) depth *= 2
  } else if (through) {
    start = -1e-4 * model.diag(faces)
    depth -= start
  }
  if (start) faces = faces.map((x) => x.translate(mul(B.n, d * start)))
  return faces.map((x) => basicFaceExtrusion(x, new Vector(mul(B.n, d * depth))))
}

/// Bereiche, die über die Drehachse reichen, auf die Seite mit der größeren Fläche beschneiden
function halfPlane(faces, sk, ax, warn, size) {
  const B = planeBasis(sk.plane)
  const [a, b] = [ax.a, ax.b]
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  const nrm = [-d[1], d[0]]
  const big = 4 * Math.max(size, ...[...a, ...b].map(Math.abs), 1)
  const halves = [1, -1].map((side) => {
    const rect = makePolygon(
      [[-big, 0], [big, 0], [big, big], [-big, big]].map(([t, h]) => to3(B, [a[0] + d[0] * t + nrm[0] * side * h, a[1] + d[1] * t + nrm[1] * side * h])),
    )
    const parts = []
    for (const f of faces) {
      try {
        parts.push(...bool('common', f, rect).faces)
      } catch {
        /* nichts auf dieser Seite */
      }
    }
    return { area: parts.reduce((s, x) => s + measureArea(x), 0), parts }
  })
  const total = faces.reduce((s, x) => s + measureArea(x), 0)
  const keep = halves[0].area >= halves[1].area ? halves[0] : halves[1]
  if (keep.area > total * (1 - 1e-9)) return faces
  warn.push('Die Kontur reicht über die Drehachse – gedreht wird nur die Hälfte auf einer Seite (bei Schnittzeichnungen richtig)')
  return keep.parts
}

function toolsRevolve(model, f, sketches, warn) {
  const sk = sketchOf(f, sketches, 'Drehen')
  const ax = f.axis
  if (!ax) throw new Problem('Drehen: Drehachse fehlt – eine Linie der Skizze als Achse wählen')
  let faces = sketchFaces(sk, f.regions, 'Drehen', f.fills)
  faces = halfPlane(faces, sk, ax, warn, model.diag(faces))
  if (!faces.length) throw new Problem('Drehen: Neben der Achse liegt keine Fläche')
  const B = planeBasis(sk.plane)
  const p = to3(B, ax.a)
  const q = to3(B, ax.b)
  if (dist3(p, q) < 1e-9) throw new Problem('Drehen: Die Achse hat keine Länge')
  let a = unit(sub(q, p))
  if (f._mirrored) a = mul(a, -1)
  let ang = Number(f.angle) || 360
  if (ang <= 0) throw new Problem('Drehen: Winkel muss größer als 0 sein')
  ang = Math.min(ang, 360)
  if (f.symmetric && ang < 360) faces = faces.map((x) => x.rotate(-ang / 2, p, a))
  try {
    return faces.flatMap((x) => solidsOf(revolution(x, p, a, ang)))
  } catch {
    throw new Problem('Drehen: Die Kontur darf die Drehachse nicht kreuzen')
  }
}

function toolsHole(model, f, sketches) {
  const sk = sketchOf(f, sketches, 'Bohrung')
  let pts = [...(sk.pts ?? [])]
  if (!pts.length) pts = (sk.ents ?? []).filter((e) => e.t === 'circle').map((e) => e.c)
  if (!pts.length) throw new Problem('Bohrung: In der Skizze ist kein Punkt – Punkte setzen, wo gebohrt werden soll')
  const dia = Number(f.diameter) || 0
  if (dia <= 0) throw new Problem('Bohrung: Durchmesser muss größer als 0 sein')
  const r = dia / 2
  const B = planeBasis(sk.plane)
  const a = mul(B.n, f.flip ? 1 : -1) // in das Material hinein
  const w = B.u // senkrecht zur Achse
  const through = !!f.through
  const depth = through ? 2 * model.diag() : Number(f.depth) || 0
  if (depth <= 0) throw new Problem('Bohrung: Tiefe muss größer als 0 sein')
  const ext = 1e-3 * dia
  const sink = f.sink ?? {}
  // Umriss der Bohrung (Radius, Tiefe) – um die Achse gedreht
  const prof = []
  if (sink.kind === 'cone') {
    const D = Number(sink.d) || 0
    if (D <= dia) throw new Problem('Bohrung: Senkdurchmesser muss größer als der Bohrungsdurchmesser sein')
    const h = (D / 2 - r) / Math.tan(((Number(sink.angle) || 90) * Math.PI) / 360)
    prof.push([D / 2, -ext], [D / 2, 0], [r, h])
  } else if (sink.kind === 'cyl') {
    const D = Number(sink.d) || 0
    const t = Number(sink.depth) || 0
    if (D <= dia || t <= 0) throw new Problem('Bohrung: Senkung braucht einen größeren Durchmesser und eine Tiefe')
    prof.push([D / 2, -ext], [D / 2, t], [r, t])
  } else prof.push([r, -ext])
  prof.push([r, depth])
  if (!through && f.tip !== false) prof.push([0, depth + r / Math.tan((59 * Math.PI) / 180)])
  else prof.push([0, depth])
  prof.push([0, -ext])
  return pts.map((p2) => {
    const p = to3(B, p2)
    const face = makePolygon(prof.map(([rr, s]) => add(add(p, mul(a, s)), mul(w, rr))))
    return solidsOf(revolution(face, p, a, 360))[0]
  })
}

/// Pfad einer Skizze (Linien und Bögen, zusammenhängend) als Draht im Raum
function pathWire(sk, what) {
  const ents = (sk.ents ?? []).filter((e) => e.t === 'line' || e.t === 'arc')
  if (!ents.length) throw new Problem(`${what}: Die Pfad-Skizze hat keine Linien oder Bögen`)
  const B = planeBasis(sk.plane)
  const key = (p) => p.map((v) => v.toFixed(4)).join(',')
  const count = new Map()
  for (const e of ents) for (const p of [e.a, e.b]) count.set(key(p), (count.get(key(p)) ?? 0) + 1)
  // Anfang: ein Ende, das nur einmal vorkommt (offener Pfad), sonst irgendeins
  let cur = ents.find((e) => count.get(key(e.a)) === 1)?.a ?? ents.find((e) => count.get(key(e.b)) === 1)?.b ?? ents[0].a
  const left = [...ents]
  const edges = []
  while (left.length) {
    const i = left.findIndex((e) => key(e.a) === key(cur) || key(e.b) === key(cur))
    if (i < 0) throw new Problem(`${what}: Der Pfad muss zusammenhängen (eine Linie ohne Abzweigungen)`)
    const e = left.splice(i, 1)[0]
    const fwd = key(e.a) === key(cur)
    const [p, q] = fwd ? [e.a, e.b] : [e.b, e.a]
    if (e.t === 'line') edges.push(makeLine(to3(B, p), to3(B, q)))
    else {
      const [a0, a1] = arcAngles(e)
      const r = entRadius(e)
      const m = (a0 + a1) / 2
      edges.push(makeThreePointArc(to3(B, p), to3(B, [e.c[0] + r * Math.cos(m), e.c[1] + r * Math.sin(m)]), to3(B, q)))
    }
    cur = q
  }
  return assembleWire(edges)
}

/// Sweep: Profil (Flächen der Skizze) entlang eines Pfads; Löcher im Profil bleiben hohl (Rohr)
function toolsSweep(model, f, sketches) {
  const sk = sketchOf(f, sketches, 'Sweep')
  const pk = sketches.get(f.path)
  if (!pk) throw new Problem('Sweep: Pfad-Skizze fehlt')
  const faces = sketchFaces(sk, f.regions, 'Sweep', f.fills)
  const out = []
  for (const face of faces) {
    const sweep = (w) => {
      try {
        return solidsOf(genericSweep(w, pathWire(pk, 'Sweep'), { frenet: true, transitionMode: 'round' }))[0]
      } catch (ex) {
        if (ex instanceof Problem) throw ex
        throw new Problem('Sweep: Das Profil lässt sich nicht entlang des Pfads führen – Profil am Pfadanfang, quer zum Pfad zeichnen; enge Bögen vermeiden')
      }
    }
    // outerWire()/innerWires() verbrauchen die Fläche (replicad): je eine Kopie
    const inner = face.clone().innerWires()
    let body = sweep(face.clone().outerWire())
    if (!body) throw new Problem('Sweep: Es ist kein Körper entstanden')
    for (const w of inner) {
      const hole = sweep(w)
      if (hole) body = solidsOf(body.cut(hole))[0] ?? body
    }
    out.push(body)
  }
  return out
}

/// Loft: Übergang zwischen den Umrissen mehrerer Skizzen (je Skizze die größte Fläche)
function toolsLoft(model, f, sketches) {
  const ids = f.sketches ?? []
  if (ids.length < 2) throw new Problem('Loft: mindestens zwei Skizzen wählen')
  const wires = ids.map((id) => {
    const sk = sketches.get(id)
    if (!sk) throw new Problem('Loft: eine gewählte Skizze fehlt (gelöscht oder unterdrückt?)')
    const faces = sketchFaces(sk, null, 'Loft', false)
    return faces.reduce((a, b) => (measureArea(b) > measureArea(a) ? b : a)).outerWire()
  })
  try {
    return solidsOf(loft(wires, { ruled: !!f.ruled }))
  } catch {
    throw new Problem('Loft: Zwischen diesen Umrissen lässt sich kein Körper bilden (Skizzen sollten übereinander liegen und gleich viele Ecken haben)')
  }
}

const TOOLS = { extrude: toolsExtrude, revolve: toolsRevolve, hole: toolsHole, sweep: toolsSweep, loft: toolsLoft }
const modeOf = (f) => (f.type === 'hole' ? 'cut' : (f.mode ?? 'add'))

// --- Kanten und Flächen ------------------------------------------------------------------------

function edgeInfo(edge) {
  const kind = edge.geomType === 'LINE' ? 'line' : edge.geomType === 'CIRCLE' ? 'circle' : 'other'
  const mid = tuple(edge.pointAt(0.5))
  const dir = unit(tuple(edge.tangentAt(0.5)))
  const out = { kind, mid, dir, length: edge.length }
  if (kind === 'circle') {
    const O = oc()
    const ad = new O.BRepAdaptor_Curve(edge.wrapped)
    const c = ad.Circle()
    const ax = c.Axis()
    const loc = c.Location()
    const d = ax.Direction()
    out.center = [loc.X(), loc.Y(), loc.Z()]
    out.axis = [d.X(), d.Y(), d.Z()]
    out.radius = c.Radius()
    ad.delete()
  }
  return out
}

/// Kante wiederfinden: nächste Mitte mit passender Richtung; mit Art auch weiter weg (wie find_curve in cad.py)
function findEdge(model, ref, what) {
  const size = model.diag()
  const cand = []
  model.bodies.forEach((b, bi) => {
    for (const e of b.shape.edges) {
      const info = edgeInfo(e)
      cand.push({ d: dist3(info.mid, ref.mid), e, bi, info })
    }
  })
  cand.sort((x, y) => x.d - y.d)
  const tol = Math.max(1e-3, 0.05 * size)
  const parallel = (d) => !ref.dir || Math.abs(dot(d, ref.dir)) > 0.9
  for (const c of cand) {
    if (c.d > tol) break
    if (parallel(c.info.dir)) return c
  }
  if (ref.kind)
    for (const c of cand) {
      if (c.d > 0.25 * size) break
      if (ref.dir && Math.abs(dot(c.info.dir, ref.dir)) < 0.999) continue
      if (c.info.kind !== ref.kind) continue
      if (c.info.kind === 'circle' && ref.radius && Math.abs(c.info.radius - ref.radius) > 1e-3 * Math.max(1, ref.radius)) continue
      if (c.info.kind === 'line' && ref.length && Math.abs(c.info.length - ref.length) > 0.02 * ref.length + 1e-6 * size) continue
      return c
    }
  throw new Problem(`${what}: eine gewählte Kante gibt es nicht mehr – im Feature neu wählen`)
}

function edgeOp(model, f, kind) {
  const what = kind === 'fillet' ? 'Verrunden' : 'Fase'
  const val = Number(kind === 'fillet' ? f.radius : f.distance) || 0
  if (val <= 0) throw new Problem(kind === 'fillet' ? 'Verrunden: Radius muss größer als 0 sein' : 'Fase: Breite muss größer als 0 sein')
  if (!f.edges?.length) throw new Problem(`${what}: keine Kante gewählt`)
  const per = new Map()
  for (const ref of f.edges) {
    const c = findEdge(model, ref, what)
    if (!per.has(c.bi)) per.set(c.bi, [])
    per.get(c.bi).push(c.e)
  }
  const O = oc()
  for (const [bi, edges] of per) {
    const body = model.bodies[bi]
    // tangential anschließende Kanten nimmt OpenCASCADE von selbst mit
    const mk = kind === 'fillet' ? new O.BRepFilletAPI_MakeFillet(body.shape.wrapped, O.ChFi3d_FilletShape.ChFi3d_Rational) : new O.BRepFilletAPI_MakeChamfer(body.shape.wrapped)
    for (const e of edges) mk.Add(val, e.wrapped)
    let ok = false
    try {
      mk.Build(new O.Message_ProgressRange())
      ok = mk.IsDone()
    } catch {
      ok = false
    }
    if (!ok) {
      mk.delete()
      throw new Problem(kind === 'fillet' ? `Verrunden: Radius ${val} mm lässt sich hier nicht erzeugen – zu groß für die angrenzenden Flächen?` : `Fase: ${val} mm lässt sich hier nicht erzeugen – zu groß für die angrenzenden Flächen?`)
    }
    const s = cast(mk.Shape())
    mk.delete()
    model.bodies[bi] = { shape: solidsOf(s)[0] ?? s, name: body.name }
  }
}

// --- Muster, Spiegeln, Fläche verschieben -------------------------------------------------------

const gpPnt = (p) => new (oc().gp_Pnt)(p[0], p[1], p[2])
const gpDir = (d) => new (oc().gp_Dir)(d[0], d[1], d[2])
function trsfTranslate(v) {
  const T = new (oc().gp_Trsf)()
  T.SetTranslation(new (oc().gp_Vec)(v[0], v[1], v[2]))
  return T
}
function trsfRotate(p, a, ang) {
  const T = new (oc().gp_Trsf)()
  T.SetRotation(new (oc().gp_Ax1)(gpPnt(p), gpDir(a)), ang)
  return T
}
function trsfMirror(o, n) {
  const T = new (oc().gp_Trsf)()
  T.SetMirror(new (oc().gp_Ax2)(gpPnt(o), gpDir(n)))
  return T
}
/// Kopie einer Form, abgebildet (Ebenen und Zylinder bleiben exakt, auch beim Spiegeln)
function transformed(shape, T) {
  const t = new (oc().BRepBuilderAPI_Transform)(shape.wrapped, T, true, false)
  const r = cast(t.Shape())
  t.delete()
  return solidsOf(r)[0] ?? r
}

/// Abbildungen eines Musters (ohne das Original)
function instances(f) {
  const out = []
  if (f.kind === 'linear') {
    const n1 = Math.round(Number(f.count) || 1)
    const n2 = f.dir2 ? Math.round(Number(f.count2) || 1) : 1
    const d1 = mul(unit(f.dir), Number(f.spacing) || 0)
    const d2 = f.dir2 ? mul(unit(f.dir2), Number(f.spacing2) || 0) : [0, 0, 0]
    if (n1 < 1 || n2 < 1 || n1 * n2 < 2) throw new Problem('Muster: Anzahl muss mindestens 2 sein')
    if (n1 * n2 > 400) throw new Problem('Muster: höchstens 400 Stück')
    if (norm(d1) < 1e-9 && n1 > 1) throw new Problem('Muster: Abstand muss größer als 0 sein')
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) if (i || j) out.push(trsfTranslate(add(mul(d1, i), mul(d2, j))))
  } else {
    const n = Math.round(Number(f.count) || 1)
    if (n < 2) throw new Problem('Muster: Anzahl muss mindestens 2 sein')
    if (n > 400) throw new Problem('Muster: höchstens 400 Stück')
    const total = ((Number(f.angle) || 360) * Math.PI) / 180
    const step = Math.abs(total - 2 * Math.PI) < 1e-9 ? total / n : total / (n - 1)
    if (!f.axis) throw new Problem('Muster: Achse fehlt')
    for (let i = 1; i < n; i++) out.push(trsfRotate(f.axis.point, unit(f.axis.dir), i * step))
  }
  return out
}

function repeat(model, f, trsfs, sketches, byId, warn, what) {
  const src = f.features
  if (src === 'body') {
    if (!model.bodies.length) throw new Problem(`${what}: Es gibt noch keinen Körper`)
    const copies = model.bodies.flatMap((b) => trsfs.map((T) => transformed(b.shape, T)))
    const name = model.bodies.find((b) => b.name)?.name ?? null
    model.bodies = fuseAll([...model.shapes, ...copies]).map((s) => ({ shape: s, name }))
    return
  }
  if (!src?.length) throw new Problem(`${what}: kein Feature gewählt`)
  for (const fid of src) {
    const g = byId.get(fid)
    if (!g) throw new Problem(`${what}: Das gewählte Feature fehlt (gelöscht oder unterdrückt?)`)
    if (!TOOLS[g.type]) throw new Problem(`${what}: geht für Extrudieren, Drehen und Bohrung – oder für den ganzen Körper`)
    const tools = trsfs.flatMap((T) => TOOLS[g.type](model, g, sketches, []).map((x) => transformed(x, T)))
    combine(model, modeOf(g), tools, warn)
  }
}

function mirrorFeature(model, f, sketches, byId, warn) {
  const pl = f.plane
  if (!pl) throw new Problem('Spiegeln: Spiegelebene fehlt')
  repeat(model, f, [trsfMirror(pl.origin, unit(pl.normal))], sketches, byId, warn, 'Spiegeln')
}

/// Art einer Fläche: { kind: 'plane', normal } | { kind: 'cylinder', axis, radius } | { kind: 'other' }
function faceKind(face) {
  const t = face.geomType
  if (t === 'PLANE') return { kind: 'plane', normal: unit(tuple(face.normalAt())) }
  if (t === 'CYLINDRE') {
    const ad = new (oc().BRepAdaptor_Surface)(face.wrapped, true)
    const cy = ad.Cylinder()
    const d = cy.Axis().Direction()
    const r = { kind: 'cylinder', axis: [d.X(), d.Y(), d.Z()], radius: cy.Radius() }
    ad.delete()
    return r
  }
  return { kind: 'other' }
}

/// Fläche wiederfinden: nächster Schwerpunkt; mit Hinweis (Art, Normale/Achse, Radius) auch weiter weg (wie find_surface)
function findFace(model, ref, what) {
  const cand = []
  model.bodies.forEach((b, bi) => {
    for (const face of b.shape.faces) cand.push({ d: dist3(tuple(face.center), ref.center), face, bi })
  })
  if (!cand.length) throw new Problem(`${what}: eine gewählte Fläche gibt es nicht mehr – im Feature neu wählen`)
  cand.sort((x, y) => x.d - y.d)
  const size = model.diag()
  const near = Math.max(1, 0.02 * size)
  if (!ref.kind) {
    if (cand[0].d > near) throw new Problem(`${what}: eine gewählte Fläche gibt es nicht mehr – im Feature neu wählen`)
    return cand[0]
  }
  const same = (face) => {
    const k = faceKind(face)
    if (ref.kind === 'plane' && k.kind === 'plane' && ref.normal) return Math.abs(dot(k.normal, unit(ref.normal))) > 0.9995
    if (ref.kind === 'cylinder' && k.kind === 'cylinder' && ref.radius)
      return (!ref.axis || Math.abs(dot(k.axis, unit(ref.axis))) > 0.9995) && Math.abs(k.radius - ref.radius) <= 1e-3 * Math.max(1, ref.radius)
    return ref.kind === 'other' && k.kind === 'other'
  }
  for (const c of cand) {
    if (c.d > 0.25 * size) break
    if (same(c.face)) return c
  }
  if (cand[0].d <= near) return cand[0]
  throw new Problem(`${what}: eine gewählte Fläche gibt es nicht mehr – im Feature neu wählen`)
}

function moveFace(model, f, warn) {
  const d = Number(f.distance) || 0
  if (d === 0) throw new Problem('Fläche verschieben: Abstand angeben (positiv = nach außen)')
  if (!f.faces?.length) throw new Problem('Fläche verschieben: keine Fläche gewählt')
  // erst alle Flächen finden, dann verschieben (sonst verschieben sich die Bezüge)
  const picks = f.faces.map((ref) => findFace(model, ref, 'Fläche verschieben'))
  const tools = []
  for (const { face } of picks) {
    if (face.geomType !== 'PLANE') throw new Problem('Fläche verschieben: geht nur für ebene Flächen')
    const n = unit(tuple(face.normalAt()))
    if (d > 0) tools.push({ mode: 'add', s: basicFaceExtrusion(face.clone(), new Vector(mul(n, d))) })
    else {
      const e = 1e-5 * model.diag()
      tools.push({ mode: 'cut', s: basicFaceExtrusion(face.clone().translate(mul(n, e)), new Vector(mul(n, d - e))) })
    }
  }
  for (const mode of ['add', 'cut']) {
    const ts = tools.filter((t) => t.mode === mode).map((t) => t.s)
    if (ts.length) combine(model, mode, ts, [])
  }
  void warn
}

/// Schale: Körper aushöhlen, gewählte Flächen bleiben offen
function shellOp(model, f) {
  const t = Number(f.thickness) || 0
  if (t <= 0) throw new Problem('Schale: Wandstärke muss größer als 0 sein')
  if (!f.faces?.length) throw new Problem('Schale: mindestens eine Fläche wählen, die offen bleibt')
  const per = new Map()
  for (const ref of f.faces) {
    const c = findFace(model, ref, 'Schale')
    if (!per.has(c.bi)) per.set(c.bi, [])
    per.get(c.bi).push(c.face)
  }
  const O = oc()
  for (const [bi, faces] of per) {
    const body = model.bodies[bi]
    const list = new O.NCollection_List_TopoDS_Shape()
    for (const x of faces) list.Append(x.wrapped)
    const mk = new O.BRepOffsetAPI_MakeThickSolid()
    let shape = null
    try {
      mk.MakeThickSolidByJoin(body.shape.wrapped, list, -t, 1e-3, O.BRepOffset_Mode.BRepOffset_Skin, false, false, O.GeomAbs_JoinType.GeomAbs_Arc, false)
      mk.Build(new O.Message_ProgressRange())
      if (mk.IsDone()) shape = cast(mk.Shape())
    } catch {
      shape = null
    }
    mk.delete()
    let solid = shape && solidsOf(shape)[0]
    // zu dicke Wand: OpenCASCADE gibt den Körper unverändert zurück
    if (solid) {
      const v0 = volumeOf(body.shape)
      const v1 = volumeOf(solid)
      if (!(v1 > 0) || Math.abs(v1 - v0) < 1e-6 * v0) solid = null
    }
    if (!solid) throw new Problem(`Schale: Wandstärke ${t} mm lässt sich hier nicht erzeugen – zu dick für den Körper oder für enge Radien?`)
    model.bodies[bi] = { shape: solid, name: body.name }
  }
}

// --- Darstellung ------------------------------------------------------------------------------

/// Fläche beschreiben; Schwerpunkt und Inhalt kommen aus den Dreiecken (exakt genug zum Wiederfinden, viel schneller)
function surfaceInfo(face, tag, body, center, area) {
  const info = { tag, kind: 'other', body, center, area }
  const t = face.geomType
  if (t === 'PLANE') {
    info.kind = 'plane'
    info.normal = unit(tuple(face.normalAt()))
    info.point = info.center
  } else if (t === 'CYLINDRE') {
    const O = oc()
    const ad = new O.BRepAdaptor_Surface(face.wrapped, true)
    const cy = ad.Cylinder()
    const ax = cy.Axis()
    const loc = ax.Location()
    const d = ax.Direction()
    const axis = [d.X(), d.Y(), d.Z()]
    const c0 = [loc.X(), loc.Y(), loc.Z()]
    const radius = cy.Radius()
    ad.delete()
    const uv = face.UVBounds
    // Ausdehnung längs der Achse aus Randpunkten
    const ext = []
    for (const e of face.edges) for (let k = 0; k <= 8; k++) ext.push(dot(sub(tuple(e.pointAt(k / 8)), c0), axis))
    const lo = Math.min(...ext)
    const length = Math.max(...ext) - lo
    // Normale und Punkt in der Mitte der Fläche (der Schwerpunkt eines vollen Zylinders liegt auf der Achse)
    const n0 = tuple(face.normalAt())
    const p0 = tuple(face.pointOnSurface(0.5, 0.5))
    const foot = add(c0, mul(axis, dot(sub(p0, c0), axis)))
    Object.assign(info, {
      kind: 'cylinder',
      axis,
      radius,
      origin: add(c0, mul(axis, lo)),
      length,
      hole: dot(n0, sub(p0, foot)) < 0,
      full: Math.abs(uv.uMax - uv.uMin - 2 * Math.PI) < 1e-6,
    })
  }
  return info
}

// Netz und Volumen hängen am Körper-Objekt ({ shape, name }); jede Formänderung legt ein neues Objekt an, unveränderte
// Körper (z. B. die übrigen Teile einer Baugruppe) behalten so ihr Netz

/// Volumen und Schwerpunkt eines Körpers (gemerkt)
function massOf(body) {
  body.memo ??= {}
  if (!body.memo.mass) {
    const p = measureShapeVolumeProperties(body.shape)
    body.memo.mass = { volume: p.volume, center: p.centerOfMass }
  }
  return body.memo.mass
}

/// Netz, Flächen und Kanten eines Körpers mit örtlicher Nummerierung (gemerkt)
function bodyTess(body, quality) {
  body.memo ??= {}
  body.memo['tess' + quality] ??= makeBodyTess(body.shape, quality)
  return body.memo['tess' + quality]
}

function makeBodyTess(shape, quality) {
  const [lo, hi] = shape.boundingBox.bounds
  const opts = { tolerance: Math.max(1e-3, (5e-4 * dist3(lo, hi)) / quality), angularTolerance: 0.25 / quality }
  {
    const O = oc()
    const m = shape.mesh(opts)
    // Inhalt und Schwerpunkt je Fläche aus den Dreiecken
    const V = (i) => [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]]
    const props = new Map()
    for (const g of m.faceGroups) {
      let A = 0
      let c = [0, 0, 0]
      for (let k = g.start; k < g.start + g.count; k += 3) {
        const [p, q, r] = [V(m.triangles[k]), V(m.triangles[k + 1]), V(m.triangles[k + 2])]
        const a = norm(cross(sub(q, p), sub(r, p))) / 2
        A += a
        c = add(c, mul(add(add(p, q), r), a / 3))
      }
      props.set(g.faceId, { area: A, center: A > 0 ? mul(c, 1 / A) : V(m.triangles[g.start]) })
    }
    const idxOf = new Map()
    const edgeFaces = new Map() // Hash der Kante → [örtliche Flächennummer]
    const seams = new Set()
    const surfaces = shape.faces.map((face, i) => {
      const h = face.hashCode
      idxOf.set(h, i)
      for (const e of face.edges) {
        const eh = e.hashCode
        if (!edgeFaces.has(eh)) edgeFaces.set(eh, [])
        edgeFaces.get(eh).push(i)
        if (O.BRep_Tool.IsClosed(e.wrapped, face.wrapped)) seams.add(eh)
      }
      const pr = props.get(h) ?? { area: 0, center: tuple(face.center) }
      return surfaceInfo(face, 0, 0, pr.center, pr.area)
    })
    const triangles = []
    const triFace = []
    for (const g of m.faceGroups) {
      const i = idxOf.get(g.faceId)
      for (let k = g.start; k < g.start + g.count; k++) triangles.push(m.triangles[k])
      for (let k = 0; k < g.count / 3; k++) triFace.push(i)
    }
    // Linienzüge der Kanten aus der Kantenvernetzung von OpenCASCADE
    const me = shape.meshEdges(opts)
    const polyOf = new Map(me.edgeGroups.map((g) => [g.edgeId, me.lines.slice(3 * g.start, 3 * (g.start + g.count)).map((x) => Math.round(x * 1e6) / 1e6)]))
    const curves = []
    for (const e of shape.edges) {
      const h = e.hashCode
      if (seams.has(h)) continue // Naht einer Zylinderfläche
      const info = edgeInfo(e)
      const c = { kind: info.kind, pts: polyOf.get(h) ?? [...info.mid, ...info.mid], mid: info.mid, dir: info.dir, faces: edgeFaces.get(h) ?? [], length: info.length }
      if (info.kind === 'circle') Object.assign(c, { center: info.center, axis: info.axis, radius: info.radius, closed: e.isClosed })
      curves.push(c)
    }
    return { positions: m.vertices.map((v) => Math.round(v * 1e6) / 1e6), triangles, triFace, surfaces, curves }
  }
}

function tessellate(model, quality = 1) {
  const positions = []
  const triangles = []
  const triSurface = []
  const surfaces = []
  const curves = []
  let tag = 1
  model.bodies.forEach((b, bi) => {
    const t = bodyTess(b, quality)
    const base = positions.length / 3
    for (const v of t.positions) positions.push(v)
    const tags = t.surfaces.map((s) => {
      const tg = tag++
      surfaces.push({ ...s, tag: tg, body: bi })
      return tg
    })
    for (const i of t.triangles) triangles.push(base + i)
    for (const i of t.triFace) triSurface.push(tags[i])
    for (const c of t.curves) {
      const { faces, ...rest } = c
      curves.push({ ...rest, tag: tag++, surfaces: faces.map((i) => tags[i]) })
    }
  })
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], positions[i])
    hi[i % 3] = Math.max(hi[i % 3], positions[i])
  }
  return { positions, triangles, tri_surface: triSurface, surfaces, curves, vertices: [], bbox: positions.length ? [lo, hi] : [[0, 0, 0], [0, 0, 0]], bodies: model.bodies.length }
}

// --- Ablauf -----------------------------------------------------------------------------------

/// Zwischenstände je Feature (nur im selben Worker): Schlüssel = Feature-Liste bis dahin
const CACHE = []
const CACHE_MAX = 40

function runFeature(model, f, sketches, warn, byId) {
  const before = new Set(model.bodies)
  if (TOOLS[f.type]) {
    const tools = TOOLS[f.type](model, f, sketches, warn)
    combine(model, modeOf(f), tools, warn, f.mode === 'new' ? (f.bodyName ?? '').trim() || null : null)
  } else if (f.type === 'fillet' || f.type === 'chamfer') edgeOp(model, f, f.type)
  else if (f.type === 'pattern') repeat(model, f, instances(f), sketches, byId, warn, 'Muster')
  else if (f.type === 'mirror') mirrorFeature(model, f, sketches, byId, warn)
  else if (f.type === 'moveface') moveFace(model, f, warn)
  else if (f.type === 'shell') shellOp(model, f)
  else throw new Problem(`„${f.type}“ kann der neue Kern noch nicht`)
  if (!model.bodies.length) throw new Problem('Es ist kein Körper entstanden')
  if (f.mode === 'new' && (f.type === 'extrude' || f.type === 'revolve')) newBodies(model, f, before, warn)
}

/// Neuer Körper: Überschneidung mit vorhandenen Teilen abziehen
function newBodies(model, f, before, warn) {
  const fresh = model.bodies.filter((b) => !before.has(b))
  const old = model.bodies.filter((b) => before.has(b))
  if (fresh.length && old.length && f.subtract !== false) {
    const oldU = fuseAll(old.map((b) => b.shape.clone())).reduce((a, s) => (a ? a.fuse(s) : s), null)
    let overlap = 0
    for (const b of fresh)
      try {
        overlap += volumeOf(bool('common', b.shape, oldU))
      } catch {
        /* keine Überschneidung */
      }
    const tol = 1e-6 * Math.min(...model.bodies.map((b) => massOf(b).volume))
    if (overlap > tol) {
      const cut = fresh.flatMap((b) => solidsOf(b.shape.cut(oldU)).map((s) => ({ shape: s, name: b.name })))
      model.bodies = [...old, ...cut]
      warn.push(`überschneidet ein anderes Teil um ${overlap.toFixed(0)} mm³ – die Überschneidung wurde vom neuen Teil abgezogen`)
    }
  }
  const now = model.bodies.filter((b) => !before.has(b))
  if (now.length > 1) warn.push(`besteht aus ${now.length} losen Stücken (Flächen der Skizze hängen nicht zusammen)`)
}

/// Feature-Liste ausführen. job: { features, upto, regions_of, tess, quality, step }
export function build(job) {
  const t0 = performance.now()
  let features = job.features ?? []
  if (job.upto != null) features = features.slice(0, job.upto)
  const keys = features.map((_, k) => JSON.stringify(features.slice(0, k + 1)))
  // längster gespeicherter Anfang
  let start = 0
  let model = new Model()
  let status = []
  for (let k = features.length - 1; k >= 0; k--) {
    const hit = CACHE.find((c) => c.key === keys[k])
    if (hit) {
      model = hit.model.clone()
      status = hit.status.map((s) => ({ ...s }))
      start = k + 1
      hit.used = performance.now()
      break
    }
  }
  const byId = new Map(features.map((f) => [f.id, f]))
  const sketches = new Map(features.slice(0, start).filter((f) => f.type === 'sketch').map((f) => [f.id, f]))
  let failed = false
  for (let k = start; k < features.length; k++) {
    const f = features[k]
    if (failed) {
      status.push({ id: f.id, ok: false, skipped: true })
      continue
    }
    if (f.type === 'sketch') {
      sketches.set(f.id, f)
      status.push({ id: f.id, ok: true })
      continue
    }
    const warn = []
    const work = model.clone()
    try {
      runFeature(work, f, sketches, warn, byId)
      model = work
      status.push(warn.length ? { id: f.id, ok: true, warn } : { id: f.id, ok: true })
      CACHE.push({ key: keys[k], model: model.clone(), status: status.map((s) => ({ ...s })), used: performance.now() })
      if (CACHE.length > CACHE_MAX) {
        CACHE.sort((a, b) => b.used - a.used)
        CACHE.length = CACHE_MAX
      }
    } catch (ex) {
      const msg = ex instanceof Problem ? ex.message : `${f.type}: Die Geometrie lässt sich so nicht erzeugen (${String(ex?.message ?? ex)})`
      status.push({ id: f.id, ok: false, error: msg })
      failed = true
    }
  }
  const tBuild = performance.now()
  const result = { status, volume: model.volume(), bodies: model.bodies.length }
  if (job.regions_of != null) {
    const sk = (job.features ?? []).find((f) => f.id === job.regions_of && f.type === 'sketch')
    let regs = []
    try {
      regs = sk ? regionsOf(sk) : []
    } catch {
      regs = []
    }
    result.regions = regs.map((r) => ({
      pt: r.pt,
      area: r.area,
      loops: r.loops,
      evenodd: r.evenodd,
      fill: inFills(r.pt, sk.fills),
      groups: [...new Set((sk.fills ?? []).filter((x) => !Array.isArray(x) && insidePoly(r.pt, x.loops)).map((x) => x.group))].sort(),
    }))
  }
  if (model.bodies.length) {
    let unnamed = 0
    result.bodies_info = model.bodies.map((b) => {
      const p = massOf(b)
      return { name: b.name ?? `Körper ${++unnamed}`, volume: p.volume, center: p.center }
    })
  }
  if (job.step && model.bodies.length && !failed) {
    let unnamed = 0
    result.stepBlob = exportSTEP(model.bodies.map((b) => ({ shape: b.shape, name: b.name ?? `Körper ${++unnamed}` })))
  }
  if (job.tess !== false) result.tess = model.bodies.length ? tessellate(model, Number(job.quality) || 1) : null
  result.timing = { build: Math.round(tBuild - t0), total: Math.round(performance.now() - t0), cached: start }
  return result
}

export function clearCache() {
  CACHE.length = 0
  REGION_CACHE.clear()
}
