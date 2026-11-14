// Bezüge folgen der Skizze: Verrundung an einer Bohrungskante bleibt an „ihrer“ Bohrung, wenn diese in der Skizze wandert.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import opencascade from 'replicad-opencascadejs'
import { setOC } from 'replicad'
import { build, clearCache } from '../src/cad/kernel/build.js'
import { newSketch, addPoint, addEnt } from '../src/cad/sketch.js'
import { kernelFeatures, anchorRefs, anchorFor } from '../src/cad/features.js'

before(async () => {
  const wasm = fileURLToPath(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))
  setOC(await opencascade({ locateFile: () => wasm }))
})

const xy = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0] }

function model() {
  // Platte 100 × 40 × 10, zwei gleiche Löcher Ø8 bei x = 20 und x = 40 (Kreise in derselben Skizze)
  const sk = newSketch(xy)
  const p = [[0, 0], [100, 0], [100, 40], [0, 40]].map((q, i) => addPoint(sk, q, i === 0))
  p.forEach((a, i) => addEnt(sk, { t: 'line', a, b: p[(i + 1) % 4] }))
  const ca = addPoint(sk, [20, 20])
  const cb = addPoint(sk, [40, 20])
  addEnt(sk, { t: 'circle', c: ca, r: 4 })
  addEnt(sk, { t: 'circle', c: cb, r: 4 })
  const features = [
    { id: 1, type: 'sketch', name: 'Skizze 1', sketch: sk },
    { id: 2, type: 'extrude', name: 'Extrudieren 1', sketch: 1, regions: null, useFills: true, mode: 'add', depth: '10', flip: false, symmetric: false, through: false },
  ]
  return { sk, features, ca, cb, p }
}

test('Anker: Bohrungskante über Kreismitte, senkrechte Kante über Ecke, Seitenfläche über Linienmitte', () => {
  const { features, ca, p } = model()
  assert.equal(anchorFor(features, [20, 20, 10]).p, ca)
  assert.equal(anchorFor(features, [100, 40, 5]).p, p[2])
  assert.deepEqual(anchorFor(features, [50, 0, 5]).l, [p[0], p[1]])
  assert.equal(anchorFor(features, [55, 22, 10]), null)
})

test('Verrundung an der Bohrung A folgt A, wenn A in der Skizze nach x = 60 wandert (früher: nächste Bohrung B)', () => {
  clearCache()
  const { sk, features, ca } = model()
  // Kante oben an Bohrung A (wie beim Anklicken: Kreiskante mit Mitte)
  const edge = { mid: [24, 20, 10], dir: [0, 1, 0], kind: 'circle', center: [20, 20, 10], axis: [0, 0, 1], radius: 4, length: 2 * Math.PI * 4 }
  const fillet = anchorRefs({ id: 3, type: 'fillet', name: 'Verrunden 1', edges: [edge], radius: '1' }, features)
  assert.equal(fillet.edges[0].anchor.p, ca)
  const all = [...features, fillet]
  const r0 = build({ features: kernelFeatures(all) })
  assert.ok(r0.status.every((s) => s.ok), JSON.stringify(r0.status))
  const torusAt = (r) => r.tess.surfaces.filter((s) => s.kind === 'other').map((s) => s.center)
  assert.ok(Math.abs(torusAt(r0)[0][0] - 20) < 1e-3)
  // Bohrung A in der Skizze nach x = 60 schieben
  sk.pts[ca].x = 60
  const r1 = build({ features: kernelFeatures(all) })
  assert.ok(r1.status.every((s) => s.ok), JSON.stringify(r1.status))
  const t = torusAt(r1)
  assert.equal(t.length, 1)
  assert.ok(Math.abs(t[0][0] - 60) < 1e-3, `Verrundung bei x = ${t[0][0]} statt 60`)
  // ohne Anker (alte Projekte): nächste Bohrung (B bei 40) – zeigt, was vorher passierte
  const old = [...features, { ...fillet, edges: [{ ...edge }] }]
  const r2 = build({ features: kernelFeatures(old) })
  assert.ok(Math.abs(torusAt(r2)[0][0] - 40) < 1e-3)
})

test('Fase an der senkrechten Ecke folgt der Ecke, wenn die Platte breiter wird', () => {
  clearCache()
  const { sk, features, p } = model()
  const edge = { mid: [100, 40, 5], dir: [0, 0, 1], kind: 'line', length: 10 }
  const ch = anchorRefs({ id: 3, type: 'chamfer', name: 'Fase 1', edges: [edge], distance: '3' }, features)
  const all = [...features, ch]
  sk.pts[p[1]].x = 150
  sk.pts[p[2]].x = 150
  const r = build({ features: kernelFeatures(all) })
  assert.ok(r.status.every((s) => s.ok), JSON.stringify(r.status))
  const vol = 150 * 40 * 10 - 2 * Math.PI * 16 * 10 - 0.5 * 9 * 10
  assert.ok(Math.abs(r.volume - vol) < 1e-6 * vol, `${r.volume} statt ${vol}`)
})
