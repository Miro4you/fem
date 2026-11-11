// Konstruktion: kleines CAD mit Skizzen, Features und Verlauf (wie Onshape: Ebene wählen, skizzieren, bemaßen,
// extrudieren …). Gebaut wird mit OpenCASCADE im Rechenkern; das Ergebnis geht als STEP in die Rechnung.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Pencil,
  Square,
  Circle,
  Spline,
  Dot,
  Ruler,
  Undo2,
  Redo2,
  Check,
  X,
  Eye,
  EyeOff,
  Trash2,
  ArrowUpFromLine,
  RotateCw,
  CircleDot,
  Grid3x3,
  FlipHorizontal2,
  SquareRoundCorner,
  Eraser,
  Move,
  Crosshair,
  Lock,
  Download,
  Play,
  TriangleAlert,
  Loader2,
  SquareDashed,
  Info,
  Diameter,
  Hash,
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
} from './features.js'
import { STD_PLANES, newSketch, applicableCons, removeItems, solved, CON_LABEL, isDim, measure } from './sketch.js'

const FEATURE_ICON = {
  sketch: Pencil,
  extrude: ArrowUpFromLine,
  revolve: RotateCw,
  hole: CircleDot,
  fillet: SquareRoundCorner,
  chamfer: SquareDashed,
  pattern: Grid3x3,
  mirror: FlipHorizontal2,
  removefaces: Eraser,
  moveface: Move,
  refillet: SquareRoundCorner,
  rehole: CircleDot,
}

