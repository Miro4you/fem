// Konstruktion: kleines CAD mit Skizzen, Features und Verlauf (wie Onshape: Ebene wählen, skizzieren, bemaßen,
// extrudieren …). Gebaut wird mit OpenCASCADE im Rechenkern; das Ergebnis geht als STEP in die Rechnung.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Undo2,
  Redo2,
  Check,
  X,
  Eye,
  EyeOff,
  Trash2,
  Lock,
  Download,
  Play,
  TriangleAlert,
  Loader2,
  SquareDashed,
  Info,
  Hash,
  FileUp,
  Power,
  PowerOff,
  PenOff,
  Boxes,
  RefreshCw,
  ExternalLink,
  Unlink,
} from 'lucide-react'
import CadView, { fmtN } from './CadView.jsx'
import * as api from '../api.js'
import {
  FEATURE_LABEL,
  HOLE_SIZES,
  defaults,
  featureId,
  featureName,
  kernelFeatures,
  problemOf,
  planeFromFace,
  dirOf,
  axisOf,
  num,
  fmtField,
} from './features.js'
import { offsetEnts } from './sketch.js'
import { STD_PLANES, newSketch, applicableCons, removeItems, solved, CON_LABEL, CON_GLYPH, isDim, measure, kernelSketch, polyline, basis, to3d } from './sketch.js'
import { readDraftpad, defaultLayers, importDraftpad, fillLoops, notesOf } from './draftpad.js'
import { suggestParts, partFeatures } from './parts.js'
import DraftpadLibrary from '../ui/DraftpadLibrary.jsx'
import NumInput from './NumInput.jsx'
import * as I from './icons.jsx'
import { describe as describePick, between as betweenPicks } from '../measure.js'
import { cadBuildView, kernelReady, newKernelWanted, oldKernelReason } from './kernel/client.js'

const FEATURE_ICON = {
  sketch: I.IcSketch,
  extrude: I.IcExtrude,
  revolve: I.IcRevolve,
  hole: I.IcHole,
  fillet: I.IcFillet,
  chamfer: I.IcChamfer,
  pattern: I.IcPattern,
  mirror: I.IcMirror,
  removefaces: I.IcRemoveFace,
  moveface: I.IcMoveFace,
  shell: I.IcShell,
  sweep: I.IcSweep,
  loft: I.IcLoft,
  refillet: I.IcFillet,
  rehole: I.IcHole,
}

const SKETCH_TOOLS = [
  ['select', 'Auswählen und ziehen', I.IcSelect, 'S'],
  ['line', 'Linie (Linienzug; Doppelklick oder Esc beendet; auch ziehen)', I.IcLine, 'L'],
  ['rect', 'Rechteck (zwei Ecken; Zahl tippen: 60x40)', I.IcRect, 'R'],
  ['circle', 'Kreis (Mitte, Radius; Zahl tippen = Ø)', I.IcCircle, 'C'],
  ['arc', 'Bogen (Mitte, Anfang, Ende – gegen den Uhrzeigersinn)', I.IcArc, 'A'],
  ['point', 'Punkt (z. B. für Bohrungen)', I.IcPoint, 'P'],
  ['dim', 'Bemaßen: ein Element (Länge, Ø, R) oder zwei Elemente (Abstand, Winkel) anklicken, Maß ablegen, Wert eingeben', I.IcDimension, 'D'],
  ['extend', 'Verlängern: Linie nahe dem Ende anklicken – bis zum nächsten Element', I.IcExtend, 'E'],
  ['trim', 'Trimmen: Stück bis zum nächsten Schnittpunkt anklicken (rot = fällt weg)', I.IcTrim, 'T'],
  ['use', 'Kante des Bauteils übernehmen', I.IcUseEdge, 'U'],
]

const PART_TOOLS = [
  ['sketch', 'Skizze: Ebene oder ebene Fläche wählen, dann zeichnen'],
  ['extrude', 'Skizze herausziehen – Material dazu oder weg'],
  ['revolve', 'Skizze um eine Achse drehen (Drehteile)'],
  ['hole', 'Bohrungen an Skizzenpunkten, mit Senkung'],
  ['fillet', 'Kanten verrunden'],
  ['chamfer', 'Kanten fasen'],
  ['pattern', 'Linear oder im Kreis vervielfältigen'],
  ['mirror', 'An einer Ebene spiegeln'],
  ['shell', 'Schale: Körper aushöhlen, gewählte Flächen bleiben offen'],
]
// seltener gebraucht: im Menü „Mehr“
const MORE_TOOLS = [
  ['sweep', 'Sweep: Profil-Skizze entlang einer Pfad-Skizze (z. B. Rohr, Bügel)'],
  ['loft', 'Loft: Übergang zwischen zwei oder mehr Skizzen'],
  ['moveface', 'Ebene Fläche verschieben (z. B. Wand dicker)'],
  ['removefaces', 'Flächen entfernen (z. B. Bohrung oder Radius weg)'],
]

const emptySel = { pts: [], ents: [], cons: [] }
const SHORT = { moveface: 'Verschieben', removefaces: 'Entfernen' }

// Kanten/Flächen einer Auswahl in der aktuellen Darstellung wiederfinden (Nummern ändern sich bei jedem Aufbau)
function matchEdges(tess, refs) {
  const out = new Set()
  if (!tess) return out
  const size = Math.hypot(...tess.bbox[1].map((v, i) => v - tess.bbox[0][i])) || 1
  for (const r of refs ?? []) {
    let best = null
    for (const c of tess.curves) {
      const d = Math.hypot(c.mid[0] - r.mid[0], c.mid[1] - r.mid[1], c.mid[2] - r.mid[2])
      if (d > 0.02 * size) continue
      // gleiche Richtung und Art bevorzugen (sonst werden eng benachbarte Kanten verwechselt)
      const par = !r.dir || !c.dir ? 1 : Math.abs(r.dir[0] * c.dir[0] + r.dir[1] * c.dir[1] + r.dir[2] * c.dir[2])
      const pen = (par > 0.999 ? 0 : 1) + (r.kind && c.kind !== r.kind ? 1 : 0)
      const score = pen * size + d
      if (!best || score < best.score) best = { score, tag: c.tag }
    }
    if (best) out.add(best.tag)
  }
  return out
}
function matchFaces(tess, refs) {
  const out = new Set()
  if (!tess) return out
  const size = Math.hypot(...tess.bbox[1].map((v, i) => v - tess.bbox[0][i])) || 1
  for (const r of refs ?? []) {
    let best = null
    for (const f of tess.surfaces) {
      const d = Math.hypot(f.center[0] - r.center[0], f.center[1] - r.center[1], f.center[2] - r.center[2])
      if (d < 0.02 * size && (!best || d < best.d)) best = { d, tag: f.tag }
    }
    if (best) out.add(best.tag)
  }
  return out
}
const edgeRef = (c) => ({ mid: c.mid, dir: c.dir, kind: c.kind, ...(c.kind === 'circle' ? { center: c.center, axis: c.axis, radius: c.radius } : {}), length: c.length })
/// Ebene parallel verschieben (Abstand entlang der Normalen)
const shiftPlane = (plane, d) => (d ? { ...plane, origin: plane.origin.map((x, i) => x + basis(plane).n[i] * d) } : plane)
/// Grundebene einer Skizze (ohne Abstand) aus ihrem Bezug
const basePlaneOf = (sk) => (sk.planeRef?.std ? STD_PLANES[sk.planeRef.std] : sk.planeRef?.face?.normal ? planeFromFace(sk.planeRef.face) : null)

const faceRef = (f) => ({ center: f.center, kind: f.kind, normal: f.normal, point: f.point, axis: f.axis, origin: f.origin, radius: f.radius })
const nameOf = (r) =>
  r?.std ? `Ebene ${r.std}` : r?.axis ? `${r.axis}-Achse` : r?.edge ? (r.edge.kind === 'circle' ? 'Kreiskante' : 'Kante') : r?.face ? (r.face.kind === 'cylinder' ? 'Zylinderfläche' : 'Fläche') : '–'

function coaxialFaces(tess, face) {
  const a = face.axis
  return tess.surfaces.filter((s) => {
    if (s.kind !== 'cylinder' || Math.abs(s.radius - face.radius) > 1e-3 * Math.max(1, face.radius)) return false
    if (Math.abs(Math.abs(s.axis[0] * a[0] + s.axis[1] * a[1] + s.axis[2] * a[2]) - 1) > 1e-6) return false
    const d = [s.origin[0] - face.origin[0], s.origin[1] - face.origin[1], s.origin[2] - face.origin[2]]
    const t = d[0] * a[0] + d[1] * a[1] + d[2] * a[2]
    return Math.hypot(d[0] - t * a[0], d[1] - t * a[1], d[2] - t * a[2]) < 1e-3 * Math.max(1, face.radius)
  })
}

