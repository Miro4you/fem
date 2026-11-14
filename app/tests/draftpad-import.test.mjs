// Draftpad-Import mit fester Geometrie („verknüpft"): tangentiale Übergänge Linie–Bogen.
// Draftpad speichert Koordinaten auf 0,001 mm gerundet, Bogenenden ergeben sich exakt aus
// Mitte + Winkel – nach dem Zusammenführen passten die Abstände zur Mitte um ~0,0004 mm nicht,
// mit festen Punkten war die Skizze dann unlösbar. Start: cd app && node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readDraftpad, defaultLayers, importDraftpad } from '../src/cad/draftpad.js'
import { newSketch, solved } from '../src/cad/sketch.js'

const { doc, layers } = readDraftpad(readFileSync(new URL('../../examples/draftpad/frame-test-fem.draftpad.json', import.meta.url), 'utf8'))

for (const fixed of [true, false]) {
  test(`Rahmen mit tangentialen Radien: Import ${fixed ? 'mit fester Geometrie' : 'frei'} ist lösbar`, () => {
    const { sketch, open } = importDraftpad(newSketch('XY'), doc, { layers: defaultLayers(layers), tol: 0.3, fixed, stableIds: true })
    assert.equal(open.length, 0)
    assert.equal(solved(sketch).info.ok, true)
  })
}

// Schmaler Schlitz (0,2 mm) von oben in eine Platte: die beiden Schlitzseiten dürfen nicht zusammenfallen
function slotDoc(w) {
  const pts = [[0, 0], [20, 0], [20, -10], [10 + w / 2, -10], [10 + w / 2, -4], [10 - w / 2, -4], [10 - w / 2, -10], [0, -10]]
  // Draftpad: y nach unten → hier y negativ = oben
  const entities = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]
    return { id: `l${i}`, kind: 'line', layerId: 'L', a: { x: p[0], y: -p[1] }, b: { x: q[0], y: -q[1] } }
  })
  return { format: 'skizzen-cad', layers: [{ id: 'L', name: 'Reinzeichnung', visible: true }], entities }
}

for (const fixed of [true, false]) {
  test(`Schmaler Schlitz 0,2 mm bleibt erhalten (${fixed ? 'fest' : 'frei'})`, async () => {
    const { regionsOf } = await import('../src/cad/region.js').catch(() => ({}))
    const { doc } = readDraftpad(JSON.stringify(slotDoc(0.2)))
    const { sketch, open, stats } = importDraftpad(newSketch('XY'), doc, { layers: new Set(['L']), tol: 0.3, fixed })
    assert.equal(open.length, 0, `offene Enden ${JSON.stringify(open)}`)
    assert.equal(sketch.ents.filter((e) => e.t === 'line').length, 8, 'alle 8 Linien')
    assert.equal(Object.keys(sketch.pts).length, 8, 'acht verschiedene Punkte')
    void regionsOf
    void stats
  })
}

test('Kleine Lücke (0,2 mm) an einer Ecke wird weiterhin geschlossen', () => {
  const d = slotDoc(4)
  d.entities[1].a.x += 0.2 // Ende von Linie 0 und Anfang von Linie 1 liegen 0,2 mm auseinander
  const { doc } = readDraftpad(JSON.stringify(d))
  const { sketch, open } = importDraftpad(newSketch('XY'), doc, { layers: new Set(['L']), tol: 0.3, fixed: false })
  assert.equal(open.length, 0)
  assert.equal(Object.keys(sketch.pts).length, 8)
})