const SKETCH_TOOLS = [
  ['select', 'Auswählen und ziehen', Crosshair, 'S'],
  ['line', 'Linie (Linienzug, Doppelklick oder Esc beendet)', Pencil, 'L'],
  ['rect', 'Rechteck (zwei Ecken)', Square, 'R'],
  ['circle', 'Kreis (Mitte, Radius)', Circle, 'C'],
  ['arc', 'Bogen (Mitte, Anfang, Ende – gegen den Uhrzeigersinn)', Spline, 'A'],
  ['point', 'Punkt (z. B. für Bohrungen)', Dot, 'P'],
  ['dim', 'Bemaßen: Element(e) anklicken, Maß ablegen, Wert eingeben', Ruler, 'D'],
  ['use', 'Kante des Bauteils übernehmen', Diameter, 'U'],
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
      if (d < 0.02 * size && (!best || d < best.d)) best = { d, tag: c.tag }
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

export default function CadStudio({ cad, setCad, nav, onApply, onExport, applied, busy, onError }) {
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
  const [history, setHistory] = useState({ undo: [], redo: [] })
  const skHist = useRef({ undo: [], redo: [] })
  const viewRef = useRef(null)
  const reqRef = useRef(0)

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
        const r = await api.cadBuild({ base: cad.base ?? null, features: kernelFeatures(list, extra.upto ?? list.length), regions_of: extra.regionsOf ?? null })
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
    const regionsOf = edit.draft.type === 'extrude' || edit.draft.type === 'revolve' ? edit.draft.sketch : null
    let stop = false
    const t = setTimeout(
      () =>
        run(isSk ? features.slice(0, edit.index) : list, { regionsOf }).then((r) => {
          if (!stop && r) setPreview(r)
        }),
      isSk ? 0 : 250,
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
    if (type === 'revolve' && lastSketch) {
      const line = lastSketch.sketch.ents.find((e) => e.t === 'line' && e.cons) ?? null
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
    } else setPickFor({ fillet: 'edges', chamfer: 'edges', removefaces: 'faces', moveface: 'faces' }[type] ?? null)
  }

  const openEdit = (f) => {
    if (edit) return note('Erst das offene Feature bestätigen oder abbrechen')
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

  const accept = () => {
    if (!edit) return
    const d = edit.draft
    if (d.type === 'sketch' && !d.sketch) return cancel()
    const prob = problemOf(d, [...features.slice(0, edit.index), d])
    if (prob && d.type !== 'sketch') return note(prob)
    const next = edit.isNew ? [...features, d] : features.map((f) => (f.id === d.id ? d : f))
    commitFeatures(next)
    if (d.type === 'sketch') setTimeout(() => viewRef.current?.fit(), 0)
    setEdit(null)
    setPickFor(null)
    setSel(emptySel)
    setSkInfo(null)
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
        if (e.key === 'Escape' && edit) cancel()
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
  const pickWant = useMemo(() => {
    if (sketchEdit) return null
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
  }, [pickFor, sketchEdit, edit?.draft.type])

  const onPick = (h, ev) => {
    if (!edit || !h) return
    const d = edit.draft
    if (pickFor === 'plane') {
      const plane = h.std ? STD_PLANES[h.std] : h.face?.normal ? planeFromFace(h.face) : null
      if (!plane) return note('Eine Hauptebene oder eine ebene Fläche anklicken')
      const ref = h.std ? { std: h.std } : { face: faceRef(h.face) }
      if (d.sketch) {
        // Ebene einer vorhandenen Skizze tauschen: Geometrie bleibt in lokalen Koordinaten
        setDraft({ sketch: { ...d.sketch, plane, planeRef: ref } })
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
  const beforeKey = edit && ['fillet', 'chamfer', 'removefaces', 'moveface', 'refillet', 'rehole', 'pattern', 'mirror'].includes(edit.draft.type) ? `${edit.index}|${builtKey}` : null
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
    api
      .cadBuild({ base: cad.base ?? null, features: kernelFeatures(features, edit.index) })
      .then((r) => !stop && setBefore(r))
      .catch((e) => onError(String(e)))
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beforeKey, built])
  const shownTessBefore = before?.tess ?? shownTess
  // beim Wählen von Kanten/Flächen den Stand davor zeigen (sonst sind sie schon verrundet/weg)
  const viewTess = edit && pickFor && ['edges', 'faces', 'cyl'].includes(pickFor) && before?.tess ? before.tess : sketchEdit ? (preview?.tess ?? null) : shownTess

  const selected = useMemo(() => {
    const d = edit?.draft
    const out = { faces: new Set(), edges: new Set(), std: new Set() }
    if (!d) return out
    if (d.edges) out.edges = matchEdges(viewTess, d.edges)
    if (d.faces) out.faces = matchFaces(viewTess, d.faces)
    if (d.type === 'mirror' && d.plane?.std) out.std.add(d.plane.std)
    if (d.type === 'mirror' && d.plane?.face) out.faces = matchFaces(viewTess, [d.plane.face])
    if ((d.type === 'refillet' || d.type === 'rehole') && d.surfaces) out.faces = matchFaces(viewTess, d.surfaces.map((c) => ({ center: c })))
    return out
  }, [edit?.draft, viewTess])

  // Bereiche zum Anklicken (Extrudieren/Drehen)
  const regionDraft = edit && (edit.draft.type === 'extrude' || edit.draft.type === 'revolve') ? edit.draft : null
  const regionSketch = regionDraft ? features.find((f) => f.id === regionDraft.sketch)?.sketch : null
  const regionList = regionDraft && preview?.regions && regionSketch
    ? preview.regions.map((r) => ({
        loops: r.loops,
        on: regionDraft.regions ? regionDraft.regions.some((q) => insidePoly(q, r.loops)) : r.evenodd,
      }))
    : null
  const regions = regionList
    ? {
        plane: regionSketch.plane,
        list: regionList,
        onToggle: (i) => {
          const cur = regionList.map((r, k) => (k === i ? !r.on : r.on))
          const pts = preview.regions.filter((_, k) => cur[k]).map((r) => r.pt)
          setDraft({ regions: pts.length ? pts : null })
        },
      }
    : null
  const axisLine = (() => {
    if (edit?.draft.type !== 'revolve' || !regionSketch || !edit.draft.axis) return null
    const e = regionSketch.ents.find((x) => x.id === edit.draft.axis)
    if (!e) return null
    return { plane: regionSketch.plane, a: [regionSketch.pts[e.a].x, regionSketch.pts[e.a].y], b: [regionSketch.pts[e.b].x, regionSketch.pts[e.b].y] }
  })()

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
        onMessage: note,
      }
    : null

  // --- Ausgabe ---------------------------------------------------------------------------------
  const hasBody = (built?.bodies ?? 0) > 0
  const errors = (built?.status ?? []).filter((s) => !s.ok && !s.skipped)
  const appliedNow = applied === builtKey
  const editingSketchEmpty = edit?.draft.type === 'sketch' && !edit.draft.sketch

  return (
    <div className="cad-studio">
      <aside className="sidebar cad-side">
        {!edit && (
          <>
            <section className="section">
              <h2>
                <Hash size={15} /> Verlauf
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
                    className={'cad-feat' + (f.suppressed ? ' off' : '') + (st && !st.ok && !st.skipped ? ' bad' : '') + (st?.skipped ? ' skipped' : '')}
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
                    <button className="icon-btn" title={f.suppressed ? 'Wieder einschalten' : 'Unterdrücken (vorübergehend aus)'} onClick={() => commitFeatures(features.map((g, k) => (k === i ? { ...g, suppressed: !g.suppressed } : g)))}>
                      {f.suppressed ? <EyeOff size={13} /> : <Eye size={13} />}
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
        {edit && (
          <FeatureDialog
            edit={edit}
            features={features}
            setDraft={setDraft}
            onOk={accept}
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
              <span className="cad-sep" />
              <button className={'cad-tool' + (construction ? ' on' : '')} title="Hilfslinie (geht nicht in den Körper ein; z. B. Drehachse). Mit Auswahl: umschalten" onClick={toggleConstruction}>
                <SquareDashed size={17} />
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
              <span className="cad-sep" />
              <SketchStatus info={skInfo} />
            </>
          ) : (
            <>
              {PART_TOOLS.map(([k, title]) => {
                const Icon = FEATURE_ICON[k]
                return (
                  <button key={k} className="cad-tool labeled" title={title} disabled={!!edit} onClick={() => startNew(k)}>
                    <Icon size={17} />
                    <span>{SHORT[k] ?? FEATURE_LABEL[k]}</span>
                  </button>
                )
              })}
              {cad.base && (
                <button className="cad-tool labeled" title="Radius oder Bohrung des Ausgangsteils ändern (Zylinderfläche anklicken)" disabled={!!edit} onClick={() => { startNew('refillet'); setPickFor('cyl') }}>
                  <SquareRoundCorner size={17} />
                  <span>Radius/Bohrung</span>
                </button>
              )}
              <span className="cad-sep" />
              <button className="cad-tool" title="Rückgängig (Strg+Z)" disabled={!!edit || !history.undo.length} onClick={undo}>
                <Undo2 size={17} />
              </button>
              <button className="cad-tool" title="Wiederholen (Strg+Y)" disabled={!!edit || !history.redo.length} onClick={redo}>
                <Redo2 size={17} />
              </button>
            </>
          )}
          {building && <Loader2 size={16} className="spin cad-busy" />}
        </div>
        {(msg || pickFor) && (
          <div className="cad-hint">
            {msg ??
              {
                plane: 'Ebene wählen: Hauptebene (XY, XZ, YZ) oder ebene Fläche des Bauteils anklicken',
                edges: 'Kanten anklicken (nochmal klicken = abwählen). Tangential anschließende Kanten kommen mit.',
                faces: edit?.draft.type === 'moveface' ? 'Ebene Flächen anklicken' : 'Flächen anklicken – bei Zylindern kommt die ganze Bohrung mit (Alt: nur diese Fläche)',
                dir: 'Richtung: gerade Kante, ebene Fläche (Normale) oder Zylinder (Achse) anklicken',
                dir2: 'Zweite Richtung: gerade Kante, ebene Fläche oder Zylinder anklicken',
                axis: 'Achse: Kreiskante, Zylinderfläche oder gerade Kante anklicken',
                mplane: 'Spiegelebene: Hauptebene oder ebene Fläche anklicken',
                cyl: 'Radius- oder Bohrungsfläche (Zylinder) anklicken',
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
          showPlanes={!sketchEdit && (!hasBody || pickFor === 'plane' || pickFor === 'mplane' || editingSketchEmpty)}
          regions={regions}
          axisLine={axisLine}
          preview={!!edit && ['extrude', 'revolve', 'hole'].includes(edit.draft.type) && edit.draft.mode === 'cut'}
        />
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

function Num({ label, value, onChange, unit = 'mm', disabled }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-unit">
        <input value={value} disabled={disabled} inputMode="decimal" onChange={(e) => onChange(e.target.value)} onFocus={(e) => e.target.select()} />
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

function FeatureDialog({ edit, features, setDraft, onOk, onCancel, pickFor, setPickFor, status, sketchInfo, sel, setSel, onCon, onFix, onConstruction, construction, onDelete, onDim, onDimName, building }) {
  const d = edit.draft
  const before = features.slice(0, edit.index)
  const sketches = before.filter((f) => f.type === 'sketch' && !f.suppressed)
  const solids = before.filter((f) => ['extrude', 'revolve', 'hole'].includes(f.type) && !f.suppressed)
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
    <Seg
      value={d.mode}
      onChange={(mode) => setDraft({ mode })}
      options={[
        ['add', 'Dazu'],
        ['cut', 'Weg'],
        ['new', 'Neuer Körper'],
      ]}
    />
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
          {sk && (
            <>
              <SketchConstraints sk={sk} sel={sel} onCon={onCon} onFix={onFix} onConstruction={onConstruction} construction={construction} onDelete={onDelete} />
              <SketchDims sk={sk} sel={sel} setSel={setSel} onDim={onDim} onDimName={onDimName} />
              <p className="hint">
                Zeichnen mit der linken Maustaste, ⇧ + links verschiebt die Ansicht. Punkte rasten an Punkten, Linienmitten und Bauteilecken ein;
                fast waagrechte/senkrechte Linien werden waagrecht/senkrecht. Bemaßen: Werkzeug „Maß“ (D), Elemente anklicken, Maß ablegen, Wert
                eintippen. Doppelklick auf ein Maß ändert es.
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
          <p className="hint">Bereiche im Bild anklicken, um sie ein- oder auszuschließen (blau = dabei). {d.regions ? '' : 'Jetzt: alle Flächen der Skizze (Löcher bleiben frei).'}</p>
          {d.regions && (
            <button className="btn small" onClick={() => setDraft({ regions: null })}>
              Bereiche zurücksetzen
            </button>
          )}
        </>
      )}

      {d.type === 'revolve' && (
        <>
          {sketchSel}
          {modeSel}
          <label className="field">
            <span>Drehachse (Linie der Skizze, gern als Hilfslinie)</span>
            <select value={d.axis ?? ''} onChange={(e) => setDraft({ axis: e.target.value || null })}>
              <option value="">– wählen –</option>
              {(features.find((f) => f.id === d.sketch)?.sketch.ents ?? [])
                .filter((e) => e.t === 'line')
                .map((e, i) => (
                  <option key={e.id} value={e.id}>
                    {e.cons ? 'Hilfslinie' : 'Linie'} {i + 1}
                  </option>
                ))}
            </select>
          </label>
          <Num label="Winkel" unit="°" value={d.angle} onChange={(angle) => setDraft({ angle })} />
          <label className="check">
            <input type="checkbox" checked={d.symmetric} onChange={(e) => setDraft({ symmetric: e.target.checked })} /> Symmetrisch
          </label>
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
