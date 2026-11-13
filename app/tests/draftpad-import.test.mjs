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
