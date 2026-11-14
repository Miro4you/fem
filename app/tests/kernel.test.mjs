// Tests des neuen Geometriekerns (OpenCASCADE über replicad) – dieselben Modelle wie die Kern-Tests in cad.rs.
// Start: cd app && node --test tests/
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import opencascade from 'replicad-opencascadejs'
import { setOC } from 'replicad'
import { build, clearCache } from '../src/cad/kernel/build.js'

before(async () => {
  const wasm = fileURLToPath(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
  setOC(await opencascade({ locateFile: () => wasm }))
})

const PI = Math.PI
const xy = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0] }
const xz = { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0] }
const rect = (x0, y0, x1, y1) => {
  const p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  return p.map((a, i) => ({ t: 'line', a, b: p[(i + 1) % 4] }))
}
const near = (v, soll, rel, msg) => assert.ok(Math.abs(v - soll) <= rel * Math.abs(soll), `${msg ?? ''} ${v} statt ${soll}`)
const allOk = (r) => assert.ok(r.status.every((s) => s.ok), JSON.stringify(r.status))

test('Flansch: Ring, Bohrungen im Kreismuster, gespiegelte Nut, Verrundung', () => {
  clearCache()
  const top = { origin: [0, 0, 12], normal: [0, 0, 1], u: [1, 0, 0] }
  const features = [
    { id: 1, type: 'sketch', plane: xy, ents: [{ t: 'circle', c: [0, 0], r: 50 }, { t: 'circle', c: [0, 0], r: 20 }] },
    { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 12, dir: 1 },
    { id: 3, type: 'sketch', plane: top, ents: [], pts: [[35, 0]] },
    { id: 4, type: 'hole', sketch: 3, diameter: 9, through: true },
    { id: 5, type: 'pattern', kind: 'circular', features: [4], axis: { point: [0, 0, 0], dir: [0, 0, 1] }, count: 6, angle: 360 },
    { id: 6, type: 'sketch', plane: top, ents: rect(22, -3, 30, 3) },
    { id: 7, type: 'extrude', sketch: 6, mode: 'cut', depth: 4, dir: -1 },
    { id: 8, type: 'mirror', features: [7], plane: { origin: [0, 0, 0], normal: [1, 0, 0] } },
    { id: 9, type: 'fillet', edges: [{ mid: [-50, 0, 12] }], radius: 2 },
  ]
  const r = build({ features })
  allOk(r)
  const ring = PI * (2500 - 400) * 12 - 6 * PI * 4.5 * 4.5 * 12 - 2 * 8 * 6 * 4
  const fillet = (1 - PI / 4) * 4 * 2 * PI * (50 - 2 * (1 - (10 - 3 * PI) / (12 - 3 * PI)))
  near(r.volume, ring - fillet, 1e-3, 'Volumen')
  assert.equal(r.bodies, 1)
  const holes = r.tess.surfaces.filter((s) => s.kind === 'cylinder' && s.hole && Math.abs(s.radius - 4.5) < 1e-6)
  assert.equal(holes.length, 6, 'sechs Bohrungen Ø9')
  assert.ok(r.tess.surfaces.some((s) => s.kind === 'plane' && s.normal[2] > 0.999), 'Deckfläche mit Normale +z')
  assert.ok(r.tess.triangles.length > 0 && r.tess.curves.length > 0)
  // nur bis vor die Bohrung (aus dem Zwischenspeicher)
  const r2 = build({ features, upto: 2 })
  near(r2.volume, PI * 2100 * 12, 1e-6)
  console.log('  Flansch', r.timing, 'bis 2:', r2.timing)
})

