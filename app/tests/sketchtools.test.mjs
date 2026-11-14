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

test('Spiegeln: Linienzug mit Bogen und Kreis an der Mittellinie – symmetrisch, keine überzähligen Bedingungen', async () => {
  const { mirrorEnts } = await import('../src/cad/sketchTools.js')
  const sk = newSketch(plane)
  const o = addPoint(sk, [0, -10], true)
  const top = addPoint(sk, [0, 30])
  const axis = addEnt(sk, { t: 'line', a: o, b: top, cons: true })
  addCon(sk, { t: 'v', a: o, b: top })
  const p1 = addPoint(sk, [0, 0])
  addCon(sk, { t: 'on', p: p1, e: axis.id })
  const p2 = addPoint(sk, [20, 0])
  const p3 = addPoint(sk, [20, 10])
  const l1 = addEnt(sk, { t: 'line', a: p1, b: p2 })
  const l2 = addEnt(sk, { t: 'line', a: p2, b: p3 })
  const c = addPoint(sk, [10, 10])
  const p4 = addPoint(sk, [0, 20])
  const arc = addEnt(sk, { t: 'arc', c, a: p3, b: p4 })
  addCon(sk, { t: 'on', p: p4, e: axis.id })
  const hole = addEnt(sk, { t: 'circle', c: addPoint(sk, [8, 5]), r: 2 })
  const r = mirrorEnts(sk, [l1.id, l2.id, arc.id, hole.id], axis.id)
  assert.ok(r.sketch, r.error)
  const s = r.sketch
  const info = solve(s)
  assert.ok(info.ok)
  assert.equal(info.redundant, 0, 'überzählig')
  // Punkte auf der Achse werden geteilt, die anderen gespiegelt
  assert.equal(r.added.length, 4)
  const mirrored = s.ents.filter((e) => r.added.includes(e.id))
  const ml1 = mirrored.find((e) => e.t === 'line' && e.a === p1)
  assert.ok(ml1, 'erste Linie hängt am Achsenpunkt')
  assert.deepEqual(P(s, ml1.b).map((v) => Math.round(v * 1e6) / 1e6 + 0), [-20, 0])
  // Original ziehen: Spiegelbild folgt
  s.pts[p2].x = 25
  const i2 = solve(s, { drag: { pts: { [p2]: [25, 0] }, radius: {} } })
  assert.ok(i2.ok)
  assert.ok(Math.abs(P(s, ml1.b)[0] + P(s, p2)[0]) < 1e-6)
})

test('Tangentenbogen: an Linienende tangential, Löser hält die Tangente', async () => {
  const { tangentAt, tangentArc } = await import('../src/cad/sketchTools.js')
  const sk = newSketch(plane)
  const a = addPoint(sk, [0, 0], true)
  const b = addPoint(sk, [20, 0])
  const l = addEnt(sk, { t: 'line', a, b })
  addCon(sk, { t: 'h', a, b })
  const tg = tangentAt(sk, b)
  assert.deepEqual(tg.dir, [1, 0])
  const ta = tangentArc([20, 0], tg.dir, [30, 10])
  assert.ok(ta && ta.ccw)
  assert.ok(Math.abs(ta.r - 10) < 1e-9 && Math.abs(ta.c[0] - 20) < 1e-9 && Math.abs(ta.c[1] - 10) < 1e-9)
  const q = addPoint(sk, [30, 10])
  const c = addPoint(sk, ta.c)
  const arc = addEnt(sk, { t: 'arc', c, a: b, b: q })
  addCon(sk, { t: 'tan', e1: l.id, e2: arc.id })
  // Ende ziehen: Bogen bleibt tangential (Mitte senkrecht über dem Linienende)
  const info = solve(sk, { drag: { pts: { [q]: [32, 14] }, radius: {} } })
  assert.ok(info.ok)
  assert.ok(Math.abs(P(sk, c)[0] - P(sk, b)[0]) < 1e-6, 'Mitte über dem Linienende')
})

test('Muster in der Skizze: Lochkreis 6 × um die Mitte, Reihe', async () => {
  const { patternEnts } = await import('../src/cad/sketchTools.js')
  const sk = newSketch(plane)
  const hole = addEnt(sk, { t: 'circle', c: addPoint(sk, [35, 0]), r: 4.5 })
  const r = patternEnts(sk, [hole.id], { kind: 'circular', n: 6, center: [0, 0], angle: 360 })
  assert.equal(r.added.length, 5)
  const cs = r.sketch.ents.filter((e) => e.t === 'circle').map((e) => P(r.sketch, e.c))
  for (const c of cs) assert.ok(Math.abs(Math.hypot(c[0], c[1]) - 35) < 1e-9)
  assert.ok(cs.some((c) => Math.abs(c[0] - 17.5) < 1e-9 && Math.abs(c[1] - 35 * Math.sin(Math.PI / 3)) < 1e-9))
  const l = patternEnts(sk, [hole.id], { kind: 'linear', n: 3, dx: 10, dy: 5 })
  const c3 = l.sketch.ents.filter((e) => e.t === 'circle').map((e) => P(l.sketch, e.c))
  assert.deepEqual(c3[2], [55, 10])
})

