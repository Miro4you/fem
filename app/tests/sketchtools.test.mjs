// Neue Skizzenwerkzeuge: Ecke verrunden, Langloch, Vieleck, Rechteck aus der Mitte – Form hält, Freiheitsgrade stimmen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newSketch, addPoint, addEnt, addCon, P, measure } from '../src/cad/sketch.js'
import { solve } from '../src/cad/solver.js'
import { filletCorner, addSlot, addPolygon, addCenterRect, polygonRadius } from '../src/cad/sketchTools.js'

const plane = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0] }

function rect() {
  const sk = newSketch(plane)
  const p = [[0, 0], [50, 0], [50, 30], [0, 30]].map((q, i) => addPoint(sk, q, i === 0))
  const L = p.map((a, i) => addEnt(sk, { t: 'line', a, b: p[(i + 1) % 4] }))
  addCon(sk, { t: 'h', a: p[0], b: p[1] })
  addCon(sk, { t: 'h', a: p[2], b: p[3] })
  addCon(sk, { t: 'v', a: p[1], b: p[2] })
  addCon(sk, { t: 'v', a: p[3], b: p[0] })
  addCon(sk, { t: 'dx', a: p[0], b: p[1], v: 50 })
  addCon(sk, { t: 'dy', a: p[1], b: p[2], v: 30 })
  return { sk, p, L }
}

test('Ecke verrunden: Bogen tangential, Ecke bleibt als Hilfspunkt, voll bestimmt', () => {
  const { sk, p } = rect()
  const r = filletCorner(sk, p[2], 8)
  assert.ok(r.sketch, r.error)
  const s = r.sketch
  const info = solve(s)
  assert.ok(info.ok)
  assert.equal(info.dof, 0, `Freiheitsgrade ${info.dof}`)
  const arc = s.ents.find((e) => e.t === 'arc')
  const c = P(s, arc.c)
  assert.ok(Math.hypot(c[0] - 42, c[1] - 22) < 1e-6, `Mitte ${c}`)
  // Berührpunkte auf den Kanten, Ecke unverändert
  const ends = [P(s, arc.a), P(s, arc.b)].map((q) => q.map((v) => Math.round(v * 1e6) / 1e6)).sort((a, b) => a[0] - b[0])
  assert.deepEqual(ends, [[42, 30], [50, 22]])
  assert.deepEqual(P(s, p[2]).map((v) => Math.round(v * 1e6) / 1e6), [50, 30])
  // Radius ändern: Bogen wandert mit, Rechteck bleibt
  const dim = s.cons.find((k) => k.t === 'rad')
  dim.v = 5
  assert.ok(solve(s).ok)
  assert.ok(Math.abs(measure(s, dim) - 5) < 1e-6)
  const c2 = P(s, arc.c)
  assert.ok(Math.hypot(c2[0] - 45, c2[1] - 25) < 1e-6, `Mitte nach Änderung ${c2}`)
  assert.ok(filletCorner(sk, p[2], 40).error, 'zu großer Radius muss abgelehnt werden')
})

test('Langloch: tangential, gleiche Radien, 5 Freiheitsgrade bzw. mit Maßen 2', () => {
  const sk = newSketch(plane)
  addSlot(sk, [0, 0], [40, 0], 6)
  const info = solve(sk)
  assert.ok(info.ok)
  assert.equal(info.dof, 4, `Freiheitsgrade ${info.dof}`) // waagrecht → 4 (Lage 2, Länge, Radius)
  const sk2 = newSketch(plane)
  addSlot(sk2, [0, 0], [30, 10], 5, { dist: 40, width: 12 })
  const i2 = solve(sk2)
  assert.ok(i2.ok)
  assert.equal(i2.dof, 3, `Freiheitsgrade ${i2.dof}`)
  const arcs = sk2.ents.filter((e) => e.t === 'arc')
  for (const a of arcs) assert.ok(Math.abs(Math.hypot(...[0, 1].map((k) => P(sk2, a.a)[k] - P(sk2, a.c)[k])) - 6) < 1e-6)
  const ax = sk2.ents.find((e) => e.t === 'line' && e.cons)
  assert.ok(Math.abs(Math.hypot(...[0, 1].map((k) => P(sk2, ax.b)[k] - P(sk2, ax.a)[k])) - 40) < 1e-6)
})

test('Sechskant SW 13: Schlüsselweite stimmt, regelmäßig', () => {
  const sk = newSketch(plane)
  const R = polygonRadius(6, 13)
  addPolygon(sk, [0, 0], [R, 0], 6, { size: 13 })
  // ein bisschen verdrehen, damit der Löser arbeiten muss
  const info = solve(sk)
  assert.ok(info.ok)
  const lines = sk.ents.filter((e) => e.t === 'line' && !e.cons)
  assert.equal(lines.length, 6)
  const Ls = lines.map((l) => Math.hypot(P(sk, l.b)[0] - P(sk, l.a)[0], P(sk, l.b)[1] - P(sk, l.a)[1]))
  for (const L of Ls) assert.ok(Math.abs(L - Ls[0]) < 1e-6)
  const sw = sk.cons.find((c) => c.t === 'dpl')
  assert.ok(Math.abs(measure(sk, sw) - 13) < 1e-6)
  assert.ok(info.dof <= 3, `Freiheitsgrade ${info.dof}`)
})

test('Rechteck aus der Mitte: Mitte bleibt Mitte', () => {
  const sk = newSketch(plane)
  addCenterRect(sk, [10, 5], [30, 20], { w: 50, h: 20 })
  const info = solve(sk)
  assert.ok(info.ok)
  assert.equal(info.dof, 2, `Freiheitsgrade ${info.dof}`)
  const xs = Object.values(sk.pts).map((q) => q.x)
  const ys = Object.values(sk.pts).map((q) => q.y)
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 50) < 1e-6)
  assert.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - 10) < 1e-6)
  assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 20) < 1e-6)
})