test('Fehler bleibt beim Feature', () => {
  const features = [
    { id: 1, type: 'sketch', plane: xy, ents: rect(0, 0, 40, 30) },
    { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 10, dir: 1 },
    { id: 3, type: 'fillet', edges: [{ mid: [0, 0, 5] }], radius: 80 },
    { id: 4, type: 'chamfer', edges: [{ mid: [20, 0, 10] }], distance: 1 },
  ]
  const r = build({ features })
  assert.equal(r.status[1].ok, true)
  assert.match(r.status[2].error, /Radius 80 mm/)
  assert.equal(r.status[3].skipped, true)
  near(r.volume, 12000, 1e-9)
})

test('Eine Skizze, mehrere Extrusionen', () => {
  const ents = [...rect(0, 0, 80, 40), { t: 'circle', c: [20, 20], r: 6 }, { t: 'circle', c: [60, 20], r: 8 }]
  const features = [
    { id: 1, type: 'sketch', plane: xy, ents },
    { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 10, dir: 1, regions: [{ pt: [40, 5], area: 0 }] },
    { id: 3, type: 'extrude', sketch: 1, mode: 'add', depth: 25, dir: 1, regions: [[20, 20]] },
    { id: 4, type: 'extrude', sketch: 1, mode: 'cut', through: true, dir: 1, regions: [[60, 20]] },
  ]
  const r = build({ features })
  allOk(r)
  near(r.volume, (3200 - PI * 36 - PI * 64) * 10 + PI * 36 * 25, 1e-6)
  assert.equal(r.bodies, 1)
  const f2 = structuredClone(features)
  f2[1].regions = []
  assert.match(build({ features: f2 }).status[1].error, /keine Fläche gewählt/)
})

test('Baugruppe aus Schraffuren', () => {
  const ents = [...rect(-10, 0, 10, 60), ...rect(10, 20, 16, 40), ...rect(-16, 20, -10, 40), { t: 'line', a: [0, -5], b: [0, 65] }]
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
  const fills = [
    { loops: [sq(-10, 0, 10, 60)], group: 'welle' },
    { loops: [sq(10, 20, 16, 40)], group: 'buchse' },
    { loops: [sq(-16, 20, -10, 40)], group: 'buchse' },
  ]
  const axis = { a: [0, -5], b: [0, 65] }
  const features = [
    { id: 1, type: 'sketch', plane: xz, ents, fills },
    { id: 2, type: 'revolve', sketch: 1, axis, angle: 360, mode: 'new', fills: { group: 'welle' }, bodyName: 'Welle' },
    { id: 3, type: 'revolve', sketch: 1, axis, angle: 360, mode: 'new', fills: { group: 'buchse' }, bodyName: 'Buchse' },
    { id: 4, type: 'sketch', plane: { origin: [0, 0, 35], normal: [0, 0, 1], u: [1, 0, 0] }, ents: [{ t: 'circle', c: [0, 0], r: 20 }] },
    { id: 5, type: 'extrude', sketch: 4, mode: 'new', depth: 10, dir: 1, bodyName: 'Deckel' },
  ]
  const r = build({ features, step: true })
  allOk(r)
  assert.match(r.status[4].warn[0], /überschneidet/)
  const welle = PI * 100 * 60
  const buchse = PI * (256 - 100) * 20
  const deckel = PI * 400 * 10 - PI * 100 * 10 - PI * (256 - 100) * 5
  near(r.volume, welle + buchse + deckel, 1e-4)
  assert.deepEqual(r.bodies_info.map((b) => b.name).sort(), ['Buchse', 'Deckel', 'Welle'])
  assert.ok(r.stepBlob && r.stepBlob.size > 1000)
  console.log('  Baugruppe', r.timing)
})