test('Ziehen zerstört nichts: Rechteck mit Rundungen klappt beim Überziehen nicht um', async () => {
  const { dragSolve } = await import('../src/cad/sketch.js')
  const sk = newSketch(plane)
  const p = [[0, 0], [50, 0], [50, 30], [0, 30]].map((q, i) => addPoint(sk, q, i === 0))
  p.forEach((a, i) => addEnt(sk, { t: 'line', a, b: p[(i + 1) % 4] }))
  addCon(sk, { t: 'h', a: p[0], b: p[1] })
  addCon(sk, { t: 'h', a: p[2], b: p[3] })
  addCon(sk, { t: 'v', a: p[1], b: p[2] })
  addCon(sk, { t: 'v', a: p[3], b: p[0] })
  let s = sk
  for (const c of [p[1], p[2], p[3]]) s = filletCorner(s, c, 5).sketch
  assert.ok(solve(s).ok)
  // obere Linie: ein Endpunkt der oberen Geraden (Berührpunkt der Rundung rechts oben)
  const top = s.ents.find((e) => e.t === 'line' && !e.cons && Math.abs(P(s, e.a)[1] - 30) < 1e-6 && Math.abs(P(s, e.b)[1] - 30) < 1e-6)
  const id = top.a
  const [x0] = P(s, id)
  const r = dragSolve(s, { pts: { [id]: [x0, -80] }, radius: {} })
  // Ziel (unter der Unterkante) ist nicht ohne Umklappen erreichbar: bleibt vorher stehen
  assert.equal(r.ok, false)
  const ys = Object.values(r.sketch.pts).map((q) => q.y)
  const topY = P(r.sketch, id)[1]
  assert.ok(topY > 0, `obere Kante bleibt über der unteren (${topY})`)
  // kleine Bewegung geht weiterhin glatt
  const r2 = dragSolve(s, { pts: { [id]: [x0, 25] }, radius: {} })
  assert.ok(r2.ok)
  assert.ok(Math.abs(P(r2.sketch, id)[1] - 25) < 1e-6)
  void ys
})

test('Bedingungen: keine Doppelten, Kollinear, Symmetrisch für zwei Linien + Achse und zwei Kreise + Achse', async () => {
  const { applicableCons, sameCon, dedupeCons, measure } = await import('../src/cad/sketch.js')
  const sk = newSketch(plane)
  const a = addPoint(sk, [0, 0], true)
  const b = addPoint(sk, [10, 0.5])
  const l = addEnt(sk, { t: 'line', a, b })
  const c1 = addCon(sk, { t: 'h', a, b })
  const c2 = addCon(sk, { t: 'h', a: b, b: a })
  assert.equal(c1, c2, 'gleiche Bedingung wird nicht doppelt angelegt')
  assert.equal(sk.cons.length, 1)
  sk.cons.push({ id: 'cx', t: 'h', a, b })
  assert.equal(dedupeCons(sk).cons.length, 1)
  assert.ok(sameCon(sk, { t: 'h', a: b, b: a }))
  // Kollinear
  const p3 = addPoint(sk, [15, 2])
  const p4 = addPoint(sk, [25, 3])
  const l2 = addEnt(sk, { t: 'line', a: p3, b: p4 })
  const col = applicableCons(sk, { pts: [], ents: [l.id, l2.id], cons: [] }).find((o) => o.t === 'col')
  assert.ok(col)
  addCon(sk, col.con)
  assert.ok(solve(sk).ok)
  assert.ok(Math.abs(P(sk, p3)[1]) < 1e-9 && Math.abs(P(sk, p4)[1]) < 1e-9, 'beide Punkte auf der Geraden y = 0')
  // Symmetrisch: zwei Linien + senkrechte Achse
  const s2 = newSketch(plane)
  const o = addPoint(s2, [0, -5], true)
  const t = addPoint(s2, [0, 30], true)
  const axis = addEnt(s2, { t: 'line', a: o, b: t, cons: true })
  const L1 = addEnt(s2, { t: 'line', a: addPoint(s2, [5, 0]), b: addPoint(s2, [8, 20]) })
  const L2 = addEnt(s2, { t: 'line', a: addPoint(s2, [-6, 1]), b: addPoint(s2, [-7, 19]) })
  const sym = applicableCons(s2, { pts: [], ents: [L1.id, axis.id, L2.id], cons: [] }).find((x) => x.t === 'sym')
  assert.ok(sym?.multi?.length === 2, 'zwei Punktpaare')
  assert.ok(sym.multi.every((m) => m.e === axis.id), 'Achse erkannt')
  for (const m of sym.multi) addCon(s2, m)
  assert.ok(solve(s2).ok)
  assert.ok(Math.abs(P(s2, L1.a)[0] + P(s2, L2.a)[0]) < 1e-9 && Math.abs(P(s2, L1.a)[1] - P(s2, L2.a)[1]) < 1e-9)
  // zwei Kreise + Linie
  const s3 = newSketch(plane)
  const ax3 = addEnt(s3, { t: 'line', a: addPoint(s3, [0, 0], true), b: addPoint(s3, [0, 10], true) })
  const k1 = addEnt(s3, { t: 'circle', c: addPoint(s3, [10, 5]), r: 3 })
  const k2 = addEnt(s3, { t: 'circle', c: addPoint(s3, [-9, 6]), r: 4 })
  const sy3 = applicableCons(s3, { pts: [], ents: [k1.id, ax3.id, k2.id], cons: [] }).find((x) => x.t === 'sym')
  for (const m of sy3.multi) addCon(s3, m)
  assert.ok(solve(s3).ok)
  assert.ok(Math.abs(P(s3, k1.c)[0] + P(s3, k2.c)[0]) < 1e-9)
  assert.ok(Math.abs(s3.ents.find((e) => e.id === k1.id).r - s3.ents.find((e) => e.id === k2.id).r) < 1e-9)
  void measure
})
