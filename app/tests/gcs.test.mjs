// FreeCAD-Löser (planegcs) gegen unseren Löser: gleiche Ergebnisse, Zeiten. Start: cd app && node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readDraftpad, defaultLayers, importDraftpad } from '../src/cad/draftpad.js'
import { newSketch, addPoint, addEnt, addCon, measure } from '../src/cad/sketch.js'
import { solve } from '../src/cad/solver.js'
import { solveWithGcs } from '../src/cad/gcs.js'

const ms = (t) => Math.round((performance.now() - t) * 10) / 10

test('Rechteck mit Maßen und Bohrung: beide Löser gleich', async () => {
  const sk = newSketch({ origin: [0, 0, 0], normal: [0, 0, 1] })
  const p = [[0, 0], [50, 0], [50, 30], [0, 30]].map((q, i) => addPoint(sk, q, i === 0))
  const L = p.map((a, i) => addEnt(sk, { t: 'line', a, b: p[(i + 1) % 4] }))
  addCon(sk, { t: 'h', a: p[0], b: p[1] })
  addCon(sk, { t: 'h', a: p[2], b: p[3] })
  addCon(sk, { t: 'v', a: p[1], b: p[2] })
  addCon(sk, { t: 'v', a: p[3], b: p[0] })
  addCon(sk, { t: 'dx', a: p[0], b: p[1], v: 80 })
  addCon(sk, { t: 'dy', a: p[1], b: p[2], v: 40 })
  const c = addEnt(sk, { t: 'circle', c: addPoint(sk, [20, 15]), r: 5 })
  addCon(sk, { t: 'dia', e: c.id, v: 12 })
  addCon(sk, { t: 'dpl', p: c.c, e: L[0].id, v: 20 })
  addCon(sk, { t: 'dpl', p: c.c, e: L[3].id, v: 25 })
  const ours = structuredClone(sk)
  assert.ok(solve(ours).ok)
  const g = await solveWithGcs(sk)
  assert.ok(g.ok, JSON.stringify(g))
  for (const [id, q] of Object.entries(ours.pts)) assert.ok(Math.hypot(q.x - g.sketch.pts[id].x, q.y - g.sketch.pts[id].y) < 1e-6, id)
  for (const k of sk.cons.filter((x) => x.v != null)) assert.ok(Math.abs(measure(g.sketch, k) - k.v) < 1e-6, k.t)
})

test('Wellenschnitt aus Draftpad: Zeiten', async () => {
  const { doc, layers } = readDraftpad(readFileSync(new URL('../../examples/draftpad/wellenschnitt.draftpad.json', import.meta.url), 'utf8'))
  const { sketch, stats } = importDraftpad(newSketch({ origin: [0, 0, 0], normal: [0, 0, 1] }), doc, { layers: defaultLayers(layers), tol: 0.3, center: true })
  const n = { pts: Object.keys(sketch.pts).length, ents: sketch.ents.length, cons: sketch.cons.length }
  let t = performance.now()
  const a = structuredClone(sketch)
  const ra = solve(a, { analyse: false })
  const tOurs = ms(t)
  t = performance.now()
  const b = structuredClone(sketch)
  const rb = solve(b)
  const tOursDof = ms(t)
  await solveWithGcs(sketch) // Laden
  t = performance.now()
  const g = await solveWithGcs(sketch)
  const tGcs = ms(t)
  // Maß auf die längste waagrechte Linie, um 2 mm länger
  const lines = sketch.ents.filter((e) => e.t === 'line' && !e.cons)
  const len = (e) => Math.hypot(sketch.pts[e.b].x - sketch.pts[e.a].x, sketch.pts[e.b].y - sketch.pts[e.a].y)
  const l = lines.reduce((x, y) => (len(y) > len(x) ? y : x))
  const s2 = structuredClone(sketch)
  addCon(s2, { t: 'dist', a: l.a, b: l.b, v: len(l) + 2 })
  t = performance.now()
  const o2 = structuredClone(s2)
  const r2 = solve(o2, { analyse: false })
  const tOurs2 = ms(t)
  t = performance.now()
  const g2 = await solveWithGcs(s2)
  const tGcs2 = ms(t)
  console.log(`  Skizze: ${n.pts} Punkte, ${n.ents} Elemente, ${n.cons} Bedingungen (${stats.cons} erkannt)`)
  console.log(`  lösen: unser Löser ${tOurs} ms (mit Freiheitsgraden ${tOursDof} ms, ok=${ra.ok}/${rb.ok}) – planegcs ${tGcs} ms (ok=${g.ok})`)
  console.log(`  Maß +2 mm: unser Löser ${tOurs2} ms (ok=${r2.ok}) – planegcs ${tGcs2} ms (ok=${g2.ok}, Widersprüche ${g2.conflicting.length})`)
  assert.ok(g.ok && g2.ok)
  const lenG = Math.hypot(g2.sketch.pts[l.b].x - g2.sketch.pts[l.a].x, g2.sketch.pts[l.b].y - g2.sketch.pts[l.a].y)
  assert.ok(Math.abs(lenG - (len(l) + 2)) < 1e-6, `${lenG}`)
})