test('Drehteil und Bereiche', () => {
  const prof = [[0, 0], [40, 0], [40, 10], [25, 10], [25, 15], [0, 15]]
  const ents = prof.map((a, i) => ({ t: 'line', a, b: prof[(i + 1) % 6] }))
  const r = build({ features: [{ id: 1, type: 'sketch', plane: xz, ents }, { id: 2, type: 'revolve', sketch: 1, axis: { a: [0, 0], b: [1, 0] }, angle: 360, mode: 'add' }] })
  allOk(r)
  near(r.volume, PI * 100 * 40 + PI * (225 - 100) * 25, 1e-6)
  const ents2 = [...rect(0, 0, 60, 40), { t: 'circle', c: [60, 40], r: 15 }]
  const r2 = build({
    features: [{ id: 1, type: 'sketch', plane: xy, ents: ents2 }, { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 5, regions: [[30, 20], [55, 35], [70, 45]] }],
    regions_of: 1,
    tess: false,
  })
  near(r2.volume, (2400 + PI * 225 * 0.75) * 5, 1e-6)
  assert.equal(r2.regions.length, 3)
})

test('Bohrung mit Kegelsenkung und Spitze', () => {
  const top = { origin: [0, 0, 20], normal: [0, 0, 1], u: [1, 0, 0] }
  const features = [
    { id: 1, type: 'sketch', plane: xy, ents: rect(-30, -30, 30, 30) },
    { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 20, dir: 1 },
    { id: 3, type: 'sketch', plane: top, ents: [], pts: [[0, 0]] },
    { id: 4, type: 'hole', sketch: 3, diameter: 10, depth: 12, tip: true, sink: { kind: 'cone', d: 20, angle: 90 } },
  ]
  const r = build({ features })
  allOk(r)
  // Senkung: Kegelstumpf r 10→5 über h 5; Bohrung r 5 von 5 bis 12; Spitze 118°
  const h = 5
  const sink = (PI * h * (100 + 50 + 25)) / 3
  const hole = PI * 25 * (12 - h)
  const tip = (PI * 25 * (5 / Math.tan((59 * PI) / 180))) / 3
  near(r.volume, 3600 * 20 - sink - hole - tip, 1e-6)
})

test('Fläche verschieben und Fase überleben eine Änderung davor', () => {
  const mk = (depth) => [
    { id: 1, type: 'sketch', plane: xy, ents: rect(0, 0, 60, 40) },
    { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth, dir: 1 },
    { id: 3, type: 'moveface', faces: [{ center: [30, 20, 10], kind: 'plane', normal: [0, 0, 1] }], distance: 5 },
    { id: 4, type: 'chamfer', edges: [{ mid: [30, 0, 15], dir: [1, 0, 0], kind: 'line', length: 60 }], distance: 1 },
  ]
  let r = build({ features: mk(10) })
  allOk(r)
  near(r.volume, 2400 * 15 - 30, 1e-9)
  r = build({ features: mk(14) })
  allOk(r)
  near(r.volume, 2400 * 19 - 30, 1e-9)
  // nach innen
  const f = mk(10)
  f[2].distance = -4
  f[3].edges = [{ mid: [30, 0, 6], dir: [1, 0, 0], kind: 'line', length: 60 }]
  r = build({ features: f })
  allOk(r)
  near(r.volume, 2400 * 6 - 30, 1e-9)
})

test('Muster linear in zwei Richtungen und Spiegeln des ganzen Körpers', () => {
  const top = { origin: [0, 0, 10], normal: [0, 0, 1], u: [1, 0, 0] }
  const features = [
    { id: 1, type: 'sketch', plane: xy, ents: rect(0, 0, 100, 60) },
    { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 10, dir: 1 },
    { id: 3, type: 'sketch', plane: top, ents: [], pts: [[10, 10]] },
    { id: 4, type: 'hole', sketch: 3, diameter: 6, through: true },
    { id: 5, type: 'pattern', kind: 'linear', features: [4], dir: [1, 0, 0], spacing: 20, count: 5, dir2: [0, 1, 0], spacing2: 20, count2: 3 },
    { id: 6, type: 'mirror', features: 'body', plane: { origin: [0, 0, 0], normal: [1, 0, 0] } },
  ]
  const r = build({ features })
  allOk(r)
  near(r.volume, 2 * (6000 * 10 - 15 * PI * 9 * 10), 1e-6)
  assert.equal(r.bodies, 1, 'gespiegelt und verschmolzen')
})

