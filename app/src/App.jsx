import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderOpen, Save, FileUp, Play, Plus, Trash2, MousePointerClick, Anchor, ArrowDownToLine,
  TriangleAlert, Download, Grid3x3, Loader2, X, Check, Box as BoxIcon, Layers, CircleGauge, PenLine, Wifi, Copy, Move3d,
  Spline, SquarePlus, SquareMinus, CircleDot, Wrench, RotateCcw, Cable,
} from 'lucide-react'
import Viewport from './components/Viewport.jsx'
import Legend from './components/Legend.jsx'
import * as api from './api.js'
import {
  MATERIALS, MATERIAL_GROUPS, materialFromPreset, materialPayload, INFILL_PATTERNS, DEFAULT_INFILL, infillFractions, shellThickness,
  presetFromMaterial,
} from './materials.js'
import { fmt, fmtVec } from './format.js'
import { buildReport } from './report.js'
import { FrameSidebar, FrameView, newFrame, framePayload } from './FrameStudio.jsx'
import { regionFromDrag, regionAnchor, regionNumbers, selectionCylinder, axisName, SHAPES, regionRefine } from './region.js'
import { GEO_OPS, opFromSurface, newSketchOp, opPayload, opProblem, remapSurfaces, axisLabel } from './geoops.js'

const SUPPORT_COLOR = '#5b8def'
const SUPPORT_ACTIVE = '#1f5fd6'
const LOAD_COLOR = '#f2a24a'
const LOAD_ACTIVE = '#e0700f'
const MOMENT_COLOR = '#9b4dca'
// Flächen, auf denen nur ein Teilbereich wirkt, blasser einfärben
const SUPPORT_PALE = '#b3c6ee'
const LOAD_PALE = '#f1cfa9'

const QUANTITIES = {
  von_mises: { label: 'Vergleichsspannung', unit: 'MPa', hint: 'von Mises' },
  disp: { label: 'Verschiebung', unit: 'mm', hint: 'gesamt' },
  sigma1: { label: 'Hauptspannung σ1', unit: 'MPa', hint: 'größte (Zug)' },
  sigma3: { label: 'Hauptspannung σ3', unit: 'MPa', hint: 'kleinste (Druck)' },
  safety: { label: 'Sicherheit', unit: '', hint: 'gesamt' },
  safety_layers: { label: 'Sicherheit Schichthaftung', unit: '', hint: 'quer zu den Schichten' },
  safety_infill: { label: 'Sicherheit Infill', unit: '', hint: 'Füllung innen' },
  shell: { label: 'Wand / Infill', unit: '', hint: '1 = Wand, 0 = Infill' },
  usage: { label: 'Materialausnutzung', unit: '%', hint: 'blau = kaum genutzt' },
}

// Ergebnisfeld je Darstellung (für Oberfläche und Schnitt)
const FIELD_OF = {
  von_mises: ['von_mises'], sigma1: ['sigma1'], sigma3: ['sigma3'],
  safety: ['utilization', true], safety_layers: ['utilization_layers', true], safety_infill: ['utilization_infill', true],
  shell: ['shell_fraction'],
}

const BUILD_DIRS = [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]]
const dirName = (d) => {
  const k = [0, 1, 2].find((i) => Math.abs(Math.abs(d[i]) - 1) < 1e-6)
  return k == null ? `(${d.map((v) => fmt(v)).join(' / ')})` : 'XYZ'[k]
}

let nextId = 1
const newSupport = () => ({
  id: nextId++, kind: 'fixed', axes: { x: true, y: true, z: true }, cyl: { radial: true, axial: true, tangential: false },
  surfaces: [], region: null,
})
const newLoad = () => ({
  id: nextId++, kind: 'force', force: [0, 0, -1000], pressure: 1, moment: [0, 0, 100], surfaces: [], region: null,
  flowDir: [1, 0, 0], medium: 'luft', velocity: '30', cw: '1.2', rhoFluid: '1000',
})

const LOAD_KINDS = {
  force: 'Kraft (gleichmäßig verteilt)',
  pressure: 'Druck',
  moment: 'Moment',
  bearing: 'Lagerlast (Bolzen/Welle, halber Umfang)',
  flow: 'Strömung / Wind (überschlägig)',
}

// Strömung: Staudruck q = ½·ρ·v² [Pa], Druck auf angeströmte Flächen p = q·c_w
const MEDIA = { luft: ['Luft', 1.225], wasser: ['Wasser', 1000], eigen: ['eigene Dichte', null] }
const flowPressurePa = (l) => {
  const rho = l.medium === 'eigen' ? Number(l.rhoFluid) : MEDIA[l.medium ?? 'luft'][1]
  return 0.5 * rho * Number(l.velocity) ** 2 * Number(l.cw)
}