export default function CadStudio({ cad, setCad, nav, onApply, onExport, applied, busy, onError, incoming, openLibrary }) {
  const features = cad.features
  const [built, setBuilt] = useState(null) // Ergebnis aller Features
  const [building, setBuilding] = useState(false)
  const [edit, setEdit] = useState(null) // { id, draft, isNew, index }
  const [preview, setPreview] = useState(null) // Ergebnis beim Bearbeiten
  const [tool, setTool] = useState('select')
  const [construction, setConstruction] = useState(false)
  const [sel, setSel] = useState(emptySel)
  const [skInfo, setSkInfo] = useState(null)
  const [pickFor, setPickFor] = useState(null) // welches Feld gerade per Klick gewählt wird
  const [msg, setMsg] = useState(null)
  const [showStd, setShowStd] = useState(false) // Hauptebenen immer zeigen
  const [showSketches, setShowSketches] = useState(true) // fertige Skizzen im Hintergrund zeigen
  const [selSketch, setSelSketch] = useState(null) // im Bild angeklickte Skizze (im Verlauf markiert)
  const [showGlyphs, setShowGlyphs] = useState(null) // Bedingungszeichen: null = automatisch (bis 40)
  const [parts, setParts] = useState(null) // Teile aus Schraffuren: { sketchId, rows, subtract, hover }
  const [history, setHistory] = useState({ undo: [], redo: [] })
  const skHist = useRef({ undo: [], redo: [] })
  const viewRef = useRef(null)
  const reqRef = useRef(0)
  // Draftpad-Import: { doc, layers, name, opts }
  const [dp, setDp] = useState(null)
  const [dpLib, setDpLib] = useState(false) // Draftpad-Bibliothek offen
  const [stale, setStale] = useState({}) // verknüpfte Skizzen mit neuerer Draftpad-Fassung: { featureId: updated }
  const fileRef = useRef(null)

  const note = useCallback((m) => {
    setMsg(m)
    clearTimeout(note.t)
    note.t = setTimeout(() => setMsg(null), 4500)
  }, [])

  // --- Aufbauen --------------------------------------------------------------------------------
  const run = useCallback(
    async (list, extra = {}) => {
      const id = ++reqRef.current
      setBuilding(true)
      try {
        const r = await cadBuildView({ base: cad.base ?? null, features: kernelFeatures(list, extra.upto ?? list.length), regions_of: extra.regionsOf ?? null })
        return id === reqRef.current ? r : null
      } catch (e) {
        if (id === reqRef.current) onError(String(e))
        return null
      } finally {
        if (id === reqRef.current) setBuilding(false)
      }
    },
    [cad.base, onError],
  )

  // neuer Kern: WebAssembly gleich beim Öffnen laden
  useEffect(() => {
    if (newKernelWanted()) kernelReady()
  }, [])

  const builtKey = JSON.stringify(kernelFeatures(features)) + (cad.base ?? '')
  useEffect(() => {
    let stop = false
    run(features).then((r) => !stop && r && setBuilt(r))
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtKey])

  const status = useMemo(() => new Map((built?.status ?? []).map((s) => [s.id, s])), [built])

  // Vorschau beim Bearbeiten: alle Features bis einschließlich Entwurf (Skizze: Stand davor)
  const draftKey = edit ? JSON.stringify(edit.draft.type === 'sketch' ? null : edit.draft) : null
  useEffect(() => {
    if (!edit) {
      setPreview(null)
      return
    }
    const list = [...features.slice(0, edit.index), edit.draft]
    const isSk = edit.draft.type === 'sketch'
    // unvollständig: Stand davor zeigen (der Kern bekommt nur fertige Features)
    const regionsOf = null
    let stop = false
    const t = setTimeout(
      () =>
        run(isSk ? features.slice(0, edit.index) : list, { regionsOf }).then((r) => {
          if (!stop && r) setPreview(r)
        }),
      isSk ? 0 : newKernelWanted() ? 60 : 250,
    )
    return () => {
      stop = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, edit?.index, builtKey])

  // --- Verlauf ändern -------------------------------------------------------------------------------
  const commitFeatures = (next) => {
    setHistory((h) => ({ undo: [...h.undo.slice(-40), features], redo: [] }))
    setCad({ ...cad, features: next })
  }
  const undo = () => {
    if (edit || !history.undo.length) return
    setHistory((h) => ({ undo: h.undo.slice(0, -1), redo: [...h.redo, features] }))
    setCad({ ...cad, features: history.undo[history.undo.length - 1] })
  }
  const redo = () => {
    if (edit || !history.redo.length) return
    setHistory((h) => ({ undo: [...h.undo, features], redo: h.redo.slice(0, -1) }))
    setCad({ ...cad, features: history.redo[history.redo.length - 1] })
  }

  const startNew = (type) => {
    if (edit) return note('Erst das offene Feature bestätigen oder abbrechen')
    const id = featureId(features)
    const draft = { id, type, name: featureName(features, type), ...defaults(type) }
    const lastSketch = [...features].reverse().find((f) => f.type === 'sketch' && !f.suppressed)
    if (['extrude', 'revolve', 'hole'].includes(type) && lastSketch) draft.sketch = lastSketch.id
    // Skizze schon von einem anderen Feature benutzt: nichts vorwählen, Flächen im Bild anklicken
    if ((type === 'extrude' || type === 'revolve') && lastSketch && features.some((f) => (f.type === 'extrude' || f.type === 'revolve') && f.sketch === lastSketch.id && !f.suppressed))
      draft.regions = []
    if (type === 'revolve' && lastSketch) {
      const line = lastSketch.sketch.ents.find((e) => e.t === 'line' && e.axis) ?? lastSketch.sketch.ents.find((e) => e.t === 'line' && e.cons) ?? null
      draft.axis = line?.id ?? null
    }
    if (type === 'hole' && lastSketch) draft.flip = false
    setEdit({ id, draft, isNew: true, index: features.length })
    setSel(emptySel)
    setTool('select')
    skHist.current = { undo: [], redo: [] }
    if (type === 'sketch') {
      setPickFor('plane')
      draft.sketch = null
    } else setPickFor({ fillet: 'edges', chamfer: 'edges', removefaces: 'faces', moveface: 'faces', shell: 'faces' }[type] ?? null)
  }

  const openEdit = (f) => {
    if (edit) return note('Erst das offene Feature bestätigen oder abbrechen')
    setSelSketch(null)
    const index = features.findIndex((g) => g.id === f.id)
    setEdit({ id: f.id, draft: structuredClone(f), isNew: false, index })
    setSel(emptySel)
    setTool('select')
    setPickFor(null)
    skHist.current = { undo: [], redo: [] }
    if (f.type === 'sketch') {
      const r = solved(f.sketch)
      setSkInfo(r.info)
      setTimeout(() => viewRef.current?.lookAt(f.sketch.plane), 0)
    }
  }

  const setDraft = (patch) => setEdit((e) => (e ? { ...e, draft: { ...e.draft, ...(typeof patch === 'function' ? patch(e.draft) : patch) } } : e))

  const accept = (next = false) => {
    if (!edit) return
    const d = edit.draft
    if (d.type === 'sketch' && !d.sketch) return cancel()
    const prob = problemOf(d, [...features.slice(0, edit.index), d])
    if (prob && d.type !== 'sketch') return note(prob)
    const list = edit.isNew ? [...features, d] : features.map((f) => (f.id === d.id ? d : f))
    commitFeatures(list)
    if (d.type === 'sketch') setTimeout(() => viewRef.current?.fit(), 0)
    // Skizze mit Schraffuren (Draftpad), noch nicht benutzt: Teile vorschlagen
    if (d.type === 'sketch' && d.sketch?.fills?.length && !list.some((f) => f.sketch === d.id && f.type !== 'sketch')) openParts(d)
    if (next) {
      // gleich das nächste Feature mit derselben Skizze, nichts gewählt
      const id = featureId(list)
      const draft = { ...defaults(d.type), id, type: d.type, name: featureName(list, d.type), sketch: d.sketch, mode: d.mode, axis: d.axis, regions: [] }
      setEdit({ id, draft, isNew: true, index: list.length })
      setPickFor(null)
      setRegionHover(-1)
      return
    }
    setEdit(null)
    setPickFor(null)
    setSel(emptySel)
    setSkInfo(null)
  }
  const openParts = (f) => {
    const rows = suggestParts(f.sketch)
    if (!rows.length) return note('In dieser Skizze sind keine Schraffuren')
    setParts({ sketchId: f.id, rows, subtract: true, hover: null })
  }
  const createParts = () => {
    const made = partFeatures(features, parts.sketchId, parts.rows, parts.subtract)
    if (!made.length) return note('Kein Teil gewählt')
    commitFeatures([...features, ...made])
    setParts(null)
    note(`${made.length} Teil${made.length > 1 ? 'e' : ''} angelegt: ${made.map((f) => f.name).join(', ')}`)
  }

  const cancel = () => {
    if (edit?.draft.type === 'sketch') setTimeout(() => viewRef.current?.fit(), 0)
    setEdit(null)
    setPickFor(null)
    setSel(emptySel)
    setSkInfo(null)
  }

  const removeFeature = (f) => {
    const users = features.filter((g) => g.sketch === f.id || (Array.isArray(g.features) && g.features.includes(f.id)))
    if (users.length) return note(`„${f.name}“ wird von ${users.map((u) => `„${u.name}“`).join(', ')} benutzt – erst dort ändern`)
    commitFeatures(features.filter((g) => g.id !== f.id))
  }

  // --- Skizze bearbeiten ----------------------------------------------------------------------------
  const sketchEdit = edit?.draft.type === 'sketch' && edit.draft.sketch ? edit.draft : null
  const changeSketch = useCallback(
    (sk2, info, dragging) => {
      setEdit((e) => {
        if (!e) return e
        if (!dragging) {
          skHist.current.undo.push(e.draft.sketch)
          skHist.current.redo = []
        }
        return { ...e, draft: { ...e.draft, sketch: sk2 } }
      })
      if (info) setSkInfo(info)
    },
    [],
  )
  // Ziehen: Verlauf nur beim Loslassen (erster Stand vor dem Ziehen)
  const dragStart = useRef(null)
  const onSketchChange = useCallback(
    (sk2, info, dragging) => {
      if (dragging) {
        if (!dragStart.current) dragStart.current = sketchEdit?.sketch
        setEdit((e) => (e ? { ...e, draft: { ...e.draft, sketch: sk2 } } : e))
        return
      }
      if (dragStart.current) {
        skHist.current.undo.push(dragStart.current)
        skHist.current.redo = []
        dragStart.current = null
        setEdit((e) => (e ? { ...e, draft: { ...e.draft, sketch: sk2 } } : e))
        if (info) setSkInfo(info)
        return
      }
      changeSketch(sk2, info, false)
    },
    [changeSketch, sketchEdit?.sketch],
  )

  const skUndo = () => {
    const h = skHist.current
    if (!h.undo.length || !sketchEdit) return
    h.redo.push(sketchEdit.sketch)
    const prev = h.undo.pop()
    setEdit((e) => ({ ...e, draft: { ...e.draft, sketch: prev } }))
    setSkInfo(solved(prev).info)
    setSel(emptySel)
  }
  const skRedo = () => {
    const h = skHist.current
    if (!h.redo.length || !sketchEdit) return
    h.undo.push(sketchEdit.sketch)
    const nxt = h.redo.pop()
    setEdit((e) => ({ ...e, draft: { ...e.draft, sketch: nxt } }))
    setSkInfo(solved(nxt).info)
    setSel(emptySel)
  }

  const deleteSelection = () => {
    if (!sketchEdit) return
    if (!sel.pts.length && !sel.ents.length && !sel.cons.length) return
    const s2 = removeItems(sketchEdit.sketch, sel)
    const r = solved(s2)
    changeSketch(r.sketch, r.info, false)
    setSel(emptySel)
  }

  const applyCon = (opt) => {
    const s2 = structuredClone(sketchEdit.sketch)
    for (const con of opt.multi ?? [opt.con]) s2.cons.push({ id: `c${s2.next++}`, ...con })
    const before = skInfo?.redundant ?? 0
    const r = solved(s2)
    if (!r.info.ok) return note('Diese Bedingung widerspricht den vorhandenen')
    if (r.info.redundant > before) note('Das war schon so festgelegt – Bedingung nicht nötig')
    changeSketch(r.sketch, r.info, false)
  }

  const applyOffset = (d) => {
    const s2 = offsetEnts(sketchEdit.sketch, sel.ents, d)
    if (!s2) return note('Versatz: zusammenhängende Linien/Bögen oder Kreise wählen (Abstand kleiner als die Radien)')
    const r = solved(s2)
    changeSketch(r.info.ok ? r.sketch : s2, r.info, false)
    note(`Versatz ${String(d).replace('.', ',')} mm angelegt (geschlossener Zug: + nach außen, − nach innen)`)
  }

  const toggleFix = () => {
    const s2 = structuredClone(sketchEdit.sketch)
    const ids = [...sel.pts, ...sel.ents.flatMap((id) => {
      const e = s2.ents.find((x) => x.id === id)
      return e ? (e.t === 'line' ? [e.a, e.b] : e.t === 'point' ? [e.p] : [e.c]) : []
    })]
    const fix = !ids.every((id) => s2.pts[id]?.fix)
    for (const id of ids) if (s2.pts[id]) s2.pts[id].fix = fix
    const r = solved(s2)
    changeSketch(r.sketch, r.info, false)
  }
  const toggleConstruction = () => {
    if (!sel.ents.length) return setConstruction(!construction)
    const s2 = structuredClone(sketchEdit.sketch)
    const on = !sel.ents.every((id) => s2.ents.find((e) => e.id === id)?.cons)
    for (const e of s2.ents) if (sel.ents.includes(e.id) && e.t !== 'point') e.cons = on || undefined
    changeSketch(s2, skInfo, false)
  }

  // Tastatur
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (sketchEdit) (e.shiftKey ? skRedo : skUndo)()
        else (e.shiftKey ? redo : undo)()
        return
      }
      if (ctrl && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        if (sketchEdit) skRedo()
        else redo()
        return
      }
      if (!sketchEdit) {
        if (e.key === 'Escape' && edit) {
          if (pickFor) setPickFor(null)
          else cancel()
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (e.key === 'Escape') {
        if (tool !== 'select') setTool('select')
        else if (sel.pts.length || sel.ents.length || sel.cons.length) setSel(emptySel)
        return
      }
      if (ctrl || e.altKey) return
      const t = SKETCH_TOOLS.find(([, , , k]) => k.toLowerCase() === e.key.toLowerCase())
      if (t) setTool(t[0])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // --- Auswahl im Bild (Ebenen, Flächen, Kanten) ------------------------------------------------------
  const shownTess = (edit ? preview?.tess : built?.tess) ?? (edit ? built?.tess : null)
  // Messen: Flächen/Kanten anklicken (zwei für Abstände)
  const [cmeasure, setCmeasure] = useState({ on: false, picks: [] })
  const [conPos, setConPos] = useState(null) // Bedingungsleiste: neben der letzten Auswahl im Bild
  const pickWant = useMemo(() => {
    if (sketchEdit) return null
    if (cmeasure.on) return { faces: true, edges: true }
    switch (pickFor) {
      case 'plane':
        return { std: true, planar: true }
      case 'edges':
        return { edges: true }
      case 'faces':
        return edit?.draft.type === 'moveface' ? { planar: true } : { faces: true }
      case 'dir':
      case 'dir2':
        return { edges: 'line', planar: true, cyl: true }
      case 'axis':
        return { edges: true, cyl: true }
      case 'mplane':
        return { std: true, planar: true }
      case 'cyl':
        return { cyl: true }
      default:
        return null
    }
  }, [pickFor, sketchEdit, edit?.draft.type, cmeasure.on])

  const onPick = (h, ev) => {
    if (cmeasure.on) {
      if (!h?.point) return
      const pick = { point: h.point, surf: h.face ?? null, edge: h.edge ?? null }
      setCmeasure((m) => ({ ...m, picks: [...(m.picks.length >= 2 ? [] : m.picks), pick] }))
      return
    }
    if (!edit || !h) return
    const d = edit.draft
    if (pickFor === 'plane') {
      const plane = h.std ? STD_PLANES[h.std] : h.face?.normal ? planeFromFace(h.face) : null
      if (!plane) return note('Eine Hauptebene oder eine ebene Fläche anklicken')
      const ref = h.std ? { std: h.std } : { face: faceRef(h.face) }
      if (d.sketch) {
        // Ebene einer vorhandenen Skizze tauschen: Geometrie bleibt in lokalen Koordinaten (Abstand bleibt)
        setDraft({ sketch: { ...d.sketch, plane: shiftPlane(plane, num(d.sketch.offset) || 0), planeRef: ref } })
      } else setDraft({ sketch: newSketch(plane, ref) })
      setSkInfo({ ok: true, dof: 0, free: new Set(), redundant: 0 })
      setPickFor(null)
      setTool('line')
      setTimeout(() => viewRef.current?.lookAt(plane), 0)
      return
    }
    if (pickFor === 'edges' && h.edge) {
      const ref = edgeRef(h.edge)
      // Kanten werden am Stand vor dem Feature gewählt
      const has = d.edges.some((r) => matchEdges(shownTessBefore, [r]).has(h.edge.tag))
      setDraft({ edges: has ? d.edges.filter((r) => !matchEdges(shownTessBefore, [r]).has(h.edge.tag)) : [...d.edges, ref] })
      return
    }
    if (pickFor === 'faces' && h.face) {
      const has = d.faces.some((r) => matchFaces(shownTessBefore, [r]).has(h.face.tag))
      let add = [faceRef(h.face)]
      // ganze Bohrung bzw. ganzer Radius auf einmal
      if (d.type === 'removefaces' && h.face.kind === 'cylinder' && !ev?.altKey) add = coaxialFaces(shownTessBefore, h.face).map(faceRef)
      setDraft({ faces: has ? d.faces.filter((r) => !matchFaces(shownTessBefore, [r]).has(h.face.tag)) : [...d.faces, ...add] })
      return
    }
    if (pickFor === 'dir' || pickFor === 'dir2') {
      const ref = h.edge ? { edge: edgeRef(h.edge) } : h.face ? { face: faceRef(h.face) } : null
      if (ref && dirOf(ref)) setDraft({ [pickFor]: ref })
      setPickFor(null)
      return
    }
    if (pickFor === 'axis') {
      const ref = h.edge ? { edge: edgeRef(h.edge) } : h.face ? { face: faceRef(h.face) } : null
      if (ref && axisOf(ref)) setDraft({ axis: ref })
      setPickFor(null)
      return
    }
    if (pickFor === 'mplane') {
      const ref = h.std ? { std: h.std } : h.face?.normal ? { face: faceRef(h.face) } : null
      if (ref) setDraft({ plane: ref })
      setPickFor(null)
      return
    }
    if (pickFor === 'cyl' && h.face?.kind === 'cylinder') {
      const parts = coaxialFaces(shownTessBefore, h.face)
      const full = h.face.hole && h.face.full !== false
      const r = Number(h.face.radius.toFixed(3))
      if (d.type === 'rehole' || (d.type === 'refillet' && full)) {
        setDraft({ type: 'rehole', name: d.name.replace(FEATURE_LABEL.refillet, FEATURE_LABEL.rehole), surfaces: parts.map((s) => s.center), axis: h.face.axis, origin: h.face.origin, diameter: String(2 * r), was: 2 * r })
      } else setDraft({ surfaces: parts.map((s) => s.center), axis: h.face.axis, radius: String(r), was: r })
      setPickFor(null)
    }
  }

  // Stand vor dem bearbeiteten Feature (zum Wählen von Kanten/Flächen)
  const [before, setBefore] = useState(null)
  const beforeKey = edit && ['fillet', 'chamfer', 'removefaces', 'moveface', 'shell', 'refillet', 'rehole', 'pattern', 'mirror'].includes(edit.draft.type) ? `${edit.index}|${builtKey}` : null
  useEffect(() => {
    if (!beforeKey) {
      setBefore(null)
      return
    }
    if (edit.index === features.length && built) {
      setBefore(built)
      return
    }
    let stop = false
    cadBuildView({ base: cad.base ?? null, features: kernelFeatures(features, edit.index) })
      .then((r) => !stop && setBefore(r))
      .catch((e) => onError(String(e)))
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beforeKey, built])
  const shownTessBefore = before?.tess ?? shownTess
  // beim Wählen von Kanten/Flächen den Stand davor zeigen (sonst sind sie schon verrundet/weg)
  // Verrunden/Fase: sobald Kanten gewählt sind, das Ergebnis zeigen und die Kanten des Stands davor darüber legen
  const edgeFeature = !!edit && ['fillet', 'chamfer'].includes(edit.draft.type)
  const pickEdges = edgeFeature && pickFor === 'edges' && before?.tess && preview?.tess && edit.draft.edges?.length ? before.tess.curves : null
  const viewTess = pickEdges
    ? preview.tess
    : edit && pickFor && ['edges', 'faces', 'cyl'].includes(pickFor) && before?.tess
      ? before.tess
      : sketchEdit
        ? (preview?.tess ?? null)
        : shownTess

  const selected = useMemo(() => {
    const d = edit?.draft
    const out = { faces: new Set(), edges: new Set(), std: new Set() }
    if (cmeasure.on) {
      for (const p of cmeasure.picks) {
        if (p.surf) out.faces.add(p.surf.tag)
        if (p.edge) out.edges.add(p.edge.tag)
      }
      return out
    }
    if (!d) return out
    if (d.edges) out.edges = matchEdges(pickEdges ? before.tess : viewTess, d.edges)
    if (d.faces) out.faces = matchFaces(viewTess, d.faces)
    if (d.type === 'mirror' && d.plane?.std) out.std.add(d.plane.std)
    if (d.type === 'mirror' && d.plane?.face) out.faces = matchFaces(viewTess, [d.plane.face])
    if ((d.type === 'refillet' || d.type === 'rehole') && d.surfaces) out.faces = matchFaces(viewTess, d.surfaces.map((c) => ({ center: c })))
    return out
  }, [edit?.draft, viewTess, cmeasure, pickEdges])

  // Bereiche zum Anklicken (Extrudieren/Drehen) – direkt aus der Skizze, je Skizze einmal geholt
  const regionDraft = edit && (edit.draft.type === 'extrude' || edit.draft.type === 'revolve') ? edit.draft : null
  const regionSketchF = regionDraft ? features.find((f) => f.id === regionDraft.sketch && f.type === 'sketch') : null
  const regionSketch = regionSketchF?.sketch ?? null
  const regionKey = regionSketch ? JSON.stringify(kernelSketch(regionSketchF.id, regionSketch)) : null
  const [regionCache, setRegionCache] = useState(() => new Map())
  const [regionHover, setRegionHover] = useState(-1)
  useEffect(() => {
    if (!regionKey || regionCache.has(regionKey)) return
    let stop = false
    const sk = JSON.parse(regionKey)
    cadBuildView({ base: null, features: [sk], regions_of: sk.id, tess: false })
      .then((r) => !stop && setRegionCache((m) => new Map(m).set(regionKey, r.regions ?? [])))
      .catch((e) => !stop && onError(String(e)))
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionKey])
  const regionInfo = regionKey ? (regionCache.get(regionKey) ?? null) : null
  const anyFill = !!regionInfo?.some((r) => r.fill)
  const pickPt = (p) => (Array.isArray(p) ? p : p.pt)
  const onOf = (d, r) =>
    d.regions == null
      ? d.fillGroup
        ? (r.groups ?? []).includes(d.fillGroup)
        : d.useFills !== false && anyFill
          ? r.fill
          : r.evenodd
      : d.regions.some((p) => insidePoly(pickPt(p), r.loops))
  // andere Features derselben Skizze: welche Flächen sie schon benutzen
  const regionState = useMemo(() => {
    if (!regionInfo || !regionDraft) return null
    const others = features.filter((f) => (f.type === 'extrude' || f.type === 'revolve') && !f.suppressed && f.sketch === regionDraft.sketch && f.id !== regionDraft.id)
    return regionInfo.map((r) => ({ on: onOf(regionDraft, r), used: others.find((f) => onOf(f, r))?.name ?? null }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionInfo, regionDraft, features, anyFill])
  // Ziehgriff für die Extrusionstiefe: an der Mitte der gewählten Flächen, in Extrusionsrichtung
  const dragHandle = useMemo(() => {
    const d = edit?.draft
    if (!d) return null
    // Verrunden/Fase: Griff an der ersten Kante, nach außen (zwischen den Normalen der Nachbarflächen)
    if ((d.type === 'fillet' || d.type === 'chamfer') && d.edges?.length && (!pickFor || pickFor === 'edges') && shownTessBefore) {
      const tag = [...matchEdges(shownTessBefore, [d.edges[0]])][0]
      const c = shownTessBefore.curves.find((x) => x.tag === tag)
      if (!c) return null
      const ns = c.surfaces.map((t) => shownTessBefore.surfaces.find((f) => f.tag === t)?.normal).filter(Boolean)
      if (!ns.length) return null
      const sum = ns.reduce((a, n) => a.map((x, i) => x + n[i]), [0, 0, 0])
      const L = Math.hypot(...sum)
      if (L < 1e-9) return null
      const key = d.type === 'fillet' ? 'radius' : 'distance'
      const v = num(d[key])
      if (!Number.isFinite(v)) return null
      return {
        origin: c.mid,
        dir: sum.map((x) => x / L),
        value: v,
        min: 0.1,
        label: `${d.type === 'fillet' ? 'R' : ''}${fmtField(v)} mm`,
        onChange: (x) => setDraft({ [key]: fmtField(x) }),
      }
    }
    // Bohrung: Tiefe am ersten Bohrpunkt, in das Material hinein
    if (d.type === 'hole' && !d.through && !pickFor) {
      const skF = features.find((f) => f.id === d.sketch && f.type === 'sketch')
      const p0 = skF && skF.sketch.ents.find((e) => e.t === 'point')
      const pt = p0 ? skF.sketch.pts[p0.p] : skF && Object.values(skF.sketch.pts)[0]
      const depth = num(d.depth)
      if (!pt || !Number.isFinite(depth)) return null
      const B = basis(skF.sketch.plane)
      const k = d.flip ? 1 : -1
      return {
        origin: to3d(skF.sketch.plane, [pt.x, pt.y]),
        dir: B.n.map((x) => x * k),
        value: depth,
        min: 0.1,
        label: `Tiefe ${fmtField(depth)} mm`,
        onChange: (x) => setDraft({ depth: fmtField(x) }),
      }
    }
    if (d.type !== 'extrude' || d.through || pickFor) return null
    const skF = features.find((f) => f.id === d.sketch && f.type === 'sketch')
    if (!skF) return null
    const depth = num(d.depth)
    if (!Number.isFinite(depth)) return null
    let pts = regionInfo && regionState ? regionInfo.filter((_, k) => regionState[k]?.on).map((r) => r.pt) : []
    if (!pts.length) pts = Object.values(skF.sketch.pts).map((p) => [p.x, p.y])
    if (!pts.length) return null
    const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
    const B = basis(skF.sketch.plane)
    const k = d.flip ? -1 : 1
    const sym = !!d.symmetric
    return {
      origin: to3d(skF.sketch.plane, c),
      dir: B.n.map((x) => x * k),
      value: sym ? depth / 2 : depth,
      min: sym ? 0.05 : 0.1,
      label: `${fmtField(depth)} mm`,
      onChange: (v) => setDraft({ depth: fmtField(sym ? 2 * v : v) }),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.draft, features, regionInfo, regionState, pickFor, shownTessBefore])
  // neues Feature, Skizze mit vielen Flächen: nichts vorwählen (sonst wird alles auf einmal extrudiert)
  const preChecked = useRef(null)
  useEffect(() => {
    if (!regionDraft || !regionInfo || !edit?.isNew) return
    const k = `${edit.id}|${regionDraft.sketch}`
    if (preChecked.current === k) return
    preChecked.current = k
    if (regionDraft.regions == null && regionInfo.length > 6) setDraft({ regions: [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionInfo, regionDraft?.sketch, edit?.id])
  const setPicks = (on) => setDraft({ regions: regionInfo.filter((_, k) => on[k]).map((r) => ({ pt: r.pt, area: r.area })) })
  const loopArea = (lp) => Math.abs(lp.reduce((a, p, k) => (k ? a + (lp[k - 1][0] * p[1] - p[0] * lp[k - 1][1]) : a), 0) / 2)
  const partsSketch = parts ? features.find((f) => f.id === parts.sketchId)?.sketch : null
  const partsFills = useMemo(() => (partsSketch?.fills ?? []).map((f) => ({ loops: fillLoops(f), group: f.group, area: 0 })), [partsSketch])
  const partsRegions = partsSketch
    ? {
        plane: partsSketch.plane,
        list: partsFills,
        state: partsFills.map((f) => {
          const row = parts.rows.find((r) => r.group === f.group)
          return { on: !!row?.on, hl: parts.hover === f.group }
        }),
        hover: -1,
        onHover: (i) => setParts((p) => (p ? { ...p, hover: partsFills[i]?.group ?? null } : p)),
        onToggle: (i) => setParts((p) => ({ ...p, rows: p.rows.map((r) => (r.group === partsFills[i].group ? { ...r, on: !r.on } : r)) })),
      }
    : null
  const regions =
    partsRegions ??
    (regionInfo && regionState && regionSketch && pickFor !== 'skaxis'
      ? {
          plane: regionSketch.plane,
          list: regionInfo,
          state: regionState,
          hover: regionHover,
          onHover: setRegionHover,
          onToggle: (i, alt) => {
            const on = regionState.map((x) => x.on)
            const target = !on[i]
            let idx = [i]
            if (alt) {
              // Fläche samt allem, was darin liegt (Löcher, Inseln)
              const outer = [...regionInfo[i].loops].sort((p, q) => loopArea(q) - loopArea(p))[0]
              idx = regionInfo.map((r, k) => (k === i || insidePoly(r.pt, [outer]) ? k : -1)).filter((k) => k >= 0)
            }
            for (const k of idx) on[k] = target
            setPicks(on)
          },
        }
      : null)
  const regionTools = regionInfo
    ? {
        count: regionInfo.length,
        chosen: regionState?.filter((x) => x.on).length ?? 0,
        anyFill,
        all: () => setPicks(regionInfo.map(() => true)),
        none: () => setDraft({ regions: [] }),
        fills: () => setPicks(regionInfo.map((r) => r.fill)),
        free: () => setPicks(regionInfo.map((_, k) => !regionState?.[k]?.used)),
        auto: () => setDraft({ regions: null }),
        groupLabel: regionDraft?.fillGroup ? (regionSketch?.fills ?? []).find((f) => f.group === regionDraft.fillGroup)?.label ?? 'Schraffur' : null,
      }
    : null
  const regionHint = regionHover >= 0 && regionState?.[regionHover]?.used && !regionState[regionHover].on ? `Diese Fläche benutzt schon „${regionState[regionHover].used}“` : null
  const axisLine = (() => {
    if (edit?.draft.type !== 'revolve' || !regionSketch || !edit.draft.axis) return null
    const e = regionSketch.ents.find((x) => x.id === edit.draft.axis)
    if (!e) return null
    return { plane: regionSketch.plane, a: [regionSketch.pts[e.a].x, regionSketch.pts[e.a].y], b: [regionSketch.pts[e.b].x, regionSketch.pts[e.b].y] }
  })()

  // fertige Skizzen im Hintergrund (nicht die gerade bearbeitete)
  const bgSketches = useMemo(() => {
    if (!showSketches) return []
    const used = edit?.draft?.sketch
    return features
      .filter((f) => f.type === 'sketch' && !f.suppressed && !f.hidden && f.id !== sketchEdit?.id && f.sketch?.ents?.length)
      .map((f) => ({ id: f.id, plane: f.sketch.plane, data: f.sketch, active: used === f.id || selSketch === f.id, highlightEnts: pickFor === 'skaxis' && used === f.id }))
  }, [features, showSketches, edit?.draft?.sketch, sketchEdit?.id, selSketch, pickFor])
  const onSketchPick = (id, open, ent) => {
    if (edit) {
      const d = edit.draft
      if (pickFor === 'skaxis' && id === d.sketch && ent) {
        const e = features.find((f) => f.id === id)?.sketch.ents.find((x) => x.id === ent)
        if (e?.t !== 'line') return note('Als Drehachse eine gerade Linie anklicken')
        setDraft({ axis: ent })
        setPickFor(null)
      } else if ((d.type === 'extrude' || d.type === 'revolve' || d.type === 'hole') && id != null && id !== d.sketch) {
        // andere Skizze im Bild angeklickt: für dieses Feature übernehmen
        const sk = features.find((f) => f.id === id)?.sketch
        const axis = d.type === 'revolve' ? (sk?.ents.find((e) => e.t === 'line' && e.axis) ?? sk?.ents.find((e) => e.t === 'line' && e.cons))?.id ?? null : d.axis
        setDraft({ sketch: id, regions: d.type === 'hole' ? d.regions : [], axis })
      }
      return
    }
    const f = features.find((g) => g.id === id)
    if (!f) return setSelSketch(null)
    setSelSketch(id)
    if (open) openEdit(f)
  }

  const sketchProps = sketchEdit
    ? {
        data: sketchEdit.sketch,
        plane: sketchEdit.sketch.plane,
        tool,
        construction,
        sel,
        info: skInfo,
        onChange: onSketchChange,
        onSel: setSel,
        onSelAt: setConPos,
        onMessage: note,
        showGlyphs,
      }
    : null

  // --- Draftpad ------------------------------------------------------------------------------
  const takeDraftpad = (text, name, source = null) => {
    try {
      const { doc, layers } = readDraftpad(text)
      const hasFills = layers.some((l) => l.hatches)
      // aus der Online-Ablage: standardmäßig verknüpft (Draftpad bleibt die Vorlage, Aktualisieren per Knopf)
      setDp({ doc, layers, name, source, opts: { layers: defaultLayers(layers), tol: '0.3', center: true, fixed: false, fills: hasFills, dims: true, linked: !!source } })
      // ohne offene Skizze: neue Skizze anfangen, erst die Ebene wählen
      if (!sketchEdit) {
        if (edit) cancel()
        setTimeout(() => startNew('sketch'), 0)
      }
    } catch (e) {
      note(String(e.message ?? e))
    }
  }
  const onDraftpadFile = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) takeDraftpad(await f.text(), f.name)
  }
  useEffect(() => {
    if (openLibrary) setDpLib(true)
  }, [openLibrary])
  const lastIncoming = useRef(null)
  useEffect(() => {
    if (incoming && incoming.n !== lastIncoming.current) {
      lastIncoming.current = incoming.n
      takeDraftpad(incoming.text, incoming.name, incoming.source ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.n])
  const runImport = () => {
    if (!sketchEdit || !dp) return
    try {
      const o = dp.opts
      const tol = num(o.tol)
      const linked = !!(dp.source && o.linked)
      const { sketch, stats } = importDraftpad(sketchEdit.sketch, dp.doc, {
        layers: o.layers,
        tol: tol > 0 ? tol : 0.3,
        center: o.center,
        fixed: linked || o.fixed,
        fills: o.fills,
        dims: !(linked || o.fixed) && o.dims,
        stableIds: !!dp.source,
      })
      const r = solved(sketch)
      changeSketch(r.info.ok ? r.sketch : sketch, r.info, false)
      if (dp.source) {
        const source = { ...dp.source, layers: [...o.layers], opts: { tol: tol > 0 ? tol : 0.3, offset: stats.offset, fills: o.fills }, mode: linked ? 'linked' : 'copy' }
        setEdit((e) => (e ? { ...e, draft: { ...e.draft, source, name: e.isNew ? dp.source.name : e.draft.name } } : e))
      }
      setDp(null)
      setTool('select')
      note(
        `Übernommen: ${stats.lines} Linien, ${stats.arcs} Bögen, ${stats.circles} Kreise` +
          (stats.merged ? `, ${stats.merged} Lücken geschlossen` : '') +
          (stats.cons ? `, ${stats.cons} Bedingungen erkannt` : '') +
          (stats.dims ? `, ${stats.dims} Maße aus Draftpad` : '') +
          (stats.fills ? `, ${stats.fills} Schraffuren als Material vorgewählt` : '') +
          (stats.solved ? '' : ' – Bedingungen ließen sich nicht alle einhalten und wurden weggelassen'),
      )
      setTimeout(() => viewRef.current?.lookAt(sketchEdit.sketch.plane, r.sketch ?? sketch), 0)
    } catch (e) {
      note(String(e.message ?? e))
    }
  }

  // verknüpfte Skizze neu aus Draftpad holen (Lage, Ebenen und Kennungen bleiben – Bezüge wie die Drehachse halten)
  const reimport = async (f, mode) => {
    const src = f.source
    const [doc, meta] = await Promise.all([api.draftpadGet(src.id), api.draftpadMeta(src.id).catch(() => null)])
    const layers = new Set(src.layers.filter((id) => doc.layers.some((l) => l.id === id)))
    if (!layers.size) throw new Error(`„${src.name}“: die übernommenen Ebenen gibt es in Draftpad nicht mehr`)
    const { sketch } = importDraftpad(newSketch(f.sketch.plane, f.sketch.planeRef), doc, { ...src.opts, layers, fixed: mode === 'linked', stableIds: true })
    const r = mode === 'linked' ? { sketch } : solved(sketch)
    return { ...f, sketch: r.sketch ?? sketch, source: { ...src, mode, updated: meta?.updated ?? src.updated, name: meta?.name ?? src.name } }
  }
  const refreshDraftpad = async (f, mode = 'linked') => {
    try {
      const g = await reimport(f, mode)
      const list = features.map((x) => (x.id === f.id ? g : x))
      // Bezüge prüfen: Drehachsen, die es nicht mehr gibt
      const lost = list.filter((x) => x.type === 'revolve' && x.sketch === f.id && x.axis && !g.sketch.ents.some((e) => e.id === x.axis))
      commitFeatures(list)
      setStale((m) => {
        const n = { ...m }
        delete n[f.id]
        return n
      })
      note(
        mode === 'copy'
          ? `„${f.name}“ ist jetzt eine eigene Kopie (bemaßbar, nicht mehr verknüpft)`
          : `„${f.name}“ aus Draftpad aktualisiert` + (lost.length ? ` – Drehachse fehlt bei ${lost.map((x) => `„${x.name}“`).join(', ')}` : ''),
      )
    } catch (e) {
      note(String(e.message ?? e))
    }
  }
  const openInDraftpad = async (f) => {
    const st = await api.draftpadStatus().catch(() => null)
    if (!st?.url) return note('Draftpad ist nicht verbunden')
    window.open(`${st.url}/?open=${encodeURIComponent(f.source.id)}`, '_blank')
  }
  // Änderungen in Draftpad bemerken (alle 4 s und beim Zurückkehren ins Fenster) und gleich übernehmen
  const linkedKey = features
    .filter((f) => f.type === 'sketch' && f.source?.kind === 'draftpad' && f.source.mode === 'linked' && !f.suppressed)
    .map((f) => `${f.id}:${f.source.id}:${f.source.updated}`)
    .join('|')
  const featuresRef = useRef(features)
  featuresRef.current = features
  // neueste Fassungen für die Abfrage im Hintergrund (sonst sähe sie alte Features)
  const autoRef = useRef(null)
  autoRef.current = { refresh: refreshDraftpad, editing: !!edit }
  useEffect(() => {
    if (!linkedKey) return
    let stop = false
    const check = async () => {
      for (const f of featuresRef.current) {
        if (f.type !== 'sketch' || f.source?.kind !== 'draftpad' || f.source.mode !== 'linked' || f.suppressed) continue
        try {
          const m = await api.draftpadMeta(f.source.id)
          if (stop) return
          if (m?.updated && f.source.updated && m.updated > f.source.updated) {
            // gleich übernehmen (wie live), außer während ein Feature bearbeitet wird – dann Hinweis
            if (!autoRef.current.editing) await autoRef.current.refresh(f)
            else setStale((s) => (s[f.id] === m.updated ? s : { ...s, [f.id]: m.updated }))
          }
        } catch {
          /* Server gerade nicht erreichbar */
        }
      }
    }
    check()
    const t = setInterval(check, 4000)
    const onVis = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', check)
    return () => {
      stop = true
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', check)
    }
  }, [linkedKey])
  const staleList = Object.keys(stale)
    .map((id) => features.find((f) => String(f.id) === id))
    .filter(Boolean)

  // --- Ausgabe ---------------------------------------------------------------------------------
  const hasBody = (built?.bodies ?? 0) > 0
  const errors = (built?.status ?? []).filter((s) => !s.ok && !s.skipped)
  const appliedNow = applied === builtKey
  const editingSketchEmpty = edit?.draft.type === 'sketch' && !edit.draft.sketch

  return (
    <div className="cad-studio">
      <aside className="sidebar cad-side">
        {parts && !edit && <PartsDialog parts={parts} setParts={setParts} sketch={partsSketch} onCreate={createParts} />}
        {!edit && !parts && (
          <>
            {staleList.map((f) => (
              <div key={f.id} className="notice warn small">
                <RefreshCw size={14} />
                <div>
                  Die Draftpad-Zeichnung zu „{f.name}“ wurde geändert.{' '}
                  <button className="link" onClick={() => refreshDraftpad(f)}>
                    Aktualisieren
                  </button>
                </div>
              </div>
            ))}
            <section className="section">
              <h2>
                <Hash size={15} /> Verlauf
                {newKernelWanted() && (
                  <span
                    className={'cad-kern ' + (built?.kernel === 'neu' ? 'neu' : 'alt')}
                    title={built?.kernel === 'neu' ? 'Neuer Geometriekern im Browser (zurück: #kern=alt an der Adresse)' : (oldKernelReason({ base: cad.base, features: kernelFeatures(features) }) ?? '')}
                  >
                    {built?.kernel === 'neu' ? `neuer Kern · ${built.timing?.total ?? '–'} ms` : 'alter Kern'}
                  </span>
                )}
              </h2>
              {cad.base && (
                <div className="cad-feat base" title={cad.base}>
                  <SquareDashed size={14} /> <span>Ausgangsteil (STEP)</span>
                </div>
              )}
              {!features.length && !cad.base && <p className="hint">Noch leer. Mit „Skizze“ anfangen: Ebene wählen, Kontur zeichnen, bemaßen, dann extrudieren.</p>}
              {features.map((f, i) => {
                const Icon = FEATURE_ICON[f.type] ?? Info
                const st = status.get(f.id)
                const prob = problemOf(f, features)
                return (
                  <div
                    key={f.id}
                    className={'cad-feat' + (f.suppressed ? ' off' : '') + (st && !st.ok && !st.skipped ? ' bad' : '') + (st?.skipped ? ' skipped' : '') + (selSketch === f.id ? ' on' : '')}
                    onDoubleClick={() => openEdit(f)}
                    title={st?.error ?? st?.warn?.join(' · ') ?? prob ?? 'Doppelklick zum Bearbeiten'}
                  >
                    <Icon size={14} />
                    <button className="cad-feat-name" onClick={() => openEdit(f)}>
                      {f.name}
                    </button>
                    {(st?.error || prob) && !f.suppressed && <TriangleAlert size={13} className="bad-icon" />}
                    {st?.warn && <Info size={13} className="warn-icon" />}
                    <span className="spacer" />
                    {f.source?.mode === 'linked' && (
                      <button
                        className={'icon-btn keep' + (stale[f.id] ? ' dp-stale-btn' : '')}
                        title={stale[f.id] ? 'In Draftpad geändert – jetzt aktualisieren' : `Verknüpft mit Draftpad „${f.source.name}“ – neu holen`}
                        onClick={() => refreshDraftpad(f)}
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                    {stale[f.id] && <span className="dp-stale">geändert</span>}
                    {f.type === 'sketch' && !f.suppressed && f.sketch?.fills?.length > 0 && (
                      <button className="icon-btn keep" title="Teile aus den Schraffuren anlegen (je Schraffur-Art ein Körper)" onClick={() => openParts(f)}>
                        <Boxes size={13} />
                      </button>
                    )}
                    {f.type === 'sketch' && !f.suppressed && (
                      <button
                        className={'icon-btn' + (f.hidden ? ' keep' : '')}
                        title={f.hidden ? 'Skizze im Bild zeigen' : 'Skizze im Bild ausblenden (wirkt weiter)'}
                        onClick={() => setCad({ ...cad, features: features.map((g, k) => (k === i ? { ...g, hidden: !g.hidden || undefined } : g)) })}
                      >
                        {f.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    )}
                    <button className={'icon-btn' + (f.suppressed ? ' keep' : '')} title={f.suppressed ? 'Wieder einschalten' : 'Unterdrücken (vorübergehend aus, wirkt nicht mehr)'} onClick={() => commitFeatures(features.map((g, k) => (k === i ? { ...g, suppressed: !g.suppressed } : g)))}>
                      {f.suppressed ? <PowerOff size={13} /> : <Power size={13} />}
                    </button>
                    <button className="icon-btn" title="Löschen" onClick={() => removeFeature(f)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
              {errors.map((e) => (
                <div key={e.id} className="notice warn small">
                  <TriangleAlert size={14} />
                  <div>
                    <b>{features.find((f) => f.id === e.id)?.name}:</b> {e.error}
                  </div>
                </div>
              ))}
              {(built?.status ?? []).filter((s) => s.warn).map((s) => (
                <p key={s.id} className="hint">
                  {features.find((f) => f.id === s.id)?.name}: {s.warn.join(' · ')}
                </p>
              ))}
            </section>
            <section className="section">
              <h2>
                <Play size={15} /> Rechnen
              </h2>
              <p className="hint">
                {hasBody
                  ? `${built.bodies} Körper, Volumen ${fmtN(built.volume / 1000)} cm³.`
                  : 'Noch kein Körper.'}{' '}
                {built?.kernel === 'neu' && built.timing && <small className="muted">(neuer Kern, {built.timing.total} ms) </small>}
                {appliedNow ? 'Dieser Stand ist im Modell.' : hasBody ? 'Übernehmen vernetzt das Teil; Lager und Lasten werden auf die neuen Flächen übertragen.' : ''}
              </p>
              <button className={'btn wide' + (!appliedNow && hasBody ? ' primary' : '')} disabled={!hasBody || busy || building || errors.length > 0} onClick={() => onApply(builtKey)}>
                <Check size={15} /> {appliedNow ? 'Übernommen' : 'In die Rechnung übernehmen'}
              </button>
              <button className="btn wide" disabled={!hasBody || busy} onClick={onExport}>
                <Download size={15} /> Als STEP speichern
              </button>
            </section>
          </>
        )}
        {dp && sketchEdit && <DraftpadPanel dp={dp} setDp={setDp} onImport={runImport} />}
        {dp && edit && !sketchEdit && <p className="hint draw">Draftpad „{dp.name}“: erst die Ebene für die Skizze wählen (z. B. XZ für ein Drehteil).</p>}
        {edit && (
          <FeatureDialog
            edit={edit}
            features={features}
            setDraft={setDraft}
            linkTools={
              edit.draft.source?.kind === 'draftpad' && !edit.isNew
                ? {
                    refresh: () => {
                      const f = features.find((x) => x.id === edit.id)
                      cancel()
                      if (f) refreshDraftpad(f, f.source?.mode ?? 'linked')
                    },
                    open: () => openInDraftpad(edit.draft),
                    unlink: () => {
                      const f = features.find((x) => x.id === edit.id)
                      cancel()
                      if (f) refreshDraftpad(f, 'copy')
                    },
                  }
                : null
            }
            onOk={() => accept(false)}
            onOkNext={() => accept(true)}
            regionTools={regionTools}
            onCancel={cancel}
            pickFor={pickFor}
            setPickFor={setPickFor}
            status={preview?.status?.find((s) => s.id === edit.id)}
            sketchInfo={skInfo}
            sel={sel}
            setSel={setSel}
            onCon={applyCon}
            onFix={toggleFix}
            onConstruction={toggleConstruction}
            construction={construction}
            onDelete={deleteSelection}
            onDim={(id, v) => {
              const s2 = structuredClone(sketchEdit.sketch)
              const c = s2.cons.find((x) => x.id === id)
              c.v = v
              const r = solved(s2)
              if (!r.info.ok) return note('Dieser Wert lässt sich nicht einhalten')
              changeSketch(r.sketch, r.info, false)
            }}
            onDimName={(id, name) => {
              const s2 = structuredClone(sketchEdit.sketch)
              s2.cons.find((x) => x.id === id).name = name || undefined
              changeSketch(s2, skInfo, false)
            }}
            building={building}
          />
        )}
      </aside>

      <section className="stage cad-stage">
        <div className="cad-toolbar">
          {sketchEdit ? (
            <>
              {SKETCH_TOOLS.map(([k, title, Icon, key]) => (
                <button key={k} className={'cad-tool' + (tool === k ? ' on' : '')} title={`${title} (${key})`} aria-label={title} onClick={() => setTool(k)}>
                  <Icon size={17} />
                </button>
              ))}
              <button className="cad-tool" title="Draftpad-Zeichnung in diese Skizze übernehmen" onClick={() => setDpLib(true)}>
                <I.IcDraftpad size={18} />
              </button>
              <span className="cad-sep" />
              <button className={'cad-tool' + (construction ? ' on' : '')} title="Hilfslinie (geht nicht in den Körper ein; z. B. Drehachse). Mit Auswahl: umschalten" onClick={toggleConstruction}>
                <I.IcConstruction size={18} />
              </button>
              <button className="cad-tool" title="Punkte fixieren / lösen" onClick={toggleFix} disabled={!sel.pts.length && !sel.ents.length}>
                <Lock size={17} />
              </button>
              <button className="cad-tool" title="Auswahl löschen (Entf)" onClick={deleteSelection} disabled={!sel.pts.length && !sel.ents.length && !sel.cons.length}>
                <Trash2 size={17} />
              </button>
              <span className="cad-sep" />
              <button className="cad-tool" title="Rückgängig (Strg+Z)" onClick={skUndo}>
                <Undo2 size={17} />
              </button>
              <button className="cad-tool" title="Wiederholen (Strg+Y)" onClick={skRedo}>
                <Redo2 size={17} />
              </button>
              <button
                className={'cad-tool' + ((showGlyphs ?? (sketchEdit.sketch.cons.length <= 40)) ? ' on' : '')}
                title="Bedingungszeichen im Bild zeigen/verbergen (bei vielen Elementen automatisch aus)"
                onClick={() => setShowGlyphs(!(showGlyphs ?? sketchEdit.sketch.cons.length <= 40))}
              >
                <I.IcConstraints size={18} />
              </button>
              <span className="cad-sep" />
              <SketchStatus info={skInfo} />
            </>
          ) : (
            <>
              {PART_TOOLS.map(([k, title]) => {
                const Icon = FEATURE_ICON[k]
                return (
                  <button key={k} className="cad-tool labeled" title={title} disabled={!!edit} onClick={() => startNew(k)}>
                    <Icon size={22} />
                    <span>{SHORT[k] ?? FEATURE_LABEL[k]}</span>
                  </button>
                )
              })}
              <MoreMenu disabled={!!edit} onPick={(k) => startNew(k)} />
              <button className="cad-tool labeled" title="Zeichnung aus Draftpad (Online-Ablage oder .draftpad.json) als Skizze übernehmen" disabled={!!edit} onClick={() => setDpLib(true)}>
                <I.IcDraftpad size={22} />
                <span>Draftpad</span>
              </button>
              {cad.base && (
                <button className="cad-tool labeled" title="Radius oder Bohrung des Ausgangsteils ändern (Zylinderfläche anklicken)" disabled={!!edit} onClick={() => { startNew('refillet'); setPickFor('cyl') }}>
                  <I.IcFillet size={22} />
                  <span>Radius/Bohrung</span>
                </button>
              )}
              <span className="cad-sep" />
              <button className={'cad-tool' + (showSketches ? ' on' : '')} title={showSketches ? 'Fertige Skizzen ausblenden' : 'Fertige Skizzen zeigen'} onClick={() => setShowSketches(!showSketches)}>
                {showSketches ? <I.IcSketch size={18} /> : <PenOff size={17} />}
              </button>
              <button className={'cad-tool' + (showStd ? ' on' : '')} title={showStd ? 'Hauptebenen verbergen (erscheinen weiter, wenn eine Ebene gewählt werden soll)' : 'Hauptebenen zeigen'} onClick={() => setShowStd(!showStd)}>
                <I.IcLayers size={18} />
              </button>
              <button className="cad-tool" title="Rückgängig (Strg+Z)" disabled={!!edit || !history.undo.length} onClick={undo}>
                <Undo2 size={17} />
              </button>
              <button className="cad-tool" title="Wiederholen (Strg+Y)" disabled={!!edit || !history.redo.length} onClick={redo}>
                <Redo2 size={17} />
              </button>
            </>
          )}
          {building && <Loader2 size={16} className="spin cad-busy" />}
          <input ref={fileRef} type="file" accept=".json,.draftpad" style={{ display: 'none' }} onChange={onDraftpadFile} />
          {dpLib && (
            <DraftpadLibrary
              onClose={() => setDpLib(false)}
              onError={note}
              onFile={() => {
                setDpLib(false)
                fileRef.current?.click()
              }}
              onPick={({ doc, source }) => takeDraftpad(JSON.stringify(doc), source.name, source)}
            />
          )}
        </div>
        {sketchEdit && (sel.pts.length > 0 || sel.ents.length > 0 || sel.cons.length > 0) && (
          <ConBar pos={conPos} sk={sketchEdit.sketch} sel={sel} onOffset={applyOffset} onCon={applyCon} onFix={toggleFix} onConstruction={toggleConstruction} construction={construction} onDelete={deleteSelection} />
        )}
        {(msg || pickFor || regionHint) && (
          <div className="cad-hint">
            {msg ??
              regionHint ??
              {
                plane: 'Ebene wählen: Hauptebene (XY, XZ, YZ) oder ebene Fläche des Bauteils anklicken',
                edges: 'Kanten anklicken (nochmal klicken = abwählen). Tangential anschließende Kanten kommen mit.',
                faces: edit?.draft.type === 'moveface' ? 'Ebene Flächen anklicken' : 'Flächen anklicken – bei Zylindern kommt die ganze Bohrung mit (Alt: nur diese Fläche)',
                dir: 'Richtung: gerade Kante, ebene Fläche (Normale) oder Zylinder (Achse) anklicken',
                dir2: 'Zweite Richtung: gerade Kante, ebene Fläche oder Zylinder anklicken',
                axis: 'Achse: Kreiskante, Zylinderfläche oder gerade Kante anklicken',
                mplane: 'Spiegelebene: Hauptebene oder ebene Fläche anklicken',
                cyl: 'Radius- oder Bohrungsfläche (Zylinder) anklicken',
                skaxis: 'Drehachse: eine gerade Linie der Skizze anklicken (Esc bricht ab)',
              }[pickFor]}
          </div>
        )}
        <CadView
          ref={viewRef}
          tess={viewTess}
          nav={nav}
          pick={pickWant}
          onPick={onPick}
          selected={selected}
          sketch={sketchProps}
          showPlanes={!sketchEdit && (showStd || !hasBody || pickFor === 'plane' || pickFor === 'mplane' || editingSketchEmpty)}
          regions={regions}
          axisLine={axisLine}
          sketches={bgSketches}
          onSketchPick={onSketchPick}
          preview={!!edit && ['extrude', 'revolve', 'hole'].includes(edit.draft.type) && edit.draft.mode === 'cut'}
          handle={dragHandle}
          pickEdges={pickEdges}
          measureTool={sketchEdit ? null : { on: cmeasure.on, onToggle: () => setCmeasure((m) => ({ on: !m.on, picks: [] })) }}
        />
        {cmeasure.on && !sketchEdit && (
          <div className="measure-panel">
            <b>Messen</b>
            {!cmeasure.picks.length && <span className="muted">Fläche oder Kante anklicken (Ø, Länge) – eine zweite für den Abstand</span>}
            {cmeasure.picks.map((p, i) => (
              <span key={i}>
                <b className="measure-tag">{'AB'[i]}</b> {describePick(p)}
              </span>
            ))}
            {cmeasure.picks.length === 2 && betweenPicks(cmeasure.picks[0], cmeasure.picks[1]).map((t) => <span key={t}>{t}</span>)}
            <button className="btn small" onClick={() => setCmeasure({ on: false, picks: [] })}>
              Fertig
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function insidePoly(q, loops) {
  let n = 0
  for (const lp of loops)
    for (let k = 0; k < lp.length - 1; k++) {
      const [x0, y0] = lp[k]
      const [x1, y1] = lp[k + 1]
      if (y0 > q[1] !== y1 > q[1] && x0 + ((q[1] - y0) * (x1 - x0)) / (y1 - y0) > q[0]) n++
    }
  return n % 2 === 1
}

function SketchStatus({ info }) {
  if (!info) return null
  if (!info.ok) return <span className="cad-status bad">Nicht lösbar</span>
  if (info.dof === 0) return <span className="cad-status good">Voll bestimmt</span>
  return (
    <span className="cad-status" title="Blau = noch frei beweglich. Mit Maßen und Bedingungen festlegen (muss nicht – unbestimmte Skizzen gehen auch)">
      {info.dof} Freiheitsgrad{info.dof === 1 ? '' : 'e'}
    </span>
  )
}

// --- Dialoge der Features -------------------------------------------------------------------------

function Num({ label, value, onChange, unit = 'mm', disabled, min }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-unit">
        <NumInput value={value} disabled={disabled} onChange={onChange} min={min} />
        {unit && <em>{unit}</em>}
      </div>
    </label>
  )
}

function Seg({ value, options, onChange }) {
  return (
    <div className="segmented small">
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function PickButton({ active, label, value, onClick }) {
  return (
    <button className={'btn pick' + (active ? ' on' : '')} onClick={onClick}>
      {label}: <span className="count">{value}</span>
    </button>
  )
}

function FeatureDialog({ edit, features, setDraft, onOk, onOkNext, regionTools, linkTools, onCancel, pickFor, setPickFor, status, sketchInfo, sel, setSel, onCon, onFix, onConstruction, construction, onDelete, onDim, onDimName, building }) {
  const d = edit.draft
  const before = features.slice(0, edit.index)
  const sketches = before.filter((f) => f.type === 'sketch' && !f.suppressed)
  const solids = before.filter((f) => ['extrude', 'revolve', 'hole', 'sweep', 'loft'].includes(f.type) && !f.suppressed)
  const Icon = FEATURE_ICON[d.type] ?? Info
  const prob = problemOf(d, [...before, d])
  const sketchSel = (
    <label className="field">
      <span>Skizze</span>
      <select value={d.sketch ?? ''} onChange={(e) => setDraft({ sketch: Number(e.target.value) || null, regions: null, axis: null })}>
        <option value="">– wählen –</option>
        {sketches.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  )
  const modeSel = (
    <>
      <Seg
        value={d.mode}
        onChange={(mode) => setDraft({ mode })}
        options={[
          ['add', 'Dazu'],
          ['cut', 'Weg'],
          ['new', 'Neuer Körper'],
        ]}
      />
      {d.mode === 'new' && (
        <>
          <label className="field">
            <span>Körpername (erscheint in der Rechnung)</span>
            <input value={d.bodyName ?? ''} placeholder="z. B. Welle" onChange={(e) => setDraft({ bodyName: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={d.subtract !== false} onChange={(e) => setDraft({ subtract: e.target.checked })} /> Überschneidung mit anderen Körpern abziehen
          </label>
        </>
      )}
    </>
  )
  const featurePick = (
    <div className="cad-feat-pick">
      <label className="check">
        <input type="checkbox" checked={d.features === 'body'} onChange={(e) => setDraft({ features: e.target.checked ? 'body' : [] })} /> Ganzer Körper
      </label>
      {d.features !== 'body' &&
        solids.map((f) => (
          <label key={f.id} className="check">
            <input
              type="checkbox"
              checked={(d.features ?? []).includes(f.id)}
              onChange={(e) => setDraft({ features: e.target.checked ? [...d.features, f.id] : d.features.filter((x) => x !== f.id) })}
            />{' '}
            {f.name}
          </label>
        ))}
      {d.features !== 'body' && !solids.length && <p className="hint">Noch keine Extrusion, Drehung oder Bohrung davor.</p>}
    </div>
  )
  const sk = d.type === 'sketch' ? d.sketch : null

  return (
    <section className="section cad-dialog">
      <h2>
        <Icon size={15} />
        <input className="cad-name" value={d.name} onChange={(e) => setDraft({ name: e.target.value })} />
      </h2>

      {d.type === 'sketch' && (
        <>
          <PickButton active={pickFor === 'plane'} label="Ebene" value={sk ? (sk.planeRef?.std ? `Ebene ${sk.planeRef.std}` : 'Fläche') : 'im Bild wählen'} onClick={() => setPickFor(pickFor === 'plane' ? null : 'plane')} />
          {sk && basePlaneOf(sk) && (
            <Num
              label="Abstand zur Ebene (z. B. für Loft)"
              value={sk.offset ?? '0'}
              onChange={(offset) => {
                const v = num(offset)
                setDraft({ sketch: { ...sk, offset, plane: Number.isFinite(v) ? shiftPlane(basePlaneOf(sk), v) : sk.plane } })
              }}
            />
          )}
          {d.source?.kind === 'draftpad' && (
            <div className="notice small dp-source">
              <FileUp size={14} />
              <div>
                {d.source.mode === 'linked' ? 'Verknüpft mit' : 'Kopie von'} Draftpad „{d.source.name}“
                {d.source.mode === 'linked' && <>. Die Geometrie ist fest – ändern in Draftpad, dann hier aktualisieren.</>}
                {linkTools && (
                  <div className="cad-cons-row">
                    {d.source.mode === 'linked' && (
                      <button className="btn small" onClick={linkTools.refresh}>
                        <RefreshCw size={13} /> Aktualisieren
                      </button>
                    )}
                    <button className="btn small" onClick={linkTools.open}>
                      <ExternalLink size={13} /> In Draftpad bearbeiten
                    </button>
                    {d.source.mode === 'linked' && (
                      <button className="btn small" title="Bedingungen erkennen und in Projekt-FEM bemaßbar machen; danach kein Aktualisieren mehr" onClick={linkTools.unlink}>
                        <Unlink size={13} /> Verknüpfung lösen
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {sk && (
            <>
              <SketchConstraints sk={sk} sel={sel} onCon={onCon} onFix={onFix} onConstruction={onConstruction} construction={construction} onDelete={onDelete} />
              <SketchDims sk={sk} sel={sel} setSel={setSel} onDim={onDim} onDimName={onDimName} />
              <p className="hint">
                Klicken oder ziehen zum Zeichnen; Länge und Winkel stehen am Zeiger und rasten auf glatte Werte (⇧ = frei). Beim Zeichnen einfach
                die Zahl tippen und Enter: Linie <b>50</b> (oder <b>50@30</b> für 30°), Rechteck <b>60x40</b>, Kreis <b>Ø</b> – daraus werden Maße.
                Bemaßen (D): ein Element oder zwei anklicken, ablegen, Wert eintippen; Doppelklick auf ein Maß ändert es. Elemente anklicken zeigt
                die passenden Bedingungen gleich daneben.
              </p>
              {sketchInfo && !sketchInfo.ok && <p className="hint bad">Die Skizze lässt sich so nicht lösen – letzte Änderung zurücknehmen (Strg+Z).</p>}
            </>
          )}
        </>
      )}

      {d.type === 'extrude' && (
        <>
          {sketchSel}
          {modeSel}
          <label className="check">
            <input type="checkbox" checked={d.through} onChange={(e) => setDraft({ through: e.target.checked })} /> Durch alles
          </label>
          {!d.through && <Num label="Tiefe" value={d.depth} onChange={(depth) => setDraft({ depth })} />}
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={d.flip} onChange={(e) => setDraft({ flip: e.target.checked })} /> Richtung umkehren
            </label>
            <label className="check">
              <input type="checkbox" checked={d.symmetric} onChange={(e) => setDraft({ symmetric: e.target.checked })} /> Symmetrisch
            </label>
          </div>
          <RegionTools d={d} t={regionTools} />
        </>
      )}

      {d.type === 'revolve' && (
        <>
          {sketchSel}
          {modeSel}
          <PickButton
            active={pickFor === 'skaxis'}
            label="Drehachse"
            value={axisName(features.find((f) => f.id === d.sketch)?.sketch, d.axis) ?? 'Linie im Bild anklicken'}
            onClick={() => setPickFor(pickFor === 'skaxis' ? null : 'skaxis')}
          />
          <label className="field">
            <span>oder aus der Liste</span>
            <select value={d.axis ?? ''} onChange={(e) => setDraft({ axis: e.target.value || null })}>
              <option value="">– wählen –</option>
              {axisOptions(features.find((f) => f.id === d.sketch)?.sketch).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Num label="Winkel" unit="°" value={d.angle} onChange={(angle) => setDraft({ angle })} />
          <label className="check">
            <input type="checkbox" checked={d.symmetric} onChange={(e) => setDraft({ symmetric: e.target.checked })} /> Symmetrisch
          </label>
          <RegionTools d={d} t={regionTools} />
        </>
      )}

      {d.type === 'hole' && (
        <>
          {sketchSel}
          <p className="hint">Gebohrt wird an jedem Punkt der Skizze (Werkzeug „Punkt“) und an Kreismitten, senkrecht zur Skizzenebene.</p>
          <label className="field">
            <span>Größe</span>
            <select
              value={d.size}
              onChange={(e) => {
                const h = HOLE_SIZES.find((x) => x.name === e.target.value)
                if (!h) return setDraft({ size: '' })
                const sink = d.sink.kind === 'cyl' ? { ...d.sink, d: String(h.cb), depth: String(h.cbT) } : d.sink.kind === 'cone' ? { ...d.sink, d: String(h.cs) } : d.sink
                setDraft({ size: h.name, diameter: String(h.d), sink })
              }}
            >
              <option value="">frei</option>
              {HOLE_SIZES.map((h) => (
                <option key={h.name} value={h.name}>
                  {h.name} Durchgang (Ø{fmtN(h.d)})
                </option>
              ))}
            </select>
          </label>
          <Num label="Durchmesser" value={d.diameter} onChange={(diameter) => setDraft({ diameter, size: '' })} />
          <label className="check">
            <input type="checkbox" checked={d.through} onChange={(e) => setDraft({ through: e.target.checked })} /> Durchgehend
          </label>
          {!d.through && (
            <>
              <Num label="Tiefe" value={d.depth} onChange={(depth) => setDraft({ depth })} />
              <label className="check">
                <input type="checkbox" checked={d.tip} onChange={(e) => setDraft({ tip: e.target.checked })} /> Bohrspitze 118°
              </label>
            </>
          )}
          <label className="field">
            <span>Senkung</span>
            <Seg
              value={d.sink.kind}
              onChange={(kind) => {
                const h = HOLE_SIZES.find((x) => x.name === d.size)
                const sink = { ...d.sink, kind }
                if (h && kind === 'cyl') Object.assign(sink, { d: String(h.cb), depth: String(h.cbT) })
                if (h && kind === 'cone') Object.assign(sink, { d: String(h.cs), angle: '90' })
                setDraft({ sink })
              }}
              options={[
                ['none', 'Keine'],
                ['cyl', 'Zylinderkopf'],
                ['cone', 'Senkkopf'],
              ]}
            />
          </label>
          {d.sink.kind !== 'none' && (
            <div className="grid3">
              <Num label="Senk-Ø" value={d.sink.d} onChange={(v) => setDraft({ sink: { ...d.sink, d: v } })} />
              {d.sink.kind === 'cyl' ? (
                <Num label="Senktiefe" value={d.sink.depth} onChange={(v) => setDraft({ sink: { ...d.sink, depth: v } })} />
              ) : (
                <Num label="Winkel" unit="°" value={d.sink.angle} onChange={(v) => setDraft({ sink: { ...d.sink, angle: v } })} />
              )}
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={d.flip} onChange={(e) => setDraft({ flip: e.target.checked })} /> Richtung umkehren
          </label>
        </>
      )}

      {(d.type === 'fillet' || d.type === 'chamfer') && (
        <>
          <PickButton active={pickFor === 'edges'} label="Kanten" value={d.edges.length ? `${d.edges.length} gewählt` : 'im Bild wählen'} onClick={() => setPickFor(pickFor === 'edges' ? null : 'edges')} />
          {d.type === 'fillet' ? (
            <Num label="Radius" value={d.radius} onChange={(radius) => setDraft({ radius })} />
          ) : (
            <Num label="Fase (Breite je Seite)" value={d.distance} onChange={(distance) => setDraft({ distance })} />
          )}
          {d.edges.length > 0 && (
            <button className="btn small" onClick={() => setDraft({ edges: [] })}>
              Auswahl leeren
            </button>
          )}
        </>
      )}

      {d.type === 'pattern' && (
        <>
          <Seg
            value={d.kind}
            onChange={(kind) => setDraft({ kind })}
            options={[
              ['linear', 'Linear'],
              ['circular', 'Kreis'],
            ]}
          />
          {featurePick}
          {d.kind === 'linear' ? (
            <>
              <DirPick label="Richtung" value={d.dir} flip={d.flip} active={pickFor === 'dir'} onPick={() => setPickFor(pickFor === 'dir' ? null : 'dir')} onAxis={(a) => setDraft({ dir: { axis: a } })} onFlip={() => setDraft({ flip: !d.flip })} />
              <div className="grid3">
                <Num label="Anzahl" unit="" value={d.count} onChange={(count) => setDraft({ count })} />
                <Num label="Abstand" value={d.spacing} onChange={(spacing) => setDraft({ spacing })} />
              </div>
              <label className="check">
                <input type="checkbox" checked={d.two} onChange={(e) => setDraft({ two: e.target.checked })} /> Zweite Richtung
              </label>
              {d.two && (
                <>
                  <DirPick label="Richtung 2" value={d.dir2} flip={d.flip2} active={pickFor === 'dir2'} onPick={() => setPickFor(pickFor === 'dir2' ? null : 'dir2')} onAxis={(a) => setDraft({ dir2: { axis: a } })} onFlip={() => setDraft({ flip2: !d.flip2 })} />
                  <div className="grid3">
                    <Num label="Anzahl" unit="" value={d.count2} onChange={(count2) => setDraft({ count2 })} />
                    <Num label="Abstand" value={d.spacing2} onChange={(spacing2) => setDraft({ spacing2 })} />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <DirPick label="Achse" value={d.axis} active={pickFor === 'axis'} onPick={() => setPickFor(pickFor === 'axis' ? null : 'axis')} onAxis={(a) => setDraft({ axis: { axis: a } })} />
              <div className="grid3">
                <Num label="Anzahl" unit="" value={d.count} onChange={(count) => setDraft({ count })} />
                <Num label="Winkel gesamt" unit="°" value={d.angle} onChange={(angle) => setDraft({ angle })} />
              </div>
              <p className="hint">360° = gleichmäßig rundum verteilt; sonst vom ersten bis zum letzten Stück.</p>
            </>
          )}
        </>
      )}

      {d.type === 'mirror' && (
        <>
          {featurePick}
          <label className="field">
            <span>Spiegelebene</span>
            <div className="row">
              <Seg value={d.plane?.std ?? ''} onChange={(std) => setDraft({ plane: { std } })} options={[['XY', 'XY'], ['XZ', 'XZ'], ['YZ', 'YZ']]} />
              <button className={'btn small' + (pickFor === 'mplane' ? ' on' : '')} onClick={() => setPickFor(pickFor === 'mplane' ? null : 'mplane')}>
                Fläche
              </button>
            </div>
          </label>
          {d.plane?.face && <p className="hint">Ebene Fläche gewählt.</p>}
        </>
      )}

      {d.type === 'sweep' && (
        <>
          <label className="field">
            <span>Profil (Skizze quer zum Pfad, am Pfadanfang)</span>
            <select value={d.sketch ?? ''} onChange={(e) => setDraft({ sketch: Number(e.target.value) || null })}>
              <option value="">– wählen –</option>
              {sketches.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Pfad (Skizze mit Linien/Bögen)</span>
            <select value={d.path ?? ''} onChange={(e) => setDraft({ path: Number(e.target.value) || null })}>
              <option value="">– wählen –</option>
              {sketches.filter((s) => s.id !== d.sketch).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {modeSel}
          <p className="hint">Löcher im Profil bleiben hohl – ein Kreisring ergibt ein Rohr.</p>
        </>
      )}

      {d.type === 'loft' && (
        <>
          <span className="field-label">Skizzen in Reihenfolge (je die größte Fläche)</span>
          {sketches.map((s) => {
            const k = (d.sketches ?? []).indexOf(s.id)
            return (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={k >= 0}
                  onChange={(e) => setDraft({ sketches: e.target.checked ? [...(d.sketches ?? []), s.id] : d.sketches.filter((x) => x !== s.id) })}
                />{' '}
                {k >= 0 ? `${k + 1}. ` : ''}
                {s.name}
              </label>
            )
          })}
          <label className="check">
            <input type="checkbox" checked={!!d.ruled} onChange={(e) => setDraft({ ruled: e.target.checked })} /> Gerade Übergänge (statt weich)
          </label>
          {modeSel}
        </>
      )}

      {d.type === 'shell' && (
        <>
          <PickButton active={pickFor === 'faces'} label="Offene Flächen" value={d.faces.length ? `${d.faces.length} gewählt` : 'im Bild wählen'} onClick={() => setPickFor(pickFor === 'faces' ? null : 'faces')} />
          <Num label="Wandstärke (nach innen)" value={d.thickness} onChange={(thickness) => setDraft({ thickness })} />
          <p className="hint">Der Körper wird ausgehöhlt; die gewählten Flächen fallen weg (offene Seite), alle anderen werden zur Wand.</p>
        </>
      )}

      {(d.type === 'removefaces' || d.type === 'moveface') && (
        <>
          <PickButton active={pickFor === 'faces'} label="Flächen" value={d.faces.length ? `${d.faces.length} gewählt` : 'im Bild wählen'} onClick={() => setPickFor(pickFor === 'faces' ? null : 'faces')} />
          {d.type === 'moveface' && <Num label="Abstand (+ nach außen, − nach innen)" value={d.distance} onChange={(distance) => setDraft({ distance })} />}
          {d.type === 'removefaces' && <p className="hint">Die Lücke wird von den Nachbarflächen geschlossen – z. B. Bohrung, Tasche oder Verrundung entfernen.</p>}
        </>
      )}

      {(d.type === 'refillet' || d.type === 'rehole') && (
        <>
          <PickButton active={pickFor === 'cyl'} label="Fläche" value={d.surfaces ? (d.type === 'rehole' ? `Bohrung Ø${fmtN(d.was)}` : `Radius R${fmtN(d.was)}`) : 'im Bild wählen'} onClick={() => setPickFor(pickFor === 'cyl' ? null : 'cyl')} />
          {d.type === 'refillet' && d.surfaces && <Num label="Neuer Radius (0 = scharfe Kante)" value={d.radius} onChange={(radius) => setDraft({ radius })} />}
          {d.type === 'rehole' && <Num label="Neuer Durchmesser (0 = zu)" value={d.diameter} onChange={(diameter) => setDraft({ diameter })} />}
        </>
      )}

      {status?.error && (
        <div className="notice warn small">
          <TriangleAlert size={14} />
          <div>{status.error}</div>
        </div>
      )}
      {status?.warn && <p className="hint">{status.warn.join(' · ')}</p>}
      {prob && d.type !== 'sketch' && <p className="hint">{prob}</p>}
      <div className="row cad-ok">
        <button className="btn primary" disabled={(!!prob && d.type !== 'sketch') || (d.type === 'sketch' && !d.sketch)} onClick={onOk}>
          <Check size={15} /> {d.type === 'sketch' ? 'Skizze fertig' : 'OK'}
        </button>
        {(d.type === 'extrude' || d.type === 'revolve') && (
          <button className="btn" disabled={!!prob} title="Übernehmen und gleich das nächste mit derselben Skizze anlegen (andere Flächen wählen)" onClick={onOkNext}>
            OK und weiter
          </button>
        )}
        <button className="btn" onClick={onCancel}>
          <X size={15} /> Abbrechen
        </button>
        {building && <Loader2 size={15} className="spin" />}
      </div>
    </section>
  )
}

function DirPick({ label, value, flip, active, onPick, onAxis, onFlip }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <Seg value={value?.axis ?? ''} onChange={onAxis} options={[['X', 'X'], ['Y', 'Y'], ['Z', 'Z']]} />
        <button className={'btn small' + (active ? ' on' : '')} onClick={(e) => (e.preventDefault(), onPick())}>
          {value && !value.axis ? nameOf(value) : 'Kante/Fläche'}
        </button>
        {onFlip && (
          <button className={'btn small' + (flip ? ' on' : '')} title="Richtung umkehren" onClick={(e) => (e.preventDefault(), onFlip())}>
            ⇄
          </button>
        )}
      </div>
    </label>
  )
}

// Menü „Mehr“ in der Werkzeugleiste (seltener gebrauchte Features)
function MoreMenu({ disabled, onPick }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  return (
    <div className="cad-more" ref={ref}>
      <button className={'cad-tool labeled' + (open ? ' on' : '')} title="Weitere Features: Sweep, Loft, Fläche verschieben, Flächen entfernen" disabled={disabled} onClick={() => setOpen(!open)}>
        <I.IcMore size={22} />
        <span>Mehr</span>
      </button>
      {open && (
        <div className="cad-more-menu" role="menu">
          {MORE_TOOLS.map(([k, title]) => {
            const Icon = FEATURE_ICON[k]
            return (
              <button
                key={k}
                role="menuitem"
                title={title}
                onClick={() => {
                  setOpen(false)
                  onPick(k)
                }}
              >
                <Icon size={20} />
                <span>
                  <b>{FEATURE_LABEL[k]}</b>
                  <small>{title.split(':').slice(-1)[0].trim()}</small>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Schwebende Leiste im Bild: passende Bedingungen zur Auswahl (wie die Bedingungsleiste in Onshape)
function ConBar({ sk, sel, onCon, onFix, onConstruction, construction, onDelete, onOffset, pos }) {
  const opts = applicableCons(sk, sel)
  const n = sel.pts.length + sel.ents.length
  const [off, setOff] = useState('2')
  const canOffset = sel.ents.some((id) => ['line', 'arc', 'circle'].includes(sk.ents.find((e) => e.id === id)?.t))
  const ref = useRef(null)
  // neben dem Zeiger, aber im Bild halten
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !pos) return
    const W = el.parentElement?.clientWidth ?? 1000
    const H = el.parentElement?.clientHeight ?? 800
    const w = el.offsetWidth
    const h = el.offsetHeight
    el.style.left = `${Math.max(8, Math.min(pos[0] + 18, W - w - 8))}px`
    el.style.top = `${pos[1] + 22 + h > H - 8 ? Math.max(8, pos[1] - h - 14) : pos[1] + 22}px`
  })
  return (
    <div ref={ref} className={'cad-conbar' + (pos ? ' at' : '')} onPointerDown={(e) => e.stopPropagation()}>
      <span className="muted">{n ? `${n} gewählt` : `${sel.cons.length} Bedingung${sel.cons.length === 1 ? '' : 'en'}`}</span>
      {opts.map((o) => (
        <button key={o.t + o.label} className="btn small" title={o.label} onClick={() => onCon(o)}>
          {CON_GLYPH[o.t] ? <b className="cad-conbar-g">{CON_GLYPH[o.t]}</b> : null} {o.label}
        </button>
      ))}
      {n > 0 && (
        <button className="btn small" onClick={onFix}>
          <Lock size={13} /> Fixieren
        </button>
      )}
      {n > 0 && (
        <button className={'btn small' + (construction ? ' on' : '')} onClick={onConstruction}>
          Hilfslinie
        </button>
      )}
      {canOffset && (
        <span className="cad-conbar-off" title="Gewählte Linien parallel versetzt kopieren (geschlossener Zug: + nach außen, − nach innen)">
          <NumInput value={off} onChange={setOff} className="cad-conbar-num" />
          <button className="btn small" onClick={() => Number.isFinite(num(off)) && num(off) !== 0 && onOffset(num(off))}>
            Versatz
          </button>
        </span>
      )}
      <button className="btn small" title="Entf" onClick={onDelete}>
        <Trash2 size={13} /> Löschen
      </button>
    </div>
  )
}

function SketchConstraints({ sk, sel, onCon, onFix, onConstruction, construction, onDelete }) {
  const opts = applicableCons(sk, sel)
  const any = sel.pts.length || sel.ents.length || sel.cons.length
  return (
    <div className="cad-cons">
      <span className="field-label">Bedingungen {any ? '' : '– erst Elemente auswählen (⇧ für mehrere)'}</span>
      <div className="cad-cons-row">
        {opts.map((o) => (
          <button key={o.t + o.label} className="btn small" onClick={() => onCon(o)}>
            {o.label}
          </button>
        ))}
        {(sel.pts.length > 0 || sel.ents.length > 0) && (
          <button className="btn small" onClick={onFix}>
            Fixieren
          </button>
        )}
        <button className={'btn small' + (construction ? ' on' : '')} onClick={onConstruction}>
          Hilfslinie
        </button>
        {any > 0 && (
          <button className="btn small" onClick={onDelete}>
            Löschen
          </button>
        )}
      </div>
    </div>
  )
}

function SketchDims({ sk, sel, setSel, onDim, onDimName }) {
  const dims = sk.cons.filter(isDim)
  const others = sk.cons.filter((c) => !isDim(c))
  if (!dims.length && !others.length) return null
  return (
    <div className="cad-dims">
      {dims.length > 0 && <span className="field-label">Maße (Name für Parameterstudien)</span>}
      {dims.map((c) => (
        <div key={c.id} className={'cad-dim-row' + (sel.cons.includes(c.id) ? ' on' : '')} onClick={() => setSel({ pts: [], ents: [], cons: [c.id] })}>
          <input className="cad-dim-name" placeholder={CON_LABEL[c.t]} value={c.name ?? ''} onChange={(e) => onDimName(c.id, e.target.value)} />
          <DimValue c={c} sk={sk} onDim={onDim} />
        </div>
      ))}
      {others.length > 0 && (
        <p className="hint">
          {others.length} Bedingung{others.length === 1 ? '' : 'en'}: {[...new Set(others.map((c) => CON_LABEL[c.t]))].join(', ')}. Anklicken der Zeichen im Bild wählt sie
          (Entf löscht).
        </p>
      )}
    </div>
  )
}

function DimValue({ c, sk, onDim }) {
  const [txt, setTxt] = useState(null)
  const shown = txt ?? fmtN(c.v ?? measure(sk, c))
  return (
    <div className="input-unit">
      <input
        value={shown}
        onChange={(e) => setTxt(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          if (txt != null) {
            const v = num(txt)
            if (v > 0 || (c.t === 'ang' && v === 0)) onDim(c.id, v)
          }
          setTxt(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
      />
      <em>{c.t === 'ang' ? '°' : 'mm'}</em>
    </div>
  )
}

function DraftpadPanel({ dp, setDp, onImport }) {
  const o = dp.opts
  const set = (patch) => setDp({ ...dp, opts: { ...o, ...patch } })
  const hasFills = dp.layers.some((l) => l.hatches)
  const hasDims = dp.layers.some((l) => o.layers.has(l.id) && l.dims)
  const canDims = !(dp.source && o.linked) && !o.fixed
  return (
    <section className="section cad-dialog">
      <h2>
        <FileUp size={15} /> Draftpad: {dp.name}
      </h2>
      <DraftpadPreview dp={dp} />
      <span className="field-label">Ebenen übernehmen</span>
      {dp.layers.map((l) => (
        <label key={l.id} className="check" title={l.visible ? '' : 'in Draftpad ausgeblendet'}>
          <input
            type="checkbox"
            disabled={!(l.lines + l.arcs)}
            checked={o.layers.has(l.id)}
            onChange={(e) => {
              const n = new Set(o.layers)
              if (e.target.checked) n.add(l.id)
              else n.delete(l.id)
              set({ layers: n })
            }}
          />
          <span style={{ opacity: l.visible ? 1 : 0.6 }}>
            {l.name} <small className="muted">({l.lines} Linien, {l.arcs} Bögen/Kreise{l.strokes ? `, ${l.strokes} Freihand – nur Bruchlinien, die Konturen schließen` : ''})</small>
          </span>
        </label>
      ))}
      {dp.source && (
        <div className="field">
          <span>Art</span>
          <Seg
            value={o.linked ? 'linked' : 'copy'}
            onChange={(v) => set({ linked: v === 'linked' })}
            options={[
              ['linked', 'Verknüpft (aktualisierbar)'],
              ['copy', 'Kopie (bemaßbar)'],
            ]}
          />
          <small className="muted">
            {o.linked
              ? 'Draftpad bleibt die Vorlage: Geometrie fest, Änderungen in Draftpad werden erkannt und per „Aktualisieren“ übernommen.'
              : 'Eigene Kopie: Bedingungen werden erkannt, du kannst hier bemaßen und ändern – kein Aktualisieren aus Draftpad.'}
          </small>
        </div>
      )}
      <label className="field">
        <span>Lücken schließen bis</span>
        <div className="input-unit">
          <input value={o.tol} inputMode="decimal" onChange={(e) => set({ tol: e.target.value })} />
          <em>mm</em>
        </div>
      </label>
      <label className="check">
        <input type="checkbox" checked={o.center} onChange={(e) => set({ center: e.target.checked })} /> Mitte der Zeichnung auf den Ursprung
      </label>
      {!(dp.source && o.linked) && (
        <label className="check">
          <input type="checkbox" checked={!o.fixed} onChange={(e) => set({ fixed: !e.target.checked })} /> Bedingungen erkennen (waagrecht, senkrecht, tangential) – danach bemaßbar
        </label>
      )}
      {hasDims && canDims && (
        <label className="check">
          <input type="checkbox" checked={o.dims} onChange={(e) => set({ dims: e.target.checked })} /> Maße aus Draftpad als Skizzenmaße (gemessener Wert, überzählige
          bleiben weg)
        </label>
      )}
      {hasFills && (
        <label className="check">
          <input type="checkbox" checked={o.fills} onChange={(e) => set({ fills: e.target.checked })} /> Schraffierte Flächen als Material vorwählen
        </label>
      )}
      <p className="hint">Strich-Punkt-Linien und Achsen werden Hilfslinien (eine Achse ist dann gleich die Drehachse für „Drehen“). Freihand-Striche bleiben weg – außer Bruchlinien, die an beiden Enden an Konturen anschließen.</p>
      <div className="row cad-ok">
        <button className="btn primary" disabled={!o.layers.size} onClick={onImport}>
          <Check size={15} /> Übernehmen
        </button>
        <button className="btn" onClick={() => setDp(null)}>
          <X size={15} /> Abbrechen
        </button>
      </div>
    </section>
  )
}

// Vorschau im Import-Dialog: übernommene Linien kräftig, Hilfslinien gestrichelt, Freihand und Texte blass,
// offene Enden rot (dort schließt sich keine Fläche – Lücke größer als „Lücken schließen bis“)
function DraftpadPreview({ dp }) {
  const o = dp.opts
  const tol = num(o.tol) > 0 ? num(o.tol) : 0.3
  const pv = useMemo(() => {
    if (!o.layers.size) return null
    try {
      const { sketch, stats, open } = importDraftpad(newSketch('XY'), dp.doc, { layers: o.layers, tol, center: o.center, fixed: true })
      const off = stats.offset
      const notes = notesOf(dp.doc, o.layers)
      const mv = (p) => [p[0] + off[0], p[1] + off[1]]
      const strokes = notes.strokes.map((l) => l.map(mv))
      const texts = notes.texts.map((t) => ({ ...t, at: mv(t.at) }))
      const lines = sketch.ents.filter((e) => e.t !== 'point').map((e) => ({ cons: !!e.cons, pts: polyline(sketch, e, 48) }))
      const all = [...lines.flatMap((l) => l.pts), ...strokes.flat(), ...texts.map((t) => t.at)]
      const lo = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))]
      const hi = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))]
      return { lines, strokes, texts, open, lo, hi }
    } catch {
      return null
    }
  }, [dp.doc, o.layers, o.center, tol])
  if (!pv) return null
  const w = Math.max(pv.hi[0] - pv.lo[0], 1)
  const h = Math.max(pv.hi[1] - pv.lo[1], 1)
  const pad = 0.04 * Math.max(w, h)
  const u = Math.max(w, h) / 300 // ≈ 1 Bildpunkt
  const path = (pts) => 'M' + pts.map((p) => `${p[0].toFixed(2)} ${(-p[1]).toFixed(2)}`).join('L')
  return (
    <div className="dp-preview">
      <svg viewBox={`${pv.lo[0] - pad} ${-pv.hi[1] - pad} ${w + 2 * pad} ${h + 2 * pad}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Vorschau der Zeichnung">
        {pv.strokes.map((l, i) => (
          <path key={'s' + i} d={path(l)} className="dp-note" strokeWidth={u} />
        ))}
        {pv.texts.map((t, i) => (
          <text key={'t' + i} x={t.at[0]} y={-t.at[1]} fontSize={t.size} className="dp-note-text">
            {t.text}
          </text>
        ))}
        {pv.lines.map((l, i) => (
          <path key={i} d={path(l.pts)} className={l.cons ? 'dp-cons' : 'dp-line'} strokeWidth={(l.cons ? 1 : 1.4) * u} strokeDasharray={l.cons ? `${6 * u} ${3 * u}` : undefined} />
        ))}
        {pv.open.map((p, i) => (
          <circle key={'o' + i} cx={p[0]} cy={-p[1]} r={3.5 * u} className="dp-open" />
        ))}
      </svg>
      <small className={pv.open.length ? 'warn-text' : 'muted'}>
        {pv.open.length
          ? `${pv.open.length} offene ${pv.open.length === 1 ? 'Ende' : 'Enden'} (rot) – dort schließt sich keine Fläche. Größere Lücke? „Lücken schließen bis“ erhöhen.`
          : 'Keine offenen Enden – alle Konturen sind geschlossen.'}
      </small>
    </div>
  )
}

// Bereichswahl im Extrudieren/Drehen-Dialog
function RegionTools({ d, t }) {
  if (!t) return <p className="hint">Flächen der Skizze werden geladen …</p>
  const mode =
    d.regions == null
      ? t.groupLabel
        ? `${t.groupLabel} (${t.chosen} Flächen)`
        : d.useFills !== false && t.anyFill
          ? 'schraffierte Flächen (automatisch)'
          : 'alle Flächen, Löcher frei (automatisch)'
      : `${t.chosen} von ${t.count} Flächen`
  return (
    <div className="cad-regions">
      <span className="field-label">
        Flächen: <b>{mode}</b>
      </span>
      <div className="cad-cons-row">
        <button className="btn small" onClick={t.all}>
          Alle
        </button>
        <button className="btn small" onClick={t.none}>
          Keine
        </button>
        <button className="btn small" title="Alle Flächen, die noch kein anderes Feature dieser Skizze benutzt" onClick={t.free}>
          Noch freie
        </button>
        {t.anyFill && (
          <button className="btn small" onClick={t.fills}>
            Schraffierte
          </button>
        )}
        <button className="btn small" title="Außenkontur mit Löchern frei (bzw. Schraffuren aus Draftpad)" onClick={t.auto}>
          Automatisch
        </button>
      </div>
      <p className="hint">
        Im Bild anklicken = Fläche dazu/weg (blau = dabei, grau = schon von einem anderen Feature benutzt). Alt + Klick = Fläche samt allem, was darin
        liegt. Löcher sind eigene Flächen: weglassen = Loch bleibt frei.
      </p>
    </div>
  )
}

// Drehachse: Name und Auswahlliste (Achsen aus Draftpad zuerst, dann Hilfslinien, dann übrige Linien mit Länge)
function axisOptions(sk) {
  if (!sk) return []
  const len = (e) => Math.hypot(sk.pts[e.b].x - sk.pts[e.a].x, sk.pts[e.b].y - sk.pts[e.a].y)
  const lines = sk.ents.filter((e) => e.t === 'line')
  const rank = (e) => (e.axis ? 0 : e.cons ? 1 : 2)
  return [...lines]
    .sort((a, b) => rank(a) - rank(b) || len(b) - len(a))
    .map((e) => ({ id: e.id, label: `${e.axis ? 'Achse (Draftpad)' : e.cons ? 'Hilfslinie' : 'Linie'} · ${fmtN(len(e))} mm` }))
}
function axisName(sk, id) {
  return axisOptions(sk).find((o) => o.id === id)?.label ?? null
}

// Teile aus den Schraffuren einer Draftpad-Skizze: je Schraffur-Art ein Körper
function PartsDialog({ parts, setParts, sketch, onCreate }) {
  const upd = (i, patch) => setParts({ ...parts, rows: parts.rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) })
  const axes = (sketch?.ents ?? []).filter((e) => e.t === 'line' && (e.axis || e.cons))
  const len = (e) => Math.hypot(sketch.pts[e.b].x - sketch.pts[e.a].x, sketch.pts[e.b].y - sketch.pts[e.a].y)
  return (
    <section className="section cad-dialog">
      <h2>
        <Boxes size={15} /> Teile aus den Schraffuren
      </h2>
      <p className="hint">
        Gleiche Schraffur (Richtung, Abstand) = ein Teil. Liegt ein Teil symmetrisch zu einer Achse, wird es gedreht, sonst extrudiert. Im Bild
        anklicken = Teil an/aus; nicht schraffierte Flächen (Lager, Schrauben) danach mit Extrudieren/Drehen selbst anlegen.
      </p>
      {parts.rows.map((r, i) => (
        <div
          key={r.group}
          className={'item cad-part' + (r.on ? '' : ' disabled') + (parts.hover === r.group ? ' active load' : '')}
          onMouseEnter={() => setParts({ ...parts, hover: r.group })}
          onMouseLeave={() => setParts({ ...parts, hover: null })}
        >
          <div className="item-head">
            <input type="checkbox" checked={r.on} onChange={(e) => upd(i, { on: e.target.checked })} />
            <input className="cad-name" value={r.name} onChange={(e) => upd(i, { name: e.target.value })} />
          </div>
          <small className="muted">
            {r.count} Fläche{r.count === 1 ? '' : 'n'} · {r.label}
          </small>
          <div className="row">
            <Seg
              value={r.kind}
              onChange={(kind) => upd(i, { kind, axis: kind === 'revolve' ? (r.axis ?? axes.find((e) => e.axis)?.id ?? axes[0]?.id ?? null) : r.axis })}
              options={[
                ['revolve', 'Drehen'],
                ['extrude', 'Extrudieren'],
              ]}
            />
            {r.kind === 'extrude' ? (
              <div className="input-unit mini">
                <NumInput value={r.depth} title="Tiefe (symmetrisch zur Skizze) – Mausrad ±1 mm" onChange={(v) => upd(i, { depth: v })} />
                <em>mm</em>
              </div>
            ) : (
              <select value={r.axis ?? ''} title="Drehachse" onChange={(e) => upd(i, { axis: e.target.value || null })}>
                <option value="">– Achse –</option>
                {axes.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.axis ? 'Achse' : 'Hilfslinie'} · {fmtN(len(e))} mm
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      ))}
      <label className="check">
        <input type="checkbox" checked={parts.subtract} onChange={(e) => setParts({ ...parts, subtract: e.target.checked })} /> Überschneidungen vom jeweils neuen Teil abziehen
      </label>
      <div className="row cad-ok">
        <button className="btn primary" disabled={!parts.rows.some((r) => r.on && (r.kind === 'extrude' || r.axis))} onClick={onCreate}>
          <Check size={15} /> Anlegen
        </button>
        <button className="btn" onClick={() => setParts(null)}>
          <X size={15} /> Später
        </button>
      </div>
    </section>
  )
}