test('Schale: Kasten oben offen, Wand 2 mm', () => {
  const features = [
    { id: 1, type: 'sketch', plane: xy, ents: rect(0, 0, 60, 40) },
    { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 30, dir: 1 },
    { id: 3, type: 'shell', faces: [{ center: [30, 20, 30], kind: 'plane', normal: [0, 0, 1] }], thickness: 2 },
  ]
  const r = build({ features })
  allOk(r)
  near(r.volume, 60 * 40 * 30 - 56 * 36 * 28, 1e-6)
  const r2 = build({ features: [...features.slice(0, 2), { ...features[2], thickness: 25 }] })
  assert.match(r2.status[2].error, /Schale/)
})

test('Sweep: Rohr (Kreisring entlang Pfad mit Bogen) und Loft (Pyramidenstumpf)', () => {
  const xzp = { origin: [0, 0, 0], normal: [0, -1, 0], u: [1, 0, 0] }
  // gerader Pfad 100 mm in z
  let r = build({ features: [
    { id: 1, type: 'sketch', plane: xy, ents: [{ t: 'circle', c: [0, 0], r: 5 }, { t: 'circle', c: [0, 0], r: 4 }] },
    { id: 2, type: 'sketch', plane: xzp, ents: [{ t: 'line', a: [0, 0], b: [0, 100] }] },
    { id: 3, type: 'sweep', sketch: 1, path: 2, mode: 'add' },
  ] })
  allOk(r)
  near(r.volume, PI * 9 * 100, 1e-6)
  // Pfad mit 90°-Bogen R 30: Länge 50 + π/2·30 + 50
  r = build({ features: [
    { id: 1, type: 'sketch', plane: xy, ents: [{ t: 'circle', c: [0, 0], r: 5 }, { t: 'circle', c: [0, 0], r: 4 }] },
    { id: 2, type: 'sketch', plane: xzp, ents: [{ t: 'line', a: [0, 0], b: [0, 50] }, { t: 'arc', c: [30, 50], a: [0, 50], b: [30, 80] }, { t: 'line', a: [30, 80], b: [80, 80] }].map((e) => (e.t === 'arc' ? { ...e, a: [30, 80], b: [0, 50] } : e)) },
    { id: 3, type: 'sweep', sketch: 1, path: 2, mode: 'add' },
  ] })
  allOk(r)
  near(r.volume, PI * 9 * (100 + (PI / 2) * 30), 1e-3)
  // Loft
  const top = { origin: [0, 0, 30], normal: [0, 0, 1], u: [1, 0, 0] }
  r = build({ features: [
    { id: 1, type: 'sketch', plane: xy, ents: rect(-10, -10, 10, 10) },
    { id: 2, type: 'sketch', plane: top, ents: rect(-5, -5, 5, 5) },
    { id: 3, type: 'loft', sketches: [1, 2], ruled: true, mode: 'add' },
  ] })
  allOk(r)
  near(r.volume, (30 / 3) * (400 + 100 + 200), 1e-6)
})

test('Bohrung aus einer Skizze unter dem Teil: bohrt automatisch ins Material', () => {
  clearCache()
  const p = [[-30, -20], [30, -20], [30, 20], [-30, 20]]
  const ents = p.map((a, i) => ({ t: 'line', a, b: p[(i + 1) % 4] }))
  for (const flip of [false, true]) {
    const features = [
      { id: 1, type: 'sketch', plane: xy, ents, pts: [[15, 5], [-15, 5]] },
      { id: 2, type: 'extrude', sketch: 1, mode: 'add', depth: 10, dir: 1 },
      { id: 3, type: 'hole', sketch: 1, diameter: 5, through: true, flip, sink: { kind: 'none' } },
    ]
    const r = build({ features })
    allOk(r)
    near(r.volume, 24000 - 2 * PI * 6.25 * 10, 1e-6, `Richtung ${flip}`)
  }
})