export default function App() {
  const [gmsh, setGmsh] = useState(undefined)
  const [stepPath, setStepPath] = useState(null)
  const [mesh, setMesh] = useState(null)
  const [meshSize, setMeshSize] = useState('')
  const [material, setMaterial] = useState(() => materialFromPreset(MATERIALS[0]))
  // Aufbaurichtung durch Anklicken der Fläche auf dem Druckbett wählen
  const [bedPick, setBedPick] = useState(false)
  // Ergebnisse des Vergleichs der Aufbaurichtungen
  const [orientations, setOrientations] = useState(null)
  const [supports, setSupports] = useState([])
  const [loads, setLoads] = useState([])
  const [active, setActive] = useState(null)
  // Bereich zeichnen: { type: 'support' | 'load', id, shape }
  const [drawing, setDrawing] = useState(null)
  // Lastrichtung im Bild wählen: { id, key: 'force' | 'moment' }
  const [dirPick, setDirPick] = useState(null)
  // Lastpfeil im Bild ausrichten: { id, field: 'force' | 'moment', plane: 'free' | 'xy' | 'yz' | 'xz' }
  const [aim, setAim] = useState(null)
  // Geometrie anpassen
  const [geoOps, setGeoOps] = useState([])
  const [geoStep, setGeoStep] = useState(null) // geänderte STEP (null = Original)
  const [geoApplied, setGeoApplied] = useState('[]') // zuletzt angewendete Änderungen (JSON)
  const [geoInfo, setGeoInfo] = useState(null) // Volumen vorher/nachher
  const [geoPick, setGeoPick] = useState(false)
  const [geoWarnings, setGeoWarnings] = useState([])
  // Ergebnis zum Vergleichen (z. B. Original vor den Geometrieänderungen)
  const [reference, setReference] = useState(null)
  // eigene Werkstoffe und Festigkeitsnachweis
  const [userMaterials, setUserMaterials] = useState([])
  const [proof, setProof] = useState({ sF: '1.5', sB: '2', uMax: '' })
  // Leichtbau-Vorschlag: { view, threshold, show, surface }
  const [topo, setTopo] = useState(null)
  // Analyseart: Statik, Eigenfrequenzen, Knicken; Ergebnis der Eigenwertrechnung
  const [analysis, setAnalysis] = useState('static')
  const [modeCount, setModeCount] = useState('6')
  const [modes, setModes] = useState(null) // { kind, values, shapes, seconds, sel, animate }
  // CAD-Schnittstelle: Hinweis über eingegangene Teile, automatisch neu rechnen
  const [notice, setNotice] = useState(null)
  const [cadAuto, setCadAuto] = useState(true)
  // Stabwerk (unabhängig von der STEP-Geometrie)
  const [frame, setFrameRaw] = useState(() => newFrame())
  const [frameResults, setFrameResults] = useState(null)
  const [frameDisplay, setFrameDisplay] = useState('util')
  const setFrame = (f) => {
    setFrameRaw(f)
    setFrameResults(null)
  }
  async function onFrameSolve() {
    setBusy('Stabwerk rechnen …')
    setError(null)
    try {
      setFrameResults(await api.frameSolve(framePayload(frame)))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }
  const [result, setResult] = useState(null)
  const [resultStale, setResultStale] = useState(false)
  const [view, setView] = useState('setup')
  const [quantity, setQuantity] = useState('von_mises')
  const [deform, setDeform] = useState('auto')
  const [showMesh, setShowMesh] = useState(false)
  // Netz in Wirkbereichen verfeinern; Schlüssel der Verfeinerung beim letzten Vernetzen
  const [refineRegions, setRefineRegions] = useState(true)
  const [meshRefineKey, setMeshRefineKey] = useState('[]')
  // Fortschritt der laufenden Rechnung (vom Rechenkern)
  const [progressInfo, setProgressInfo] = useState(null)
  // Schnittansicht im Ergebnis
  const [cut, setCut] = useState({ on: false, axis: 2, pos: 50, flip: false })
  const [cutData, setCutData] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [probe, setProbe] = useState(null)
  const sidebar = useRef(null)

  // beim Wechsel Modell/Ergebnis oben beginnen
  useEffect(() => {
    sidebar.current?.scrollTo(0, 0)
  }, [view])

  useEffect(() => {
    api.gmshPath().then(setGmsh).catch(() => setGmsh(null))
    api.loadUserMaterials().then((l) => setUserMaterials(Array.isArray(l) ? l : [])).catch(() => {})
  }, [])

  async function saveUserMaterial() {
    const name = window.prompt('Name für den eigenen Werkstoff:', material.name.startsWith('Benutzerdefiniert') ? '' : material.name + ' (eigen)')
    if (!name) return
    const list = [...userMaterials.filter((m) => m.name !== name), presetFromMaterial(material, name)]
    try {
      await api.saveUserMaterials(list)
      setUserMaterials(list)
      setMaterial({ ...material, name })
    } catch (e) {
      setError(String(e))
    }
  }

  async function deleteUserMaterial(name) {
    if (!window.confirm(`Eigenen Werkstoff „${name}“ löschen?`)) return
    const list = userMaterials.filter((m) => m.name !== name)
    try {
      await api.saveUserMaterials(list)
      setUserMaterials(list)
    } catch (e) {
      setError(String(e))
    }
  }

  // jede Änderung am Modell macht ein vorhandenes Ergebnis veraltet
  useEffect(() => {
    if (result) setResultStale(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, supports, loads])

  const surfaceInfo = useMemo(() => new Map((mesh?.surfaces ?? []).map((s) => [s.tag, s])), [mesh])

  // Während einer Rechnung den Fortschritt abfragen
  useEffect(() => {
    if (!busy) {
      setProgressInfo(null)
      return
    }
    let stop = false
    const tick = async () => {
      try {
        const p = await api.progress()
        if (!stop) setProgressInfo(p)
      } catch {
        /* ältere Gegenstelle ohne Fortschritt */
      }
      if (!stop) setTimeout(tick, 400)
    }
    tick()
    return () => {
      stop = true
    }
  }, [busy])

  // Netzverfeinerungen für die aktuellen Wirkbereiche (Lasten und Lager)
  function currentRefine(size) {
    const h = Number(size) || mesh?.mesh_size || 5
    const out = []
    // 3D-Druck mit Füllung: an der Oberfläche etwa so fein wie die Wand
    if (material.layered && material.infill?.on && material.infill.refine !== false) {
      const t = shellThickness(material.infill)
      const thin = Math.min(...[t.wall, t.top, t.bottom].filter((v) => v > 0))
      if (Number.isFinite(thin)) out.push({ type: 'surface', size: Math.max(thin, h / 6), dist: Math.max(thin, h / 6) })
    }
    if (refineRegions) {
      for (const it of [...supports, ...loads]) {
        const r = regionNumbers(it.region)
        if (!r) continue
        try {
          out.push(regionRefine(r, selectionCylinder(it.surfaces, surfaceInfo), h))
        } catch {
          /* unvollständiger Bereich */
        }
      }
    }
    return out
  }
  const diag = useMemo(() => {
    if (!mesh) return 1
    const [lo, hi] = mesh.bbox
    return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  }, [mesh])

  // --- Geometrie ---------------------------------------------------------------
  // base = false: geänderte Geometrie neu vernetzen (Original und Änderungen bleiben)
  async function loadGeometry(path, size, keepSetup = false, base = true, refineOverride = null) {
    setBusy('Vernetze Geometrie …')
    setError(null)
    try {
      const ref = refineOverride ?? (keepSetup ? currentRefine(size) : [])
      const m = await api.openStep(path, size ? Number(size) : null, false, ref)
      setMeshRefineKey(JSON.stringify(ref))
      setMesh(m)
      setMeshSize(String(Number(m.mesh_size.toPrecision(3))))
      setResult(null)
      setResultStale(false)
      setProbe(null)
      if (base) {
        setStepPath(path)
        setView('setup')
        setGeoStep(null)
        setGeoApplied('[]')
        setGeoInfo(null)
        setGeoWarnings([])
      }
      setTopo(null)
      if (!keepSetup) {
        setSupports([])
        setLoads([])
        setActive(null)
        setDrawing(null)
        setGeoOps([])
        setReference(null)
      }
      return m
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onOpenStep() {
    const p = await api.pickStep()
    if (p) loadGeometry(p, null)
  }

  // --- Projekt speichern / laden -------------------------------------------------
  async function onSaveProject() {
    if (!stepPath) return
    const data = { format: 'projekt-fem', version: 1, step: stepPath, meshSize: Number(meshSize) || null, material, supports, loads, geoOps, proof }
    try {
      await api.saveProject(stepPath, data)
    } catch (e) {
      setError(String(e))
    }
  }

  async function onLoadProject() {
    try {
      const d = await api.loadProject()
      if (!d) return
      if (d.format !== 'projekt-fem') throw new Error('Keine Projekt-FEM-Datei')
      const m = await loadGeometry(d.step, d.meshSize, true, true, [])
      if (!m) return
      const ops = d.geoOps ?? []
      setGeoOps(ops)
      setReference(null)
      // gespeicherte Lager/Lasten beziehen sich auf die geänderte Geometrie → Änderungen gleich anwenden
      const active = ops.filter((o) => o.enabled && !opProblem(o))
      if (active.length) {
        setBusy('Passe Geometrie an …')
        try {
          const g = await api.modifyGeometry(d.step, active.map(opPayload), d.meshSize ? Number(d.meshSize) : null)
          setMesh(g.mesh)
          setGeoStep(g.step)
          setGeoInfo(g)
          setGeoApplied(JSON.stringify(active.map(opPayload)))
        } finally {
          setBusy(null)
        }
      }
      setMaterial({ ...materialFromPreset(MATERIALS[0]), ...d.material, infill: { ...DEFAULT_INFILL, ...(d.material?.infill ?? {}) } })
      if (d.proof) setProof(d.proof)
      setSupports(d.supports.map((s) => ({ ...newSupport(), ...s, id: nextId++ })))
      setLoads(d.loads.map((l) => ({ ...newLoad(), ...l, id: nextId++ })))
      setActive(null)
    } catch (e) {
      setError(String(e))
    }
  }

  // --- Lager / Lasten ---------------------------------------------------------------
  const onPick = useCallback(
    (tag) => {
      if (bedPick) {
        const n = surfaceInfo.get(tag)?.normal
        if (!n) return setError('Bitte eine ebene Fläche anklicken – sie liegt dann auf dem Druckbett.')
        // die Fläche liegt auf dem Bett: Aufbaurichtung zeigt von ihr weg ins Bauteil
        setMaterial((m) => ({ ...m, buildDir: n.map((v) => (Math.abs(v) < 1e-9 ? 0 : -v)) }))
        setOrientations(null)
        setBedPick(false)
        return
      }
      if (geoPick) {
        const op = opFromSurface(tag, surfaceInfo)
        if (op.error) return setError(op.error)
        setGeoOps((ops) => [...ops, { ...op, mesh: mesh?.positions?.length }])
        setGeoPick(false)
        return
      }
      if (dirPick) {
        const info = surfaceInfo.get(tag)
        // ebene Fläche: Last drückt senkrecht auf die Fläche; Zylinder: entlang der Achse
        const dir = info?.normal ? info.normal.map((v) => -v) : info?.cylinder?.axis
        if (!dir) {
          setError('Diese Fläche ist weder eben noch zylindrisch – bitte eine ebene Fläche oder eine Bohrung/Welle anklicken.')
          return
        }
        setLoads((ls) =>
          ls.map((x) => {
            if (x.id !== dirPick.id) return x
            const ui = dirUi(x[dirPick.key], x[dirPick.key + 'Ui'])
            const next = { ...ui, ...anglesOf(dir), mag: currentMag(x[dirPick.key], ui) }
            return { ...x, [dirPick.key + 'Ui']: next, [dirPick.key]: vectorOf(next) }
          }),
        )
        setDirPick(null)
        return
      }
      if (!active) return
      const toggle = (items) =>
        items.map((it) =>
          it.id !== active.id
            ? it
            : { ...it, surfaces: it.surfaces.includes(tag) ? it.surfaces.filter((t) => t !== tag) : [...it.surfaces, tag] },
        )
      if (active.type === 'support') setSupports(toggle)
      else setLoads(toggle)
    },
    [active, dirPick, geoPick, bedPick, surfaceInfo, mesh],
  )

  const surfaceTint = useCallback(
    (tag) => {
      if (view === 'geometry') {
        // Radien/Bohrungen, die geändert werden (Flächennummern vom Zeitpunkt der Auswahl)
        return geoOps.some((o) => o.enabled && o.tags?.includes(tag) && o.mesh === mesh?.positions?.length) ? '#c9a227' : null
      }
      for (const l of loads)
        if (l.surfaces.includes(tag)) return l.region ? LOAD_PALE : active?.id === l.id ? LOAD_ACTIVE : LOAD_COLOR
      for (const s of supports)
        if (s.surfaces.includes(tag)) return s.region ? SUPPORT_PALE : active?.id === s.id ? SUPPORT_ACTIVE : SUPPORT_COLOR
      return null
    },
    [supports, loads, active, view, geoOps, mesh],
  )

  // --- Wirkbereiche ------------------------------------------------------------------
  const updateItem = (type, id, patch) => {
    const f = (items) => items.map((x) => (x.id === id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x))
    if (type === 'support') setSupports(f)
    else setLoads(f)
  }

  function startDrawing(type, item, shape) {
    setActive(null)
    setDirPick(null)
    setAim(null)
    setDrawing({ type, id: item.id, shape })
  }

  const onDraw = useCallback(
    (ev) => {
      if (!drawing) return
      const info = surfaceInfo.get(ev.tag)
      if (drawing.type === 'geo') {
        const sketch = regionFromDrag(drawing.shape, ev)
        setGeoOps((ops) => ops.map((o) => (o.id === drawing.id ? { ...o, sketch } : o)))
        if (ev.final) setDrawing(null)
        return
      }
      if (drawing.shape === 'band' && !info?.cylinder) {
        if (ev.final) setError('Ein Wellen-/Bohrungsabschnitt lässt sich nur auf einer zylindrischen Fläche zeichnen.')
        return
      }
      const region = regionFromDrag(drawing.shape, ev, info?.cylinder)
      updateItem(drawing.type, drawing.id, (x) => ({
        region,
        surfaces: x.surfaces.includes(ev.tag) ? x.surfaces : [...x.surfaces, ev.tag],
      }))
      if (ev.final) setDrawing(null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawing, surfaceInfo],
  )

  const planeNormal = useCallback((tag) => surfaceInfo.get(tag)?.normal ?? null, [surfaceInfo])

  const overlays = useMemo(() => {
    const out = []
    const push = (item, color, activeColor) => {
      const region = regionNumbers(item.region)
      if (!region || Object.values(region).some((v) => (Array.isArray(v) ? v.some((x) => !Number.isFinite(x)) : v !== region.shape && !Number.isFinite(v)))) return
      const isActive = active?.id === item.id || drawing?.id === item.id
      out.push({ region, cyl: selectionCylinder(item.surfaces, surfaceInfo), color: isActive ? activeColor : color, active: isActive })
    }
    if (view === 'geometry') {
      for (const o of geoOps) {
        if (!o.sketch || !o.enabled) continue
        const isActive = drawing?.id === o.id
        out.push({ region: regionNumbers(o.sketch), cyl: null, color: o.op === 'add' ? '#2e9e5b' : '#d64545', active: isActive })
      }
      return out
    }
    for (const s of supports) push(s, SUPPORT_COLOR, SUPPORT_ACTIVE)
    for (const l of loads) push(l, LOAD_COLOR, LOAD_ACTIVE)
    return out
  }, [supports, loads, surfaceInfo, active, drawing, view, geoOps])

  function supportFix(s) {
    if (s.kind === 'fixed') return { fix: { x: 0, y: 0, z: 0 } }
    if (s.kind === 'axes') {
      if (!s.axes.x && !s.axes.y && !s.axes.z) return { error: 'Mindestens eine Richtung sperren' }
      return { fix: { x: s.axes.x ? 0 : null, y: s.axes.y ? 0 : null, z: s.axes.z ? 0 : null } }
    }
    const free = { x: null, y: null, z: null }
    // reibungsfreie Auflage: senkrecht zur Fläche gesperrt (beliebig schräg)
    if (s.kind === 'frictionless') return { fix: free, local: { type: 'normal' } }
    // zylindrische Lagerung: radial / tangential / axial je einzeln
    const c = selectionCylinder(s.surfaces, surfaceInfo)
    if (s.surfaces.some((t) => !surfaceInfo.get(t)?.cylinder)) return { error: 'Nur für zylindrische Flächen (Bohrung, Welle, Bolzen)' }
    const cy = { radial: true, axial: true, tangential: false, ...s.cyl }
    if (!cy.radial && !cy.axial && !cy.tangential) return { error: 'Mindestens eine Richtung sperren' }
    if (!c) return { fix: free }
    return { fix: free, local: { type: 'cylindrical', origin: c.origin, axis: c.axis, ...cy } }
  }

  function loadNormal(l) {
    // mittlere Normale der gewählten Flächen (nach außen)
    const n = [0, 0, 0]
    for (const t of l.surfaces) {
      const s = surfaceInfo.get(t)
      if (s?.normal) for (let k = 0; k < 3; k++) n[k] += s.normal[k] * s.area
    }
    const len = Math.hypot(...n)
    return len > 0 ? n.map((v) => v / len) : null
  }

  const arrows = useMemo(() => {
    const out = []
    for (const l of loads) {
      if (!l.surfaces.length) continue
      let area = 0
      const c = [0, 0, 0]
      for (const t of l.surfaces) {
        const s = surfaceInfo.get(t)
        if (!s) continue
        area += s.area
        for (let k = 0; k < 3; k++) c[k] += s.center[k] * s.area
      }
      if (!area) continue
      let tip = c.map((v) => v / area)
      const region = regionNumbers(l.region)
      if (region) tip = regionAnchor(region, selectionCylinder(l.surfaces, surfaceInfo))
      let dir = null
      if ((l.kind === 'force' || l.kind === 'bearing') && Math.hypot(...l.force) > 0) dir = l.force
      if (l.kind === 'flow' && Math.hypot(...l.flowDir.map(Number)) > 0) dir = l.flowDir.map(Number)
      if (l.kind === 'moment' && Math.hypot(...l.moment.map(Number)) > 0) {
        // Momentenvektor (rechte Hand) vom Bereich weg
        const m = l.moment.map(Number)
        const len = Math.hypot(...m)
        const L = 0.2 * diag
        out.push({ id: l.id, anchor: tip, tip: tip.map((v, k) => v + (m[k] / len) * L), dir: m, length: L, color: MOMENT_COLOR })
        continue
      }
      if (l.kind === 'pressure') {
        const n = loadNormal(l)
        if (n) dir = n.map((v) => -v * Math.sign(l.pressure || 1))
      }
      if (dir) out.push({ id: l.id, anchor: tip, tip, dir, length: 0.16 * diag, color: active?.id === l.id || aim?.id === l.id ? LOAD_ACTIVE : LOAD_COLOR })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, surfaceInfo, diag, active, drawing, aim])

  // Griff zum Ausrichten am Pfeil der gewählten Last
  const aimView = useMemo(() => {
    if (!aim) return null
    const a = arrows.find((x) => x.id === aim.id)
    if (!a) return null
    return { anchor: a.anchor, dir: a.dir.map(Number), length: a.length, kind: aim.field === 'moment' ? 'moment' : 'force', plane: aim.plane, color: aim.field === 'moment' ? MOMENT_COLOR : LOAD_ACTIVE }
  }, [aim, arrows])

  const onAim = useCallback(
    (dir) => {
      if (!aim) return
      setLoads((ls) =>
        ls.map((x) => {
          if (x.id !== aim.id) return x
          const ui = dirUi(x[aim.field], x[aim.field + 'Ui'])
          const next = { ...ui, mode: 'dir', mag: currentMag(x[aim.field], ui), ...anglesOf(dir) }
          return { ...x, [aim.field + 'Ui']: next, [aim.field]: vectorOf(next) }
        }),
      )
    },
    [aim],
  )

  function startAim(id, field) {
    setActive(null)
    setDrawing(null)
    setDirPick(null)
    setAim(aim?.id === id && aim.field === field ? null : { id, field, plane: aim?.plane ?? 'free' })
  }

  // --- Geometrie anpassen ----------------------------------------------------------------
  const geoPending = useMemo(() => {
    const act = geoOps.filter((o) => o.enabled && !opProblem(o)).map(opPayload)
    return JSON.stringify(act) !== geoApplied
  }, [geoOps, geoApplied])

  async function onApplyGeometry() {
    const act = geoOps.filter((o) => o.enabled && !opProblem(o))
    const payload = act.map(opPayload)
    // Ergebnis vor der ersten Änderung als Vergleich merken
    if (result && !reference) setReference(summary(result, mesh, 'Original'))
    setBusy(act.length ? 'Passe Geometrie an und vernetze …' : 'Stelle Original wieder her …')
    setError(null)
    setDrawing(null)
    setGeoPick(false)
    try {
      const ref = currentRefine(meshSize)
      const g = act.length ? await api.modifyGeometry(stepPath, payload, Number(meshSize) || null, ref) : null
      const m = g ? g.mesh : await api.openStep(stepPath, Number(meshSize) || null, false, ref)
      setMeshRefineKey(JSON.stringify(ref))
      // Lager und Lasten auf die neuen Flächennummern umstellen
      const map = remapSurfaces(mesh.surfaces, m.surfaces)
      const warn = []
      const remap = (items, what) =>
        items.map((x, i) => {
          const lost = x.surfaces.filter((t) => map.get(t) == null)
          if (lost.length) warn.push(`${what} ${i + 1}: ${lost.length === 1 ? 'eine Fläche' : lost.length + ' Flächen'} nicht wiedergefunden – im Reiter Modell prüfen`)
          return { ...x, surfaces: [...new Set(x.surfaces.map((t) => map.get(t)).filter((t) => t != null))] }
        })
      setSupports((ss) => remap(ss, 'Lager'))
      setLoads((ls) => remap(ls, 'Last'))
      setGeoWarnings(warn)
      setMesh(m)
      setGeoStep(g ? g.step : null)
      setGeoInfo(g)
      setGeoApplied(JSON.stringify(payload))
      setTopo(null)
      setProbe(null)
      if (result) setResultStale(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // --- Parameterstudie -------------------------------------------------------------------
  const [study, setStudy] = useState({ param: 'mesh', values: '4; 3; 2; 1.5' })
  const [studyRows, setStudyRows] = useState(null)

  // Wählbare Parameter: Netzgröße, Füllgrad, je Geometrieänderung ein Maß
  const studyParams = useMemo(() => {
    const out = [{ key: 'mesh', label: 'Netzgröße (Konvergenzstudie)', unit: 'mm' }]
    if (material.layered && material.infill?.on) out.push({ key: 'infill', label: 'Füllgrad', unit: '%' })
    geoOps.forEach((o, i) => {
      if (!o.enabled) return
      const n = `${i + 1}. ${GEO_OPS[o.op]}`
      if (o.op === 'fillet') out.push({ key: `geo:${o.id}:radius`, label: `${n}: Radius`, unit: 'mm' })
      if (o.op === 'hole') out.push({ key: `geo:${o.id}:diameter`, label: `${n}: Durchmesser`, unit: 'mm' })
      if (o.op === 'add') out.push({ key: `geo:${o.id}:height`, label: `${n}: Höhe`, unit: 'mm' })
      if (o.op === 'cut') out.push({ key: `geo:${o.id}:depth`, label: `${n}: Tiefe`, unit: 'mm' })
      if ((o.op === 'add' || o.op === 'cut') && o.sketch?.shape === 'circle') out.push({ key: `geo:${o.id}:dia`, label: `${n}: Skizze Ø`, unit: 'mm' })
      if ((o.op === 'add' || o.op === 'cut') && o.sketch?.shape === 'rect') out.push({ key: `geo:${o.id}:width`, label: `${n}: Skizze Breite`, unit: 'mm' })
    })
    return out
  }, [material, geoOps])

  async function runStudy() {
    const values = study.values.split(/[;\s]+/).map((v) => Number(v.replace(',', '.'))).filter((v) => Number.isFinite(v))
    if (!values.length) return setError('Bitte Werte angeben, z. B. „4; 3; 2; 1,5“')
    const param = study.param
    const meta = studyParams.find((p) => p.key === param)
    const rows = []
    const origSurfaces = mesh.surfaces
    const refine = currentRefine(meshSize)
    const active = geoOps.filter((o) => o.enabled && !opProblem(o))
    setError(null)
    setActive(null)
    setDrawing(null)
    try {
      for (const [i, v] of values.entries()) {
        setBusy(`Studie ${meta.label} = ${fmt(v)} ${meta.unit} (${i + 1}/${values.length}) …`)
        let mat = material
        let sups = supports
        let lds = loads
        let m = mesh
        if (param === 'mesh') {
          m = active.length
            ? (await api.modifyGeometry(stepPath, active.map(opPayload), v, currentRefine(v))).mesh
            : await api.openStep(stepPath, v, false, currentRefine(v))
        } else if (param === 'infill') {
          mat = { ...material, infill: { ...material.infill, percent: v } }
        } else if (param.startsWith('geo:')) {
          const [, id, field] = param.split(':')
          const ops = active.map((o) => {
            if (String(o.id) !== id) return o
            if (field === 'dia') return { ...o, sketch: { ...o.sketch, radius: v / 2 } }
            if (field === 'width') return { ...o, sketch: { ...o.sketch, width: v } }
            if (field === 'depth') return { ...o, depth: v, through: false }
            return { ...o, [field]: v }
          })
          const g = await api.modifyGeometry(stepPath, ops.map(opPayload), Number(meshSize) || null, refine)
          m = g.mesh
          const map = remapSurfaces(origSurfaces, m.surfaces)
          const re = (items) => items.map((x) => ({ ...x, surfaces: [...new Set(x.surfaces.map((t) => map.get(t)).filter((t) => t != null))] }))
          sups = re(supports)
          lds = re(loads)
        }
        const r = await api.solve(buildSetup(mat, sups, lds))
        const rho = Number(material.rho)
        rows.push({
          value: v, vm: r.max_von_mises.value, u: r.max_displacement.value, safety: r.safety, safetyBreak: r.safety_break,
          volume: r.solid_volume, mass: rho > 0 ? (r.solid_volume / 1000) * rho : null, elements: m.elements, equations: r.equations,
        })
        setStudyRows({ param: meta, rows: [...rows] })
      }
      // Ausgangszustand wiederherstellen (Netz und Ergebnis)
      if (param === 'mesh' || param.startsWith('geo:')) {
        setBusy('Ausgangszustand wiederherstellen …')
        const m = active.length
          ? (await api.modifyGeometry(stepPath, active.map(opPayload), Number(meshSize) || null, refine)).mesh
          : await api.openStep(stepPath, Number(meshSize) || null, false, refine)
        setMesh(m)
      }
      if (result) {
        const r = await api.solve(buildSetup(material))
        setResult(r)
        setResultStale(false)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  function exportStudyCsv() {
    if (!studyRows) return
    const head = [`${studyRows.param.label} [${studyRows.param.unit}]`, 'max. Vergleichsspannung [MPa]', 'max. Verschiebung [mm]', 'Sicherheit', 'Sicherheit Bruch', 'Volumen [mm³]', 'Masse [g]', 'Elemente', 'Unbekannte']
    const lines = [head.join(';')]
    for (const r of studyRows.rows)
      lines.push([r.value, r.vm, r.u, r.safety ?? '', r.safetyBreak ?? '', r.volume, r.mass ?? '', r.elements, r.equations].map((v) => String(v).replace('.', ',')).join(';'))
    api.saveBlob(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv' }), 'parameterstudie.csv', 'CSV', 'csv').catch((e) => setError(String(e)))
  }

  // --- Leichtbau ----------------------------------------------------------------------
  async function onTopo(args) {
    setBusy('Leichtbau-Vorschlag berechnen …')
    setError(null)
    setDrawing(null)
    setGeoPick(false)
    try {
      const v = await api.topopt(buildSetup(material), args)
      setTopo({ view: v, threshold: 0.5, show: true, surface: v.surface })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onTopoThreshold(t) {
    setTopo((x) => ({ ...x, threshold: t }))
    try {
      const sfc = await api.topoSurface(t)
      setTopo((x) => (x && x.threshold === t ? { ...x, surface: sfc } : x))
    } catch (e) {
      setError(String(e))
    }
  }

  // --- Rechnen ---------------------------------------------------------------------
  const problems = useMemo(() => {
    const p = []
    if (!mesh) p.push('Geometrie öffnen')
    if (!supports.length) p.push('Mindestens ein Lager anlegen')
    supports.forEach((s, i) => {
      if (!s.surfaces.length) p.push(`Lager ${i + 1}: Flächen wählen`)
      const f = supportFix(s)
      if (f.error) p.push(`Lager ${i + 1}: ${f.error}`)
    })
    if (!loads.length && analysis !== 'modal') p.push('Mindestens eine Last anlegen')
    if (analysis === 'modal' && !(Number(material.rho) > 0)) p.push('Für Eigenfrequenzen die Dichte des Werkstoffs angeben')
    loads.forEach((l, i) => {
      if (!l.surfaces.length) p.push(`Last ${i + 1}: Flächen wählen`)
      if (l.kind === 'bearing' && l.surfaces.some((t) => !surfaceInfo.get(t)?.cylinder))
        p.push(`Last ${i + 1}: Lagerlast nur auf zylindrischen Flächen (Bohrung, Welle)`)
    })
    for (const [what, items] of [['Lager', supports], ['Last', loads]])
      items.forEach((x, i) => {
        if (drawing?.id === x.id && !x.region) p.push(`${what} ${i + 1}: Bereich auf die Fläche zeichnen`)
      })
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, supports, loads, surfaceInfo, drawing, analysis, material.rho])

  function buildSetup(mat, sups = supports, lds = loads) {
    return {
        material: materialPayload(mat),
        supports: sups.map((s) => {
          const f = supportFix(s)
          return { surfaces: s.surfaces, fix: f.fix, local: f.local ?? null, region: regionNumbers(s.region) }
        }),
        loads: lds.map((l) => {
          const base = { type: l.kind, surfaces: l.surfaces, region: regionNumbers(l.region) }
          if (l.kind === 'pressure') return { ...base, pressure: Number(l.pressure) }
          // Moment in der Oberfläche in N·m, im Rechenkern N·mm
          if (l.kind === 'moment') return { ...base, moment: l.moment.map((v) => Number(v) * 1000) }
          if (l.kind === 'flow') return { ...base, direction: l.flowDir.map(Number), pressure: flowPressurePa(l) * 1e-6 }
          return { ...base, force: l.force.map(Number) }
        }),
      }
  }

  async function onSolve(mat = material) {
    setBusy('Rechne …')
    setError(null)
    setActive(null)
    setDrawing(null)
    setAim(null)
    setBedPick(false)
    try {
      const r = await api.solve(buildSetup(mat))
      setResult(r)
      reportCad(r, mat)
      setResultStale(false)
      setView('result')
      setProbe(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // Modell ohne Aufbaurichtung – ändert sich das, ist ein Richtungsvergleich veraltet
  function orientationKey() {
    try {
      const s = buildSetup({ ...material, buildDir: [0, 0, 1] })
      return JSON.stringify(s) + (mesh?.nodes ?? 0)
    } catch {
      return ''
    }
  }

  // Gleiche Rechnung für die Aufbaurichtungen X, Y, Z (und eine eigene): Sicherheit je Richtung.
  // Die aktuelle Richtung wird zuletzt gerechnet, damit das angezeigte Ergebnis zu ihr passt.
  async function onCompareOrientations() {
    const cur = material.buildDir ?? [0, 0, 1]
    const same = (a, b) => Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) - 1) < 1e-6
    const dirs = BUILD_DIRS.map(([, d]) => d).filter((d) => !same(d, cur))
    dirs.push(cur)
    setError(null)
    setActive(null)
    setDrawing(null)
    setBedPick(false)
    const rows = []
    try {
      for (const [i, d] of dirs.entries()) {
        setBusy(`Vergleiche Aufbaurichtung ${dirName(d)} (${i + 1}/${dirs.length}) …`)
        const r = await api.solve(buildSetup({ ...material, buildDir: d }))
        rows.push({ dir: d, safety: r.safety, safetyBreak: r.safety_break, governing: r.governing, u: r.max_displacement.value })
        if (i === dirs.length - 1) {
          setResult(r)
          setResultStale(false)
          setProbe(null)
        }
      }
      rows.sort((a, b) => (b.safety ?? 0) - (a.safety ?? 0))
      setOrientations({ rows, key: orientationKey() })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // Ergebniswerte für „Ergebnis holen“ im CAD (Eigenschaften des Teils)
  function reportCad(r, mat = material, sups = supports, path = stepPath) {
    if (!path) return
    const name = path.split(/[\\/]/).pop().replace(/\.(step|stp)$/i, '')
    const rho = Number(mat.rho)
    const rows = proofRows(r, proof)
    const num = (v) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(4)))
    api
      .cadSetSummary(name, {
        FEM_Sicherheit: num(r.safety),
        FEM_Sicherheit_Bruch: num(r.safety_break),
        FEM_SigmaV_MPa: num(r.max_von_mises.value),
        FEM_Verformung_mm: num(r.max_displacement.value),
        FEM_Masse_g: rho > 0 ? num((r.solid_volume / 1000) * rho) : null,
        FEM_Nachweis: rows.length ? (rows.every((x) => x[3] <= 1) ? 'erfüllt' : 'nicht erfüllt') : null,
        FEM_Massgeblich: r.governing ?? null,
        FEM_Werkstoff: mat.name,
        FEM_Lager: sups.length,
        FEM_Datum: new Date().toLocaleString('de-DE'),
      })
      .catch(() => {})
  }

  // Teil aus dem CAD: gleiches Teil → neue Version mit denselben Lagern/Lasten, sonst neu öffnen
  async function handleIncoming(inc) {
    const cur = stepPath ? stepPath.split(/[\\/]/).pop().replace(/\.(step|stp)$/i, '') : null
    const same = mesh && cur === inc.name
    if (!same) {
      await loadGeometry(inc.path, null)
      setNotice(`${inc.source}: „${inc.name}“ geöffnet – Lager und Lasten festlegen`)
      return
    }
    setBusy(`${inc.source}: neue Version von „${inc.name}“ übernehmen …`)
    try {
      const ref = currentRefine(meshSize)
      const m = await api.openStep(inc.path, Number(meshSize) || null, false, ref)
      const map = remapSurfaces(mesh.surfaces, m.surfaces)
      let lost = 0
      const re = (items) =>
        items.map((x) => {
          lost += x.surfaces.filter((t) => map.get(t) == null).length
          return { ...x, surfaces: [...new Set(x.surfaces.map((t) => map.get(t)).filter((t) => t != null))] }
        })
      const sups = re(supports)
      const lds = re(loads)
      setSupports(sups)
      setLoads(lds)
      setMesh(m)
      setStepPath(inc.path)
      setMeshRefineKey(JSON.stringify(ref))
      setGeoOps([])
      setGeoStep(null)
      setGeoApplied('[]')
      setTopo(null)
      setProbe(null)
      if (result && cadAuto && !lost) {
        if (!reference) setReference(summary(result, mesh, 'vorige Version'))
        setBusy(`„${inc.name}“ neu rechnen …`)
        const r = await api.solve(buildSetup(material, sups, lds))
        setResult(r)
        setResultStale(false)
        reportCad(r, material, sups, inc.path)
        setView('result')
      } else if (result) setResultStale(true)
      setNotice(
        `${inc.source}: neue Version von „${inc.name}“ übernommen` +
          (lost ? ` – ${lost} Lager-/Lastfläche(n) nicht wiedergefunden, bitte prüfen` : result && cadAuto ? ' und neu gerechnet' : ''),
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }
  const incomingRef = useRef(null)
  incomingRef.current = handleIncoming
  // eingehende Teile nacheinander verarbeiten (sonst überholt ein schnelles Teil ein langsames)
  const incomingQueue = useRef(Promise.resolve())
  useEffect(
    () =>
      api.onCadOpen((inc) => {
        incomingQueue.current = incomingQueue.current.then(() => incomingRef.current?.(inc)).catch(() => {})
      }),
    [],
  )
  useEffect(() => {
    api.startupFile().then((p) => p && loadGeometry(p, null)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(t)
  }, [notice])

  async function onModes() {
    setBusy(analysis === 'modal' ? 'Eigenfrequenzen berechnen …' : 'Knicklasten berechnen …')
    setError(null)
    setActive(null)
    setDrawing(null)
    setAim(null)
    try {
      const m = await api.modes(buildSetup(material), analysis, Number(modeCount) || 6, Number(material.rho) || null)
      setModes({ ...m, sel: 0, animate: true })
      setView('result')
      setProbe(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onExportVtu() {
    api.exportVtu(stepPath).catch((e) => setError(String(e)))
  }

  // --- Schnitt ------------------------------------------------------------------------
  const cutPlane = useMemo(() => {
    if (!cut.on || !mesh) return null
    const [lo, hi] = mesh.bbox
    const point = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
    const k = cut.axis
    point[k] = lo[k] + ((hi[k] - lo[k]) * Math.min(Math.max(cut.pos, 0.5), 99.5)) / 100
    const normal = [0, 0, 0]
    normal[k] = cut.flip ? -1 : 1
    return { point, normal }
  }, [cut, mesh])

  useEffect(() => {
    if (!cutPlane || !result || resultStale) {
      setCutData(null)
      return
    }
    let stop = false
    const t = setTimeout(async () => {
      try {
        const d = await api.section(cutPlane.point, cutPlane.normal)
        if (!stop) setCutData(d)
      } catch (e) {
        if (!stop) setError(String(e))
      }
    }, 120)
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [cutPlane, result, resultStale])

  // --- Ergebnisanzeige ----------------------------------------------------------------
  const showModes = analysis !== 'static' && modes && modes.kind === analysis
  const display = useMemo(() => {
    if (showModes && mesh) {
      const sh = modes.shapes[modes.sel] ?? modes.shapes[0]
      const n = sh.length / 3
      const values = new Float32Array(n)
      let imax = 0
      for (let i = 0; i < n; i++) {
        values[i] = Math.hypot(sh[3 * i], sh[3 * i + 1], sh[3 * i + 2])
        if (values[i] > values[imax]) imax = i
      }
      const scale = 0.08 * diag
      return { values, min: 0, max: 1, imin: 0, imax, reverse: false, displacement: sh, scale, auto: scale, cut: null, animate: modes.animate, modal: true }
    }
    if (!result || !mesh) return null
    const n = result.von_mises.length
    let values
    let reverse = false
    if (quantity === 'disp') {
      values = new Float32Array(n)
      for (let i = 0; i < n; i++) values[i] = Math.hypot(result.displacement[3 * i], result.displacement[3 * i + 1], result.displacement[3 * i + 2])
    } else if (FIELD_OF[quantity]?.[1]) {
      const u = result[FIELD_OF[quantity][0]]
      values = Float32Array.from(u ?? [], (v) => Math.min(1 / Math.max(v, 1e-12), 10))
      reverse = true
    } else if (quantity === 'usage') {
      // Auslastung in % (ohne Festigkeitswerte: Vergleichsspannung bezogen auf das Maximum)
      const vmax = result.max_von_mises.value || 1
      values = result.utilization ? Float32Array.from(result.utilization, (u) => 100 * u) : Float32Array.from(result.von_mises, (v) => (100 * v) / vmax)
    } else if (quantity === 'shell') {
      values = Float32Array.from(result.shell_fraction ?? [])
    } else values = Float32Array.from(result[quantity])
    let min = Infinity, max = -Infinity, imin = 0, imax = 0
    for (let i = 0; i < n; i++) {
      if (values[i] < min) (min = values[i]), (imin = i)
      if (values[i] > max) (max = values[i]), (imax = i)
    }
    // Werte auf der Schnittfläche (gleiche Farbskala, Bereich ggf. erweitert)
    let cutValues = null
    if (cutData) {
      const m = cutData.positions.length / 3
      if (quantity === 'disp') {
        cutValues = new Float32Array(m)
        for (let i = 0; i < m; i++) cutValues[i] = Math.hypot(cutData.displacement[3 * i], cutData.displacement[3 * i + 1], cutData.displacement[3 * i + 2])
      } else if (quantity === 'usage') {
        const vmax = result.max_von_mises.value || 1
        const src = cutData.fields.utilization
        cutValues = src ? Float32Array.from(src, (u) => 100 * u) : Float32Array.from(cutData.fields.von_mises, (v) => (100 * v) / vmax)
      } else {
        const [field, inv] = FIELD_OF[quantity] ?? []
        const src = cutData.fields[field]
        if (src) cutValues = Float32Array.from(src, (v) => (inv ? Math.min(1 / Math.max(v, 1e-12), 10) : v))
      }
      if (cutValues) for (const v of cutValues) (min = Math.min(min, v)), (max = Math.max(max, v))
    }
    const umax = result.max_displacement.value
    const auto = umax > 0 ? (0.05 * diag) / umax : 0
    const scale = deform === 'off' ? 0 : deform === 'true' ? 1 : auto
    const cutView = cutData && cutValues && cutPlane ? { ...cutData, values: cutValues, plane: cutPlane } : null
    return { values, min, max, imin, imax, reverse, displacement: result.displacement, scale, auto, cut: cutView }
  }, [result, mesh, quantity, deform, diag, cutData, cutPlane, showModes, modes])

  const markers = useMemo(() => {
    if (!display || display.modal) return []
    const q = QUANTITIES[quantity]
    const u = q.unit ? ' ' + q.unit : ''
    const m = []
    if (quantity === 'shell') {
      /* keine Markierung */
    } else if (FIELD_OF[quantity]?.[1]) m.push({ node: display.imin, label: `Min ${fmt(display.min)}` })
    else if (quantity === 'sigma3') m.push({ node: display.imin, label: `Min ${fmt(display.min)}${u}` })
    else m.push({ node: display.imax, label: `Max ${fmt(display.max)}${u}` })
    if (probe) m.push({ node: probe.node, label: `${fmt(display.values[probe.node])}${u}`, probe: true })
    return m
  }, [display, quantity, probe])

  const mode = view === 'result' && display ? 'result' : 'setup'
  // aktueller Stand für asynchrone Abläufe (Bericht)
  const displayRef = useRef(null)
  displayRef.current = display
  const viewRef = useRef(null)

  // --- PDF-Bericht ----------------------------------------------------------------------
  async function onReport() {
    if (!result) return
    const prev = { view, quantity }
    const wait = () => new Promise((r) => setTimeout(r, 400))
    setBusy('Bericht erstellen …')
    setActive(null)
    setDrawing(null)
    setAim(null)
    try {
      const images = []
      setView('setup')
      await wait()
      images.push({ title: 'Modell mit Lagern und Lasten', ...viewRef.current.snapshot() })
      setView('result')
      const qs = ['von_mises', 'disp']
      if (result.utilization) qs.push('safety')
      if (result.utilization_layers) qs.push('safety_layers')
      if (result.utilization_infill) qs.push('safety_infill')
      for (const q of qs) {
        setQuantity(q)
        await wait()
        await wait()
        const d = displayRef.current
        const Q = QUANTITIES[q]
        images.push({
          title: `${Q.label} (${Q.hint})`,
          ...viewRef.current.snapshot(),
          legend: d && { min: d.min, max: d.max, reverse: d.reverse, unit: Q.unit, label: Q.label + (d.scale ? ` – Verformung ${fmt(d.scale)}-fach überhöht` : '') },
        })
      }
      setQuantity(prev.quantity)
      setView(prev.view)
      const blob = buildReport(reportData(images))
      const name = (stepPath ?? 'bauteil').split(/[\\/]/).pop().replace(/\.(step|stp)$/i, '') + '_bericht.pdf'
      await api.saveBlob(blob, name, 'PDF-Bericht', 'pdf')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // --- MathPad: Rechenblatt mit Ergebnissen und Nachweis ---------------------------------
  function onExportMathpad() {
    if (!result) return
    const file = (stepPath ?? 'Bauteil').split(/[\\/]/).pop()
    const num = (v) => {
      const x = Number(v)
      return Math.abs(x) < 1e-9 ? '0' : String(Number(x.toPrecision(5)))
    }
    const has = (v) => v !== '' && v != null && Number.isFinite(Number(v))
    const L = []
    const note = (t) => L.push('"' + t)
    note(`Projekt-FEM: ${file} – Ergebnis vom ${new Date().toLocaleDateString('de-DE')}`)
    note(`Werkstoff: ${material.name}${material.layered ? ` (3D-Druck, Aufbaurichtung ${dirLabel(material.buildDir ?? [0, 0, 1])})` : ''}`)
    L.push(`E = ${num(material.E)} MPa`)
    if (has(material.yield)) L.push(`R_e = ${num(material.yield)} MPa`)
    if (has(material.tensile)) L.push(`R_m = ${num(material.tensile)} MPa`)
    if (material.layered) {
      L.push(`E_z = ${num(material.E_z)} MPa`)
      if (has(material.yield_z)) L.push(`R_ez = ${num(material.yield_z)} MPa`)
      if (has(material.tensile_z)) L.push(`R_mz = ${num(material.tensile_z)} MPa`)
    }
    L.push('')
    note('Ergebnisse der FEM-Rechnung (Maximalwerte)')
    L.push(`σ_v = ${num(result.max_von_mises.value)} MPa`)
    L.push(`σ_1 = ${num(result.max_sigma1.value)} MPa`)
    L.push(`σ_3 = ${num(result.min_sigma3.value)} MPa`)
    L.push(`u_max = ${num(result.max_displacement.value)} mm`)
    const rho = Number(material.rho)
    if (rho > 0) L.push(`m = ${num((result.solid_volume / 1000) * rho)} g`)
    const ref = Math.hypot(...result.total_load) || 1
    result.reactions.forEach((r, i) => {
      const c = clean(r, ref)
      ;['x', 'y', 'z'].forEach((a, k) => L.push(`F_A${i + 1}${a} = ${num(c[k])} N`))
      L.push(`F_A${i + 1} = sqrt(F_A${i + 1}x^2 + F_A${i + 1}y^2 + F_A${i + 1}z^2)`)
    })
    L.push('')
    note('Nachweis (Formeln rechnen live – Werte hier anpassen)')
    const strength = has(material.yield) ? 'R_e' : has(material.tensile) ? 'R_m' : null
    if (strength) {
      L.push(`S_F = ${strength} / σ_v`)
      if (result.governing) note(`FEM mit Schichtaufbau: S = ${num(result.safety)} (maßgeblich: ${result.governing}) – die Formel oben gilt nur in der Schicht`)
    }
    if (has(material.tensile) && strength === 'R_e') L.push('S_B = R_m / σ_v')
    if (Number(proof.sF) > 0) L.push(`S_Ferf = ${num(proof.sF)}`)
    if (Number(proof.sB) > 0) L.push(`S_Berf = ${num(proof.sB)}`)
    if (strength && Number(proof.sF) > 0) L.push('a_F = S_Ferf / S_F')
    if (has(material.tensile) && strength === 'R_e' && Number(proof.sB) > 0) L.push('a_B = S_Berf / S_B')
    L.push('')
    const lines = L.map((text, i) => ({ id: i + 1, text, mark: null }))
    const name = file.replace(/\.(step|stp)$/i, '') + ' FEM'
    const data = { lines, nid: lines.length + 1, name, savedAt: new Date().toISOString() }
    api.saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name + '.mathpad', 'MathPad-Arbeitsblatt', 'mathpad').catch((e) =>
      setError(String(e)),
    )
  }

  function reportData(images) {
    const file = (stepPath ?? 'Bauteil').split(/[\\/]/).pop()
    const [lo, hi] = mesh.bbox
    const rho = Number(material.rho)
    const mass = rho > 0 ? (result.solid_volume / 1000) * rho : null
    const kindText = { fixed: 'fest eingespannt', frictionless: 'reibungsfreie Auflage', axes: 'Richtungen gesperrt', cylindrical: 'zylindrische Lagerung' }
    const regionText = (r) => (r ? ` – nur im Bereich ${SHAPES[r.shape] ?? r.shape}` : '')
    const supportsRows = supports.map((x, i) => {
      let t = kindText[x.kind] ?? x.kind
      if (x.kind === 'axes') t += ' (' + ['x', 'y', 'z'].filter((a) => x.axes[a]).join(', ') + ')'
      if (x.kind === 'cylindrical') {
        const c = { radial: true, axial: true, tangential: false, ...x.cyl }
        t += ` (${c.radial ? 'radial fest' : 'radial frei'}, ${c.axial ? 'axial fest' : 'axial frei'}, ${c.tangential ? 'Drehung gesperrt' : 'drehbar'})`
      }
      return [`Lager ${i + 1}`, `${t}, ${x.surfaces.length} Fläche(n)${regionText(x.region)}`]
    })
    const loadsRows = loads.map((l, i) => {
      let t
      if (l.kind === 'pressure') t = `Druck ${fmt(Number(l.pressure))} MPa`
      else if (l.kind === 'moment') t = `Moment (${fmtVec(l.moment.map(Number))}) N·m`
      else if (l.kind === 'flow') t = `Strömung ${MEDIA[l.medium ?? 'luft'][0]}, v = ${fmt(Number(l.velocity))} m/s, c_w = ${fmt(Number(l.cw))}, Richtung (${fmtVec(l.flowDir.map(Number))}), Druck ${fmt(flowPressurePa(l))} Pa`
      else t = `${l.kind === 'bearing' ? 'Lagerlast' : 'Kraft'} (${fmtVec(l.force.map(Number))}) N, Betrag ${fmt(Math.hypot(...l.force.map(Number)))} N`
      return [`Last ${i + 1}`, `${t}, ${l.surfaces.length} Fläche(n)${regionText(l.region)}`]
    })
    const mat = [
      ['Werkstoff', material.name],
      ['E-Modul / ν', `${fmt(Number(material.E))} MPa / ${fmt(Number(material.nu))}`],
      ['Re bzw. Rp0,2 / Rm', `${material.yield !== '' && material.yield != null ? fmt(Number(material.yield)) + ' MPa' : '–'} / ${material.tensile !== '' && material.tensile != null ? fmt(Number(material.tensile)) + ' MPa' : '–'}`],
    ]
    if (rho > 0) mat.push(['Dichte', `${fmt(rho)} g/cm³`])
    if (material.layered) {
      mat.push(['3D-Druck: quer zu den Schichten', `E ${fmt(Number(material.E_z))} MPa, Re/Rp ${material.yield_z !== '' ? fmt(Number(material.yield_z)) : '–'}, Rm ${material.tensile_z !== '' ? fmt(Number(material.tensile_z)) : '–'} MPa`])
      mat.push(['Aufbaurichtung', dirLabel(material.buildDir ?? [0, 0, 1])])
      const inf = material.infill
      if (inf?.on) {
        const t = shellThickness(inf)
        mat.push(['Füllung', `${INFILL_PATTERNS[inf.pattern].label}, ${fmt(Number(inf.percent))} %`])
        mat.push(['Wände / Deck / Boden', `${inf.walls} × ${fmt(Number(inf.lineWidth))} mm = ${fmt(t.wall)} mm / ${fmt(t.top)} mm / ${fmt(t.bottom)} mm`])
      }
    }
    const meshLines = [
      ['Datei', file],
      ['Abmessungen', fmtVec(hi.map((v, k) => v - lo[k])) + ' mm'],
      ['Volumen', `${fmt(mesh.volume / 1000)} cm³` + (Math.abs(result.solid_volume - mesh.volume) > 1e-6 * mesh.volume ? ` (gefüllt ${fmt(result.solid_volume / 1000)} cm³)` : '')],
      ...(mass != null ? [['Masse', mass >= 1000 ? `${fmt(mass / 1000)} kg` : `${fmt(mass)} g`]] : []),
      ['Netz', `${mesh.elements.toLocaleString('de-DE')} Elemente TET10, ${mesh.nodes.toLocaleString('de-DE')} Knoten, Elementgröße ${fmt(mesh.mesh_size)} mm`],
      ['Gleichungen', `${result.equations.toLocaleString('de-DE')} Unbekannte, ${result.iterations != null ? `iterativ (${result.iterations} Iterationen)` : 'direkt'}, ${fmt(result.seconds)} s`],
    ]
    const act = geoOps.filter((o) => o.enabled)
    if (act.length && geoStep) meshLines.push(['Geometrie geändert', act.map((o) => GEO_OPS[o.op]).join(', ')])
    const res = [
      ['max. Vergleichsspannung (von Mises)', `${fmt(result.max_von_mises.value)} MPa bei (${fmtVec(result.max_von_mises.at)}) mm`],
      ['max. Verschiebung', `${fmt(result.max_displacement.value)} mm bei (${fmtVec(result.max_displacement.at)}) mm`],
      ['größte / kleinste Hauptspannung', `${fmt(result.max_sigma1.value)} / ${fmt(result.min_sigma3.value)} MPa`],
    ]
    if (result.safety != null) res.push(['Sicherheit', `S = ${fmt(result.safety)}${result.governing ? ` (maßgeblich: ${result.governing})` : ''}`])
    if (result.safety_break != null) res.push(['Sicherheit gegen Bruch', `S = ${fmt(result.safety_break)}`])
    result.reactions.forEach((r, i) => res.push([`Lagerkraft Lager ${i + 1}`, `(${fmtVec(clean(r, Math.hypot(...result.total_load) || 1))}) N`]))
    const ref = Math.hypot(...result.total_load) || 1
    res.push(['Summe Lasten / Lager', `(${fmtVec(clean(result.total_load, ref))}) N / (${fmtVec(clean(result.total_reaction, ref))}) N`])
    const pr = proofRows(result, proof).map(([lab, have, need, a]) => [
      lab,
      lab === 'Verformung' ? `${fmt(have)} mm` : `S = ${fmt(have)}`,
      lab === 'Verformung' ? `<= ${fmt(need)} mm` : `>= ${fmt(need)}`,
      `${(100 * a).toFixed(0)} %${a <= 1 ? ' ok' : ' NICHT ERFÜLLT'}`,
    ])
    const prow = proofRows(result, proof)
    const verdict = prow.length
      ? { ok: prow.every((r) => r[3] <= 1), text: prow.every((r) => r[3] <= 1) ? 'Festigkeitsnachweis erfüllt' : 'Festigkeitsnachweis NICHT erfüllt' }
      : result.safety != null
        ? { ok: result.safety >= 1, text: `Sicherheit S = ${fmt(result.safety)}` }
        : null
    return {
      title: `Festigkeitsberechnung ${file.replace(/\.(step|stp)$/i, '')}`,
      file,
      date: new Date().toLocaleDateString('de-DE'),
      verdict,
      meshLines,
      materialLines: mat,
      supports: supportsRows,
      loads: loadsRows,
      resultLines: res,
      proofRows: pr,
      warnings: result.warnings,
      images,
      notes: [
        'Linear-elastische Rechnung mit kleinen Verformungen; oberhalb der Streckgrenze bzw. Festigkeit sind die Werte nicht realistisch.',
        'Spannungsspitzen an starren Lagern und scharfen Innenecken sind Singularitäten und wachsen mit feinerem Netz – dort nicht bewerten.',
        'Spannungen sind über die angrenzenden Elemente gemittelt (Knotenwerte). Für belastbare Werte eine Netzstudie (Parameterstudie Netzgröße) durchführen.',
        ...(material.layered ? ['3D-Druck: Werkstoffwerte sind Richtwerte bzw. Eingaben; Infill als Ersatzwerkstoff (Näherung). Kalibrierung mit eigenem Zugstab empfohlen.'] : []),
        'Rechenkern geprüft an Lehrbuchfällen (Zugstab, Kragbalken, Lochplatte, Torsion, Gelenkbalken, 3D-Druck), siehe „projekt-fem validieren“.',
      ],
    }
  }
  const fileName = stepPath?.split(/[\\/]/).pop()

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BoxIcon size={18} strokeWidth={2.2} />
          <span>Projekt-FEM</span>
          {fileName && <span className="file">{fileName}</span>}
        </div>
        <div className="segmented">
          <button className={view === 'setup' ? 'on' : ''} onClick={() => setView('setup')}>
            Modell
          </button>
          <button className={view === 'geometry' ? 'on' : ''} disabled={!mesh} onClick={() => { setActive(null); setAim(null); setDirPick(null); setDrawing(null); setView('geometry') }}>
            Geometrie{geoOps.some((o) => o.enabled) ? ` (${geoOps.filter((o) => o.enabled).length})` : ''}
          </button>
          <button className={view === 'study' ? 'on' : ''} disabled={!mesh} onClick={() => { setActive(null); setDrawing(null); setView('study') }}>
            Studie
          </button>
          <button className={view === 'frame' ? 'on' : ''} onClick={() => { setActive(null); setDrawing(null); setView('frame') }}>
            Stabwerk
          </button>
          <button className={view === 'result' ? 'on' : ''} disabled={!result && !modes} onClick={() => setView('result')}>
            Ergebnis{resultStale && result ? ' (veraltet)' : ''}
          </button>
        </div>
        <div className="actions">
          <CadButton onError={(e) => setError(String(e))} />
          {api.isDesktop ? (
            <ShareButton onError={(e) => setError(String(e))} />
          ) : (
            <span className="remote-badge" title="Die Rechnung läuft auf dem Rechner, auf dem Projekt-FEM die Heimnetz-Freigabe hat">
              <Wifi size={14} /> Rechnet auf {window.location.hostname}
            </span>
          )}
          <button className="btn ghost" onClick={onLoadProject}>
            <FolderOpen size={15} /> Projekt öffnen
          </button>
          <button className="btn ghost" onClick={onSaveProject} disabled={!stepPath}>
            <Save size={15} /> Speichern
          </button>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar" ref={sidebar}>
          {gmsh === null && (
            <div className="notice warn">
              <TriangleAlert size={16} />
              <div>
                Gmsh wurde nicht gefunden. Installieren mit <code>uv tool install gmsh</code> (Linux/Mac) oder{' '}
                <code>brew install gmsh</code> (Mac), dann neu starten.
              </div>
            </div>
          )}

          {view === 'setup' ? (
            <>
              <Section n={1} title="Geometrie" done={!!mesh}>
                <button className="btn primary wide" onClick={onOpenStep} disabled={!gmsh}>
                  <FileUp size={15} /> STEP-Datei öffnen
                </button>
                {mesh && (
                  <div className="stats">
                    <Stat label="Volumen" value={`${fmt(mesh.volume / 1000)} cm³`} />
                    <Stat label="Abmessungen" value={fmtVec(mesh.bbox[1].map((v, k) => v - mesh.bbox[0][k])) + ' mm'} />
                    <Stat label="Flächen" value={mesh.surfaces.length} />
                  </div>
                )}
              </Section>

              {mesh && (
                <Section n={2} title="Netz" done>
                  <div className="row">
                    <label className="field grow">
                      <span>Elementgröße</span>
                      <div className="input-unit">
                        <input value={meshSize} onChange={(e) => setMeshSize(e.target.value)} inputMode="decimal" />
                        <em>mm</em>
                      </div>
                    </label>
                    <button
                      className={'btn' + (Number(meshSize) !== Number(mesh.mesh_size.toPrecision(3)) || JSON.stringify(currentRefine(meshSize)) !== meshRefineKey ? ' primary' : '')}
                      onClick={() => loadGeometry(geoStep ?? stepPath, meshSize, true, !geoStep)}
                    >
                      <Grid3x3 size={15} /> Neu vernetzen
                    </button>
                  </div>
                  <MeshSlider mesh={mesh} diag={diag} value={meshSize} onChange={setMeshSize} />
                  <p className="hint">
                    {mesh.elements.toLocaleString('de-DE')} Elemente (TET10), {mesh.nodes.toLocaleString('de-DE')} Knoten. An Bohrungen und
                    Radien wird automatisch feiner vernetzt.
                  </p>
                  <label className="check">
                    <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} /> Netz anzeigen
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={refineRegions} onChange={(e) => setRefineRegions(e.target.checked)} /> Netz in Wirkbereichen
                    automatisch verfeinern
                  </label>
                  {JSON.stringify(currentRefine(meshSize)) !== meshRefineKey && (
                    <p className="hint warn-text">Wirkbereiche oder Füllung geändert – „Neu vernetzen“, damit das Netz dort passend fein wird.</p>
                  )}
                </Section>
              )}

              {mesh && (
                <Section n={3} title="Werkstoff" done>
                  <select
                    value={[...MATERIALS, ...userMaterials].some((m) => m.name === material.name) ? material.name : ''}
                    onChange={(e) => {
                      const m = [...userMaterials, ...MATERIALS].find((x) => x.name === e.target.value)
                      setMaterial(m ? { ...materialFromPreset(m, material.buildDir), infill: material.infill ?? { ...DEFAULT_INFILL } } : { ...material, name: 'Benutzerdefiniert' })
                    }}
                  >
                    {MATERIAL_GROUPS.map((g) => (
                      <optgroup key={g} label={g}>
                        {MATERIALS.filter((m) => m.group === g).map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    {userMaterials.length > 0 && (
                      <optgroup label="Eigene Werkstoffe">
                        {userMaterials.map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="">Benutzerdefiniert</option>
                  </select>
                  <MaterialFields material={material} setMaterial={setMaterial} />
                  <div className="row mat-actions">
                    <button className="link" onClick={saveUserMaterial}>
                      <Save size={13} /> Als eigenen Werkstoff speichern
                    </button>
                    {userMaterials.some((m) => m.name === material.name) && (
                      <button className="link" onClick={() => deleteUserMaterial(material.name)}>
                        <Trash2 size={13} /> löschen
                      </button>
                    )}
                  </div>
                  <ProofFields proof={proof} setProof={setProof} />
                  <Calibration material={material} setMaterial={setMaterial} />
                  <label className="check">
                    <input type="checkbox" checked={!!material.layered} onChange={(e) => setMaterial({ ...material, layered: e.target.checked, name: material.layered === e.target.checked ? material.name : 'Benutzerdefiniert' })} />
                    3D-Druck: Schichtaufbau berücksichtigen
                  </label>
                  {material.layered && (
                    <PrintOrientation
                      material={material}
                      setMaterial={(m) => setMaterial(m)}
                      picking={bedPick}
                      onPick={() => { setActive(null); setDrawing(null); setGeoPick(false); setBedPick(!bedPick) }}
                      canCompare={problems.length === 0 && !busy}
                      onCompare={onCompareOrientations}
                      orientations={orientations?.key === orientationKey() ? orientations.rows : null}
                      hasResult={!!result}
                      onScan={async () => {
                        try {
                          setBusy('Bewerte Aufbaurichtungen …')
                          return await api.orientationScan(materialPayload(material))
                        } catch (e) {
                          setError(String(e))
                          return null
                        } finally {
                          setBusy(null)
                        }
                      }}
                      onUse={(d) => { const m = { ...material, buildDir: d }; setMaterial(m); onSolve(m) }}
                    />
                  )}
                  {material.layered && <InfillFields material={material} setMaterial={setMaterial} />}
                </Section>
              )}

              {mesh && (
                <Section n={4} title="Lager" done={supports.length > 0 && supports.every((s) => s.surfaces.length)}>
                  {supports.map((s, i) => {
                    const f = supportFix(s)
                    const isActive = active?.id === s.id
                    return (
                      <div key={s.id} className={'item' + (isActive ? ' active support' : '')}>
                        <div className="item-head">
                          <Anchor size={14} color={SUPPORT_ACTIVE} />
                          <strong>Lager {i + 1}</strong>
                          <span className="spacer" />
                          <button className="icon-btn" title="Löschen" onClick={() => { setSupports(supports.filter((x) => x.id !== s.id)); if (isActive) setActive(null) }}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <select value={s.kind} onChange={(e) => setSupports(supports.map((x) => (x.id === s.id ? { ...x, kind: e.target.value } : x)))}>
                          <option value="fixed">Fest eingespannt</option>
                          <option value="frictionless">Reibungsfreie Auflage / Symmetrie</option>
                          <option value="axes">Richtungen einzeln sperren</option>
                          <option value="cylindrical">Zylindrische Lagerung (Bolzen/Gelenk)</option>
                        </select>
                        {s.kind === 'cylindrical' && (
                          <>
                            <div className="row axes">
                              {[['radial', 'radial fest'], ['axial', 'axial fest'], ['tangential', 'Drehung gesperrt']].map(([k, lab]) => (
                                <label key={k} className="check">
                                  <input
                                    type="checkbox"
                                    checked={{ radial: true, axial: true, tangential: false, ...s.cyl }[k]}
                                    onChange={(e) => setSupports(supports.map((x) => (x.id === s.id ? { ...x, cyl: { radial: true, axial: true, tangential: false, ...x.cyl, [k]: e.target.checked } } : x)))}
                                  />
                                  {lab}
                                </label>
                              ))}
                            </div>
                            <p className="hint">
                              Bohrung oder Bolzen wählen. Standard = Gelenk: Das Bauteil bleibt am Bolzen, kann sich aber um die Achse drehen
                              {!(s.cyl?.tangential ?? false) && ' – ein zweites Lager muss die Drehung verhindern'}.
                            </p>
                          </>
                        )}
                        {s.kind === 'frictionless' && (
                          <p className="hint">Senkrecht zur Fläche gesperrt, entlang der Fläche frei – auch auf schrägen Flächen.</p>
                        )}
                        {s.kind === 'axes' && (
                          <div className="row axes">
                            {['x', 'y', 'z'].map((a) => (
                              <label key={a} className="check">
                                <input type="checkbox" checked={s.axes[a]} onChange={(e) => setSupports(supports.map((x) => (x.id === s.id ? { ...x, axes: { ...x.axes, [a]: e.target.checked } } : x)))} />
                                {a} gesperrt
                              </label>
                            ))}
                          </div>
                        )}
                        <RegionEditor
                          item={s}
                          cyl={selectionCylinder(s.surfaces, surfaceInfo)}
                          drawing={drawing?.id === s.id ? drawing : null}
                          onStart={(shape) => startDrawing('support', s, shape)}
                          onCancel={() => setDrawing(null)}
                          onChange={(region) => updateItem('support', s.id, { region })}
                        />
                        <PickButton active={isActive} count={s.surfaces.length} onClick={() => { setDrawing(null); setActive(isActive ? null : { type: 'support', id: s.id }) }} />
                        {f.error && s.surfaces.length > 0 && <p className="error-text">{f.error}</p>}
                      </div>
                    )
                  })}
                  <button className="btn wide" onClick={() => { const s = newSupport(); setSupports([...supports, s]); setActive({ type: 'support', id: s.id }) }}>
                    <Plus size={15} /> Lager hinzufügen
                  </button>
                </Section>
              )}

              {mesh && (
                <Section n={5} title="Lasten" done={loads.length > 0 && loads.every((l) => l.surfaces.length)}>
                  {loads.map((l, i) => {
                    const isActive = active?.id === l.id
                    const upd = (patch) => setLoads(loads.map((x) => (x.id === l.id ? { ...x, ...patch } : x)))
                    const n = loadNormal(l)
                    const cyl = selectionCylinder(l.surfaces, surfaceInfo)
                    return (
                      <div key={l.id} className={'item' + (isActive ? ' active load' : '')}>
                        <div className="item-head">
                          <ArrowDownToLine size={14} color={LOAD_ACTIVE} />
                          <strong>Last {i + 1}</strong>
                          <span className="spacer" />
                          <button className="icon-btn" title="Löschen" onClick={() => { setLoads(loads.filter((x) => x.id !== l.id)); if (isActive) setActive(null) }}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <select value={l.kind} onChange={(e) => upd({ kind: e.target.value })}>
                          {Object.entries(LOAD_KINDS).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                        {l.kind === 'moment' ? (
                          <>
                            <VectorInput
                              item={l}
                              field="moment"
                              labels={['Mx', 'My', 'Mz']}
                              unit="N·m"
                              upd={upd}
                              picking={dirPick?.id === l.id && dirPick.key === 'moment'}
                              onPick={() => { setActive(null); setDrawing(null); setAim(null); setDirPick(dirPick ? null : { id: l.id, key: 'moment' }) }}
                              aiming={aim?.id === l.id && aim.field === 'moment'}
                              onAimToggle={() => startAim(l.id, 'moment')}
                              presets={cyl ? [['um die Wellenachse (Torsion)', cyl.axis]] : []}
                            />
                            <p className="hint">Wirkt um den Schwerpunkt des Bereichs, linear verteilt wie bei einem starren Anschlussteil. Drehsinn nach der rechten Hand.</p>
                          </>
                        ) : l.kind === 'flow' ? (
                          <>
                            <div className="grid3">
                              <label className="field">
                                <span>Medium</span>
                                <select value={l.medium ?? 'luft'} onChange={(e) => upd({ medium: e.target.value })}>
                                  {Object.entries(MEDIA).map(([k, [lab]]) => (
                                    <option key={k} value={k}>
                                      {lab}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <NumField label="Geschwindigkeit" unit="m/s" value={l.velocity} onChange={(v) => upd({ velocity: v })} />
                              <NumField label="c_w" value={l.cw} onChange={(v) => upd({ cw: v })} />
                            </div>
                            {l.medium === 'eigen' && <NumField label="Dichte" unit="kg/m³" value={l.rhoFluid} onChange={(v) => upd({ rhoFluid: v })} />}
                            <VectorInput
                              item={l}
                              field="flowDir"
                              labels={['x', 'y', 'z']}
                              unit=""
                              upd={upd}
                              picking={false}
                              onPick={() => {}}
                              aiming={aim?.id === l.id && aim.field === 'flowDir'}
                              onAimToggle={() => startAim(l.id, 'flowDir')}
                              presets={[]}
                            />
                            <button className="link" onClick={() => upd({ surfaces: (mesh?.surfaces ?? []).map((x) => x.tag) })}>
                              Alle Außenflächen wählen
                            </button>
                            <p className="hint">
                              Staudruck × c_w = {fmt(flowPressurePa(l))} Pa auf alle angeströmten Flächen (Richtung = Strömungsrichtung). Überschlägig: keine Sogseite,
                              keine Umströmung; c_w z. B. Platte quer 1,2, Zylinder 1,0, Kugel 0,5. Für genaue Strömungslasten wäre eine CFD-Rechnung nötig.
                            </p>
                          </>
                        ) : l.kind === 'bearing' ? (
                          <>
                            <VectorInput
                              item={l}
                              field="force"
                              labels={['Fx', 'Fy', 'Fz']}
                              unit="N"
                              upd={upd}
                              picking={dirPick?.id === l.id && dirPick.key === 'force'}
                              onPick={() => { setActive(null); setDrawing(null); setAim(null); setDirPick(dirPick ? null : { id: l.id, key: 'force' }) }}
                              aiming={aim?.id === l.id && aim.field === 'force'}
                              onAimToggle={() => startAim(l.id, 'force')}
                              presets={[]}
                            />
                            <p className="hint">Kraft, mit der Bolzen bzw. Lager auf das Bauteil drücken. Sie wirkt nur auf der Hälfte, gegen die gedrückt wird (Druck ∝ cos φ).</p>
                          </>
                        ) : l.kind === 'force' ? (
                          <>
                            <VectorInput
                              item={l}
                              field="force"
                              labels={['Fx', 'Fy', 'Fz']}
                              unit="N"
                              upd={upd}
                              picking={dirPick?.id === l.id && dirPick.key === 'force'}
                              onPick={() => { setActive(null); setDrawing(null); setAim(null); setDirPick(dirPick ? null : { id: l.id, key: 'force' }) }}
                              aiming={aim?.id === l.id && aim.field === 'force'}
                              onAimToggle={() => startAim(l.id, 'force')}
                              presets={n ? [['senkrecht auf die gewählte Fläche', n.map((v) => -v)]] : []}
                            />
                          </>
                        ) : (
                          <NumField label="Druck (positiv = drückt auf die Fläche)" unit="MPa" value={l.pressure} onChange={(v) => upd({ pressure: v })} />
                        )}
                        <RegionEditor
                          item={l}
                          cyl={cyl}
                          drawing={drawing?.id === l.id ? drawing : null}
                          onStart={(shape) => startDrawing('load', l, shape)}
                          onCancel={() => setDrawing(null)}
                          onChange={(region) => upd({ region })}
                        />
                        <PickButton active={isActive} count={l.surfaces.length} onClick={() => { setDrawing(null); setActive(isActive ? null : { type: 'load', id: l.id }) }} />
                      </div>
                    )
                  })}
                  <button className="btn wide" onClick={() => { const l = newLoad(); setLoads([...loads, l]); setActive({ type: 'load', id: l.id }) }}>
                    <Plus size={15} /> Last hinzufügen
                  </button>
                </Section>
              )}

              {mesh && (
                <div className="solve">
                  <div className="row analysis-row">
                    <div className="segmented small">
                      {[['static', 'Statik'], ['modal', 'Eigenfrequenzen'], ['buckling', 'Knicken']].map(([k, l]) => (
                        <button key={k} className={analysis === k ? 'on' : ''} onClick={() => setAnalysis(k)}>
                          {l}
                        </button>
                      ))}
                    </div>
                    {analysis !== 'static' && (
                      <label className="field mini">
                        <div className="input-unit">
                          <input value={modeCount} onChange={(e) => setModeCount(e.target.value)} title="Anzahl Moden" />
                          <em>Moden</em>
                        </div>
                      </label>
                    )}
                  </div>
                  <button className="btn primary wide big" disabled={problems.length > 0 || !!busy} onClick={() => (analysis === 'static' ? onSolve() : onModes())}>
                    <Play size={16} /> {analysis === 'static' ? 'Rechnen' : analysis === 'modal' ? 'Eigenfrequenzen rechnen' : 'Knicklasten rechnen'}
                  </button>
                  {analysis === 'buckling' && <p className="hint">Knicklast = Lastfaktor × aufgebrachte Lasten (lineares Beulen/Knicken, ohne Imperfektionen).</p>}
                  <label className="check">
                    <input type="checkbox" checked={cadAuto} onChange={(e) => setCadAuto(e.target.checked)} /> Neue Version aus dem CAD automatisch neu rechnen
                  </label>
                  {problems.length > 0 && (
                    <ul className="todo">
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          ) : view === 'frame' ? (
            <FrameSidebar
              frame={frame}
              setFrame={setFrame}
              results={frameResults}
              onSolve={onFrameSolve}
              busy={!!busy}
              display={frameDisplay}
              setDisplay={setFrameDisplay}
              onSave={() => api.saveBlob(new Blob([JSON.stringify({ format: 'projekt-fem-stabwerk', version: 1, ...frame }, null, 2)], { type: 'application/json' }), 'stabwerk.stab.json', 'Stabwerk', 'json').catch((e) => setError(String(e)))}
              onOpen={async () => {
                try {
                  const d = await api.openJson('Stabwerk', 'json')
                  if (!d) return
                  if (d.format !== 'projekt-fem-stabwerk') throw new Error('Keine Stabwerk-Datei')
                  const { format, version, ...rest } = d // eslint-disable-line no-unused-vars
                  setFrame({ ...newFrame(), ...rest })
                } catch (e) {
                  setError(String(e))
                }
              }}
            />
          ) : view === 'study' ? (
            <StudyPanel
              study={study}
              setStudy={setStudy}
              params={studyParams}
              rows={studyRows}
              canRun={problems.length === 0 && !busy}
              onRun={runStudy}
              onCsv={exportStudyCsv}
            />
          ) : view === 'geometry' ? (
            <GeometryPanel
              ops={geoOps}
              setOps={setGeoOps}
              pending={geoPending}
              info={geoInfo}
              warnings={geoWarnings}
              picking={geoPick}
              onPick={() => { setDrawing(null); setGeoPick(!geoPick) }}
              drawing={drawing?.type === 'geo' ? drawing : null}
              onDraw={(op) => { setGeoPick(false); setDrawing({ type: 'geo', id: op.id, shape: op.shape }) }}
              onCancelDraw={() => setDrawing(null)}
              onApply={onApplyGeometry}
              busy={!!busy}
              modified={!!geoStep}
              topo={topo}
              setTopo={setTopo}
              onTopo={onTopo}
              onTopoThreshold={onTopoThreshold}
              canTopo={supports.length > 0 && loads.length > 0 && problems.length === 0}
              onTopoStl={() => api.exportTopoStl(topo.threshold, (stepPath ?? 'bauteil').split(/[\\/]/).pop().replace(/\.(step|stp)$/i, '') + '_leichtbau.stl').catch((e) => setError(String(e)))}
              onExport={() => api.exportStep(geoStep, (stepPath ?? 'geometrie').split(/[\\/]/).pop().replace(/\.(step|stp)$/i, '') + '_geaendert.step').catch((e) => setError(String(e)))}
              mesh={mesh}
            />
          ) : showModes ? (
            <ModesPanel modes={modes} setModes={setModes} loads={loads} />
          ) : (
            result && (
              <ResultPanel
                result={result}
                material={material}
                quantity={quantity}
                setQuantity={setQuantity}
                deform={deform}
                setDeform={setDeform}
                display={display}
                showMesh={showMesh}
                setShowMesh={setShowMesh}
                stale={resultStale}
                onExport={onExportVtu}
                onReport={onReport}
                onMathpad={onExportMathpad}
                cut={cut}
                setCut={setCut}
                proof={proof}
                reference={reference}
                current={summary(result, mesh, geoStep ? 'Geändert' : 'Aktuell')}
                onPin={() => setReference(summary(result, mesh, geoStep ? 'Geändert' : 'Vorher'))}
                onUnpin={() => setReference(null)}
              />
            )
          )}
        </aside>

        <section className="stage">
          {view === 'frame' && <FrameView frame={frame} results={frameResults} display={frameDisplay} />}
          {!mesh && !busy && view !== 'frame' && (
            <div className="empty">
              <Layers size={40} strokeWidth={1.4} />
              <h2>Bauteil öffnen</h2>
              <p>STEP-Datei aus deinem CAD laden (Einheit mm). Danach Werkstoff, Lager und Lasten festlegen und rechnen.</p>
              <button className="btn primary" onClick={onOpenStep} disabled={!gmsh}>
                <FileUp size={15} /> STEP-Datei öffnen
              </button>
            </div>
          )}
          <Viewport
            ref={viewRef}
            mesh={mesh}
            mode={mode}
            surfaceTint={surfaceTint}
            pickable={((!!active || !!dirPick || bedPick) && view === 'setup') || (geoPick && view === 'geometry')}
            layers={material.layered && mode !== 'result' ? { dir: material.buildDir ?? [0, 0, 1] } : null}
            onPick={onPick}
            result={display}
            showMesh={showMesh}
            arrows={view === 'setup' ? arrows : []}
            markers={mode === 'result' ? markers : []}
            onProbe={setProbe}
            drawing={view === 'setup' || view === 'geometry' ? drawing?.shape : null}
            planeNormal={planeNormal}
            onDraw={onDraw}
            overlays={overlays}
            topoShape={view === 'geometry' && topo?.show ? topo.surface : null}
            aim={view === 'setup' ? aimView : null}
            onAim={onAim}
          />
          {aim && aimView && view === 'setup' && (
            <div className="pick-hint aim-bar">
              <Move3d size={15} />
              <span>Griff am Pfeil ziehen</span>
              <div className="segmented small">
                {[['free', 'Frei'], ['xy', 'XY'], ['yz', 'YZ'], ['xz', 'XZ']].map(([k, lab]) => (
                  <button key={k} className={aim.plane === k ? 'on' : ''} onClick={() => setAim({ ...aim, plane: k })} title={k === 'free' ? 'Frei im Raum' : `nur in der Ebene ${lab}`}>
                    {lab}
                  </button>
                ))}
              </div>
              <span className="aim-angle">{aimAngleText(aimView.dir, aim.plane)}</span>
              <span className="muted small">Umschalt = stufenlos</span>
              <button className="btn small" onClick={() => setAim(null)}>
                <Check size={14} /> Fertig
              </button>
            </div>
          )}
          {dirPick && view === 'setup' && (
            <div className="pick-hint">
              <MousePointerClick size={15} />
              Fläche anklicken: Richtung senkrecht darauf (ebene Fläche) oder entlang der Achse (Bohrung/Welle)
              <button className="btn small" onClick={() => setDirPick(null)}>
                <X size={14} /> Abbrechen
              </button>
            </div>
          )}
          {bedPick && view === 'setup' && (
            <div className="pick-hint">
              <MousePointerClick size={15} />
              Fläche anklicken, die auf dem Druckbett liegt
              <button className="btn small" onClick={() => setBedPick(false)}>
                <X size={14} /> Abbrechen
              </button>
            </div>
          )}
          {geoPick && view === 'geometry' && (
            <div className="pick-hint">
              <MousePointerClick size={15} />
              Radius- oder Bohrungsfläche anklicken
              <button className="btn small" onClick={() => setGeoPick(false)}>
                <X size={14} /> Abbrechen
              </button>
            </div>
          )}
          {drawing && (view === 'setup' || view === 'geometry') && (
            <div className="pick-hint">
              <PenLine size={15} />
              {drawing.shape === 'band'
                ? 'Auf der Welle/Bohrung drücken und entlang der Achse ziehen (quer ziehen = nur ein Winkelbereich)'
                : `${SHAPES[drawing.shape]} auf die Fläche zeichnen: drücken und ziehen`}
              <button className="btn small" onClick={() => setDrawing(null)}>
                <X size={14} /> Abbrechen
              </button>
            </div>
          )}
          {active && view === 'setup' && (
            <div className="pick-hint">
              <MousePointerClick size={15} />
              Flächen anklicken, um sie {active.type === 'support' ? 'dem Lager' : 'der Last'} hinzuzufügen oder zu entfernen
              <button className="btn small" onClick={() => setActive(null)}>
                <Check size={14} /> Fertig
              </button>
            </div>
          )}
          {mode === 'result' && display && (
            <Legend display={display} quantity={display.modal ? { label: modes.kind === 'modal' ? 'Schwingform' : 'Knickform', unit: '', hint: 'relativ' } : QUANTITIES[quantity]} />
          )}
          {mode === 'result' && probe && display && (
            <div className="probe">
              <button className="icon-btn" onClick={() => setProbe(null)}>
                <X size={14} />
              </button>
              <div className="probe-title">Messpunkt</div>
              <div>{QUANTITIES[quantity].label}: <strong>{fmt(display.values[probe.node])} {QUANTITIES[quantity].unit}</strong></div>
              <div className="muted">bei {fmtVec([0, 1, 2].map((k) => mesh.positions[3 * probe.node + k]))} mm (unverformt)</div>
            </div>
          )}
          {busy && (
            <div className="busy">
              <Loader2 size={22} className="spin" />
              <div className="busy-text">
                <div>{busy}</div>
                {progressInfo && <div className="busy-detail">{progressInfo.text}</div>}
                {progressInfo?.fraction != null && (
                  <div className="progress-bar">
                    <div style={{ width: `${Math.round(100 * progressInfo.fraction)}%` }} />
                  </div>
                )}
              </div>
            </div>
          )}
          {notice && (
            <div className="toast notice-toast">
              <Check size={16} />
              <span>{notice}</span>
              <button className="icon-btn" onClick={() => setNotice(null)}>
                <X size={14} />
              </button>
            </div>
          )}
          {error && (
            <div className="toast error">
              <TriangleAlert size={16} />
              <span>{error}</span>
              <button className="icon-btn" onClick={() => setError(null)}>
                <X size={14} />
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// Kennwerte eines Ergebnisses für den Vergleich vorher/nachher
function summary(result, mesh, label) {
  return { label, vm: result.max_von_mises.value, u: result.max_displacement.value, safety: result.safety, volume: mesh?.volume ?? null }
}

function Compare({ reference, current, onUnpin }) {
  const rows = [
    ['σv max', 'vm', 'MPa', -1],
    ['u max', 'u', 'mm', -1],
    ['Sicherheit', 'safety', '', 1],
    ['Volumen', 'volume', 'cm³', -1],
  ]
  const val = (o, k) => (k === 'volume' && o[k] != null ? o[k] / 1000 : o[k])
  return (
    <div className="compare">
      <div className="item-head">
        <strong>Vergleich</strong>
        <span className="spacer" />
        <button className="icon-btn" title="Vergleich beenden" onClick={onUnpin}>
          <X size={14} />
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>{reference.label}</th>
            <th>{current.label}</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([lab, k, unit, better]) => {
            const a = val(reference, k)
            const b = val(current, k)
            if (a == null || b == null) return null
            const d = a ? (b - a) / Math.abs(a) : 0
            const cls = Math.abs(d) < 0.001 ? '' : d * better > 0 ? 'good' : 'bad'
            return (
              <tr key={k}>
                <td>{lab}</td>
                <td>{fmt(a)} {unit}</td>
                <td>{fmt(b)} {unit}</td>
                <td className={cls}>{d > 0 ? '+' : ''}{(100 * d).toFixed(1).replace('.', ',')} %</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ResultPanel({ result, material, quantity, setQuantity, deform, setDeform, display, showMesh, setShowMesh, stale, onExport, onReport, onMathpad, reference, current, onPin, onUnpin, cut, setCut, proof }) {
  const rho = Number(material.rho)
  const massG = rho > 0 ? (result.solid_volume / 1000) * rho : null
  const sf = result.safety
  const sfClass = sf == null ? '' : sf >= 1.5 ? 'good' : sf >= 1 ? 'ok' : 'bad'
  const balance = Math.hypot(...result.total_load.map((v, k) => v + result.total_reaction[k]))
  const loadMag = Math.hypot(...result.total_load) || 1
  return (
    <>
      {stale && (
        <div className="notice warn">
          <TriangleAlert size={16} />
          <div>Das Modell wurde geändert. Das Ergebnis gehört noch zum vorherigen Stand – neu rechnen.</div>
        </div>
      )}
      {reference && !stale ? (
        <Compare reference={reference} current={current} onUnpin={onUnpin} />
      ) : (
        !reference && (
          <button className="link" onClick={onPin}>
            Dieses Ergebnis zum Vergleichen merken
          </button>
        )
      )}
      {sf != null && (
        <div className={'safety ' + sfClass}>
          <CircleGauge size={22} />
          <div>
            <div className="safety-value">S = {fmt(sf)}</div>
            <div className="safety-text">
              {result.governing
                ? `Sicherheit mit Schichtaufbau (${material.name}, Aufbaurichtung ${dirName(material.buildDir ?? [0, 0, 1])}) – maßgeblich: ${result.governing}`
                : material.yield !== '' && material.yield != null
                  ? `Sicherheit gegen Fließen (${material.name}, Re = ${fmt(Number(material.yield))} MPa)`
                  : `Sicherheit gegen Bruch (${material.name}, Rm = ${fmt(Number(material.tensile))} MPa)`}
              {sf < 1 ? ' – Festigkeit überschritten' : ''}
              {result.safety_break != null && material.yield !== '' && material.yield != null && Math.abs(result.safety_break - sf) > 1e-6 && (
                <div>gegen Bruch (Rm): S = {fmt(result.safety_break)}</div>
              )}
            </div>
          </div>
        </div>
      )}
      <ProofCard result={result} proof={proof} />
      <div className="card">
        {massG != null && <Stat label="Masse" value={massG >= 1000 ? `${fmt(massG / 1000)} kg` : `${fmt(massG)} g`} />}
        <Stat label="max. Vergleichsspannung" value={`${fmt(result.max_von_mises.value)} MPa`} />
        <Stat label="max. Verschiebung" value={`${fmt(result.max_displacement.value)} mm`} />
        <Stat label="größte Hauptspannung σ1" value={`${fmt(result.max_sigma1.value)} MPa`} />
        <Stat label="kleinste Hauptspannung σ3" value={`${fmt(result.min_sigma3.value)} MPa`} />
      </div>
      {result.warnings.map((w) => (
        <div key={w} className="notice warn">
          <TriangleAlert size={16} />
          <div>{w}</div>
        </div>
      ))}

      <h3 className="sub">Darstellung</h3>
      <div className="quantities">
        {Object.entries(QUANTITIES).map(([k, q]) => (
          <button key={k} className={'q' + (quantity === k ? ' on' : '')} disabled={FIELD_OF[k] && FIELD_OF[k][0] !== 'von_mises' && !result[FIELD_OF[k][0]] && !['sigma1', 'sigma3'].includes(k)} onClick={() => setQuantity(k)}>
            <span>{q.label}</span>
            <em>{q.hint}</em>
          </button>
        ))}
      </div>
      <div className="field">
        <span>Verformung</span>
        <div className="segmented small">
          <button className={deform === 'off' ? 'on' : ''} onClick={() => setDeform('off')}>Aus</button>
          <button className={deform === 'true' ? 'on' : ''} onClick={() => setDeform('true')}>Echt 1:1</button>
          <button className={deform === 'auto' ? 'on' : ''} onClick={() => setDeform('auto')}>
            Überhöht{display?.auto ? ` ×${fmt(display.auto)}` : ''}
          </button>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} /> Netz anzeigen
      </label>
      <div className="cut-box">
        <label className="check">
          <input type="checkbox" checked={cut.on} onChange={(e) => setCut({ ...cut, on: e.target.checked })} /> Schnitt (ins Bauteil schauen)
        </label>
        {cut.on && (
          <>
            <div className="row">
              <div className="segmented small">
                {['X', 'Y', 'Z'].map((a, k) => (
                  <button key={a} className={cut.axis === k ? 'on' : ''} onClick={() => setCut({ ...cut, axis: k })}>
                    {a}
                  </button>
                ))}
              </div>
              <button className="btn small" onClick={() => setCut({ ...cut, flip: !cut.flip })}>
                ⇄ Seite
              </button>
            </div>
            <input type="range" className="slim-range" min={0} max={100} step={0.5} value={cut.pos} onChange={(e) => setCut({ ...cut, pos: Number(e.target.value) })} />
          </>
        )}
      </div>
      <p className="hint">Auf das Bauteil klicken, um den Wert an einer Stelle abzulesen.</p>

      <h3 className="sub">Lagerkräfte</h3>
      <div className="card">
        {result.reactions.map((r, i) => (
          <Stat key={i} label={`Lager ${i + 1}`} value={fmtVec(clean(r, loadMag)) + ' N'} />
        ))}
        <Stat
          label="Gleichgewicht"
          value={balance < 1e-6 * loadMag ? 'erfüllt' : `Abweichung ${fmt(balance)} N`}
        />
      </div>
      <p className="hint">
        {result.equations.toLocaleString('de-DE')} Unbekannte, gerechnet in {fmt(result.seconds)} s
        {result.iterations != null && ` (iterativer Löser, ${result.iterations} Iterationen)`}
      </p>
      <button className="btn wide primary" onClick={onReport} disabled={stale}>
        <Download size={15} /> Bericht als PDF
      </button>
      <button className="btn wide" onClick={onMathpad} disabled={stale}>
        <Download size={15} /> Nach MathPad (.mathpad)
      </button>
      <button className="btn wide" onClick={onExport}>
        <Download size={15} /> Ergebnis für ParaView exportieren (.vtu)
      </button>
    </>
  )
}

// Rundungsrauschen (z. B. 3e-9 N bei 1500 N Last, iterativer Löser ~1e-7) als 0 anzeigen
function clean(v, ref) {
  return v.map((x) => (Math.abs(x) < 1e-6 * ref ? 0 : x))
}

function Section({ n, title, done, children }) {
  return (
    <section className="section">
      <h2>
        <span className={'step' + (done ? ' done' : '')}>{done ? <Check size={12} strokeWidth={3} /> : n}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function NumField({ label, unit, value, onChange }) {
  return (
    <label className="field">
      {label && <span>{label}</span>}
      <div className="input-unit">
        <input value={value} inputMode="decimal" onChange={(e) => onChange(e.target.value.replace(',', '.'))} />
        {unit && <em>{unit}</em>}
      </div>
    </label>
  )
}

// --- Eigenfrequenzen / Knicken ------------------------------------------------------------------------

function ModesPanel({ modes, setModes, loads }) {
  const modal = modes.kind === 'modal'
  const loadMag = loads.reduce((m, l) => Math.max(m, Math.hypot(...(l.kind === 'pressure' ? [0] : l.kind === 'moment' ? l.moment : l.force).map(Number))), 0)
  return (
    <>
      <section className="section">
        <h2>
          <CircleGauge size={15} /> {modal ? 'Eigenfrequenzen' : 'Knicken'}
        </h2>
        <p className="hint">
          {modal
            ? 'Frequenzen, bei denen das gelagerte Bauteil von selbst schwingt. Eine Anregung (Motor, Unwucht) in der Nähe einer Eigenfrequenz führt zu Resonanz – Abstand halten (Faustregel ± 20 %).'
            : 'Lastfaktor λ: Bei λ-facher Last knickt bzw. beult das Bauteil aus (ideal gerade, ohne Imperfektionen). Für die Auslegung deutliche Sicherheit einhalten (je nach Regelwerk λ ≥ 2–3).'}
        </p>
        <table className="orient-table modes-table">
          <thead>
            <tr>
              <th>Nr.</th>
              <th>{modal ? 'Frequenz' : 'Lastfaktor λ'}</th>
              {!modal && loadMag > 0 && <th>Knicklast</th>}
            </tr>
          </thead>
          <tbody>
            {modes.values.map((v, i) => (
              <tr key={i} className={modes.sel === i ? 'current' : ''} onClick={() => setModes({ ...modes, sel: i })}>
                <td>{i + 1}</td>
                <td>{modal ? `${fmt(v)} Hz` : fmt(v)}</td>
                {!modal && loadMag > 0 && <td>{fmt(v * loadMag)} {loads.some((l) => l.kind === 'moment') ? '' : 'N'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="check">
          <input type="checkbox" checked={modes.animate} onChange={(e) => setModes({ ...modes, animate: e.target.checked })} /> Form animieren
        </label>
        <p className="hint">
          Zeile anklicken, um die Form zu zeigen. Die Größe der Auslenkung ist frei gewählt (nur die Form zählt). Gerechnet in {fmt(modes.seconds)} s.
        </p>
      </section>
    </>
  )
}

// --- Parameterstudie --------------------------------------------------------------------------------

const STUDY_METRICS = {
  vm: { label: 'max. Vergleichsspannung', short: 'Spannung', unit: 'MPa' },
  u: { label: 'max. Verschiebung', short: 'Verformung', unit: 'mm' },
  safety: { label: 'Sicherheit', short: 'Sicherheit', unit: '' },
  mass: { label: 'Masse', short: 'Masse', unit: 'g' },
}

// Liniendiagramm einer Messreihe (Wert über Parameter), Werte beim Darüberfahren
function StudyChart({ rows, metric, param }) {
  const [hover, setHover] = useState(null)
  const pts = rows.filter((r) => r[metric] != null && Number.isFinite(r[metric]))
  if (pts.length < 2) return <p className="hint">Für das Diagramm mindestens zwei Werte.</p>
  const W = 300, H = 170, L = 44, R = 10, T = 10, B = 30
  const xs = pts.map((r) => r.value)
  const ys = pts.map((r) => r[metric])
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  const pad = (y1 - y0) * 0.1 || Math.abs(y1) * 0.1 || 1
  y0 -= pad
  y1 += pad
  const sx = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R)
  const sy = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B)
  const sorted = pts.map((r, i) => [r.value, r[metric], i]).sort((a, b) => a[0] - b[0])
  const path = sorted.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')
  const ticks = [0, 0.5, 1].map((t) => y0 + t * (y1 - y0))
  const m = STUDY_METRICS[metric]
  return (
    <svg className="study-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.label} über ${param.label}`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} className="grid" />
          <text x={L - 5} y={sy(t) + 3} className="tick" textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {sorted.map(([x]) => (
        <text key={'x' + x} x={sx(x)} y={H - B + 14} className="tick" textAnchor="middle">
          {fmt(x)}
        </text>
      ))}
      <text x={(L + W - R) / 2} y={H - 3} className="axis" textAnchor="middle">
        {param.label} {param.unit && `[${param.unit}]`}
      </text>
      <path d={path} className="line" />
      {sorted.map(([x, y, i]) => (
        <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <circle cx={sx(x)} cy={sy(y)} r={12} className="hit" />
          <circle cx={sx(x)} cy={sy(y)} r={hover === i ? 5.5 : 4} className="dot" />
        </g>
      ))}
      {hover != null && (() => {
        const r = pts[hover]
        const x = Math.min(Math.max(sx(r.value), L + 50), W - R - 50)
        return (
          <g>
            <rect x={x - 50} y={T} width={100} height={30} rx={4} className="tip" />
            <text x={x} y={T + 12} textAnchor="middle" className="tip-text">
              {fmt(r.value)} {param.unit}
            </text>
            <text x={x} y={T + 25} textAnchor="middle" className="tip-text strong">
              {fmt(r[metric])} {m.unit}
            </text>
          </g>
        )
      })()}
    </svg>
  )
}

function StudyPanel({ study, setStudy, params, rows, canRun, onRun, onCsv }) {
  const [metric, setMetric] = useState('vm')
  const param = params.find((p) => p.key === study.param) ?? params[0]
  const defaults = { mesh: '4; 3; 2; 1,5', infill: '10; 20; 40; 60; 100' }
  return (
    <>
      <section className="section">
        <h2>
          <Layers size={15} /> Parameterstudie
        </h2>
        <p className="hint">
          Rechnet dasselbe Modell für mehrere Werte eines Parameters. Die Netzstudie zeigt, ob eine Spannung belastbar ist: Bleibt sie bei feinerem
          Netz gleich, passt es; wächst sie immer weiter, ist es eine Singularität (Lagerkante, scharfe Ecke). Geometriemaße erscheinen hier, sobald im
          Reiter Geometrie eine Änderung angelegt ist.
        </p>
        <label className="field">
          <span>Parameter</span>
          <select
            value={param.key}
            onChange={(e) => setStudy({ param: e.target.value, values: defaults[e.target.value] ?? study.values })}
          >
            {params.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Werte {param.unit && `[${param.unit}]`}, getrennt mit Semikolon</span>
          <input value={study.values} onChange={(e) => setStudy({ ...study, values: e.target.value })} />
        </label>
        <button className="btn primary wide" disabled={!canRun} onClick={onRun} title={canRun ? '' : 'Erst Lager und Lasten im Reiter Modell festlegen'}>
          <Play size={15} /> Studie starten
        </button>
      </section>
      {rows && (
        <section className="section">
          <h2>Ergebnis: {rows.param.label}</h2>
          <div className="segmented small">
            {Object.entries(STUDY_METRICS).map(([k, m]) => (
              <button key={k} className={metric === k ? 'on' : ''} onClick={() => setMetric(k)}>
                {m.short}
              </button>
            ))}
          </div>
          <StudyChart rows={rows.rows} metric={metric} param={rows.param} />
          <table className="orient-table">
            <thead>
              <tr>
                <th>{rows.param.unit || 'Wert'}</th>
                <th>σv max</th>
                <th>u max</th>
                <th>S</th>
                <th>Elem.</th>
              </tr>
            </thead>
            <tbody>
              {rows.rows.map((r) => (
                <tr key={r.value}>
                  <td>{fmt(r.value)}</td>
                  <td>{fmt(r.vm)}</td>
                  <td>{fmt(r.u)}</td>
                  <td>{fmt(r.safety)}</td>
                  <td>{r.elements.toLocaleString('de-DE')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn wide" onClick={onCsv}>
            <Download size={15} /> Tabelle als CSV (Excel)
          </button>
        </section>
      )}
    </>
  )
}

// --- Werkstoff ------------------------------------------------------------------------------------

function MaterialFields({ material: m, setMaterial }) {
  const set = (k) => (v) => setMaterial({ ...m, [k]: v, name: 'Benutzerdefiniert' })
  if (!m.layered) {
    return (
      <>
        <div className="grid3">
          <NumField label="E-Modul" unit="MPa" value={m.E} onChange={set('E')} />
          <NumField label="ν" value={m.nu} onChange={set('nu')} />
          <NumField label="Dichte" unit="g/cm³" value={m.rho ?? ''} onChange={set('rho')} />
        </div>
        <div className="grid3">
          <NumField label="Re / Rp0,2" unit="MPa" value={m.yield ?? ''} onChange={set('yield')} />
          <NumField label="Rm" unit="MPa" value={m.tensile ?? ''} onChange={set('tensile')} />
        </div>
      </>
    )
  }
  const row = (label, a, b) => (
    <>
      <span className="mat-label">{label}</span>
      <NumField unit="MPa" value={m[a] ?? ''} onChange={set(a)} />
      <NumField unit="MPa" value={m[b] ?? ''} onChange={set(b)} />
    </>
  )
  return (
    <>
      <div className="mat-table">
        <span />
        <span className="mat-head">in der Schicht (XY)</span>
        <span className="mat-head">quer zu den Schichten (Z)</span>
        {row('E-Modul', 'E', 'E_z')}
        {row('Re / Rp0,2', 'yield', 'yield_z')}
        {row('Rm', 'tensile', 'tensile_z')}
      </div>
      <div className="grid3">
        <NumField label="ν" value={m.nu} onChange={set('nu')} />
        <NumField label="Dichte" unit="g/cm³" value={m.rho ?? ''} onChange={set('rho')} />
      </div>
      <p className="hint">
        Re/Rp leer lassen, wenn es keine ausgeprägte Streckgrenze gibt (Kunststoffe) – dann wird mit Rm gerechnet. Richtwerte gelten für
        100 % Füllung; bei weniger Füllung bzw. wenigen Wandlinien sind die Werte deutlich kleiner.
      </p>
    </>
  )
}

// Festigkeitsnachweis: erforderliche Sicherheiten, zulässige Verformung
function ProofFields({ proof, setProof }) {
  const set = (k) => (v) => setProof({ ...proof, [k]: v })
  return (
    <div className="print-orient">
      <span className="mat-head">Festigkeitsnachweis – erforderlich:</span>
      <div className="grid3">
        <NumField label="Sicherheit Fließen" value={proof.sF} onChange={set('sF')} />
        <NumField label="Sicherheit Bruch" value={proof.sB} onChange={set('sB')} />
        <NumField label="Verformung max." unit="mm" value={proof.uMax} onChange={set('uMax')} />
      </div>
      <p className="hint">Typisch: Stahl statisch 1,5 / 2,0; Kunststoff- und Druckteile eher 2–3. Leer = nicht prüfen.</p>
    </div>
  )
}

function proofRows(result, proof) {
  const rows = []
  const sF = Number(proof.sF)
  const sB = Number(proof.sB)
  const uMax = Number(proof.uMax)
  if (sF > 0 && result.safety != null) rows.push(['Fließen / Festigkeit', result.safety, sF, sF / result.safety])
  if (sB > 0 && result.safety_break != null) rows.push(['Bruch (Rm)', result.safety_break, sB, sB / result.safety_break])
  if (uMax > 0) rows.push(['Verformung', result.max_displacement.value, uMax, result.max_displacement.value / uMax])
  return rows
}

function ProofCard({ result, proof }) {
  const rows = proofRows(result, proof)
  if (!rows.length) return null
  const ok = rows.every((r) => r[3] <= 1)
  return (
    <div className={'proof ' + (ok ? 'good' : 'bad')}>
      <div className="item-head">
        {ok ? <Check size={15} /> : <TriangleAlert size={15} />}
        <strong>Festigkeitsnachweis {ok ? 'erfüllt' : 'nicht erfüllt'}</strong>
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>vorhanden</th>
            <th>erforderlich</th>
            <th>Ausnutzung</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([lab, have, need, a]) => (
            <tr key={lab}>
              <td>{lab}</td>
              <td>{lab === 'Verformung' ? `${fmt(have)} mm` : `S = ${fmt(have)}`}</td>
              <td>{lab === 'Verformung' ? `≤ ${fmt(need)} mm` : `≥ ${fmt(need)}`}</td>
              <td className={a <= 1 ? 'good' : 'bad'}>{(100 * a).toFixed(0)} %</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.warnings.some((w) => w.includes('direkt an einem Lager')) && (
        <p className="hint">Achtung: Die höchste Spannung liegt an einem Lager (Singularität) – dort ist der Nachweis nicht aussagekräftig.</p>
      )}
    </div>
  )
}

// Werte aus einem eigenen Zugversuch übernehmen (Rm, Rp0,2, E)
function Calibration({ material, setMaterial }) {
  const [open, setOpen] = useState(false)
  const [v, setV] = useState({ b: '10', h: '4', L0: '50', Fmax: '', Fp: '', F1: '', dL1: '', dir: 'xy' })
  const set = (k) => (x) => setV({ ...v, [k]: x })
  const A = Number(v.b) * Number(v.h)
  const rm = Number(v.Fmax) > 0 && A > 0 ? Number(v.Fmax) / A : null
  const rp = Number(v.Fp) > 0 && A > 0 ? Number(v.Fp) / A : null
  const e = Number(v.F1) > 0 && Number(v.dL1) > 0 && A > 0 ? Number(v.F1) / A / (Number(v.dL1) / Number(v.L0)) : null
  const round = (x) => Number(x.toPrecision(4))
  const apply = () => {
    const z = material.layered && v.dir === 'z'
    const patch = { name: 'Benutzerdefiniert (kalibriert)' }
    if (rm != null) patch[z ? 'tensile_z' : 'tensile'] = round(rm)
    if (rp != null) patch[z ? 'yield_z' : 'yield'] = round(rp)
    if (e != null) patch[z ? 'E_z' : 'E'] = round(e)
    setMaterial({ ...material, ...patch })
    setOpen(false)
  }
  if (!open)
    return (
      <button className="link" onClick={() => setOpen(true)}>
        Werte aus eigenem Zugversuch übernehmen …
      </button>
    )
  return (
    <div className="calib">
      <div className="item-head">
        <strong>Kalibrierung aus Zugversuch</strong>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="grid3">
        <NumField label="Breite b" unit="mm" value={v.b} onChange={set('b')} />
        <NumField label="Dicke h" unit="mm" value={v.h} onChange={set('h')} />
        <NumField label="Messlänge L₀" unit="mm" value={v.L0} onChange={set('L0')} />
      </div>
      <div className="grid3">
        <NumField label="Höchstkraft" unit="N" value={v.Fmax} onChange={set('Fmax')} />
        <NumField label="Kraft bei Rp0,2" unit="N" value={v.Fp} onChange={set('Fp')} />
      </div>
      <div className="grid3">
        <NumField label="Kraft F₁" unit="N" value={v.F1} onChange={set('F1')} />
        <NumField label="Verlängerung bei F₁" unit="mm" value={v.dL1} onChange={set('dL1')} />
      </div>
      {material.layered && (
        <div className="segmented small">
          <button className={v.dir === 'xy' ? 'on' : ''} onClick={() => set('dir')('xy')}>
            liegend gedruckt (XY)
          </button>
          <button className={v.dir === 'z' ? 'on' : ''} onClick={() => set('dir')('z')}>
            stehend gedruckt (Z)
          </button>
        </div>
      )}
      <p className="hint">
        Ergebnis: Rm {rm != null ? fmt(rm) : '–'} MPa · Rp0,2 {rp != null ? fmt(rp) : '–'} MPa · E {e != null ? fmt(e) : '–'} MPa. F₁ und Verlängerung aus
        dem geraden Anfangsteil der Kurve. Probe am besten mit 100 % Füllung drucken – dann gelten die Werte für den Werkstoff, und Wände/Infill
        rechnet das Programm selbst.
      </p>
      <button className="btn wide" disabled={rm == null && rp == null && e == null} onClick={apply}>
        <Check size={15} /> Übernehmen
      </button>
    </div>
  )
}

function InfillFields({ material, setMaterial }) {
  const inf = { ...DEFAULT_INFILL, ...(material.infill ?? {}) }
  const set = (patch) => setMaterial({ ...material, infill: { ...inf, ...patch } })
  const t = shellThickness(inf)
  const f = infillFractions(inf.pattern, inf.percent)
  return (
    <div className="print-orient">
      <label className="check">
        <input type="checkbox" checked={!!inf.on} onChange={(e) => set({ on: e.target.checked })} />
        Wände und Infill berücksichtigen (sonst massiv)
      </label>
      {inf.on && (
        <>
          <div className="grid3">
            <label className="field" style={{ gridColumn: 'span 2' }}>
              <span>Füllmuster</span>
              <select value={inf.pattern} onChange={(e) => set({ pattern: e.target.value })}>
                {Object.entries(INFILL_PATTERNS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <NumField label="Füllgrad" unit="%" value={inf.percent} onChange={(v) => set({ percent: v })} />
          </div>
          <input type="range" className="slim-range" min={0} max={100} step={5} value={Number(inf.percent) || 0} onChange={(e) => set({ percent: e.target.value })} />
          <div className="grid3">
            <NumField label="Wände" value={inf.walls} onChange={(v) => set({ walls: v })} />
            <NumField label="Linienbreite" unit="mm" value={inf.lineWidth} onChange={(v) => set({ lineWidth: v })} />
            <NumField label="Schichthöhe" unit="mm" value={inf.layerHeight} onChange={(v) => set({ layerHeight: v })} />
          </div>
          <div className="grid3">
            <NumField label="Deckschichten" value={inf.top} onChange={(v) => set({ top: v })} />
            <NumField label="Bodenschichten" value={inf.bottom} onChange={(v) => set({ bottom: v })} />
          </div>
          <p className="hint">
            Wand {fmt(t.wall)} mm · Deckschicht {fmt(t.top)} mm · Boden {fmt(t.bottom)} mm. Infill als Ersatzwerkstoff: E {fmt(f[0] * material.E)} /{' '}
            {fmt(f[1] * material.E_z)} MPa, Rm {fmt(f[2] * Number(material.tensile || material.yield))} / {fmt(f[3] * Number(material.tensile_z || material.yield_z))} MPa (in der
            Schicht / quer). Näherungswerte je Muster – für genaue Ergebnisse mit einem eigenen Zugstab kalibrieren.
          </p>
          <label className="check">
            <input type="checkbox" checked={inf.refine !== false} onChange={(e) => set({ refine: e.target.checked })} />
            Netz an der Oberfläche auf Wandstärke verfeinern (genauer, rechnet länger)
          </label>
        </>
      )}
    </div>
  )
}

// Richtung als Text: Achse (±X/Y/Z) oder Winkel
function dirLabel(d) {
  const k = [0, 1, 2].find((i) => Math.abs(Math.abs(d[i]) - 1) < 1e-3)
  if (k != null) return (d[k] > 0 ? '+' : '−') + 'XYZ'[k]
  const a = anglesOf(d)
  return `${fmt(Number(a.a))}° / ${fmt(Number(a.b))}°`
}

function OrientationScan({ onScan, onUse, current }) {
  const [rows, setRows] = useState(null)
  const [sort, setSort] = useState('safety')
  const list = useMemo(() => {
    if (!rows) return []
    const total = rows.reduce((m, r) => Math.max(m, r.overhang_area + r.bed_area), 1)
    const key = {
      safety: (r) => -(r.safety ?? 0),
      support: (r) => r.overhang_area - 1e-6 * (r.safety ?? 0),
      // Kompromiss: Sicherheit abgewertet um den Anteil Stützfläche
      both: (r) => -(r.safety ?? 0) * (1 - (0.5 * r.overhang_area) / total),
    }[sort]
    const sorted = [...rows].sort((a, b) => key(a) - key(b))
    const picked = []
    for (const r of sorted) {
      if (picked.every((p) => p.dir[0] * r.dir[0] + p.dir[1] * r.dir[1] + p.dir[2] * r.dir[2] < Math.cos((20 * Math.PI) / 180))) picked.push(r)
      if (picked.length >= 6) break
    }
    return picked
  }, [rows, sort])
  return (
    <>
      <button className="btn wide" onClick={async () => setRows(await onScan())}>
        <Move3d size={15} /> Aufbaurichtung optimieren (alle Richtungen)
      </button>
      {rows && (
        <>
          <div className="segmented small">
            {[['safety', 'Sicherheit'], ['support', 'wenig Stützmaterial'], ['both', 'Kompromiss']].map(([k, l]) => (
              <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
                {l}
              </button>
            ))}
          </div>
          <table className="orient-table">
            <thead>
              <tr>
                <th>Richtung</th>
                <th>S ≈</th>
                <th>Stütze</th>
                <th>Höhe</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i}>
                  <td title={`Aufbaurichtung (${r.dir.map((v) => fmt(v)).join(' / ')})`}>{dirLabel(r.dir)}</td>
                  <td className={r.safety >= 1.5 ? 'good' : r.safety >= 1 ? 'ok' : 'bad'}>
                    {fmt(r.safety)}
                    {r.layer_governs ? '*' : ''}
                  </td>
                  <td>{fmt(r.overhang_area / 100)} cm²</td>
                  <td>{fmt(r.height)} mm</td>
                  <td>
                    <button className="link" onClick={() => onUse(r.dir)}>
                      prüfen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            S ≈ aus den Spannungen der letzten Rechnung abgeschätzt (* = Schichthaftung maßgeblich); „prüfen“ rechnet die Richtung voll nach.
            Stütze = Fläche mit Überhang über 45°. Winkelangabe: Winkel in XY / Neigung zu XY. Aktuell: {dirLabel(current)}.
          </p>
        </>
      )}
    </>
  )
}

function PrintOrientation({ material, setMaterial, picking, onPick, canCompare, onCompare, orientations, onUse, hasResult, onScan }) {
  const dir = material.buildDir ?? [0, 0, 1]
  const isDir = (d) => Math.abs(Math.abs(d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) - 1) < 1e-6
  return (
    <div className="print-orient">
      <div className="field">
        <span>Aufbaurichtung (Z des Druckers)</span>
        <div className="row">
          <div className="segmented small">
            {BUILD_DIRS.map(([lab, d]) => (
              <button key={lab} className={isDir(d) ? 'on' : ''} onClick={() => setMaterial({ ...material, buildDir: d })}>
                {lab}
              </button>
            ))}
          </div>
          <button className="btn small" title="Bauteil auf den Kopf stellen (wichtig für Überhänge)" onClick={() => setMaterial({ ...material, buildDir: dir.map((v) => (v === 0 ? 0 : -v)) })}>
            ⇅ Umdrehen
          </button>
          <button className={'link' + (picking ? ' on' : '')} onClick={onPick}>
            <MousePointerClick size={13} /> {picking ? 'Auswahl abbrechen' : 'Fläche aufs Druckbett legen'}
          </button>
        </div>
        <p className="hint">Aufbaurichtung {dirLabel(dir)}. Rot markierte Flächen hängen über (über 45°) und brauchen Stützmaterial.</p>
      </div>
      <button className="btn wide" disabled={!canCompare} onClick={onCompare} title={canCompare ? '' : 'Erst Lager und Lasten festlegen'}>
        <Layers size={15} /> Aufbaurichtung vergleichen (X / Y / Z)
      </button>
      {hasResult ? (
        <OrientationScan onScan={onScan} onUse={onUse} current={dir} />
      ) : (
        <p className="hint">Nach einer Rechnung lässt sich die Aufbaurichtung auch frei optimieren (alle Richtungen, mit Stützmaterial).</p>
      )}
      {orientations && (
        <table className="orient-table">
          <thead>
            <tr>
              <th>Richtung</th>
              <th>Sicherheit</th>
              <th>maßgeblich</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orientations.map((r, i) => (
              <tr key={i} className={isDir(r.dir) ? 'current' : ''}>
                <td>
                  {dirName(r.dir)}
                  {i === 0 && ' ★'}
                </td>
                <td className={r.safety >= 1.5 ? 'good' : r.safety >= 1 ? 'ok' : 'bad'}>{fmt(r.safety)}</td>
                <td>{r.governing ?? '–'}</td>
                <td>
                  {!isDir(r.dir) && (
                    <button className="link" onClick={() => onUse(r.dir)}>
                      übernehmen
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// --- Geometrie anpassen -------------------------------------------------------------------------

const OP_ICONS = { fillet: Spline, hole: CircleDot, add: SquarePlus, cut: SquareMinus }

function TopoSection({ topo, setTopo, onTopo, onTopoThreshold, canTopo, onTopoStl }) {
  const [vf, setVf] = useState('40')
  const [iters, setIters] = useState('30')
  const [radius, setRadius] = useState('')
  const h = topo?.view?.history
  return (
    <section className="section">
      <h2>
        <Spline size={15} /> Leichtbau-Vorschlag
      </h2>
      <p className="hint">
        Topologieoptimierung: Bei gleichen Lagern und Lasten wird das Material so verteilt, dass das Teil mit weniger Material möglichst steif bleibt.
        Flächen mit Lagern und Lasten bleiben voll. Ergebnis als Vorlage für die Konstruktion (STL).
      </p>
      <div className="grid3">
        <NumField label="Material behalten" unit="%" value={vf} onChange={setVf} />
        <NumField label="Durchläufe" value={iters} onChange={setIters} />
        <NumField label="Filterradius" unit="mm" value={radius} onChange={setRadius} />
      </div>
      <p className="hint">Filterradius leer = 2,5 × Elementgröße (größer = gröbere, einfachere Form).</p>
      <button
        className="btn wide"
        disabled={!canTopo}
        title={canTopo ? '' : 'Erst Lager und Lasten im Reiter Modell festlegen'}
        onClick={() => onTopo({ volume_fraction: Number(vf) / 100, iterations: Number(iters) || 30, filter_radius: Number(radius) || 0 })}
      >
        <Play size={15} /> Form berechnen
      </button>
      {topo && (
        <>
          <label className="check">
            <input type="checkbox" checked={topo.show} onChange={(e) => setTopo({ ...topo, show: e.target.checked })} /> Form im Bild zeigen
          </label>
          <div className="field">
            <span>
              Schwellwert {fmt(topo.threshold)} – sichtbar {fmt(100 * (topo.surface?.volume_fraction ?? 0))} % des Volumens
            </span>
            <input type="range" className="slim-range" min={0.1} max={0.9} step={0.05} value={topo.threshold} onChange={(e) => onTopoThreshold(Number(e.target.value))} />
          </div>
          {h?.length > 1 && (
            <p className="hint">
              {h.length} Durchläufe. Nachgiebigkeit {fmt(h[0][0])} → {fmt(h[h.length - 1][0])} N·mm bei {fmt(100 * h[h.length - 1][1])} % Material (kleiner = steifer).
            </p>
          )}
          <button className="btn wide" onClick={onTopoStl}>
            <Download size={15} /> Form als STL speichern
          </button>
        </>
      )}
    </section>
  )
}

function GeometryPanel({ ops, setOps, pending, info, warnings, picking, onPick, drawing, onDraw, onCancelDraw, onApply, busy, modified, onExport, mesh, topo, setTopo, onTopo, onTopoThreshold, canTopo, onTopoStl }) {
  const upd = (id, patch) => setOps(ops.map((o) => (o.id === id ? { ...o, ...patch } : o)))
  const addSketch = (op, shape) => {
    const o = newSketchOp(op, shape)
    setOps([...ops, o])
    onDraw(o)
  }
  const problems = ops.filter((o) => o.enabled).map((o) => opProblem(o)).filter(Boolean)
  return (
    <>
      <section className="section">
        <h2>
          <Wrench size={15} /> Geometrie anpassen
        </h2>
        <p className="hint">
          Für schnelle Abschätzungen „was wäre, wenn“: Radien und Bohrungen ändern, Material hinzufügen oder entfernen. Lager und
          Lasten bleiben erhalten. Die Änderungen gehen nicht ins CAD – bei Bedarf die geänderte STEP-Datei speichern.
        </p>
        <div className="tool-grid">
          <button className={'btn' + (picking ? ' on' : '')} onClick={onPick}>
            <Spline size={15} /> Radius / Bohrung
          </button>
          <div className="tool-split">
            <span>
              <SquarePlus size={15} /> Material hinzu
            </span>
            <button className="btn small" onClick={() => addSketch('add', 'rect')}>Rechteck</button>
            <button className="btn small" onClick={() => addSketch('add', 'circle')}>Kreis</button>
          </div>
          <div className="tool-split">
            <span>
              <SquareMinus size={15} /> Material weg
            </span>
            <button className="btn small" onClick={() => addSketch('cut', 'rect')}>Rechteck</button>
            <button className="btn small" onClick={() => addSketch('cut', 'circle')}>Kreis</button>
          </div>
        </div>
      </section>

      {ops.length > 0 && (
        <section className="section">
          <h2>Änderungen</h2>
          {ops.map((o, i) => {
            const Icon = OP_ICONS[o.op]
            const prob = opProblem(o)
            const isDrawing = drawing?.id === o.id
            return (
              <div key={o.id} className={'item' + (isDrawing ? ' active load' : '') + (o.enabled ? '' : ' disabled')}>
                <div className="item-head">
                  <input type="checkbox" title="Änderung an/aus" checked={o.enabled} onChange={(e) => upd(o.id, { enabled: e.target.checked })} />
                  <Icon size={14} />
                  <strong>
                    {i + 1}. {GEO_OPS[o.op]}
                  </strong>
                  <span className="spacer" />
                  <button className="icon-btn" title="Löschen" onClick={() => { setOps(ops.filter((x) => x.id !== o.id)); if (isDrawing) onCancelDraw() }}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {o.op === 'fillet' && (
                  <>
                    <NumField label={`Radius (vorher R${fmt(o.was)})`} unit="mm" value={o.radius} onChange={(v) => upd(o.id, { radius: v })} />
                    <p className="hint">{o.convex ? 'Außenkante' : 'Innenradius (Kehle)'}, Achse {axisLabel(o.axis)}. 0 = scharfe Kante.</p>
                  </>
                )}
                {o.op === 'hole' && (
                  <>
                    <NumField label={`Durchmesser (vorher Ø${fmt(o.was)})`} unit="mm" value={o.diameter} onChange={(v) => upd(o.id, { diameter: v })} />
                    <p className="hint">0 = Bohrung schließen.</p>
                  </>
                )}
                {(o.op === 'add' || o.op === 'cut') && (
                  <>
                    {isDrawing ? (
                      <p className="hint draw">{o.shape === 'circle' ? 'Kreis' : 'Rechteck'} im Bild auf eine Fläche zeichnen: drücken und ziehen …</p>
                    ) : o.sketch ? (
                      <>
                        <div className="grid3">
                          {['Mitte x', 'Mitte y', 'Mitte z'].map((lab, k) => (
                            <NumField key={lab} label={lab} unit="mm" value={o.sketch.center[k]} onChange={(v) => upd(o.id, { sketch: { ...o.sketch, center: o.sketch.center.map((c, j) => (j === k ? v : c)) } })} />
                          ))}
                        </div>
                        <div className="grid3">
                          {o.sketch.shape === 'circle' ? (
                            <NumField label="Durchmesser" unit="mm" value={2 * o.sketch.radius} onChange={(v) => upd(o.id, { sketch: { ...o.sketch, radius: Number(v) / 2 } })} />
                          ) : (
                            <>
                              <NumField label="Breite" unit="mm" value={o.sketch.width} onChange={(v) => upd(o.id, { sketch: { ...o.sketch, width: v } })} />
                              <NumField label="Länge" unit="mm" value={o.sketch.height} onChange={(v) => upd(o.id, { sketch: { ...o.sketch, height: v } })} />
                            </>
                          )}
                          {o.op === 'add' ? (
                            <NumField label="Höhe" unit="mm" value={o.height} onChange={(v) => upd(o.id, { height: v })} />
                          ) : (
                            !o.through && <NumField label="Tiefe" unit="mm" value={o.depth} onChange={(v) => upd(o.id, { depth: v })} />
                          )}
                        </div>
                        {o.op === 'cut' && (
                          <label className="check">
                            <input type="checkbox" checked={o.through} onChange={(e) => upd(o.id, { through: e.target.checked })} /> durch alles
                          </label>
                        )}
                        <button className="link" onClick={() => onDraw(o)}>
                          <PenLine size={13} /> Neu zeichnen
                        </button>
                      </>
                    ) : (
                      <button className="link" onClick={() => onDraw(o)}>
                        <PenLine size={13} /> Skizze zeichnen
                      </button>
                    )}
                  </>
                )}
                {prob && !isDrawing && <p className="error-text">{prob}</p>}
              </div>
            )
          })}
        </section>
      )}

      {warnings.length > 0 && (
        <div className="notice warn">
          <TriangleAlert size={16} />
          <div>{warnings.join(' · ')}</div>
        </div>
      )}

      <div className="solve">
        <button className="btn primary wide big" disabled={busy || !pending} onClick={onApply}>
          <Check size={16} /> {pending ? 'Änderungen anwenden' : modified ? 'Änderungen angewendet' : 'Keine Änderungen'}
        </button>
        {problems.length > 0 && <p className="hint">Unvollständige Änderungen werden übersprungen: {problems.join(', ')}.</p>}
        {info && (
          <p className="hint">
            Volumen {fmt(info.volume_before / 1000)} → {fmt(info.volume_after / 1000)} cm³ ({info.volume_after >= info.volume_before ? '+' : ''}
            {fmt((100 * (info.volume_after - info.volume_before)) / info.volume_before)} %). Danach im Reiter Modell rechnen – das Ergebnis wird
            mit dem vorherigen verglichen.
          </p>
        )}
        {modified && (
          <div className="row">
            <button className="btn wide" onClick={onExport}>
              <Download size={15} /> Geänderte STEP speichern
            </button>
            <button className="btn" title="Alle Änderungen ausschalten" onClick={() => setOps(ops.map((o) => ({ ...o, enabled: false })))}>
              <RotateCcw size={15} /> Original
            </button>
          </div>
        )}
        {mesh && <p className="hint">{mesh.elements.toLocaleString('de-DE')} Elemente im aktuellen Netz.</p>}
      </div>
      <TopoSection topo={topo} setTopo={setTopo} onTopo={onTopo} onTopoThreshold={onTopoThreshold} canTopo={canTopo} onTopoStl={onTopoStl} />
    </>
  )
}

// --- Netzgröße per Schieberegler (logarithmisch, links grob, rechts fein) ----------------------

function niceSize(h) {
  const d = h >= 10 ? 0 : h >= 1 ? 1 : 2
  return Number(h.toFixed(d))
}

function MeshSlider({ mesh, diag, value, onChange }) {
  const hMax = diag / 8
  const hMin = diag / 300
  const toT = (h) => Math.round((1000 * Math.log(h / hMax)) / Math.log(hMin / hMax))
  const toH = (t) => hMax * Math.pow(hMin / hMax, t / 1000)
  const h = Number(value) > 0 ? Number(value) : mesh.mesh_size
  const t = Math.min(1000, Math.max(0, toT(h)))
  // Hochrechnung aus dem aktuellen Netz (Elementzahl ~ 1/h³)
  const ratio = Math.pow(mesh.mesh_size / h, 3)
  const unknowns = 3 * mesh.nodes * ratio
  const elems = mesh.elements * ratio
  const round = (x) => (x >= 1e6 ? `${fmt(x / 1e6)} Mio.` : Number(x.toPrecision(2)).toLocaleString('de-DE'))
  return (
    <div className="mesh-slider">
      <input type="range" min={0} max={1000} value={t} onChange={(e) => onChange(String(niceSize(toH(Number(e.target.value)))))} />
      <div className="slider-labels">
        <span>grob</span>
        <span>fein</span>
      </div>
      {Number(value) > 0 && Math.abs(h - mesh.mesh_size) > 1e-9 && (
        <p className={'hint' + (unknowns > 3e6 ? ' warn-text' : '')}>
          Etwa {round(elems)} Elemente, {round(unknowns)} Unbekannte
          {unknowns > 3e6 ? ' – sehr fein: Rechnung dauert mehrere Minuten und braucht viel Arbeitsspeicher (≈ 2,5 GB je Mio. Unbekannte).' : ''}
        </p>
      )}
    </div>
  )
}

// --- Vektoreingabe: Komponenten oder Betrag + Richtung -----------------------------------------

const deg = Math.PI / 180
const r2 = (x) => Math.round(x * 100) / 100 || 0

/// Winkel einer Richtung: α in der XY-Ebene ab +X, β Neigung zur XY-Ebene (+ = Richtung +Z)
function anglesOf(v) {
  const len = Math.hypot(...v) || 1
  const [x, y, z] = v.map((c) => c / len)
  const b = Math.asin(Math.max(-1, Math.min(1, z))) / deg
  let a = Math.abs(Math.abs(b) - 90) < 1e-9 ? 0 : r2(Math.atan2(y, x) / deg)
  if (a <= -180) a += 360 // −180° und 180° sind dieselbe Richtung
  return { a: String(a), b: String(r2(b)) }
}

/// Zustand der Richtungseingabe (aus dem Vektor, falls noch keiner gespeichert ist)
function dirUi(vec, ui) {
  if (ui) return ui
  const v = vec.map(Number)
  const mag = Math.hypot(...v)
  return { mode: 'xyz', mag: String(Number(mag.toPrecision(6)) || ''), ...anglesOf(mag ? v : [0, 0, -1]) }
}

/// Betrag für eine neue Richtung: aktueller Betrag (aus den Komponenten, falls so eingegeben), sonst 1000
function currentMag(vec, ui) {
  if (ui.mode === 'dir' && Number(ui.mag)) return ui.mag
  return String(Number(Math.hypot(...vec.map(Number)).toPrecision(6)) || 1000)
}

function vectorOf(ui) {
  const m = Number(ui.mag) || 0
  const a = Number(ui.a) * deg
  const b = Number(ui.b) * deg
  return [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)].map((c) => {
    const v = Number((m * c).toPrecision(6))
    return Math.abs(v) < 1e-9 * Math.max(m, 1) ? 0 : v
  })
}

// Anzeige der Pfeilrichtung beim Ausrichten
function aimAngleText(dir, plane) {
  const len = Math.hypot(...dir) || 1
  const [x, y, z] = dir.map((c) => c / len)
  const f = (v) => `${Math.round(v * 10) / 10 || 0}°`
  if (plane === 'xy') return `${f(Math.atan2(y, x) / deg)} von +X`
  if (plane === 'yz') return `${f(Math.atan2(z, y) / deg)} von +Y`
  if (plane === 'xz') return `${f(Math.atan2(z, x) / deg)} von +X`
  const a = anglesOf(dir)
  return `Winkel in XY ${f(Number(a.a))}, Neigung ${f(Number(a.b))}`
}

const AXIS_BUTTONS = [['+X', [1, 0, 0]], ['−X', [-1, 0, 0]], ['+Y', [0, 1, 0]], ['−Y', [0, -1, 0]], ['+Z', [0, 0, 1]], ['−Z', [0, 0, -1]]]

function VectorInput({ item, field, labels, unit, upd, picking, onPick, presets, aiming, onAimToggle }) {
  const vec = item[field]
  const ui = dirUi(vec, item[field + 'Ui'])
  const setUi = (patch) => {
    const next = { ...ui, ...patch }
    upd({ [field + 'Ui']: next, [field]: next.mode === 'dir' ? vectorOf(next) : vec })
  }
  const setDir = (v) => setUi(anglesOf(v))
  const switchMode = (mode) => {
    if (mode === 'dir') {
      const v = vec.map(Number)
      const mag = Math.hypot(...v)
      setUi({ mode, mag: String(Number(mag.toPrecision(6)) || ui.mag || 1000), ...(mag ? anglesOf(v) : {}) })
    } else upd({ [field + 'Ui']: { ...ui, mode } })
  }
  return (
    <div className="vector">
      <div className="segmented small">
        <button className={ui.mode !== 'dir' ? 'on' : ''} onClick={() => switchMode('xyz')}>
          Komponenten
        </button>
        <button className={ui.mode === 'dir' ? 'on' : ''} onClick={() => switchMode('dir')}>
          Betrag + Richtung
        </button>
      </div>
      {ui.mode !== 'dir' ? (
        <div className="grid3">
          {labels.map((lab, k) => (
            <NumField key={lab} label={lab} unit={unit} value={vec[k]} onChange={(v) => upd({ [field]: vec.map((f, j) => (j === k ? v : f)) })} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid3">
            <NumField label="Betrag" unit={unit} value={ui.mag} onChange={(v) => setUi({ mag: v })} />
            <NumField label="Winkel in XY" unit="°" value={ui.a} onChange={(v) => setUi({ a: v })} />
            <NumField label="Neigung zu XY" unit="°" value={ui.b} onChange={(v) => setUi({ b: v })} />
          </div>
          <div className="dir-buttons">
            {AXIS_BUTTONS.map(([lab, v]) => (
              <button key={lab} className="btn small" onClick={() => setDir(v)}>
                {lab}
              </button>
            ))}
            <button className="btn small" title="Richtung umkehren" onClick={() => setDir(vectorOf({ ...ui, mag: 1 }).map((c) => -c))}>
              ⇄ Umkehren
            </button>
          </div>
          <p className="hint">
            = {labels.map((lab, k) => `${lab} ${fmt(vec[k])}`).join('  ·  ')} {unit}
          </p>
        </>
      )}
      <div className="dir-links">
        <button className={'link' + (aiming ? ' on' : '')} onClick={onAimToggle}>
          <Move3d size={13} /> {aiming ? 'Ausrichten beenden' : 'Im Bild ausrichten (Pfeil ziehen)'}
        </button>
        <button className={'link' + (picking ? ' on' : '')} onClick={onPick}>
          <MousePointerClick size={13} /> {picking ? 'Auswahl abbrechen' : 'Richtung im Bild wählen'}
        </button>
        {presets.map(([lab, v]) => (
          <button
            key={lab}
            className="link"
            onClick={() => {
              const next = { ...ui, mode: 'dir', mag: currentMag(vec, ui), ...anglesOf(v) }
              upd({ [field + 'Ui']: next, [field]: vectorOf(next) })
            }}
          >
            Richtung: {lab}
          </button>
        ))}
      </div>
    </div>
  )
}

// Lesezeichen für die Lesezeichenleiste (React lässt javascript:-Links nicht zu → Attribut direkt setzen)
function Bookmarklet({ code, children }) {
  return (
    <a
      className="bookmarklet"
      ref={(el) => el?.setAttribute('href', code)}
      onClick={(e) => {
        e.preventDefault()
        window.alert('In die Lesezeichenleiste des Browsers ziehen (nicht anklicken). Danach im offenen Onshape-Teilestudio anklicken.')
      }}
      title="In die Lesezeichenleiste ziehen"
    >
      {children}
    </a>
  )
}

const bookmarkletCode = (base, key, path) =>
  `javascript:void(window.open('${base}/${path}?k=${key}&url='+encodeURIComponent(location.href),'projekt-fem','width=600,height=420'))`

// CAD-Verbindung: Add-ins, Onshape-Schlüssel und -Lesezeichen
function CadButton({ onError }) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState(null)
  const [net, setNet] = useState(null)
  const [access, setAccess] = useState('')
  const [secret, setSecret] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    if (!open) return
    api.cadInfo().then(setInfo).catch(onError)
    if (api.isDesktop) api.serverStatus().then(setNet).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const saveKeys = async (a, s) => {
    try {
      const ok = await api.onshapeSetKeys(a, s)
      setInfo({ ...info, onshape: ok })
      setAccess('')
      setSecret('')
      setMsg(ok ? 'Onshape-Schlüssel gespeichert' : 'Onshape-Schlüssel entfernt')
    } catch (e) {
      onError(e)
    }
  }
  const fetchUrl = async () => {
    setBusy('Hole Teilestudio aus Onshape …')
    setMsg(null)
    try {
      const inc = await api.onshapeImport(url)
      setMsg(`„${inc.name}“ geholt – wird geöffnet`)
      setUrl('')
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy(null)
    }
  }
  // Einstellungsdatei für Add-ins auf einem anderen Rechner (Desktop: nur mit Heimnetz-Freigabe)
  const remoteBase = info && (api.isDesktop ? net?.running && net.urls?.[0] && new URL(net.urls[0]).origin : info.web)
  const remote = remoteBase ? `adresse = ${remoteBase}/api/cad\nschluessel = ${info.key}` : null
  const [copied, setCopied] = useState(false)
  const copySettings = () => {
    navigator.clipboard?.writeText(remote + '\n')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  // Adressen, unter denen die Lesezeichen Projekt-FEM erreichen
  const targets = []
  if (info) {
    if (api.isDesktop) {
      targets.push(['dieser Rechner', `http://127.0.0.1:${info.localPort}/cad`])
      if (net?.running && net.urls?.[0]) targets.push(['andere Rechner im Heimnetz', new URL(net.urls[0]).origin + '/api/cad'])
    } else targets.push([null, info.web + '/api/cad'])
  }
  return (
    <div className="share">
      <button className="btn ghost" onClick={() => setOpen(!open)} title="Verbindung zu Onshape, Fusion 360, SolidWorks, NX, Solid Edge">
        <Cable size={15} /> CAD
      </button>
      {open && (
        <div className="share-panel cad-panel">
          <div className="item-head">
            <strong>CAD-Verbindung</strong>
            <span className="spacer" />
            <button className="icon-btn" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <p className="hint">
            Knöpfe im CAD: <b>In Projekt-FEM rechnen</b> schickt das aktive Teil hierher (gleiches Teil: Lager und Lasten bleiben, es
            wird neu gerechnet), <b>Ergebnis holen</b> trägt Sicherheit, Spannung, Verformung und Masse als Eigenschaften ins Teil ein.
            Add-ins für Fusion 360, SolidWorks, NX und Solid Edge: Ordner <code>cad-addins</code> im Projekt, Anleitung dort.
          </p>
          {api.isDesktop && net && !net.running && (
            <p className="hint">CAD auf einem anderen Rechner? Dann zusätzlich die Heimnetz-Freigabe einschalten.</p>
          )}
          {remote && (
            <>
              <p className="hint">
                {api.isDesktop ? 'CAD auf einem anderen Rechner im Heimnetz' : 'CAD auf diesem Rechner'}: Datei{' '}
                <code>projekt-fem-cad.txt</code> im Benutzerordner anlegen ({api.isDesktop ? 'dort' : 'hier'}), Inhalt:
              </p>
              <div className="share-url">
                <code className="cad-settings">{remote}</code>
                <button className="icon-btn" title="Kopieren" onClick={copySettings}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </>
          )}
          <div className="cad-section">
            <strong>Onshape</strong>
            {info && (
              <span className={info.onshape ? 'ok-text' : 'warn-text'}>
                {info.onshape ? ' API-Schlüssel hinterlegt' : ' API-Schlüssel fehlen'}
              </span>
            )}
          </div>
          <p className="hint">
            Schlüssel anlegen unter <code>dev-portal.onshape.com</code> → API keys (Rechte: lesen, für „Ergebnis → Onshape“ auch
            schreiben). Sie bleiben auf dem rechnenden Rechner.
          </p>
          <div className="grid2">
            <label className="field">
              <span>Access Key</span>
              <input value={access} onChange={(e) => setAccess(e.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              <span>Secret Key</span>
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <div className="row">
            <button className="btn" disabled={!access.trim() || !secret.trim()} onClick={() => saveKeys(access, secret)}>
              <Check size={14} /> Speichern
            </button>
            {info?.onshape && (
              <button className="btn ghost" onClick={() => saveKeys('', '')}>
                <Trash2 size={14} /> Entfernen
              </button>
            )}
          </div>
          {info?.onshape && (
            <>
              <p className="hint">Lesezeichen in die Lesezeichenleiste ziehen, dann im offenen Onshape-Teilestudio anklicken:</p>
              {targets.map(([label, base]) => (
                <div key={base} className="bookmarks">
                  {label && <span className="hint">{label}:</span>}
                  <Bookmarklet code={bookmarkletCode(base, info.key, 'onshape')}>→ Projekt-FEM</Bookmarklet>
                  <Bookmarklet code={bookmarkletCode(base, info.key, 'onshape_result')}>FEM-Ergebnis → Onshape</Bookmarklet>
                </div>
              ))}
              <label className="field">
                <span>oder Adresse des Teilestudios einfügen</span>
                <div className="row">
                  <input value={url} placeholder="https://cad.onshape.com/documents/…" onChange={(e) => setUrl(e.target.value)} />
                  <button className="btn" disabled={!url.trim() || !!busy} onClick={fetchUrl}>
                    {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Holen
                  </button>
                </div>
              </label>
            </>
          )}
          {msg && <p className="hint cad-msg">{msg}</p>}
        </div>
      )}
    </div>
  )
}

// Heimnetz-Freigabe: Oberfläche für andere Rechner im Browser bereitstellen
function ShareButton({ onError }) {
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState(null)
  const [copied, setCopied] = useState(null)
  useEffect(() => {
    api.serverStatus().then(setSt).catch(() => {})
  }, [open])
  const run = (p) => p.then(setSt).catch(onError)
  const copy = (u) => {
    navigator.clipboard?.writeText(u)
    setCopied(u)
    setTimeout(() => setCopied(null), 1500)
  }
  return (
    <div className="share">
      <button className={'btn ghost' + (st?.running ? ' share-on' : '')} onClick={() => setOpen(!open)}>
        <Wifi size={15} /> Heimnetz{st?.running ? ': an' : ''}
      </button>
      {open && st && (
        <div className="share-panel">
          <div className="item-head">
            <strong>Im Heimnetz freigeben</strong>
            <span className="spacer" />
            <button className="icon-btn" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <p className="hint">
            Andere Rechner (Laptop, Arbeits-PC) öffnen Projekt-FEM dann im Browser. Gerechnet wird auf diesem Rechner. Der Link
            enthält einen Zugangsschlüssel – nur an eigene Geräte geben.
          </p>
          <label className="check">
            <input type="checkbox" checked={st.running} onChange={(e) => run(e.target.checked ? api.serverStart() : api.serverStop())} />
            Freigabe aktiv (Port {st.port})
          </label>
          <label className="check">
            <input type="checkbox" checked={st.autostart} onChange={(e) => run(api.serverConfigure({ autostart: e.target.checked }))} />
            Beim Start von Projekt-FEM automatisch freigeben
          </label>
          {st.running && (
            <>
              <div className="share-urls">
                {st.urls.map((u) => (
                  <div key={u} className="share-url">
                    <code>{u}</code>
                    <button className="icon-btn" title="Kopieren" onClick={() => copy(u)}>
                      {copied === u ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                ))}
              </div>
              <p className="hint">
                Der erste Link funktioniert meist überall im Heimnetz. Falls nicht: Firewall auf diesem Rechner für Port {st.port} öffnen.
              </p>
            </>
          )}
          <button className="link" onClick={() => window.confirm('Neuer Schlüssel – bisherige Links und Lesezeichen funktionieren dann nicht mehr. Fortfahren?') && run(api.serverConfigure({ newKey: true }))}>
            Neuen Zugangsschlüssel erzeugen
          </button>
        </div>
      )}
    </div>
  )
}

function RegionEditor({ item, cyl, drawing, onStart, onCancel, onChange }) {
  const r = item.region
  const shape = drawing?.shape ?? r?.shape ?? 'all'
  const set = (patch) => onChange({ ...r, ...patch })
  const vec = (key, labels) => (
    <div className="grid3">
      {labels.map((lab, k) => (
        <NumField key={lab} label={lab} unit="mm" value={r[key][k]} onChange={(v) => set({ [key]: r[key].map((x, j) => (j === k ? v : x)) })} />
      ))}
    </div>
  )
  return (
    <div className="region">
      <label className="field">
        <span>Wirkbereich</span>
        <select
          value={shape}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'all') {
              onCancel()
              onChange(null)
            } else onStart(v)
          }}
        >
          <option value="all">Ganze Fläche</option>
          {Object.entries(SHAPES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {drawing && <p className="hint draw">Im Bild auf die Fläche drücken und ziehen …</p>}
      {r && !drawing && (
        <>
          {r.shape === 'circle' && (
            <>
              {vec('center', ['Mitte x', 'Mitte y', 'Mitte z'])}
              <NumField label="Radius" unit="mm" value={r.radius} onChange={(v) => set({ radius: v })} />
            </>
          )}
          {r.shape === 'rect' && (
            <>
              {vec('center', ['Mitte x', 'Mitte y', 'Mitte z'])}
              <div className="grid3">
                <NumField label="Breite" unit="mm" value={r.width} onChange={(v) => set({ width: v })} />
                <NumField label="Höhe" unit="mm" value={r.height} onChange={(v) => set({ height: v })} />
              </div>
            </>
          )}
          {r.shape === 'band' && (
            <>
              <div className="grid3">
                <NumField label="axial von" unit="mm" value={r.start} onChange={(v) => set({ start: v })} />
                <NumField label="bis" unit="mm" value={r.end} onChange={(v) => set({ end: v })} />
              </div>
              <div className="grid3">
                <NumField label="Winkel von" unit="°" value={r.angle_from} onChange={(v) => set({ angle_from: v })} />
                <NumField label="bis" unit="°" value={r.angle_to} onChange={(v) => set({ angle_to: v })} />
              </div>
              <p className="hint">
                Axial gemessen vom Anfang der Fläche{cyl ? ` (Länge ${fmt(cyl.length)} mm, Ø ${fmt(2 * cyl.radius)} mm)` : ''}.
                0° = Richtung {axisName(r.reference) ?? 'Bezugsachse'}, Drehsinn um {axisName(r.axis) ?? 'die Achse'}.{' '}
                {Math.abs(r.angle_to - r.angle_from) < 360 && (
                  <button className="link inline" onClick={() => set({ angle_from: 0, angle_to: 360 })}>
                    Ganzer Umfang
                  </button>
                )}
              </p>
            </>
          )}
          <button className="link" onClick={() => onStart(r.shape)}>
            <PenLine size={13} /> Neu zeichnen
          </button>
        </>
      )}
    </div>
  )
}

function PickButton({ active, count, onClick }) {
  return (
    <button className={'btn pick' + (active ? ' on' : '')} onClick={onClick}>
      <MousePointerClick size={14} />
      {active ? 'Auswahl beenden' : 'Flächen wählen'}
      <span className="count">{count === 1 ? '1 Fläche' : `${count} Flächen`}</span>
    </button>
  )
}
