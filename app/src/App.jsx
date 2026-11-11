import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Save, Play, Plus, Trash2, MousePointerClick,
  TriangleAlert, Download, Grid3x3, Loader2, X, Check, Layers, CircleGauge, PenLine, Wifi, Move3d,
  Spline, SquarePlus, SquareMinus, CircleDot, Wrench, RotateCcw, Video, ChevronDown, ChevronRight, Grid2x2,
} from 'lucide-react'
import StartPage from './ui/StartPage.jsx'
import Settings from './ui/Settings.jsx'
import OnshapeLibrary from './ui/OnshapeLibrary.jsx'
import { Menu, MenuItem, MenuSep } from './ui/Menu.jsx'
import * as I from './ui/icons.jsx'
import logo from './ui/logo.svg'
import { usePref, addRecent, NAV_DEFAULT, NAV_PRESETS, DISPLAY_DEFAULT, applyTheme } from './prefs.js'
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
import CadStudio from './cad/CadStudio.jsx'
import { kernelFeatures, featuresFromGeoOps, cadParams } from './cad/features.js'

const SUPPORT_COLOR = '#5b8def'
const SUPPORT_ACTIVE = '#1f5fd6'
const LOAD_COLOR = '#f2a24a'
const LOAD_ACTIVE = '#e0700f'
const MOMENT_COLOR = '#9b4dca'
// Flächen, auf denen nur ein Teilbereich wirkt, blasser einfärben
const SUPPORT_PALE = '#b3c6ee'
const LOAD_PALE = '#f1cfa9'
// Schweißnähte: Fläche A (wird angekoppelt) und Gegenfläche B
const WELD_A = '#c2410c'
const WELD_B = '#e9a23b'
// flächige Verbindung (Baugruppe): türkis, damit sie nicht wie eine Last aussieht
const BOND_A = '#0f9f8f'
const BOND_B = '#5fd4c4'

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
const newWeld = () => ({ id: nextId++, a: [], b: [], kind: 'butt', throat: '3', maxGap: '' })
const newSupport = () => ({
  id: nextId++, kind: 'fixed', axes: { x: true, y: true, z: true }, cyl: { radial: true, axial: true, tangential: false },
  surfaces: [], region: null,
})
const newLoad = () => ({
  id: nextId++, kind: 'force', force: [0, 0, -1000], followNormal: true, pressure: 1, moment: [0, 0, 100], surfaces: [], region: null,
})

const LOAD_KINDS = {
  force: 'Kraft (gleichmäßig verteilt)',
  pressure: 'Druck',
  moment: 'Moment',
  bearing: 'Lagerlast (Bolzen/Welle, halber Umfang)',
}

// Auswahl als Symbole: Lagerarten und Lastarten
const SUPPORT_KINDS = [
  ['fixed', 'fest', I.IcFixed, 'Fest eingespannt: keine Verschiebung, keine Drehung.'],
  ['frictionless', 'gleitend', I.IcSlide, 'Gleitend / Symmetrie: senkrecht zur Fläche fest, entlang der Fläche frei – auch auf schrägen Flächen.'],
  ['cylindrical', 'Bolzen', I.IcPin, 'Bolzen / Gelenk auf einer Bohrung oder Welle: radial und axial fest, Drehung um den Bolzen frei.'],
  ['axes', 'Richtungen', I.IcAxes, 'Richtungen einzeln sperren: X, Y und Z wählbar.'],
]
const SUPPORT_NAME = { fixed: 'fest', frictionless: 'gleitend', cylindrical: 'Bolzen', axes: 'Richtungen' }
const LOAD_CHOICES = [
  ['force', 'Kraft', I.IcForce],
  ['pressure', 'Druck', I.IcPressure],
  ['moment', 'Moment', I.IcMoment],
  ['bearing', 'Bolzenlast', I.IcBearing],
]
// Festigkeitsklassen: Rp0,2 bzw. ReL, Rm [MPa], E [MPa] (ISO 898-1, ISO 3506-1)
const BOLT_CLASSES = {
  '4.6': [240, 400, 210000],
  '5.6': [300, 500, 210000],
  '8.8': [640, 800, 210000],
  '10.9': [940, 1000, 210000],
  '12.9': [1100, 1200, 210000],
  'A2-50': [210, 500, 200000],
  'A2-70': [450, 700, 200000],
  'A2-80': [600, 800, 200000],
  'A4-50': [210, 500, 200000],
  'A4-70': [450, 700, 200000],
  'A4-80': [600, 800, 200000],
}

// Schraubennachweis (Rechenkern): σ_red = √((F_S/A_s + M_b/W)² + 3·(0,5·M_G/W_p + Q/A_s)²) ≤ Rp0,2
function boltRows(result, bolts, sF = 1, fatigue = false) {
  return (result.bolts ?? []).map((r) => {
    const b = bolts.find((x) => x.name === r.name)
    const cls = b?.cls ?? '8.8'
    const [rp, rm] = BOLT_CLASSES[cls] ?? BOLT_CLASSES['8.8']
    const sv = r.sigma_red
    // Flächenpressung unter Kopf/Mutter gegen p_G, Einschraubtiefe gegen die nötige (Gewinde soll nicht vor der Schraube ausreißen)
    const pHead = r.bearing_limit ? r.bearing_pressure / r.bearing_limit : null
    const pNut = r.nut_pressure != null && r.nut_limit ? r.nut_pressure / r.nut_limit : null
    const engOk = r.engagement == null || r.engagement_min == null || r.engagement >= r.engagement_min
    const pressOk = (pHead ?? 0) <= 1 && (pNut ?? 0) <= 1
    // Dauerfestigkeit (Last schwellt 0 ↔ Betriebslast): S_D = σ_ASV / σ_a ≥ 1,2 (VDI 2230)
    const sD = r.stress_amplitude > 1e-9 ? r.fatigue_limit / r.stress_amplitude : Infinity
    const fatOk = !fatigue || sD >= 1.2
    return { ...r, cls, rp, rm, sv, safety: sv > 0 ? rp / sv : Infinity, util: sv / rp, need: boltNeed(r, sF), pHead, pNut, engOk, pressOk, sD, fatOk }
  })
}
// nötige Sicherheit: vorgespannt nach VDI 2230 σ_red ≤ Rp0,2 (S ≥ 1), sonst wie beim Bauteil
const boltNeed = (r, sF) => (r.preload > 0 ? 1 : sF)

// Regelgewinde für Schrauben von Hand
const M_SIZES = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 27, 30]

// Vorspannung: wie angezogen wird (VDI 2230)
const TIGHTEN = {
  vdi: 'Ausnutzung der Streckgrenze (VDI 2230)',
  moment: 'Anziehmoment je Schraube',
  kraft: 'Vorspannkraft je Schraube',
  none: 'ohne Vorspannung',
}
// Anziehverfahren: Anziehfaktor α_A = F_M,max/F_M,min (VDI 2230 Tab. A8, gerundet)
const TIGHTEN_METHODS = {
  nenn: ['Nennwert, ohne Streuung', 1],
  schluessel: ['Drehmomentschlüssel / Drehschrauber (α_A 1,6)', 1.6],
  winkel: ['streckgrenz- oder drehwinkelgesteuert (α_A 1,0)', 1],
  schlag: ['Schlagschrauber (α_A 3)', 3],
  eigen: ['eigener Anziehfaktor α_A', null],
}
function scatterOf(t) {
  if (t.mode === 'none') return null
  const m = TIGHTEN_METHODS[t.method ?? 'schluessel'] ?? TIGHTEN_METHODS.schluessel
  const alpha = m[1] ?? posNum(t.alpha, 1.6)
  const setting = t.setting ?? true
  return alpha > 1 || setting ? { alpha_a: Math.max(alpha, 1), setting } : null
}
const posNum = (v, d) => {
  const x = Number(String(v ?? '').replace(',', '.'))
  return String(v ?? '').trim() !== '' && x >= 0 ? x : d
}
function tightenOf(t, b) {
  if (t.mode === 'none') return null
  const mu_g = posNum(t.muG, 0.12)
  const mu_k = posNum(t.muK, 0.12)
  if (t.mode === 'moment' && posNum(b.ma, 0) > 0) return { art: 'moment', m_a: posNum(b.ma, 0), mu_g, mu_k }
  if (t.mode === 'kraft' && posNum(b.fv, 0) > 0) return { art: 'kraft', f_v: posNum(b.fv, 0) * 1000 }
  return { art: 'ausnutzung', nu: posNum(t.nu, 90) / 100, mu_g, mu_k }
}
// Reibung in der Fuge
function frictionOf(f) {
  if (f.mode === 'stick') return { art: 'haftend' }
  if (f.mode === 'free') return { art: 'coulomb', mu: 0 }
  return { art: 'coulomb', mu: posNum(f.mu, 0.15) }
}

const ANALYSES = {
  static: ['Statik', 'Spannung, Verformung, Sicherheit'],
  modal: ['Eigenfrequenzen', 'Schwingformen, Hz'],
  buckling: ['Knicken', 'Knicklast, Lastfaktor'],
}
const baseName = (p) => (p ?? '').split(/[\\/]/).pop()
const stemOf = (p) => baseName(p).replace(/\.(step|stp)$/i, '')
// Rundungsrauschen weg (−0, 1e-13)
const tidy = (x) => {
  const v = Number(Number(x).toPrecision(6))
  return Math.abs(v) < 1e-9 ? 0 : v
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
  const [welds, setWelds] = useState([])
  // Baugruppe: eigener Werkstoff je Körper (nach Körpername, bleibt bei neuer CAD-Version) und ausgeblendete Körper
  const [bodyMats, setBodyMats] = useState({})
  const [hiddenBodies, setHiddenBodies] = useState([])
  // Schrauben: aus dem CAD erkannt oder Vorschläge aus Bohrungen; Klasse und an/aus je Name (bleibt bei neuer Version)
  const [bolts, setBolts] = useState([])
  const boltPrefs = useRef({})
  const [openJoints, setOpenJoints] = useState(true)
  // Fuge mit Kontakt: Reibung; Vorspannung der Schrauben
  const [jointFric, setJointFric] = useState({ mode: 'mu', mu: '0.15' })
  // Berührflächen mit Kontakt statt verklebt (je Körperpaar nach Namen)
  const [contactPairs, setContactPairs] = useState({})
  const [tight, setTight] = useState({ mode: 'vdi', nu: '90', muG: '0.12', muK: '0.12', method: 'schluessel', alpha: '1.6', setting: true, fatigue: false })
  const [keepFasteners, setKeepFasteners] = useState(false)
  const keepFastenersRef = useRef(false)
  keepFastenersRef.current = keepFasteners
  const [selBolt, setSelBolt] = useState(null)
  // Schrauben von Hand an Bohrungen (bleiben bei neuer CAD-Version erhalten) und Auswahl-Modus „Bohrung anklicken“
  const [handBolts, setHandBolts] = useState([])
  const [boltPick, setBoltPick] = useState(false)
  // Herkunft des offenen Teils (Onshape-Adresse) – für die Parameterstudie über Onshape-Variablen
  const [partOrigin, setPartOrigin] = useState(null)
  const [gaps, setGaps] = useState({ max: '1', list: null })
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
  // Konstruktion (kleines CAD): Ausgangsteil (STEP, null = neues Teil) und Feature-Verlauf
  const [cad, setCad] = useState({ base: null, features: [] })
  const [cadApplied, setCadApplied] = useState(null) // Stand (Schlüssel), der im Rechenmodell ist
  const keepCadRef = useRef(false)
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
  const [cadAuto] = usePref('cadAuto', true)
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
  // Verformungsanimation (Laststeigerung 0 → 100 % → 0) und Videoaufnahme
  const [anim, setAnim] = useState({ on: false, speed: 1, recording: false })
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
  // Neue Oberfläche: Startseite, Auswahl im Studienbaum, Dialoge, Darstellungsleiste
  const [home, setHome] = useState(false)
  const [sel, setSel] = useState('teil')
  const [dlg, setDlg] = useState(null) // 'settings' | 'settings:cad' | 'onshape'
  const [todoOpen, setTodoOpen] = useState(null)
  const [probeOn, setProbeOn] = useState(true)
  const [minmax, setMinmax] = useState(true)
  const [iso, setIso] = useState({ on: false, above: true, t: 0.5 })
  const [detailsOpen, setDetailsOpen] = usePref('detailsOpen', true)
  const [nav] = usePref('nav', NAV_DEFAULT)
  const [look] = usePref('display', DISPLAY_DEFAULT)
  // Herkunft des offenen Teils für „Neue Version holen“ (STEP-Datei, Onshape, SolidCraft, SolidWorks …)
  const [partSource, setPartSource] = useState(null)
  useEffect(() => applyTheme(look.theme), [look.theme])

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
  }, [material, supports, loads, welds, bodyMats, bolts, openJoints, jointFric, tight, contactPairs])

  const surfaceInfo = useMemo(() => new Map((mesh?.surfaces ?? []).map((s) => [s.tag, s])), [mesh])
  // Baugruppe: Masse aus Volumen und Dichte je Körper (null = nicht ermittelbar bzw. ein Körper)
  const assemblyMass = useMemo(() => {
    if (!(mesh?.bodies?.length > 1)) return null
    let m = 0
    for (const b of mesh.bodies) {
      const rho = Number((bodyMats[b.name] ?? material).rho)
      if (!(rho > 0)) return null
      m += (b.volume / 1000) * rho
    }
    return m
  }, [mesh, bodyMats, material])
  // Schrauben aus dem Netz übernehmen; Klasse und an/aus je Name beibehalten
  useEffect(() => {
    const list = (mesh?.bolts ?? []).map((b, i) => {
      const name = b.bolt.name || `Schraube ${i + 1}`
      const prev = boltPrefs.current[name]
      return {
        id: i,
        name,
        source: b.source,
        parts: b.parts,
        bolt: b.bolt,
        cls: prev?.cls ?? b.class ?? '8.8',
        classFromName: !!b.class,
        on: prev?.on ?? b.source === 'cad',
        ma: prev?.ma ?? '',
        fv: prev?.fv ?? '',
      }
    })
    for (const [i, h] of handBolts.entries()) {
      const prev = boltPrefs.current[h.name]
      list.push({ id: 1000 + i, name: h.name, source: 'hand', parts: [], bolt: h.bolt, cls: prev?.cls ?? '8.8', on: prev?.on ?? true, ma: prev?.ma ?? '', fv: prev?.fv ?? '' })
    }
    setBolts(list)
    setSelBolt(null)
  }, [mesh, handBolts])
  useEffect(() => {
    for (const b of bolts) boltPrefs.current[b.name] = { cls: b.cls, on: b.on, ma: b.ma, fv: b.fv }
  }, [bolts])
  // Darstellung der Schrauben im Bild (Schaft + Kopf)
  const boltGlyphs = useMemo(
    () =>
      bolts
        .filter((b) => b.on || sel === 'verb')
        .map((b) => {
          const { origin: o, axis: a, head_t, head_d, nut_t, nut_d, thread_t1, d } = b.bolt
          const at = (t) => [0, 1, 2].map((k) => o[k] + a[k] * t)
          return {
            id: b.id,
            head: at(head_t),
            end: at(nut_t ?? thread_t1),
            axis: a,
            d,
            headD: head_d,
            nut: nut_t != null ? { at: at(nut_t), d: nut_d ?? 1.6 * d } : null,
            color: selBolt === b.id ? '#4c8dff' : b.on ? '#8d96a6' : '#e0b341',
            ghost: !b.on,
          }
        }),
    [bolts, sel, selBolt],
  )
  // ausgeblendete Körper → ihre Flächen werden in der 3D-Ansicht nicht gezeichnet
  const hiddenSurfaces = useMemo(
    () => new Set((mesh?.surfaces ?? []).filter((x) => hiddenBodies.includes(x.body)).map((x) => x.tag)),
    [mesh, hiddenBodies],
  )

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
  // Vernetzen läuft: darf „erst grob laden“ angeboten werden (nur beim Öffnen einer neuen Datei)?
  const meshingRef = useRef(null)
  const [meshing, setMeshing] = useState(null)
  async function loadGeometry(path, size, keepSetup = false, base = true, refineOverride = null, preview = false) {
    setBusy(preview ? 'Lade grobe Vorschau …' : 'Vernetze Geometrie …')
    setError(null)
    const job = { preview, fresh: !keepSetup || !mesh, wantPreview: false }
    meshingRef.current = job
    setMeshing(job)
    try {
      const ref = refineOverride ?? (keepSetup ? currentRefine(size) : [])
      const m = await api.openStep(path, size ? Number(size) : null, false, ref, keepFastenersRef.current, preview)
      setMeshRefineKey(JSON.stringify(ref))
      if (!keepSetup) {
        boltPrefs.current = {}
        setHandBolts([])
      }
      setMesh(m)
      const nCad = (m.bolts ?? []).filter((b) => b.source === 'cad').length
      const nSug = (m.bolts ?? []).length - nCad
      if (!keepSetup && (nCad || nSug))
        setNotice(
          [nCad && `${nCad} Schraube${nCad > 1 ? 'n' : ''} aus dem CAD erkannt`, nSug && `${nSug} mögliche Schraube${nSug > 1 ? 'n' : ''} an Bohrungen`]
            .filter(Boolean)
            .join(', ') + ' – unter Verbindungen Festigkeitsklasse wählen',
        )
      if (!m.preview) setMeshSize(String(Number(m.mesh_size.toPrecision(3))))
      if (m.preview)
        setNotice('Grobe Vorschau geladen – Lager, Lasten und Verbindungen kannst du schon festlegen. Vor dem Rechnen unter „Netz“ vernetzen.')
      setResult(null)
      setResultStale(false)
      setProbe(null)
      setHome(false)
      if (base) {
        setStepPath(path)
        setView('setup')
        if (!keepSetup) setSel('teil')
        if (keepCadRef.current) keepCadRef.current = false
        else {
          setCad({ base: path, features: [] })
          setCadApplied(null)
        }
        setGeoStep(null)
        setGeoApplied('[]')
        setGeoInfo(null)
        setGeoWarnings([])
      }
      setTopo(null)
      if (!keepSetup) {
        setSupports([])
        setLoads([])
        setWelds([])
        setBodyMats({})
        setHiddenBodies([])
        if (base) setPartOrigin(null)
        setGaps((g) => ({ ...g, list: null }))
        setActive(null)
        setDrawing(null)
        setGeoOps([])
        setReference(null)
      }
      return m
    } catch (e) {
      const msg = String(e)
      const cancelled = /Abgebrochen/.test(msg)
      if (!preview && job.fresh && (job.wantPreview || !cancelled)) {
        // nicht fertig vernetzt: Datei trotzdem laden (grob), damit man weiterarbeiten kann
        if (!cancelled) setError(`Vernetzen fehlgeschlagen: ${msg.replace(/^Error: /, '')} – es wird eine grobe Vorschau geladen.`)
        setBusy(null)
        return loadGeometry(path, size, keepSetup, base, refineOverride, true)
      }
      if (cancelled) setNotice(keepSetup && mesh ? 'Vernetzen abgebrochen – das bisherige Netz bleibt.' : 'Abgebrochen.')
      else setError(msg)
    } finally {
      if (meshingRef.current === job) {
        meshingRef.current = null
        setMeshing(null)
      }
      setBusy((b) => (meshingRef.current ? b : null))
    }
  }

  async function onOpenStep() {
    try {
      const p = await api.pickStep()
      if (p) await openStepPath(p)
    } catch (e) {
      setError(String(e))
    }
  }

  async function openStepPath(p) {
    const m = await loadGeometry(p, null)
    if (!m) return
    setPartSource('STEP-Datei')
    addRecent({ kind: 'step', path: p, name: baseName(p), info: `${fmt(m.volume / 1000)} cm³` })
  }

  // zuletzt geöffnet: Datei, Projekt oder Onshape-Teilestudio
  async function openRecent(r) {
    if (r.kind === 'step') return openStepPath(r.path)
    if (r.kind === 'project') return onLoadProject(r.path)
    if (r.kind === 'onshape') {
      setBusy('Hole Teilestudio aus Onshape …')
      setError(null)
      try {
        await api.onshapeImport(r.path) // das Teil kommt danach wie aus dem CAD an
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(null)
      }
    }
  }

  // Datei auf das Fenster gezogen (Browser: hochladen; Desktop: Pfad vom Fenster)
  async function onDropFile(f) {
    try {
      if (/\.(step|stp)$/i.test(f.name)) {
        setBusy('Lade Datei …')
        const p = await api.uploadStepFile(f)
        setBusy(null)
        return openStepPath(p)
      }
      if (/\.json$/i.test(f.name)) return applyProject(await api.projectFromText(await f.text()))
      setError('Bitte eine STEP-Datei (.step, .stp) oder ein Projekt (.fem.json) hierher ziehen')
    } catch (e) {
      setBusy(null)
      setError(String(e))
    }
  }
  const dropRef = useRef(null)
  dropRef.current = (paths) => {
    const p = paths[0]
    if (/\.(step|stp)$/i.test(p)) openStepPath(p)
    else if (/\.json$/i.test(p)) onLoadProject(p)
  }
  useEffect(() => api.onFileDrop((paths) => dropRef.current?.(paths)), [])

  // --- Projekt speichern / laden -------------------------------------------------
  async function onSaveProject() {
    let path = stepPath
    // neues Teil, noch nicht übernommen: STEP aus der Konstruktion bauen
    if (!cad.base && cad.features.length && (!path || cadApplied == null)) {
      try {
        const r = await api.cadBuild({ base: null, features: kernelFeatures(cad.features), step: 'Konstruktion', tess: false })
        if (!r.step) throw new Error('Die Konstruktion hat noch keinen Körper')
        path = r.step
      } catch (e) {
        return setError(String(e))
      }
    }
    if (!path) return
    const stepPath_ = path
    const data = { format: 'projekt-fem', version: 1, step: stepPath, meshSize: Number(meshSize) || null, material, supports, loads, welds, geoOps, proof, origin: partOrigin, bodyMaterials: bodyMats, hiddenBodies,
      bolts: Object.fromEntries(bolts.map((b) => [b.name, { cls: b.cls, on: b.on, ma: b.ma, fv: b.fv }])), openJoints, jointFriction: jointFric, tighten: tight, contacts: contactPairs, handBolts, keepFasteners,
      cad: { features: cad.features, newPart: !cad.base, applied: cadApplied != null } }
    data.step = cad.base ?? stepPath_
    data.geoOps = []
    try {
      const p = await api.saveProject(stepPath_, data)
      if (p) addRecent({ kind: 'project', path: p, name: baseName(p), info: result ? `${material.name} · σv ${fmt(result.max_von_mises.value)} MPa` : material.name })
      if (p) setNotice(`Projekt gespeichert: ${baseName(p)}`)
      else if (!api.isDesktop) setNotice('Projekt heruntergeladen (mit eingebetteter STEP-Datei)')
    } catch (e) {
      setError(String(e))
    }
  }

  async function onLoadProject(path = null) {
    try {
      const d = await api.loadProject(path)
      if (!d) return
      await applyProject(d)
    } catch (e) {
      setError(String(e))
    }
  }

  async function applyProject(d) {
    try {
      if (d.format !== 'projekt-fem') throw new Error('Keine Projekt-FEM-Datei')
      // Schrauben-Einstellungen vor dem Vernetzen (Erkennung läuft dabei)
      boltPrefs.current = d.bolts ?? {}
      setOpenJoints(d.openJoints ?? true)
      if (d.jointFriction) setJointFric(d.jointFriction)
      if (d.tighten) setTight((t) => ({ ...t, ...d.tighten }))
      setContactPairs(d.contacts ?? {})
      setHandBolts(d.handBolts ?? [])
      setKeepFasteners(!!d.keepFasteners)
      keepFastenersRef.current = !!d.keepFasteners
      // Konstruktion: neues Teil aus den Features neu bauen; Importteil + Änderungen (auch alte „Geometrie anpassen“)
      const feats = d.cad?.features ?? featuresFromGeoOps(d.geoOps)
      const newPart = !!d.cad?.newPart
      let step = d.step
      if (newPart && feats.length) {
        setBusy('Baue Konstruktion …')
        try {
          const r = await api.cadBuild({ base: null, features: kernelFeatures(feats), step: 'Konstruktion', tess: false })
          if (r.step) step = r.step
        } catch (e) {
          setNotice('Konstruktion ließ sich nicht neu bauen – gespeicherte Geometrie geladen: ' + String(e))
        } finally {
          setBusy(null)
        }
      }
      keepCadRef.current = true
      const m = await loadGeometry(step, d.meshSize, true, true, [])
      keepCadRef.current = false
      if (!m) return
      const cadNext = { base: newPart ? null : d.step, features: feats }
      setCad(cadNext)
      setCadApplied(newPart ? JSON.stringify(kernelFeatures(feats)) : null)
      setReference(null)
      // gespeicherte Lager/Lasten beziehen sich auf die geänderte Geometrie → Änderungen gleich anwenden
      if (!newPart && kernelFeatures(feats).length) {
        setBusy('Passe Geometrie an …')
        try {
          const r = await api.cadBuild({ base: d.step, features: kernelFeatures(feats), step: stemOf(d.step) + '_geaendert', tess: false })
          const bad = r.status.find((x) => !x.ok && !x.skipped)
          if (bad) throw new Error(bad.error)
          const g = await api.openStep(r.step, d.meshSize ? Number(d.meshSize) : null, false, [])
          setMesh(g)
          setGeoStep(r.step)
          setCadApplied(JSON.stringify(kernelFeatures(feats)) + d.step)
        } catch (e) {
          setError('Änderungen der Konstruktion ließen sich nicht anwenden: ' + String(e))
        } finally {
          setBusy(null)
        }
      }
      setMaterial({ ...materialFromPreset(MATERIALS[0]), ...d.material, infill: { ...DEFAULT_INFILL, ...(d.material?.infill ?? {}) } })
      if (d.proof) setProof(d.proof)
      setPartOrigin(d.origin ?? null)
      setSupports(d.supports.map((s) => ({ ...newSupport(), ...s, id: nextId++ })))
      // ältere Projekte: Kraftrichtung fest (nicht der Fläche folgend)
      const windLoads = d.loads.filter((l) => l.kind === 'flow').length
      setLoads(d.loads.filter((l) => l.kind !== 'flow').map((l) => ({ ...newLoad(), followNormal: false, ...l, id: nextId++ })))
      if (windLoads) setNotice(`${windLoads} Wind-Last(en) aus dem Projekt entfernt – die überschlägige Windlast gibt es nicht mehr`)
      setWelds((d.welds ?? []).map((w) => ({ ...newWeld(), ...w, id: nextId++ })))
      setBodyMats(d.bodyMaterials ?? {})
      setHiddenBodies(d.hiddenBodies ?? [])
      setActive(null)
      setPartSource(d.origin?.includes('/documents/') ? 'Onshape' : 'Projekt')
      if (d.file) addRecent({ kind: 'project', path: d.file, name: baseName(d.file), info: d.material?.name ?? '' })
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
      if (boltPick) {
        // Schraube von Hand: Bohrung anklicken, fluchtende Bohrungen der anderen Teile kommen dazu
        const holes = (mesh?.surfaces ?? []).filter((x) => x.cylinder)
        const pick = holes.findIndex((x) => x.tag === tag)
        if (pick < 0) return setError('Bitte die Innenfläche einer Bohrung anklicken.')
        api
          .boltAtHole(
            holes.map((x) => ({ body: x.body, cyl: x.cylinder })),
            pick,
          )
          .then((bolt) => {
            setHandBolts((hs) => {
              const taken = new Set([...hs.map((h) => h.name), ...(mesh?.bolts ?? []).map((b) => b.bolt.name)])
              let k = 1
              while (taken.has(`Schraube ${k}`)) k++
              return [...hs, { name: `Schraube ${k}`, bolt }]
            })
            setBoltPick(false)
          })
          .catch((e) => setError(String(e)))
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
            return { ...x, [dirPick.key + 'Ui']: next, [dirPick.key]: vectorOf(next), ...(dirPick.key === 'force' ? { followNormal: false } : {}) }
          }),
        )
        setDirPick(null)
        return
      }
      if (!active) {
        // Fläche anklicken = zugehöriges Lager / Last / Naht im Studienbaum wählen
        const s = supports.find((x) => x.surfaces.includes(tag))
        if (s) return setSel('s:' + s.id)
        const l = loads.find((x) => x.surfaces.includes(tag))
        if (l) return setSel('l:' + l.id)
        if (welds.some((w) => w.a.includes(tag) || w.b.includes(tag))) return setSel('verb')
        // Baugruppe: Körper der Fläche wählen
        const b = surfaceInfo.get(tag)?.body
        if (mesh?.bodies?.length > 1 && b != null) return setSel('b:' + b)
        return
      }
      if (active.type === 'weldA' || active.type === 'weldB') {
        const k = active.type === 'weldA' ? 'a' : 'b'
        const other = k === 'a' ? 'b' : 'a'
        setWelds((ws) =>
          ws.map((w) =>
            w.id !== active.id
              ? w
              : { ...w, [k]: w[k].includes(tag) ? w[k].filter((t) => t !== tag) : [...w[k], tag], [other]: w[other].filter((t) => t !== tag) },
          ),
        )
        return
      }
      const toggle = (items) =>
        items.map((it) =>
          it.id !== active.id
            ? it
            : { ...it, surfaces: it.surfaces.includes(tag) ? it.surfaces.filter((t) => t !== tag) : [...it.surfaces, tag] },
        )
      if (active.type === 'support') setSupports(toggle)
      else setLoads(toggle)
    },
    [active, dirPick, geoPick, bedPick, boltPick, surfaceInfo, mesh, supports, loads, welds],
  )

  const surfaceTint = useCallback(
    (tag) => {
      if (view === 'geometry') {
        // Radien/Bohrungen, die geändert werden (Flächennummern vom Zeitpunkt der Auswahl)
        return geoOps.some((o) => o.enabled && o.tags?.includes(tag) && o.mesh === mesh?.positions?.length) ? '#c9a227' : null
      }
      const hot = (id) => active?.id === id || sel === 's:' + id || sel === 'l:' + id
      for (const l of loads)
        if (l.surfaces.includes(tag)) return l.region ? LOAD_PALE : hot(l.id) ? LOAD_ACTIVE : LOAD_COLOR
      for (const s of supports)
        if (s.surfaces.includes(tag)) return s.region ? SUPPORT_PALE : hot(s.id) ? SUPPORT_ACTIVE : SUPPORT_COLOR
      for (const w of welds) {
        if (w.a.includes(tag)) return w.kind === 'bond' ? BOND_A : WELD_A
        if (w.b.includes(tag)) return w.kind === 'bond' ? BOND_B : WELD_B
      }
      return null
    },
    [supports, loads, welds, active, view, geoOps, mesh, sel],
  )

  // --- Schweißnähte -----------------------------------------------------------------
  async function onFindGaps() {
    const max = Number(String(gaps.max).replace(',', '.'))
    if (!(max > 0)) return setError('Größten Spalt in mm angeben, z. B. 1')
    try {
      const list = await api.findGaps(max)
      setGaps({ ...gaps, list })
    } catch (e) {
      setError(String(e))
    }
  }

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
          return { ...x, [aim.field + 'Ui']: next, [aim.field]: vectorOf(next), ...(aim.field === 'force' ? { followNormal: false } : {}) }
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

  // --- Konstruktion übernehmen ---------------------------------------------------------------
  // neue Geometrie vernetzen; Lager, Lasten und Nähte auf die neuen Flächennummern umstellen
  async function swapGeometry(path, newGeoStep) {
    const ref = currentRefine(meshSize)
    const m = await api.openStep(path, Number(meshSize) || null, false, ref, keepFastenersRef.current)
    setMeshRefineKey(JSON.stringify(ref))
    const map = remapSurfaces(mesh.surfaces, m.surfaces)
    const warn = []
    const mapTags = (ts) => [...new Set(ts.map((t) => map.get(t)).filter((t) => t != null))]
    const remap = (items, what) =>
      items.map((x, i) => {
        const lost = x.surfaces.filter((t) => map.get(t) == null)
        if (lost.length) warn.push(`${what} ${i + 1}: ${lost.length === 1 ? 'eine Fläche' : lost.length + ' Flächen'} nicht wiedergefunden – im Reiter Modell prüfen`)
        return { ...x, surfaces: mapTags(x.surfaces) }
      })
    setSupports((ss) => remap(ss, 'Lager'))
    setLoads((ls) => remap(ls, 'Last'))
    setWelds((ws) => ws.map((w) => ({ ...w, a: mapTags(w.a), b: mapTags(w.b) })))
    setGeoWarnings(warn)
    setMesh(m)
    setGeoStep(newGeoStep)
    setTopo(null)
    setProbe(null)
    if (result) setResultStale(true)
    return warn
  }

  async function onCadApply(key) {
    if (result && !reference) setReference(summary(result, mesh, 'Vorher'))
    setBusy('Baue das Teil und vernetze …')
    setError(null)
    try {
      const kf = kernelFeatures(cad.features)
      let warn = []
      if (cad.base && !kf.length) {
        warn = await swapGeometry(cad.base, null)
      } else {
        const r = await api.cadBuild({ base: cad.base, features: kf, step: cad.base ? stemOf(cad.base) + '_geaendert' : 'Konstruktion', tess: false })
        const bad = r.status.find((x) => !x.ok && !x.skipped)
        if (bad) throw new Error(bad.error)
        if (!r.step) throw new Error('Die Konstruktion hat noch keinen Körper')
        if (cad.base) warn = await swapGeometry(r.step, r.step)
        else if (cadApplied == null || !mesh) {
          // erstes Mal: wie ein neu geöffnetes Teil
          keepCadRef.current = true
          const m = await loadGeometry(r.step, null, false, true)
          keepCadRef.current = false
          if (!m) return
          setPartSource('Konstruktion')
        } else {
          warn = await swapGeometry(r.step, null)
          setStepPath(r.step)
        }
      }
      setCadApplied(key)
      setNotice(warn.length ? warn.join(' · ') : 'Konstruktion übernommen – Lager und Lasten im Reiter Modell festlegen bzw. prüfen')
    } catch (e) {
      keepCadRef.current = false
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onCadExport() {
    try {
      const r = await api.cadBuild({ base: cad.base, features: kernelFeatures(cad.features), step: cad.base ? stemOf(cad.base) + '_geaendert' : 'Konstruktion', tess: false })
      if (!r.step) throw new Error('Die Konstruktion hat noch keinen Körper')
      await api.exportStep(r.step, (cad.base ? stemOf(cad.base) + '_geaendert' : 'Konstruktion') + '.step')
    } catch (e) {
      setError(String(e))
    }
  }

  function newCadPart() {
    setCad({ base: null, features: [] })
    setCadApplied(null)
    setHome(false)
    setView('cad')
  }

  // --- Parameterstudie -------------------------------------------------------------------
  const [study, setStudy] = useState({ param: 'mesh', values: '4; 3; 2; 1.5' })
  const [studyRows, setStudyRows] = useState(null)

  // SolidCraft-Parameter, wenn das offene Teil das SolidCraft-Design ist (Live-Verbindung)
  const [scStudyInfo, setScStudyInfo] = useState(null)
  useEffect(() => {
    if (view !== 'study' || !stepPath) return
    let stop = false
    ;(async () => {
      try {
        const st = await api.scStatus()
        const stem = stepPath.split(/[\\/]/).pop().replace(/\.(step|stp)$/i, '')
        const same = st.name && (stem === st.name || stem === st.name.replace(/[^\p{L}\p{N} ._()-]/gu, '_'))
        if (!st.connected || !same) {
          if (!stop) setScStudyInfo(null)
          return
        }
        const params = await api.scParams()
        if (!stop) setScStudyInfo({ name: st.name, params })
      } catch {
        if (!stop) setScStudyInfo(null)
      }
    })()
    return () => {
      stop = true
    }
  }, [view, stepPath])

  // Onshape-Variablen, wenn das offene Teil aus Onshape kommt
  const [osVars, setOsVars] = useState(null)
  // Variablen je Teilestudio nur einmal holen (jeder Aufruf zählt bei Onshape)
  const osVarsCache = useRef(new Map())
  useEffect(() => {
    if (view !== 'study' || !partOrigin?.includes('/documents/')) {
      setOsVars(null)
      return
    }
    if (osVarsCache.current.has(partOrigin)) {
      setOsVars(osVarsCache.current.get(partOrigin))
      return
    }
    let stop = false
    api
      .onshapeVariables(partOrigin)
      .then((v) => {
        osVarsCache.current.set(partOrigin, v)
        if (!stop) setOsVars(v)
      })
      .catch((e) => !stop && setOsVars({ error: String(e) }))
    return () => {
      stop = true
    }
  }, [view, partOrigin])

  // Wählbare Parameter: Netzgröße, Füllgrad, je Geometrieänderung ein Maß, SolidCraft-Parameter, Onshape-Variablen
  const studyParams = useMemo(() => {
    const out = [{ key: 'mesh', label: 'Netzgröße (Konvergenzstudie)', unit: 'mm' }]
    for (const p of scStudyInfo?.params ?? []) {
      const v = p.value
      const values = Number.isFinite(v) && v !== 0 ? [0.6, 0.8, 1, 1.2, 1.4].map((f) => Number((f * v).toPrecision(3))).join('; ').replace(/\./g, ',') : ''
      out.push({ key: `sc:${p.name}`, label: `SolidCraft: ${p.name}`, unit: p.unit || '', values })
    }
    for (const v of Array.isArray(osVars) ? osVars : []) {
      const x = v.value
      const values = Number.isFinite(x) && x !== 0 ? [0.6, 0.8, 1, 1.2, 1.4].map((f) => Number((f * x).toPrecision(3))).join('; ').replace(/\./g, ',') : ''
      out.push({ key: `os:${v.name}`, label: `Onshape: #${v.name}`, unit: v.unit || '', values })
    }
    if (material.layered && material.infill?.on) out.push({ key: 'infill', label: 'Füllgrad', unit: '%' })
    if (cadApplied != null)
      for (const p of cadParams(cad.features)) {
        const x = p.value
        const values = Number.isFinite(x) && x !== 0 ? [0.6, 0.8, 1, 1.2, 1.4].map((f) => Number((f * x).toPrecision(3))).join('; ').replace(/\./g, ',') : ''
        out.push({ key: p.key, label: `Konstruktion: ${p.label}`, unit: p.unit, values })
      }
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
  }, [material, geoOps, scStudyInfo, osVars, cad, cadApplied])

  async function runStudy() {
    const values = study.values.split(/[;\s]+/).map((v) => Number(v.replace(',', '.'))).filter((v) => Number.isFinite(v))
    if (!values.length) return setError('Bitte Werte angeben, z. B. „4; 3; 2; 1,5“')
    const param = study.param
    const meta = studyParams.find((p) => p.key === param)
    const rows = []
    const origSurfaces = mesh.surfaces
    const refine = currentRefine(meshSize)
    const active = geoOps.filter((o) => o.enabled && !opProblem(o))
    const scParam = param.startsWith('sc:') ? scStudyInfo?.params.find((p) => p.name === param.slice(3)) : null
    let scTouched = false
    const osVar = param.startsWith('os:') && Array.isArray(osVars) ? osVars.find((v) => v.name === param.slice(3)) : null
    const osUrl = partOrigin
    let osTouched = false
    setError(null)
    setActive(null)
    setDrawing(null)
    try {
      if (scParam) await api.scPause(true)
      for (const [i, v] of values.entries()) {
        setBusy(`Studie ${meta.label} = ${fmt(v)} ${meta.unit} (${i + 1}/${values.length}) …`)
        let mat = material
        let sups = supports
        let lds = loads
        let wls = welds
        let m = mesh
        if (param === 'mesh') {
          m = active.length
            ? (await api.modifyGeometry(stepPath, active.map(opPayload), v, currentRefine(v))).mesh
            : await api.openStep(geoStep ?? stepPath, v, false, currentRefine(v))
        } else if (param === 'infill') {
          mat = { ...material, infill: { ...material.infill, percent: v } }
        } else if (osVar) {
          // Variable in Onshape setzen, Geometrie holen, Lager/Lasten/Nähte übertragen
          osTouched = true
          const path = await api.onshapeStudy(osUrl, osVar.name, osVar.unit ? `${v} ${osVar.unit}` : String(v))
          m = await api.openStep(path, Number(meshSize) || null, false, refine)
          const map = remapSurfaces(origSurfaces, m.surfaces)
          const mapTags = (ts) => [...new Set(ts.map((t) => map.get(t)).filter((t) => t != null))]
          if ([...supports, ...loads].some((x) => x.surfaces.some((t) => map.get(t) == null)))
            throw new Error(`Bei #${osVar.name} = ${fmt(v)} ${osVar.unit} sind Lager- oder Lastflächen nicht mehr wiederzufinden – Studie abgebrochen`)
          sups = supports.map((x) => ({ ...x, surfaces: mapTags(x.surfaces) }))
          lds = loads.map((x) => ({ ...x, surfaces: mapTags(x.surfaces) }))
          wls = welds.map((w) => ({ ...w, a: mapTags(w.a), b: mapTags(w.b) }))
        } else if (scParam) {
          // Maß in SolidCraft setzen, Geometrie holen, Lager/Lasten/Nähte übertragen
          scTouched = true
          const path = await api.scStudy(scParam.name, scParam.unit ? `${v} ${scParam.unit}` : String(v))
          m = await api.openStep(path, Number(meshSize) || null, false, refine)
          const map = remapSurfaces(origSurfaces, m.surfaces)
          const mapTags = (ts) => [...new Set(ts.map((t) => map.get(t)).filter((t) => t != null))]
          const lost = [...supports, ...loads].some((x) => x.surfaces.some((t) => map.get(t) == null))
          if (lost) throw new Error(`Bei ${scParam.name} = ${fmt(v)} ${scParam.unit} sind Lager- oder Lastflächen nicht mehr wiederzufinden – Studie abgebrochen`)
          sups = supports.map((x) => ({ ...x, surfaces: mapTags(x.surfaces) }))
          lds = loads.map((x) => ({ ...x, surfaces: mapTags(x.surfaces) }))
          wls = welds.map((w) => ({ ...w, a: mapTags(w.a), b: mapTags(w.b) }))
        } else if (param.startsWith('cad:')) {
          // Maß der Konstruktion ändern, Teil neu bauen, Lager/Lasten/Nähte übertragen
          const [, fid, field, cid] = param.split(':')
          const feats = cad.features.map((f) => {
            if (String(f.id) !== fid) return f
            if (field === 'con') return { ...f, sketch: { ...f.sketch, cons: f.sketch.cons.map((c) => (c.id === cid ? { ...c, v } : c)) } }
            return { ...f, [field]: String(v) }
          })
          // Skizze mit dem neuen Maß lösen
          const { solved } = await import('./cad/sketch.js')
          const solvedFeats = feats.map((f) => (f.type === 'sketch' && String(f.id) === fid ? { ...f, sketch: solved(f.sketch).sketch } : f))
          if (field === 'con' && solvedFeats.find((f) => String(f.id) === fid).sketch === feats.find((f) => String(f.id) === fid).sketch)
            throw new Error(`${meta.label} = ${fmt(v)}: Skizze nicht lösbar – Studie abgebrochen`)
          const r = await api.cadBuild({ base: cad.base, features: kernelFeatures(solvedFeats), step: 'Studie', tess: false })
          const bad = r.status.find((x) => !x.ok && !x.skipped)
          if (bad) throw new Error(`${meta.label} = ${fmt(v)}: ${bad.error}`)
          m = await api.openStep(r.step, Number(meshSize) || null, false, refine)
          const map = remapSurfaces(origSurfaces, m.surfaces)
          const mapTags = (ts) => [...new Set(ts.map((t) => map.get(t)).filter((t) => t != null))]
          if ([...supports, ...loads].some((x) => x.surfaces.some((t) => map.get(t) == null)))
            throw new Error(`Bei ${meta.label} = ${fmt(v)} sind Lager- oder Lastflächen nicht mehr wiederzufinden – Studie abgebrochen`)
          sups = supports.map((x) => ({ ...x, surfaces: mapTags(x.surfaces) }))
          lds = loads.map((x) => ({ ...x, surfaces: mapTags(x.surfaces) }))
          wls = welds.map((w) => ({ ...w, a: mapTags(w.a), b: mapTags(w.b) }))
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
          const mapTags = (ts) => [...new Set(ts.map((t) => map.get(t)).filter((t) => t != null))]
          sups = re(supports)
          lds = re(loads)
          wls = welds.map((w) => ({ ...w, a: mapTags(w.a), b: mapTags(w.b) }))
        }
        const r = await api.solve(buildSetup(mat, sups, lds, wls))
        const rho = Number(material.rho)
        rows.push({
          value: v, vm: r.max_von_mises.value, u: r.max_displacement.value, safety: r.safety, safetyBreak: r.safety_break,
          volume: r.solid_volume, mass: rho > 0 ? (r.solid_volume / 1000) * rho : null, elements: m.elements, equations: r.equations,
        })
        setStudyRows({ param: meta, rows: [...rows] })
      }
      // Ausgangszustand wiederherstellen (Netz und Ergebnis)
      if (osTouched) {
        osTouched = false
        setBusy(`Onshape: #${osVar.name} zurück auf ${osVar.expression} …`)
        await api.onshapeSetVariable(osUrl, osVar.name, osVar.expression)
      }
      if (scTouched) {
        scTouched = false
        setBusy(`SolidCraft: ${scParam.name} zurück auf ${scParam.expression} …`)
        await api.scStudy(scParam.name, scParam.expression)
      }
      if (param === 'mesh' || param.startsWith('geo:') || param.startsWith('cad:') || scParam || osVar) {
        setBusy('Ausgangszustand wiederherstellen …')
        const m = active.length
          ? (await api.modifyGeometry(stepPath, active.map(opPayload), Number(meshSize) || null, refine)).mesh
          : await api.openStep(geoStep ?? stepPath, Number(meshSize) || null, false, refine)
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
      // Onshape: Variable zurücksetzen (auch nach Fehler)
      if (osVar && osTouched) await api.onshapeSetVariable(osUrl, osVar.name, osVar.expression).catch(() => {})
      // SolidCraft: Maß zurücksetzen (auch nach Fehler) und wieder mitlaufen
      if (scParam) {
        if (scTouched) await api.scStudy(scParam.name, scParam.expression).catch(() => {})
        await api.scPause(false).catch(() => {})
      }
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
  // offene Punkte vor dem Rechnen; `sel` = Eintrag im Studienbaum, der dazu gehört
  const problems = useMemo(() => {
    const p = []
    const add = (text, at) => p.push({ text, sel: at })
    if (!mesh) add('Geometrie öffnen', 'teil')
    if (mesh?.preview) add('Netz: nur grobe Vorschau – unter „Netz“ vernetzen', 'netz')
    if (!supports.length) add('Mindestens ein Lager anlegen', 'lager+')
    supports.forEach((s, i) => {
      if (!s.surfaces.length) add(`Lager ${i + 1}: Flächen wählen`, 's:' + s.id)
      const f = supportFix(s)
      if (f.error && s.surfaces.length) add(`Lager ${i + 1}: ${f.error}`, 's:' + s.id)
    })
    if (!loads.length && analysis !== 'modal') add('Mindestens eine Last anlegen', 'last+')
    welds.forEach((w, i) => {
      if (!w.a.length || !w.b.length) add(`Naht ${i + 1}: Fläche A und Fläche B wählen`, 'verb')
      if (w.kind === 'fillet' && !(Number(String(w.throat).replace(',', '.')) > 0)) add(`Naht ${i + 1}: a-Maß angeben`, 'verb')
    })
    if (analysis === 'modal' && !(Number(material.rho) > 0)) add('Für Eigenfrequenzen die Dichte des Werkstoffs angeben', 'mat')
    loads.forEach((l, i) => {
      if (!l.surfaces.length) add(`Last ${i + 1}: Flächen wählen`, 'l:' + l.id)
      if (l.kind === 'bearing' && l.surfaces.some((t) => !surfaceInfo.get(t)?.cylinder))
        add(`Last ${i + 1}: Bolzenlast nur auf zylindrischen Flächen (Bohrung, Welle)`, 'l:' + l.id)
      const v = l.kind === 'moment' ? l.moment : l.kind === 'pressure' ? [l.pressure] : l.force
      if (l.surfaces.length && !(Math.hypot(...v.map(Number)) > 0)) add(`Last ${i + 1}: Betrag angeben`, 'l:' + l.id)
    })
    for (const [what, items, k] of [['Lager', supports, 's:'], ['Last', loads, 'l:']])
      items.forEach((x, i) => {
        if (drawing?.id === x.id && !x.region) add(`${what} ${i + 1}: Bereich auf die Fläche zeichnen`, k + x.id)
      })
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh, supports, loads, welds, surfaceInfo, drawing, analysis, material.rho])

  // Kraft „senkrecht auf die Fläche“ folgt den gewählten Flächen
  useEffect(() => {
    setLoads((ls) => {
      let changed = false
      const out = ls.map((l) => {
        if (!l.followNormal || l.kind !== 'force') return l
        const n = loadNormal(l)
        if (!n) return l
        const mag = Math.hypot(...l.force.map(Number))
        if (!mag) return l
        const f = n.map((v) => tidy(-v * mag))
        if (f.every((v, k) => Math.abs(v - Number(l.force[k])) <= 1e-6 * mag)) return l
        changed = true
        return { ...l, force: f, forceUi: null }
      })
      return changed ? out : ls
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, surfaceInfo])

  // --- Studienbaum ---------------------------------------------------------------------
  function selectItem(key) {
    setSel(key)
    setDrawing(null)
    setAim(null)
    setDirPick(null)
    setBedPick(false)
    const id = Number(key.split(':')[1])
    if (active && active.id !== id) setActive(null)
    if (view !== 'setup') setView('setup')
  }
  function addSupport() {
    const s = newSupport()
    setSupports((ss) => [...ss, s])
    selectItem('s:' + s.id)
    setActive({ type: 'support', id: s.id })
  }
  function addLoad() {
    const l = newLoad()
    setLoads((ls) => [...ls, l])
    selectItem('l:' + l.id)
    setActive({ type: 'load', id: l.id })
  }
  // offener Punkt angeklickt: dorthin springen
  function jumpTo(at) {
    setTodoOpen(null)
    if (at === 'lager+') return addSupport()
    if (at === 'last+') return addLoad()
    selectItem(at)
  }
  const ready = problems.length === 0 && !busy
  function run() {
    setTodoOpen(null)
    if (analysis === 'static') onSolve()
    else onModes()
  }

  function buildSetup(mat, sups = supports, lds = loads, wls = welds) {
    const num = (v) => Number(String(v).replace(',', '.'))
    return {
        material: materialPayload(mat),
        welds: wls
          .filter((w) => w.a.length && w.b.length)
          .map((w, i) => ({
            name: `${w.kind === 'bond' ? 'Verbindung' : 'Naht'} ${i + 1}`,
            a: w.a,
            b: w.b,
            throat: w.kind === 'fillet' ? num(w.throat) : null,
            max_gap: num(w.maxGap) > 0 ? num(w.maxGap) : null,
          })),
        bodies: (mesh?.bodies ?? []).filter((b) => bodyMats[b.name]).map((b) => ({ body: b.body, material: materialPayload(bodyMats[b.name]) })),
        bolts: bolts
          .filter((b) => b.on)
          .map((b) => ({
            ...b.bolt,
            name: b.name,
            e: BOLT_CLASSES[b.cls]?.[2] ?? 210000,
            rp: BOLT_CLASSES[b.cls]?.[0] ?? 640,
            rm: BOLT_CLASSES[b.cls]?.[1] ?? 800,
            tighten: tightenOf(tight, b),
            scatter: scatterOf(tight),
          })),
        open_joints: openJoints,
        joint_friction: frictionOf(jointFric),
        contacts: (mesh?.touching ?? []).filter(([a, b]) => contactPairs[touchKey(mesh, a, b)]).map(([a, b]) => [a, b]),
        supports: sups.map((s) => {
          const f = supportFix(s)
          return { surfaces: s.surfaces, fix: f.fix, local: f.local ?? null, region: regionNumbers(s.region) }
        }),
        loads: lds.map((l) => {
          const base = { type: l.kind, surfaces: l.surfaces, region: regionNumbers(l.region) }
          if (l.kind === 'pressure') return { ...base, pressure: Number(l.pressure) }
          // Moment in der Oberfläche in N·m, im Rechenkern N·mm
          if (l.kind === 'moment') return { ...base, moment: l.moment.map((v) => Number(v) * 1000) }
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
        FEM_Masse_g: assemblyMass != null ? num(assemblyMass) : rho > 0 ? num((r.solid_volume / 1000) * rho) : null,
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
    const recent = inc.origin?.includes('/documents/')
      ? { kind: 'onshape', path: inc.origin, name: inc.name }
      : { kind: 'step', path: inc.path, name: inc.name, info: inc.source }
    if (!same) {
      const m = await loadGeometry(inc.path, null)
      if (!m) return
      setPartOrigin(inc.origin ?? null)
      setPartSource(inc.source)
      addRecent({ ...recent, info: [recent.info, `${fmt(m.volume / 1000)} cm³`].filter(Boolean).join(' · ') })
      setNotice(`${inc.source}: „${inc.name}“ geöffnet – Lager und Lasten festlegen`)
      return
    }
    addRecent(recent)
    setPartSource(inc.source)
    setHome(false)
    setBusy(`${inc.source}: neue Version von „${inc.name}“ übernehmen …`)
    try {
      const ref = currentRefine(meshSize)
      const m = await api.openStep(inc.path, Number(meshSize) || null, false, ref, keepFastenersRef.current)
      const map = remapSurfaces(mesh.surfaces, m.surfaces)
      let lost = 0
      const re = (items) =>
        items.map((x) => {
          lost += x.surfaces.filter((t) => map.get(t) == null).length
          return { ...x, surfaces: [...new Set(x.surfaces.map((t) => map.get(t)).filter((t) => t != null))] }
        })
      const sups = re(supports)
      const lds = re(loads)
      const wls = welds.map((w) => {
        const m2 = (ts) => {
          lost += ts.filter((t) => map.get(t) == null).length
          return [...new Set(ts.map((t) => map.get(t)).filter((t) => t != null))]
        }
        return { ...w, a: m2(w.a), b: m2(w.b) }
      })
      setSupports(sups)
      setLoads(lds)
      setWelds(wls)
      setMesh(m)
      setStepPath(inc.path)
      setPartOrigin(inc.origin ?? null)
      setMeshRefineKey(JSON.stringify(ref))
      setGeoOps([])
      setGeoStep(null)
      setGeoApplied('[]')
      setTopo(null)
      setProbe(null)
      if (result && cadAuto && !lost) {
        if (!reference) setReference(summary(result, mesh, 'vorige Version'))
        setBusy(`„${inc.name}“ neu rechnen …`)
        const r = await api.solve(buildSetup(material, sups, lds, wls))
        setResult(r)
        setResultStale(false)
        reportCad(r, material, sups, inc.path)
        setView('result')
      } else if (result) setResultStale(true)
      setNotice(
        `${inc.source}: neue Version von „${inc.name}“ übernommen` +
          (lost ? ` – ${lost} Lager-/Last-/Nahtfläche(n) nicht wiedergefunden, bitte prüfen` : result && cadAuto ? ' und neu gerechnet' : ''),
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

  // Bild der aktuellen Ansicht (PNG, weißer Hintergrund)
  async function onImage() {
    try {
      const shot = viewRef.current.snapshot(1800, 'image/png')
      const blob = await (await fetch(shot.data)).blob()
      await api.saveBlob(blob, stemOf(stepPath || 'ansicht') + (view === 'result' ? '-ergebnis' : '-modell') + '.png', 'Bild', 'png')
    } catch (e) {
      setError(String(e))
    }
  }

  // Ergebnis ins CAD zurück: Onshape (Beschreibung der Teile) bzw. SolidCraft (Parameter)
  async function onResultToCad() {
    setError(null)
    try {
      if (partOrigin?.includes('/documents/')) {
        setBusy('Schreibe Ergebnis nach Onshape …')
        setNotice('In Onshape eingetragen – ' + (await api.onshapeWriteResult(partOrigin)))
      } else if (partSource === 'SolidCraft') {
        setBusy('Schreibe Ergebnis nach SolidCraft …')
        setNotice('In SolidCraft eingetragen: ' + (await api.scResult()))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // „Neue Version holen“: gleiches Teil neu laden, Lager und Lasten bleiben (Flächen werden zugeordnet)
  async function reloadPart() {
    setError(null)
    try {
      if (partOrigin?.includes('/documents/')) {
        setBusy('Hole neue Version aus Onshape …')
        await api.onshapeImport(partOrigin)
      } else if (partSource === 'SolidCraft') {
        setBusy('Hole neue Version aus SolidCraft …')
        await api.scFetch()
      } else if (stepPath) {
        await handleIncoming({ name: stemOf(stepPath), path: stepPath, source: partSource ?? 'STEP-Datei', origin: partOrigin })
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // Tastatur: Esc beendet Auswahl/Zeichnen, Strg+S speichert, Strg+O öffnet
  const keyRef = useRef(null)
  keyRef.current = (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName ?? '')
    if (e.key === 'Escape') {
      if (dlg) return setDlg(null)
      setActive(null)
      setDrawing(null)
      setAim(null)
      setDirPick(null)
      setBedPick(false)
      setGeoPick(false)
      setTodoOpen(null)
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (stepPath) onSaveProject()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o' && !typing) {
      e.preventDefault()
      onOpenStep()
    }
  }
  useEffect(() => {
    const on = (e) => keyRef.current?.(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

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
    // Spannungsgrößen: Farbskala ohne die örtlichen Spitzen an der Krafteinleitung der Schrauben
    const zone = quantity !== 'disp' && quantity !== 'shell' ? result.bolt_zone : null
    for (let i = 0; i < n; i++) {
      if (zone?.[i]) continue
      if (values[i] < min) (min = values[i]), (imin = i)
      if (values[i] > max) (max = values[i]), (imax = i)
    }
    if (!(max >= min)) (min = 0), (max = 1)
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
    // lastproportionale Größen wachsen in der Animation mit (Sicherheit nicht)
    const rampColors = ['von_mises', 'disp', 'sigma1', 'sigma3', 'usage'].includes(quantity)
    // Iso-Clip: nur Bereiche über bzw. unter dem Schwellwert farbig
    const isoView = iso.on && quantity !== 'shell' ? { above: iso.above, value: min + iso.t * (max - min) } : null
    return {
      values, min, max, imin, imax, reverse, displacement: result.displacement, scale, auto, cut: cutView,
      animate: anim.on || anim.recording ? 'ramp' : false, animSpeed: anim.speed, rampColors, iso: isoView,
    }
  }, [result, mesh, quantity, deform, diag, cutData, cutPlane, showModes, modes, anim, iso])

  // Video der Verformung (zwei Durchläufe) mit Farbskala und Kennwerten
  async function onVideo() {
    if (!result || !viewRef.current) return
    const q = QUANTITIES[quantity]
    const d = display
    setAnim((a) => ({ ...a, recording: true }))
    setError(null)
    try {
      await new Promise((r) => setTimeout(r, 100))
      const seconds = 2 / (0.35 * anim.speed)
      const lines = [
        `${material.name} · σv max ${fmt(result.max_von_mises.value)} MPa · u max ${fmt(result.max_displacement.value)} mm${result.safety != null ? ` · S = ${fmt(result.safety)}` : ''}`,
        deform === 'auto' ? `Verformung ${fmt(d.auto)}-fach überhöht` : deform === 'true' ? 'Verformung maßstäblich' : '',
      ]
      const legend = d && q ? { title: `${q.label}${q.unit ? ` [${q.unit}]` : ''}`, min: fmt(d.min), max: fmt(d.max), reverse: d.reverse } : null
      const { blob, ext } = await viewRef.current.record({ seconds, title: (stepPath ?? 'Bauteil').split(/[\\/]/).pop().replace(/\.(step|stp)$/i, ''), lines, legend })
      const name = (stepPath ?? 'ergebnis').split(/[\\/]/).pop().replace(/\.(step|stp)$/i, '') + '-verformung.' + ext
      await api.saveBlob(blob, name, 'Video', ext)
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setAnim((a) => ({ ...a, recording: false }))
    }
  }

  const markers = useMemo(() => {
    if (!display || display.modal) return []
    const q = QUANTITIES[quantity]
    const u = q.unit ? ' ' + q.unit : ''
    const m = []
    if (quantity === 'shell' || !minmax) {
      /* keine Markierung */
    } else if (FIELD_OF[quantity]?.[1]) m.push({ node: display.imin, label: `Min ${fmt(display.min)}` })
    else if (quantity === 'sigma3') m.push({ node: display.imin, label: `Min ${fmt(display.min)}${u}` })
    else m.push({ node: display.imax, label: `Max ${fmt(display.max)}${u}` })
    if (probe) m.push({ node: probe.node, label: `${fmt(display.values[probe.node])}${u}`, probe: true })
    return m
  }, [display, quantity, probe, minmax])

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
    const act = cad.features.filter((f) => !f.suppressed && f.type !== 'sketch')
    if (act.length && cadApplied != null) meshLines.push([cad.base ? 'Geometrie geändert' : 'Konstruktion', act.map((f) => f.name).join(', ')])
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
      weldRows: weldRows(result, material).map((w) => [
        w.label,
        `${fmt(w.force)} N`,
        `${fmt(w.length)} / ${fmt(w.throat)} mm`,
        `${fmt(w.stress_max)} MPa`,
        w.util == null ? '–' : `${(100 * w.util).toFixed(0)} %${w.util <= 1 ? ' ok' : ' NICHT ERFÜLLT'}`,
      ]),
      boltRows: boltRows(result, bolts, Number(proof.sF) > 0 ? Number(proof.sF) : 1, tight.mode !== 'none' && tight.fatigue).map((r) => [
        r.name,
        r.cls,
        r.preload > 0
          ? `${r.preload_min != null ? `${fmt(r.preload_min / 1000)} … ` : ''}${fmt(r.preload / 1000)} kN / ${fmt(r.torque)} N·m`
          : '–',
        `${fmt(r.axial / 1000)} kN`,
        `${fmt(r.shear)} N`,
        `S = ${Number.isFinite(r.safety) ? fmt(Math.min(r.safety, 99)) : '–'} (nötig ${fmt(r.need)})${r.safety >= r.need ? ' ok' : ' NICHT ERFÜLLT'}`,
      ]),
      boltDetailRows: boltRows(result, bolts, Number(proof.sF) > 0 ? Number(proof.sF) : 1).map((r) => [
        r.name,
        `${fmt(r.bearing_pressure)}${r.bearing_limit ? ` / ${fmt(r.bearing_limit)}` : ''} MPa${r.pHead == null ? '' : r.pHead <= 1 ? ' ok' : ' ZU HOCH'}`,
        r.nut_pressure != null ? `${fmt(r.nut_pressure)}${r.nut_limit ? ` / ${fmt(r.nut_limit)}` : ''} MPa${r.pNut == null ? '' : r.pNut <= 1 ? ' ok' : ' ZU HOCH'}` : '–',
        r.engagement != null ? `${fmt(r.engagement)} / ${r.engagement_min != null ? fmt(r.engagement_min) : '?'} mm${r.engOk ? ' ok' : ' ZU KURZ'}` : '– (Mutter)',
        tight.mode !== 'none' && tight.fatigue
          ? `${fmt(r.stress_amplitude)} / ${fmt(r.fatigue_limit)} MPa${r.fatOk ? ' ok' : ' NICHT ERFÜLLT'}`
          : `${fmt(r.stress_amplitude)} MPa (nicht geprüft)`,
      ]),
      jointRows: (result.joints ?? []).map((j) => {
        const nameOf = (id) => (result.bodies ?? []).find((b) => b.body === id)?.name ?? `Körper ${id}`
        return [
          `${nameOf(j.body_a)} ↔ ${nameOf(j.body_b)}`,
          `${(100 * j.closed).toFixed(0)} %${j.closed_preload != null ? ` (angezogen ${(100 * j.closed_preload).toFixed(0)} %)` : ''}`,
          `${fmt(j.pressure_force / 1000)} kN`,
          `${fmt(j.max_pressure)} MPa`,
          j.friction_limit == null ? `${fmt(j.friction_force / 1000)} kN (haftet)` : `${fmt(j.friction_force / 1000)} / ${fmt(j.friction_limit / 1000)} kN`,
        ]
      }),
      openJoints,
      jointText: openJoints
        ? `Fuge mit Kontakt (Druck ja, Zug nein), ${jointFric.mode === 'stick' ? 'haftend' : jointFric.mode === 'free' ? 'reibungsfrei' : `Reibung µ = ${fmt(posNum(jointFric.mu, 0.15))}`}`
        : 'Fuge verklebt',
      tightText:
        tight.mode === 'none'
          ? 'ohne Vorspannung'
          : `Vorspannung: ${TIGHTEN[tight.mode]}${tight.mode === 'vdi' ? ` ν = ${fmt(posNum(tight.nu, 90))} %` : ''}, µ_G = ${fmt(posNum(tight.muG, 0.12))}, µ_K = ${fmt(posNum(tight.muK, 0.12))}` +
            (scatterOf(tight)
              ? `; Streuung α_A = ${fmt(scatterOf(tight).alpha_a)}${scatterOf(tight).setting ? ', Setzen (VDI 2230 Tab. 5.4/1)' : ''} – Festigkeit mit F_V,max, Fuge mit F_V,min`
              : ''),
      weldNote: (result.welds ?? []).length
        ? 'τw = größte Linienkraft entlang der Naht / a-Maß; zulässig f_vw,d = Rm / (√3·β_w·γ_M2), vereinfachtes Verfahren EN 1993-1-8 (4.5.3.3). Stumpfnaht durchgeschweißt: a = Blechdicke.'
        : null,
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
  const modelView = view === 'setup' || view === 'result'
  const showStart = home || (!mesh && view !== 'frame')
  const isOnshape = !!partOrigin?.includes('/documents/')
  const canResultToCad = !!result && !resultStale && (isOnshape || partSource === 'SolidCraft')
  const meshPending = !!mesh && (Number(meshSize) !== Number(mesh.mesh_size.toPrecision(3)) || JSON.stringify(currentRefine(meshSize)) !== meshRefineKey)
  const itemState = (key) => (problems.some((p) => p.sel === key) ? 'todo' : 'ok')
  const facesText = (n) => (n === 0 ? 'keine Fläche' : n === 1 ? '1 Fläche' : `${n} Flächen`)

  function switchView(v) {
    setActive(null)
    setAim(null)
    setDirPick(null)
    setDrawing(null)
    setBedPick(false)
    setGeoPick(false)
    setTodoOpen(null)
    setHome(false)
    setView(v)
  }

  const exportGeo = () => onCadExport()
  const exportTopo = () => api.exportTopoStl(topo.threshold, stemOf(stepPath || 'bauteil') + '_leichtbau.stl').catch((e) => setError(String(e)))
  async function videoFromMenu() {
    if (view !== 'result') {
      setView('result')
      await new Promise((r) => setTimeout(r, 400))
    }
    onVideo()
  }

  // Liste „Noch offen“ am Rechnen-Knopf schließen, wenn daneben geklickt wird
  useEffect(() => {
    if (!todoOpen) return
    const off = (e) => !e.target.closest?.('.run-box') && setTodoOpen(null)
    window.addEventListener('pointerdown', off)
    return () => window.removeEventListener('pointerdown', off)
  }, [todoOpen])

  // Rechnen-Knopf: grün, wenn alles festgelegt ist; sonst grau und nennt die offenen Punkte
  const runButton = (where) => (
    <div className="run-box">
      <button
        className={'btn run ' + (ready ? 'go' : 'wait')}
        disabled={!!busy}
        title={ready ? 'Bereit zum Rechnen' : 'Noch offen: ' + problems.map((p) => p.text).join(' · ')}
        onClick={() => (ready ? run() : setTodoOpen(todoOpen === where ? null : where))}
      >
        <I.IcPlay size={12} /> Rechnen
      </button>
      {todoOpen === where && !ready && (
        <div className="menu right todo-pop" role="menu">
          <div className="todo-title">Noch offen – anklicken:</div>
          {problems.map((p) => (
            <button key={p.text} className="mi" onClick={() => jumpTo(p.sel)}>
              <span>{p.text}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  )

  // --- Richtung und Betrag einer Last (Kraft, Moment) -----------------------------------
  function dirEditor(l, field, { unit = '', normal = null, axisPreset = null, noMag = false } = {}) {
    const upd = (patch) => setLoads((ls) => ls.map((x) => (x.id === l.id ? { ...x, ...patch } : x)))
    const vec = l[field].map(Number)
    const mag = Math.hypot(...vec)
    const u = mag ? vec.map((v) => v / mag) : null
    const follow = field === 'force' && l.kind === 'force' && !!l.followNormal
    const ax = !follow && u ? [0, 1, 2].find((k) => Math.abs(Math.abs(u[k]) - 1) < 1e-6) : undefined
    const m = noMag ? 1 : mag || (field === 'moment' ? 100 : 1000)
    const setDir = (d) => upd({ [field]: d.map((c) => tidy(c * m)), [field + 'Ui']: null, ...(field === 'force' ? { followNormal: false } : {}) })
    const pickAxis = (k) => {
      const d = [0, 0, 0]
      d[k] = ax === k ? -Math.sign(u[k]) : k === 2 ? -1 : 1
      setDir(d)
    }
    const aiming = aim?.id === l.id && aim.field === field
    const picking = dirPick?.id === l.id && dirPick.key === field
    let text
    if (follow) text = normal ? 'drückt senkrecht auf die gewählte Fläche' : 'senkrecht auf die Fläche – sobald eine ebene Fläche gewählt ist'
    else if (!u) text = 'Richtung wählen'
    else if (ax != null) text = `in Richtung ${u[ax] > 0 ? '+' : '−'}${'XYZ'[ax]}`
    else {
      const a = anglesOf(u)
      text = `schräg: Winkel in XY ${fmt(Number(a.a))}°, Neigung ${fmt(Number(a.b))}°`
    }
    if (field === 'moment' && u) text = 'Drehachse ' + text.replace('in Richtung ', '') + ' (Drehsinn nach der rechten Hand)'
    return (
      <div className="dir-editor">
        {!noMag && (
          <label className="field">
            <span>Betrag</span>
            <NumInput
              value={mag}
              unit={unit}
              onChange={(v) => upd({ [field]: (u ?? (follow && normal) ?? (field === 'moment' ? [0, 0, 1] : [0, 0, -1])).map((c) => tidy(c * v)), [field + 'Ui']: null })}
            />
          </label>
        )}
        <div className="field">
          <span>{field === 'moment' ? 'Drehachse' : 'Richtung'}</span>
          <div className="dir-row">
            {field === 'force' && l.kind === 'force' && (
              <button
                className={'dir' + (follow ? ' on' : '')}
                title="senkrecht auf die gewählte Fläche"
                aria-label="senkrecht auf die gewählte Fläche"
                onClick={() => upd({ followNormal: true, forceUi: null, ...(normal ? { force: normal.map((c) => tidy(c * m)) } : {}) })}
              >
                <I.IcNormal />
              </button>
            )}
            {['X', 'Y', 'Z'].map((a, k) => (
              <button
                key={a}
                className={'dir' + (ax === k ? ' on' : '')}
                title={ax === k ? 'nochmal klicken: Gegenrichtung' : `in ${a}-Richtung`}
                onClick={() => pickAxis(k)}
              >
                {ax === k ? (u[k] > 0 ? '+' : '−') : ''}
                {a}
              </button>
            ))}
            {axisPreset && (
              <button className="dir wide" title="um die Achse der gewählten Bohrung/Welle (Torsion)" onClick={() => setDir(axisPreset)}>
                ⟳ Achse
              </button>
            )}
            <button className="dir" title="Richtung umkehren" aria-label="Richtung umkehren" disabled={!u} onClick={() => setDir(u.map((c) => -c))}>
              <I.IcFlip />
            </button>
            <button
              className={'dir' + (aiming ? ' on' : '')}
              title="Pfeil im Bild ziehen (rastet in 5°-Schritten ein, ⇧ = stufenlos)"
              aria-label="Pfeil im Bild ziehen"
              onClick={() => startAim(l.id, field)}
            >
              <I.IcDrag />
            </button>
            {
              <button
                className={'dir' + (picking ? ' on' : '')}
                title="Richtung von einer Fläche übernehmen: senkrecht darauf bzw. entlang der Bohrungsachse"
                aria-label="Richtung von einer Fläche übernehmen"
                onClick={() => {
                  setActive(null)
                  setDrawing(null)
                  setAim(null)
                  setDirPick(picking ? null : { id: l.id, key: field })
                }}
              >
                <I.IcFacePick />
              </button>
            }
          </div>
          <p className="hint">{text}</p>
        </div>
      </div>
    )
  }

  // Flächen eines Lagers/einer Last: Anzahl, Farbe, Auswahl ein/aus
  const facesCard = (item, type, color) => {
    const on = active?.id === item.id
    const n = item.surfaces.length
    const cyl = n > 0 && item.surfaces.every((t) => surfaceInfo.get(t)?.cylinder)
    return (
      <div className={'faces' + (on ? ' on' : '')}>
        <span className="swatch" style={{ background: color }} />
        <span className="grow">
          {on && !n ? 'Flächen im Bild anklicken' : facesText(n)}
          {cyl ? (n === 1 ? ' (Bohrung/Welle)' : ' (zylindrisch)') : ''}
        </span>
        <button
          className={'btn small' + (on ? ' primary' : '')}
          onClick={() => {
            setDrawing(null)
            setAim(null)
            setDirPick(null)
            setActive(on ? null : { type, id: item.id })
          }}
        >
          {on ? 'Fertig' : n ? 'Flächen ändern' : 'Flächen wählen'}
        </button>
      </div>
    )
  }

  function loadSummary(l) {
    const mag = (v) => Math.hypot(...v.map(Number))
    const axis = (v) => {
      const m = mag(v)
      const k = m ? [0, 1, 2].find((i) => Math.abs(Math.abs(Number(v[i])) / m - 1) < 1e-6) : undefined
      return k == null ? 'schräg' : `${Number(v[k]) > 0 ? '+' : '−'}${'XYZ'[k]}`
    }
    if (l.kind === 'pressure') return `Druck ${fmt(Number(l.pressure))} MPa`
    if (l.kind === 'moment') return `Moment ${fmt(mag(l.moment))} N·m · ${axis(l.moment)}`
    if (l.kind === 'bearing') return `Bolzenlast ${fmt(mag(l.force))} N · ${axis(l.force)}`
    return `Kraft ${fmt(mag(l.force))} N · ${l.followNormal ? 'senkrecht auf Fläche' : axis(l.force)}`
  }

  // --- Eigenschaften des gewählten Eintrags ---------------------------------------------------------
  function renderProps() {
    if (!mesh) return null
    if (sel === 'mat') {
      const num = (v, u) => (v === '' || v == null || !Number.isFinite(Number(v)) ? '–' : `${fmt(Number(v))} ${u}`)
      return (
        <>
          <PropsHead title="Werkstoff" />
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
          <div className="card kv-grid">
            <Stat label="E" value={num(material.E, 'MPa')} />
            <Stat label="Re / Rp0,2" value={num(material.yield, 'MPa')} />
            <Stat label="Rm" value={num(material.tensile, 'MPa')} />
            <Stat label="Dichte" value={num(material.rho, 'g/cm³')} />
          </div>
          <div className="field">
            <span>Erforderlich (leer = nicht prüfen)</span>
            <div className="grid3">
              <NumField label="Sicherheit Fließen" value={proof.sF} onChange={(v) => setProof({ ...proof, sF: v })} />
              <NumField label="Sicherheit Bruch" value={proof.sB} onChange={(v) => setProof({ ...proof, sB: v })} />
              <NumField label="Verformung max." unit="mm" value={proof.uMax} onChange={(v) => setProof({ ...proof, uMax: v })} />
            </div>
          </div>
          <p className="hint">Typisch: Stahl statisch 1,5 / 2,0; Kunststoff- und Druckteile eher 2–3.</p>
          <label className="check">
            <input
              type="checkbox"
              checked={!!material.layered}
              onChange={(e) => setMaterial({ ...material, layered: e.target.checked, name: material.layered === e.target.checked ? material.name : 'Benutzerdefiniert' })}
            />
            3D-Druck: Schichten und Infill berücksichtigen
          </label>
          {material.layered && (
            <PrintOrientation
              material={material}
              setMaterial={(m) => setMaterial(m)}
              picking={bedPick}
              onPick={() => {
                setActive(null)
                setDrawing(null)
                setGeoPick(false)
                setBedPick(!bedPick)
              }}
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
              onUse={(d) => {
                const m = { ...material, buildDir: d }
                setMaterial(m)
                onSolve(m)
              }}
            />
          )}
          {material.layered && <InfillFields material={material} setMaterial={setMaterial} />}
          <More title="Werte ändern, eigenen Werkstoff speichern" open={material.name === 'Benutzerdefiniert' || !!material.layered}>
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
            <Calibration material={material} setMaterial={setMaterial} />
          </More>
        </>
      )
    }
    if (sel === 'netz') {
      return (
        <>
          <PropsHead title="Netz" />
          <div className="row">
            <label className="field grow">
              <span>Elementgröße</span>
              <div className="input-unit">
                <input value={meshSize} onChange={(e) => setMeshSize(e.target.value.replace(',', '.'))} inputMode="decimal" />
                <em>mm</em>
              </div>
            </label>
            <button className={'btn' + (meshPending || mesh.preview ? ' primary' : '')} onClick={() => loadGeometry(geoStep ?? stepPath, meshSize, true, !geoStep)}>
              <Grid3x3 size={15} /> {mesh.preview ? 'Jetzt vernetzen' : 'Neu vernetzen'}
            </button>
          </div>
          <MeshSlider mesh={mesh} diag={diag} value={meshSize} onChange={setMeshSize} />
          <div className="card">
            <Stat label="Aktuelles Netz" value={`${mesh.elements.toLocaleString('de-DE')} Elemente`} />
            <Stat label="Unbekannte" value={(3 * mesh.nodes).toLocaleString('de-DE')} />
          </div>
          {meshPending && <p className="hint warn-text">Geändert – „Neu vernetzen“, damit das Netz zur Einstellung passt.</p>}
          <label className="check">
            <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} /> Netz anzeigen
          </label>
          <More title="Feiner an Lager- und Lastbereichen">
            <label className="check">
              <input type="checkbox" checked={refineRegions} onChange={(e) => setRefineRegions(e.target.checked)} /> Netz in gezeichneten Wirkbereichen
              automatisch verfeinern
            </label>
            <p className="hint">An Bohrungen und Radien wird immer automatisch feiner vernetzt (TET10, quadratische Elemente).</p>
          </More>
        </>
      )
    }
    if (sel === 'verb') {
      return (
        <>
        {(bolts.length > 0 || mesh.bodies?.length > 1) && (
          <BoltSection
            bolts={bolts}
            setBolts={setBolts}
            selBolt={selBolt}
            setSelBolt={setSelBolt}
            openJoints={openJoints}
            setOpenJoints={setOpenJoints}
            jointFric={jointFric}
            setJointFric={setJointFric}
            tight={tight}
            setTight={setTight}
            handBolts={handBolts}
            setHandBolts={setHandBolts}
            boltPick={boltPick}
            setBoltPick={(v) => {
              setActive(null)
              setBoltPick(v)
            }}
            keepFasteners={keepFasteners}
            onKeepFasteners={(v) => {
              setKeepFasteners(v)
              keepFastenersRef.current = v
              loadGeometry(geoStep ?? stepPath, meshSize, true, !geoStep)
            }}
          />
        )}
        <TouchSection mesh={mesh} contacts={contactPairs} setContacts={setContactPairs} jointFric={jointFric} setJointFric={setJointFric} />
        <WeldSection
          welds={welds}
          setWelds={setWelds}
          gaps={gaps}
          setGaps={setGaps}
          active={active}
          setActive={(a) => {
            setDrawing(null)
            setActive(a)
          }}
          onFind={onFindGaps}
        />
        </>
      )
    }
    const s = sel.startsWith('s:') ? supports.find((x) => 's:' + x.id === sel) : null
    if (s) {
      const i = supports.indexOf(s)
      const upd = (patch) => setSupports((ss) => ss.map((x) => (x.id === s.id ? { ...x, ...patch } : x)))
      const f = supportFix(s)
      const cy = { radial: true, axial: true, tangential: false, ...s.cyl }
      return (
        <>
          <PropsHead
            title={`Lager ${i + 1}`}
            onDelete={() => {
              setSupports(supports.filter((x) => x.id !== s.id))
              setActive(null)
              setDrawing(null)
              setSel('teil')
            }}
          />
          <div className="choices c4">
            {SUPPORT_KINDS.map(([k, lab, Icon]) => (
              <button key={k} className={'choice' + (s.kind === k ? ' on' : '')} onClick={() => upd({ kind: k })}>
                <Icon size={26} />
                {lab}
              </button>
            ))}
          </div>
          <p className="hint">{SUPPORT_KINDS.find((x) => x[0] === s.kind)?.[3]}</p>
          {s.kind === 'cylindrical' && (
            <div className="checks">
              {[['radial', 'radial fest'], ['axial', 'axial fest'], ['tangential', 'Drehung gesperrt']].map(([k, lab]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={cy[k]} onChange={(e) => upd({ cyl: { ...cy, [k]: e.target.checked } })} />
                  {lab}
                </label>
              ))}
              {!cy.tangential && <p className="hint">Ein zweites Lager muss die Drehung um den Bolzen verhindern.</p>}
            </div>
          )}
          {s.kind === 'axes' && (
            <div className="dir-row">
              {['x', 'y', 'z'].map((a) => (
                <button key={a} className={'dir' + (s.axes[a] ? ' on' : '')} title={`${a.toUpperCase()} ${s.axes[a] ? 'gesperrt' : 'frei'}`} onClick={() => upd({ axes: { ...s.axes, [a]: !s.axes[a] } })}>
                  {a.toUpperCase()}
                </button>
              ))}
              <span className="hint">markiert = gesperrt</span>
            </div>
          )}
          {facesCard(s, 'support', SUPPORT_COLOR)}
          {f.error && s.surfaces.length > 0 && <p className="error-text">{f.error}</p>}
          <More title="Nur ein Teil der Fläche (Bereich zeichnen)" open={!!s.region}>
            <RegionEditor
              item={s}
              cyl={selectionCylinder(s.surfaces, surfaceInfo)}
              drawing={drawing?.id === s.id ? drawing : null}
              onStart={(shape) => startDrawing('support', s, shape)}
              onCancel={() => setDrawing(null)}
              onChange={(region) => updateItem('support', s.id, { region })}
            />
          </More>
        </>
      )
    }
    const l = sel.startsWith('l:') ? loads.find((x) => 'l:' + x.id === sel) : null
    if (l) {
      const i = loads.indexOf(l)
      const upd = (patch) => setLoads((ls) => ls.map((x) => (x.id === l.id ? { ...x, ...patch } : x)))
      const n = loadNormal(l)
      const cyl = selectionCylinder(l.surfaces, surfaceInfo)
      const p = Number(l.pressure)
      const vecField = l.kind === 'moment' ? 'moment' : 'force'
      return (
        <>
          <PropsHead
            title={`Last ${i + 1}`}
            onDelete={() => {
              setLoads(loads.filter((x) => x.id !== l.id))
              setActive(null)
              setAim(null)
              setDrawing(null)
              setSel('teil')
            }}
          />
          <div className="choices c5">
            {LOAD_CHOICES.map(([k, lab, Icon]) => (
              <button key={k} className={'choice' + (l.kind === k ? ' on' : '')} title={LOAD_KINDS[k]} onClick={() => upd({ kind: k })}>
                <Icon size={26} />
                {lab}
              </button>
            ))}
          </div>
          {l.kind === 'force' && dirEditor(l, 'force', { unit: 'N', normal: n ? n.map((v) => -v) : null })}
          {l.kind === 'bearing' && (
            <>
              {dirEditor(l, 'force', { unit: 'N' })}
              <p className="hint">Kraft, mit der Bolzen bzw. Welle auf die Bohrung drückt. Sie wirkt nur auf der Hälfte, gegen die gedrückt wird (Druck ∝ cos φ).</p>
            </>
          )}
          {l.kind === 'moment' && (
            <>
              {dirEditor(l, 'moment', { unit: 'N·m', axisPreset: cyl?.axis ?? null })}
              <p className="hint">Wirkt um den Schwerpunkt des Bereichs, verteilt wie bei einem starren Anschlussteil.</p>
            </>
          )}
          {l.kind === 'pressure' && (
            <>
              <label className="field">
                <span>Betrag</span>
                <NumInput value={Math.abs(p)} unit="MPa" onChange={(v) => upd({ pressure: (p < 0 ? -1 : 1) * v })} />
              </label>
              <div className="segmented small">
                <button className={p >= 0 ? 'on' : ''} onClick={() => upd({ pressure: Math.abs(p) })}>
                  drückt auf die Fläche
                </button>
                <button className={p < 0 ? 'on' : ''} onClick={() => upd({ pressure: -Math.abs(p) })}>
                  zieht (Sog)
                </button>
              </div>
              <p className="hint">1 MPa = 1 N/mm² = 10 bar. Wirkt immer senkrecht auf jede gewählte Fläche.</p>
            </>
          )}
          {facesCard(l, 'load', LOAD_ACTIVE)}
          <More title="Mehr: Komponenten, nur Teil der Fläche" open={!!l.region}>
            {l.kind !== 'pressure' && (
              <VectorInput
                item={l}
                field={vecField}
                labels={l.kind === 'moment' ? ['Mx', 'My', 'Mz'] : ['Fx', 'Fy', 'Fz']}
                unit={l.kind === 'moment' ? 'N·m' : 'N'}
                upd={(patch) => upd({ ...patch, ...(vecField === 'force' ? { followNormal: false } : {}) })}
                picking={false}
                onPick={() => {}}
                aiming={false}
                onAimToggle={null}
                presets={[]}
              />
            )}
            <RegionEditor
              item={l}
              cyl={cyl}
              drawing={drawing?.id === l.id ? drawing : null}
              onStart={(shape) => startDrawing('load', l, shape)}
              onCancel={() => setDrawing(null)}
              onChange={(region) => upd({ region })}
            />
          </More>
        </>
      )
    }
    // Körper einer Baugruppe
    const bd = sel.startsWith('b:') ? mesh.bodies?.find((x) => 'b:' + x.body === sel) : null
    if (bd) {
      const own = bodyMats[bd.name]
      const mat = own ?? material
      const rho = Number(mat.rho)
      const hidden = hiddenBodies.includes(bd.body)
      const nSurf = mesh.surfaces.filter((x) => x.body === bd.body).length
      return (
        <>
          <PropsHead title={bd.name} />
          <div className="card">
            <Stat label="Volumen" value={`${fmt(bd.volume / 1000)} cm³`} />
            {rho > 0 && <Stat label="Masse" value={`${fmt((bd.volume / 1000) * rho)} g`} />}
            <Stat label="Flächen" value={nSurf} />
          </div>
          <label className="field">
            <span>Werkstoff dieses Körpers</span>
            <select
              value={own ? own.name : ''}
              onChange={(e) => {
                const v = e.target.value
                const m = [...userMaterials, ...MATERIALS].find((x) => x.name === v)
                setBodyMats((bm) => {
                  const next = { ...bm }
                  if (!m) delete next[bd.name]
                  else next[bd.name] = materialFromPreset(m)
                  return next
                })
              }}
            >
              <option value="">wie Werkstoff ({material.name})</option>
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
            </select>
          </label>
          {own && (
            <div className="card kv-grid">
              <Stat label="E" value={`${fmt(Number(own.E))} MPa`} />
              <Stat label="Re" value={own.yield !== '' && own.yield != null ? `${fmt(Number(own.yield))} MPa` : '–'} />
              <Stat label="Rm" value={own.tensile !== '' && own.tensile != null ? `${fmt(Number(own.tensile))} MPa` : '–'} />
              <Stat label="Dichte" value={own.rho ? `${fmt(Number(own.rho))} g/cm³` : '–'} />
            </div>
          )}
          <div className="row wrap">
            <label className="check">
              <input type="checkbox" checked={!hidden} onChange={() => setHiddenBodies((h) => (hidden ? h.filter((x) => x !== bd.body) : [...h, bd.body]))} /> sichtbar
            </label>
            <button className="link" onClick={() => setHiddenBodies(mesh.bodies.filter((x) => x.body !== bd.body).map((x) => x.body))}>
              nur diesen zeigen
            </button>
            {hiddenBodies.length > 0 && (
              <button className="link" onClick={() => setHiddenBodies([])}>
                alle zeigen
              </button>
            )}
          </div>
          <p className="hint">
            Körper, die sich berühren, sind an der gemeinsamen Fläche fest verbunden (verklebt). Liegt ein Spalt dazwischen (lose Teile, Schweißteile):
            unter Verbindungen „Spalte suchen“ und als Naht oder flächige Verbindung übernehmen. Ausgeblendete Körper rechnen mit.
          </p>
        </>
      )
    }
    // Teil
    const dims = mesh.bbox[1].map((v, k) => v - mesh.bbox[0][k])
    const rho = Number(material.rho)
    return (
      <>
        <PropsHead title="Teil" />
        <div className="card">
          <Stat label="Name" value={stemOf(fileName)} />
          <Stat label="Quelle" value={partSource ?? 'STEP-Datei'} />
          <Stat label="Volumen" value={`${fmt(mesh.volume / 1000)} cm³`} />
          {(assemblyMass ?? (rho > 0 ? (mesh.volume / 1000) * rho : null)) != null && <Stat label="Masse" value={`${fmt(assemblyMass ?? (mesh.volume / 1000) * rho)} g`} />}
          <Stat label="Abmessungen" value={dims.map((v) => fmt(v)).join(' × ') + ' mm'} />
          <Stat label="Flächen" value={mesh.surfaces.length} />
          {mesh.bodies?.length > 1 && <Stat label="Baugruppe" value={`${mesh.bodies.length} Körper`} />}
        </div>
        <div className="row wrap">
          <button className="btn" disabled title="Kommt bald: eine Fläche mit Linie, Rechteck oder Kreis teilen – Lager und Lasten wirken dann auf eine Teilfläche">
            <I.IcSplit /> Fläche teilen … <span className="soon">bald</span>
          </button>
          <button className="btn" onClick={reloadPart} disabled={!!busy} title="Teil neu laden – Lager und Lasten bleiben erhalten">
            <RotateCcw size={14} /> Neue Version holen
          </button>
        </div>
        <p className="hint">
          Nur ein Teil einer Fläche soll Lager oder Last tragen? Beim Lager bzw. bei der Last unter „Mehr“ einen Bereich zeichnen.
        </p>
        <div className="row wrap">
          <button className="link" onClick={onOpenStep}>
            Andere STEP-Datei öffnen …
          </button>
          <button className="link" onClick={() => setDlg('onshape')}>
            Aus Onshape …
          </button>
        </div>
      </>
    )
  }

  const SUPPORT_ICON = Object.fromEntries(SUPPORT_KINDS.map(([k, , Icon]) => [k, Icon]))
  const LOAD_ICON = Object.fromEntries(LOAD_CHOICES.map(([k, , Icon]) => [k, Icon]))

  const modelPanel = mesh && (
    <>
      <div className="tree-head">
        <span>Studie · {ANALYSES[analysis][0]}</span>
        {analysis !== 'static' && (
          <label className="mini-count" title="Anzahl der Formen">
            <input value={modeCount} onChange={(e) => setModeCount(e.target.value)} /> Formen
          </label>
        )}
        <span className="spacer" />
        {runButton('tree')}
      </div>
      <div className="tree" role="tree">
        <TreeRow icon={I.IcPart} title="Teil" sum={[partSource ?? 'STEP-Datei', `${mesh.surfaces.length} Flächen`].join(' · ')} state="ok" on={sel === 'teil'} onClick={() => selectItem('teil')} />
        {mesh.bodies?.length > 1 &&
          mesh.bodies.map((bd) => (
            <TreeRow
              key={'b' + bd.body}
              sub
              icon={I.IcPart}
              title={bd.name}
              sum={(bodyMats[bd.name]?.name ?? `wie Werkstoff`) + (hiddenBodies.includes(bd.body) ? ' · ausgeblendet' : '')}
              muted={hiddenBodies.includes(bd.body)}
              state={null}
              on={sel === 'b:' + bd.body}
              onClick={() => selectItem('b:' + bd.body)}
            />
          ))}
        <TreeRow
          icon={I.IcMaterial}
          title="Werkstoff"
          sum={material.name + (Number(proof.sF) > 0 ? ` · Nachweis S ≥ ${fmt(Number(proof.sF))}` : '')}
          state={itemState('mat')}
          on={sel === 'mat'}
          onClick={() => selectItem('mat')}
        />
        <TreeRow
          icon={I.IcMesh}
          title="Netz"
          sum={mesh.preview ? 'grobe Vorschau – noch vernetzen' : `${fmt(mesh.mesh_size)} mm · ${mesh.elements.toLocaleString('de-DE')} Elemente`}
          state={meshPending || mesh.preview ? 'todo' : 'ok'}
          on={sel === 'netz'}
          onClick={() => selectItem('netz')}
        />
        <TreeGroup icon={I.IcSupportTree} color={SUPPORT_COLOR} title="Lager" count={supports.length} onAdd={addSupport} addTitle="Lager hinzufügen" />
        {supports.map((s, i) => (
          <TreeRow
            key={s.id}
            sub
            icon={SUPPORT_ICON[s.kind]}
            color={SUPPORT_COLOR}
            title={`Lager ${i + 1}`}
            sum={`${SUPPORT_NAME[s.kind]} · ${facesText(s.surfaces.length)}${s.region ? ' (Bereich)' : ''}`}
            state={itemState('s:' + s.id)}
            on={sel === 's:' + s.id}
            onClick={() => selectItem('s:' + s.id)}
          />
        ))}
        <TreeGroup icon={I.IcForce} color={LOAD_COLOR} title="Lasten" count={loads.length} onAdd={addLoad} addTitle="Last hinzufügen" />
        {loads.map((l, i) => (
          <TreeRow
            key={l.id}
            sub
            icon={LOAD_ICON[l.kind]}
            color={l.kind === 'moment' ? MOMENT_COLOR : LOAD_COLOR}
            title={`Last ${i + 1}`}
            sum={loadSummary(l)}
            state={itemState('l:' + l.id)}
            on={sel === 'l:' + l.id}
            onClick={() => selectItem('l:' + l.id)}
          />
        ))}
        <TreeRow
          icon={I.IcLink}
          title="Verbindungen"
          muted={!welds.length && !bolts.some((b) => b.on) && !Object.values(contactPairs).some(Boolean)}
          sum={
            welds.length || bolts.length || Object.values(contactPairs).some(Boolean)
              ? [
                  [bolts.filter((b) => b.on).length, 'Schraube', 'Schrauben'],
                  [(mesh?.touching ?? []).filter(([a, b]) => contactPairs[touchKey(mesh, a, b)]).length, 'Kontakt', 'Kontakte'],
                  [welds.filter((w) => w.kind !== 'bond').length, 'Schweißnaht', 'Schweißnähte'],
                  [welds.filter((w) => w.kind === 'bond').length, 'Verbindung', 'Verbindungen'],
                  [bolts.filter((b) => !b.on).length, 'Vorschlag', 'Vorschläge'],
                ]
                  .filter(([n]) => n)
                  .map(([n, a, b]) => `${n} ${n > 1 ? b : a}`)
                  .join(' · ')
              : 'optional – Schrauben, Kontakt, Schweißnähte'
          }
          state={welds.length || bolts.some((b) => b.on) || Object.values(contactPairs).some(Boolean) ? itemState('verb') : null}
          on={sel === 'verb'}
          onClick={() => selectItem('verb')}
        />
      </div>
      <div className="props">{renderProps()}</div>
    </>
  )

  const probeQ = QUANTITIES[quantity]
  const probeVals = probe && result && display && !display.modal
    ? {
        vm: result.von_mises[probe.node],
        u: Math.hypot(result.displacement[3 * probe.node], result.displacement[3 * probe.node + 1], result.displacement[3 * probe.node + 2]),
        s: result.utilization ? 1 / Math.max(result.utilization[probe.node], 1e-12) : null,
      }
    : null

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setHome(true)} title="Startseite">
          <img src={logo} alt="" width={22} height={22} />
          <span>Projekt-FEM</span>
        </button>
        {!showStart && modelView && mesh && (
          <>
            {fileName && (
              <span className="file" title={stepPath}>
                {stemOf(fileName)}
              </span>
            )}
            <Menu label={<><span className="muted">Analyse:</span> {ANALYSES[analysis][0]}</>} className="btn" title="Analyseart wählen">
              {Object.entries(ANALYSES).map(([k, [lab, sub]]) => (
                <MenuItem key={k} onClick={() => setAnalysis(k)} sub={sub} hint={analysis === k ? '✓' : null}>
                  {lab}
                </MenuItem>
              ))}
            </Menu>
            <div className="segmented">
              <button className={view === 'setup' ? 'on' : ''} onClick={() => switchView('setup')}>
                Modell
              </button>
              <button className={view === 'result' ? 'on' : ''} disabled={!result && !modes} onClick={() => switchView('result')}>
                Ergebnis{resultStale && result ? ' (veraltet)' : ''}
              </button>
            </div>
          </>
        )}
        {!showStart && !modelView && <span className="file">{{ cad: cad.base ? 'Konstruktion – ' + stemOf(cad.base) : 'Konstruktion – neues Teil', geometry: 'Geometrie anpassen', topo: 'Leichtbau', study: 'Parameterstudie', frame: 'Stabwerk' }[view]}</span>}
        <span className="spacer" />
        {!api.isDesktop && (
          <span className="remote-badge" title="Die Rechnung läuft auf dem Rechner, auf dem Projekt-FEM die Heimnetz-Freigabe hat">
            <Wifi size={14} /> Rechnet auf {window.location.hostname}
          </span>
        )}
        <Menu label="Datei" align="right">
          <MenuItem onClick={onOpenStep} hint="Strg+O" disabled={gmsh === null}>
            STEP-Datei öffnen …
          </MenuItem>
          <MenuItem onClick={() => setDlg('onshape')} disabled={gmsh === null}>
            Aus Onshape-Bibliothek …
          </MenuItem>
          <MenuItem onClick={() => onLoadProject()} disabled={gmsh === null}>
            Projekt öffnen …
          </MenuItem>
          <MenuSep />
          <MenuItem onClick={onSaveProject} hint="Strg+S" disabled={!stepPath}>
            Projekt speichern …
          </MenuItem>
          <MenuSep />
          <MenuItem onClick={() => switchView('frame')}>Stabwerk</MenuItem>
          <MenuItem onClick={() => setHome(true)}>Startseite</MenuItem>
        </Menu>
        <Menu label="Export" align="right">
          <MenuItem onClick={onReport} disabled={!result || resultStale}>
            Bericht als PDF
          </MenuItem>
          <MenuItem onClick={videoFromMenu} disabled={!result || resultStale || showModes || showStart}>
            Video der Verformung
          </MenuItem>
          <MenuItem onClick={onImage} disabled={!mesh || showStart || view === 'frame'}>
            Bild der Ansicht (PNG)
          </MenuItem>
          <MenuSep />
          <MenuItem
            onClick={onResultToCad}
            disabled={!canResultToCad}
            sub={isOnshape ? 'Beschreibung der Teile' : partSource === 'SolidCraft' ? 'Parameter FEM_…' : 'für Teile aus Onshape oder SolidCraft'}
          >
            Ergebnis → {partSource === 'SolidCraft' ? 'SolidCraft' : 'Onshape'}
          </MenuItem>
          <MenuItem onClick={onExportMathpad} disabled={!result || resultStale}>
            MathPad-Rechenblatt
          </MenuItem>
          <MenuItem onClick={onExportVtu} disabled={!result}>
            ParaView (.vtu)
          </MenuItem>
          <MenuSep />
          <MenuItem onClick={exportGeo} disabled={!geoStep}>
            Geänderte Geometrie (STEP)
          </MenuItem>
          <MenuItem onClick={exportTopo} disabled={!topo}>
            Leichtbau-Form (STL)
          </MenuItem>
        </Menu>
        <button className="btn ghost icon" title="Einstellungen" aria-label="Einstellungen" onClick={() => setDlg('settings')}>
          <I.IcSliders />
        </button>
        {!showStart && modelView && mesh && runButton('head')}
      </header>

      <div className="main">
        {showStart ? (
          <StartPage
            gmsh={gmsh}
            onOpenStep={onOpenStep}
            onOnshape={() => setDlg('onshape')}
            onProject={() => onLoadProject()}
            onFrame={() => switchView('frame')}
            onNewPart={newCadPart}
            onRecent={openRecent}
            onDropFile={onDropFile}
            current={mesh ? stemOf(fileName) : null}
            onBack={() => setHome(false)}
          />
        ) : (
          <>
            <nav className="rail" aria-label="Werkzeuge">
              {[
                ['Modell', 'Modell und Ergebnis', I.IcPart, modelView, () => switchView(modelView ? view : 'setup'), false],
                ['Konstruktion', 'Konstruktion: Teil zeichnen oder ändern (Skizze, Extrudieren, Bohrung, Verrunden …)', I.IcWrench, view === 'cad', () => switchView('cad'), false],
                ['Leichtbau', 'Leichtbau-Vorschlag (Topologieoptimierung)', I.IcFeather, view === 'topo', () => switchView('topo'), !mesh],
                ['Studie', 'Parameterstudie', I.IcChart, view === 'study', () => switchView('study'), !mesh],
                ['Stabwerk', 'Stabwerk: Balken, Rahmen, Fachwerke', I.IcTruss, view === 'frame', () => switchView('frame'), false],
              ].map(([short, title, Icon, on, click, dis]) => (
                <button key={short} className={'rail-btn' + (on ? ' on' : '')} title={title} aria-label={title} disabled={dis} onClick={click}>
                  <Icon size={20} />
                  <span>{short}</span>
                </button>
              ))}
            </nav>

            {view === 'cad' ? (
              <CadStudio
                cad={cad}
                setCad={setCad}
                nav={nav}
                applied={cadApplied}
                onApply={onCadApply}
                onExport={onCadExport}
                busy={!!busy}
                onError={(e) => setError(e)}
                onNotice={setNotice}
              />
            ) : (
            <>
            <aside className={'sidebar' + (view === 'setup' ? ' flush' : '')} ref={sidebar}>
              {view === 'setup' && modelPanel}
              {view === 'result' &&
                (showModes ? (
                  <ModesPanel modes={modes} setModes={setModes} loads={loads} />
                ) : (
                  result && (
                    <ResultSidebar
                      result={result}
                      material={material}
                      proof={proof}
                      quantity={quantity}
                      setQuantity={setQuantity}
                      stale={resultStale}
                      canRerun={ready}
                      onRerun={run}
                      reference={reference}
                      current={summary(result, mesh, geoStep ? 'Geändert' : 'Aktuell')}
                      onPin={() => setReference(summary(result, mesh, geoStep ? 'Geändert' : 'Vorher'))}
                      onUnpin={() => setReference(null)}
                      detailsOpen={detailsOpen}
                      mass={assemblyMass}
                      bolts={bolts}
                      boltFatigue={tight.mode !== 'none' && tight.fatigue}
                      setDetailsOpen={setDetailsOpen}
                    />
                  )
                ))}
              {view === 'frame' && (
                <FrameSidebar
                  frame={frame}
                  setFrame={setFrame}
                  results={frameResults}
                  onSolve={onFrameSolve}
                  busy={!!busy}
                  display={frameDisplay}
                  setDisplay={setFrameDisplay}
                  onSave={() =>
                    api
                      .saveBlob(new Blob([JSON.stringify({ format: 'projekt-fem-stabwerk', version: 1, ...frame }, null, 2)], { type: 'application/json' }), 'stabwerk.stab.json', 'Stabwerk', 'json')
                      .catch((e) => setError(String(e)))
                  }
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
              )}
              {view === 'study' && (
                <StudyPanel
                  study={study}
                  setStudy={setStudy}
                  params={studyParams}
                  rows={studyRows}
                  canRun={problems.length === 0 && !busy}
                  onRun={runStudy}
                  onCsv={exportStudyCsv}
                  note={
                    osVars?.error
                      ? `Onshape-Variablen nicht abrufbar: ${osVars.error}`
                      : Array.isArray(osVars) && !osVars.length
                        ? 'Das Onshape-Teilestudio hat keine Variablen. In Onshape eine Variable anlegen (Feature „Variable“, z. B. #dicke) und im Maß verwenden.'
                        : null
                  }
                />
              )}
              {view === 'geometry' && (
                <GeometryPanel
                  ops={geoOps}
                  setOps={setGeoOps}
                  pending={geoPending}
                  info={geoInfo}
                  warnings={geoWarnings}
                  picking={geoPick}
                  onPick={() => {
                    setDrawing(null)
                    setGeoPick(!geoPick)
                  }}
                  drawing={drawing?.type === 'geo' ? drawing : null}
                  onDraw={(op) => {
                    setGeoPick(false)
                    setDrawing({ type: 'geo', id: op.id, shape: op.shape })
                  }}
                  onCancelDraw={() => setDrawing(null)}
                  onApply={onApplyGeometry}
                  busy={!!busy}
                  modified={!!geoStep}
                  onExport={exportGeo}
                  mesh={mesh}
                />
              )}
              {view === 'topo' && (
                <TopoSection
                  topo={topo}
                  setTopo={setTopo}
                  onTopo={onTopo}
                  onTopoThreshold={onTopoThreshold}
                  canTopo={supports.length > 0 && loads.length > 0 && problems.length === 0}
                  onTopoStl={exportTopo}
                />
              )}
            </aside>

            <section className={'stage' + (view === 'frame' ? ' is-frame' : '')}>
              {view === 'frame' && <FrameView frame={frame} results={frameResults} display={frameDisplay} />}
              <Viewport
                ref={viewRef}
                mesh={mesh}
                mode={mode}
                surfaceTint={surfaceTint}
                pickable={view === 'setup' || (geoPick && view === 'geometry')}
                layers={material.layered && mode !== 'result' ? { dir: material.buildDir ?? [0, 0, 1] } : null}
                onPick={onPick}
                result={display}
                showMesh={showMesh}
                arrows={view === 'setup' ? arrows : []}
                markers={mode === 'result' ? markers : []}
                onProbe={probeOn ? setProbe : null}
                drawing={view === 'setup' || view === 'geometry' ? drawing?.shape : null}
                planeNormal={planeNormal}
                onDraw={onDraw}
                overlays={overlays}
                topoShape={(view === 'geometry' || view === 'topo') && topo?.show ? topo.surface : null}
                aim={view === 'setup' ? aimView : null}
                onAim={onAim}
                nav={nav}
                look={look}
                hiddenSurfaces={hiddenSurfaces}
                bolts={view === 'frame' ? [] : boltGlyphs}
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
              {boltPick && view === 'setup' && (
                <div className="pick-hint">
                  <MousePointerClick size={15} />
                  Bohrung anklicken, in der eine Schraube sitzen soll – fluchtende Bohrungen der anderen Teile kommen dazu
                  <button className="btn small" onClick={() => setBoltPick(false)}>
                    <X size={14} /> Abbrechen
                  </button>
                </div>
              )}
              {active && view === 'setup' && (
                <div className="pick-hint">
                  <MousePointerClick size={15} />
                  {active.type === 'weldA' || active.type === 'weldB'
                    ? `Fläche ${active.type === 'weldA' ? 'A' : 'B'} der Naht anklicken`
                    : `Flächen anklicken, um sie ${active.type === 'support' ? 'dem Lager' : 'der Last'} hinzuzufügen oder zu entfernen`}
                  <button className="btn small primary" onClick={() => setActive(null)}>
                    <Check size={14} /> Fertig
                  </button>
                </div>
              )}
              {mode === 'result' && display && (
                <Legend display={display} quantity={display.modal ? { label: modes.kind === 'modal' ? 'Schwingform' : 'Knickform', unit: '', hint: 'relativ' } : QUANTITIES[quantity]} />
              )}
              {mode === 'result' && probe && display && !display.modal && (
                <div className="probe">
                  <button className="icon-btn" onClick={() => setProbe(null)} aria-label="Messpunkt schließen">
                    <X size={14} />
                  </button>
                  <div className="probe-title">Messpunkt</div>
                  <div>
                    {probeQ.label}:{' '}
                    <strong>
                      {display.reverse && display.values[probe.node] >= 10 ? '≥ 10' : fmt(display.values[probe.node])} {probeQ.unit}
                    </strong>
                  </div>
                  {probeVals && (
                    <div className="muted">
                      σv {fmt(probeVals.vm)} MPa · u {fmt(probeVals.u)} mm{probeVals.s != null ? ` · S ${probeVals.s >= 10 ? '≥ 10' : fmt(probeVals.s)}` : ''}
                    </div>
                  )}
                  <div className="muted">bei {fmtVec([0, 1, 2].map((k) => mesh.positions[3 * probe.node + k]))} mm (unverformt)</div>
                </div>
              )}

              {view === 'setup' && mesh && !drawing && !aim && !dirPick && !bedPick && (
                <div className="float-bar">
                  <div className="tb" role="toolbar" aria-label="Modell">
                    <button className="btn small" disabled title="Kommt bald: eine Fläche mit Linie, Rechteck oder Kreis teilen">
                      <I.IcSplit /> Fläche teilen <span className="soon">bald</span>
                    </button>
                    <button className={'btn small' + (showMesh ? ' on' : '')} onClick={() => setShowMesh(!showMesh)}>
                      <Grid2x2 size={14} /> Netz
                    </button>
                    <span className="div" />
                    <span className="tb-hint">{NAV_PRESETS[nav.preset]?.help}</span>
                    <button className="btn small ghost" title="Maus und Trackpad einstellen" aria-label="Maus und Trackpad einstellen" onClick={() => setDlg('settings:nav')}>
                      <I.IcSliders size={14} />
                    </button>
                  </div>
                </div>
              )}

              {mode === 'result' && display && !display.modal && (
                <div className="float-bar">
                  <div className="tb" role="toolbar" aria-label="Darstellung">
                    <span className="tb-label">Verformung</span>
                    <div className="segmented small">
                      <button className={deform === 'off' ? 'on' : ''} onClick={() => setDeform('off')}>
                        aus
                      </button>
                      <button className={deform === 'true' ? 'on' : ''} onClick={() => setDeform('true')} title="maßstäblich">
                        1:1
                      </button>
                      <button className={deform === 'auto' ? 'on' : ''} onClick={() => setDeform('auto')} title="überhöht, damit man sie sieht">
                        ×{fmt(display.auto)}
                      </button>
                    </div>
                    <button className={'btn small' + (anim.on ? ' on' : '')} onClick={() => setAnim({ ...anim, on: !anim.on })} title="Last von 0 auf 100 % steigern und zurück">
                      {anim.on ? <I.IcPause size={12} /> : <I.IcPlay size={12} />} Animation
                    </button>
                    {anim.on && (
                      <div className="segmented small">
                        {[[0.5, '½×'], [1, '1×'], [2, '2×']].map(([v, lab]) => (
                          <button key={v} className={anim.speed === v ? 'on' : ''} onClick={() => setAnim({ ...anim, speed: v })}>
                            {lab}
                          </button>
                        ))}
                      </div>
                    )}
                    <span className="div" />
                    <button className={'btn small' + (cut.on ? ' on' : '')} onClick={() => setCut({ ...cut, on: !cut.on })} title="Schnitt: ins Bauteil schauen">
                      <I.IcCut /> Schnitt
                    </button>
                    <button
                      className={'btn small' + (iso.on ? ' on' : '')}
                      disabled={quantity === 'shell'}
                      onClick={() => setIso({ ...iso, on: !iso.on })}
                      title="Iso-Clip: nur Bereiche über (oder unter) einem Wert farbig zeigen"
                    >
                      <I.IcIso /> Iso-Clip
                    </button>
                    <button
                      className={'btn small' + (probeOn ? ' on' : '')}
                      onClick={() => {
                        setProbeOn(!probeOn)
                        setProbe(null)
                      }}
                      title="Messen: auf das Bauteil klicken zeigt die Werte an dieser Stelle"
                    >
                      <I.IcProbe /> Messen
                    </button>
                    <button className={'btn small' + (showMesh ? ' on' : '')} onClick={() => setShowMesh(!showMesh)}>
                      Netz
                    </button>
                    <button className={'btn small' + (minmax ? ' on' : '')} onClick={() => setMinmax(!minmax)} title="Größt-/Kleinstwert markieren">
                      Min/Max
                    </button>
                    <button className="btn small" disabled={anim.recording} onClick={onVideo} title="Video der Verformung mit Farbskala speichern" aria-label="Video speichern">
                      {anim.recording ? <Loader2 size={14} className="spin" /> : <Video size={14} />}
                    </button>
                    {cut.on && (
                      <div className="tb-row">
                        <span className="tb-label">Schnittebene</span>
                        <div className="segmented small">
                          {['X', 'Y', 'Z'].map((a, k) => (
                            <button key={a} className={cut.axis === k ? 'on' : ''} onClick={() => setCut({ ...cut, axis: k })}>
                              {a}
                            </button>
                          ))}
                        </div>
                        <input type="range" className="slim-range grow" min={0} max={100} step={0.5} value={cut.pos} aria-label="Lage der Schnittebene" onChange={(e) => setCut({ ...cut, pos: Number(e.target.value) })} />
                        <button className="btn small" onClick={() => setCut({ ...cut, flip: !cut.flip })}>
                          ⇄ Seite
                        </button>
                      </div>
                    )}
                    {iso.on && quantity !== 'shell' && (
                      <div className="tb-row">
                        <span className="tb-label">Zeige nur {QUANTITIES[quantity].label}</span>
                        <div className="segmented small">
                          <button className={iso.above ? 'on' : ''} onClick={() => setIso({ ...iso, above: true })}>
                            über
                          </button>
                          <button className={!iso.above ? 'on' : ''} onClick={() => setIso({ ...iso, above: false })}>
                            unter
                          </button>
                        </div>
                        <input type="range" className="slim-range grow" min={0} max={1} step={0.005} value={iso.t} aria-label="Schwellwert" onChange={(e) => setIso({ ...iso, t: Number(e.target.value) })} />
                        <b className="tb-val">
                          {fmt(display.min + iso.t * (display.max - display.min))} {QUANTITIES[quantity].unit}
                        </b>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {mode === 'result' && display?.modal && (
                <div className="float-bar">
                  <div className="tb" role="toolbar" aria-label="Darstellung">
                    <button className={'btn small' + (modes.animate ? ' on' : '')} onClick={() => setModes({ ...modes, animate: !modes.animate })}>
                      {modes.animate ? <I.IcPause size={12} /> : <I.IcPlay size={12} />} Animation
                    </button>
                    <button className={'btn small' + (showMesh ? ' on' : '')} onClick={() => setShowMesh(!showMesh)}>
                      Netz
                    </button>
                  </div>
                </div>
              )}
            </section>
            </>
            )}
          </>
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
              <div className="busy-actions">
                {meshing?.fresh && !meshing.preview && (
                  <button
                    className="btn small"
                    title="Vernetzen abbrechen und die Datei mit einem groben Netz laden – richtig vernetzen geht später unter „Netz“"
                    onClick={() => {
                      if (meshingRef.current) meshingRef.current.wantPreview = true
                      api.cancel().catch(() => {})
                    }}
                  >
                    Erst grob laden
                  </button>
                )}
                <button className="btn small" onClick={() => api.cancel().catch(() => {})}>
                  <X size={13} /> Abbrechen
                </button>
              </div>
            </div>
          </div>
        )}
        {notice && (
          <div className="toast notice-toast">
            <Check size={16} />
            <span>{notice}</span>
            <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Schließen">
              <X size={14} />
            </button>
          </div>
        )}
        {error && (
          <div className="toast error">
            <TriangleAlert size={16} />
            <span>{error}</span>
            <button className="icon-btn" onClick={() => setError(null)} aria-label="Schließen">
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {dlg === 'onshape' && <OnshapeLibrary onClose={() => setDlg(null)} onError={(e) => setError(String(e))} />}
      {dlg?.startsWith('settings') && <Settings tab={dlg.split(':')[1] ?? 'nav'} onClose={() => setDlg(null)} onError={(e) => setError(String(e))} />}
    </div>
  )
}

// --- Bausteine der neuen Oberfläche ---------------------------------------------------------------

function PropsHead({ title, onDelete }) {
  return (
    <div className="props-head">
      <h3>{title}</h3>
      <span className="spacer" />
      {onDelete && (
        <button className="icon-btn" title="Löschen" aria-label={`${title} löschen`} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      )}
    </div>
  )
}

// Eintrag im Studienbaum: Symbol, Titel, Kurzfassung, Status (grün = fertig, Kreis = offen)
function TreeRow({ icon: Icon, color, title, sum, state, on, onClick, sub, muted }) {
  return (
    <button className={'ti' + (on ? ' on' : '') + (sub ? ' sub' : '') + (muted ? ' muted' : '')} role="treeitem" aria-selected={on} onClick={onClick}>
      <Icon size={sub ? 16 : 18} style={{ color: color ?? undefined }} />
      <span className="ti-text">
        <b>{title}</b>
        {sum && <span className="sum">{sum}</span>}
      </span>
      {state ? <span className={'dot ' + state} title={state === 'ok' ? 'festgelegt' : 'noch offen'} /> : <span />}
    </button>
  )
}

function TreeGroup({ icon: Icon, color, title, count, onAdd, addTitle }) {
  return (
    <div className="tg">
      <Icon size={18} style={{ color }} />
      <b>
        {title}
        {count ? ` (${count})` : ''}
      </b>
      {!count && <span className="sum">noch keins</span>}
      <span className="spacer" />
      <button className="btn small add" onClick={onAdd} title={addTitle} aria-label={addTitle}>
        <Plus size={14} /> neu
      </button>
    </div>
  )
}

// aufklappbarer Bereich für seltener gebrauchte Einstellungen
function More({ title, open: initial = false, children }) {
  const [open, setOpen] = useState(initial)
  return (
    <div className={'more' + (open ? ' open' : '')}>
      <button className="more-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {title}
      </button>
      {open && <div className="more-body">{children}</div>}
    </div>
  )
}

// Zahl mit Einheit; Komma oder Punkt; meldet nur gültige Zahlen
function NumInput({ value, unit, onChange }) {
  const [text, setText] = useState(null)
  const shown = text ?? (Number.isFinite(value) ? String(Number(Number(value).toPrecision(6))).replace('.', ',') : '')
  return (
    <div className="input-unit">
      <input
        value={shown}
        inputMode="decimal"
        onFocus={() => setText(shown)}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value)
          const v = Number(e.target.value.replace(',', '.'))
          if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= 0) onChange(v)
        }}
      />
      {unit && <em>{unit}</em>}
    </div>
  )
}

// Schrauben: Vorspannung, Kräfte im Betrieb und Nachweis (VDI 2230)
function BoltCard({ rows, sF, fatigue }) {
  if (!rows.length) return null
  const ok = rows.every((r) => r.safety >= r.need && r.pressOk && r.engOk && r.fatOk)
  const pre = rows.some((r) => r.preload > 0)
  const spread = rows.some((r) => r.preload_min != null)
  const mm1 = (v) => (Math.round(v * 10) / 10).toLocaleString('de-DE')
  // kN auf drei Stellen, ohne Einheit (steht im Kopf)
  const kN = (v) => Number((v / 1000).toPrecision(3)).toLocaleString('de-DE')
  const pct = (x) => `${(100 * x).toFixed(0)} %`
  return (
    <div className={'proof ' + (ok ? 'good' : 'bad')}>
      <div className="item-head">
        <I.IcPin size={15} />
        <strong>Schrauben{ok ? ' – Nachweis erfüllt' : ' – Nachweis NICHT erfüllt'}</strong>
      </div>
      <table className="weld-table bolt-table">
        <thead>
          <tr>
            <th />
            {pre && <th title={spread ? 'Vorspannkraft kleinste (nach Setzen) … größte (Streuung beim Anziehen)' : 'Vorspannkraft nach dem Anziehen'}>F_V kN</th>}
            <th title="Schraubenkraft im Betrieb (mit Vorspannung)">F_S kN</th>
            <th title="Querkraft auf dem Schaft">Quer N</th>
            <th>S</th>
            {fatigue && <th title="Dauerfestigkeit: σ_ASV / σ_a, Last schwellt zwischen 0 und Betriebslast, nötig 1,2">S_D</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.name}
              title={`${r.name} – M${fmt(r.d)} ${r.cls}: Rp0,2 = ${r.rp} MPa, A_s = ${fmt(r.stress_area)} mm²${r.preload > 0 ? ` · Anziehmoment M_A = ${fmt(r.torque)} N·m · Zusatzkraft aus Last ${fmt((r.axial - r.preload) / 1000)} kN${r.phi_k != null ? ` · Kraftverhältnis Φ_K = ${fmt(r.phi_k)}` : ''}${r.setting_loss != null && r.preload_min != null ? ` · Setzverlust F_Z = ${fmt(r.setting_loss / 1000)} kN` : ''}` : ''} · σ_a = ${fmt(r.stress_amplitude)} MPa (σ_ASV = ${fmt(r.fatigue_limit)}) · Flächenpressung unter Kopf ${fmt(r.bearing_pressure)} MPa · σ_red = ${fmt(r.sv)} MPa · Biegemoment ${fmt(r.moment / 1000)} N·m · Klemmlänge ${fmt(r.clamp)} mm`}
            >
              <td className="bolt-cell">
                <span>{r.name}</span> <em className="muted">{r.cls}</em>
              </td>
              {pre && <td>{r.preload > 0 ? (r.preload_min != null ? `${kN(r.preload_min)}…${kN(r.preload)}` : kN(r.preload)) : '–'}</td>}
              <td>{kN(r.axial)}</td>
              <td>{Number(r.shear.toPrecision(3)).toLocaleString('de-DE')}</td>
              <td className={r.safety >= r.need ? 'good' : 'bad'}>{Number.isFinite(r.safety) ? fmt(Math.min(r.safety, 99)) : '–'}</td>
              {fatigue && <td className={r.fatOk ? 'good' : 'bad'}>{Number.isFinite(r.sD) ? fmt(Math.min(r.sD, 99)) : '–'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <table className="weld-table bolt-table">
        <thead>
          <tr>
            <th />
            <th title="Flächenpressung unter dem Kopf bzw. der Scheibe / Grenzflächenpressung p_G des Teils darunter">Kopf p/p_G</th>
            <th title="Flächenpressung unter der Mutter / p_G">Mutter</th>
            <th title="eingeschraubte Länge in der Gewindebohrung / nötige, damit das Innengewinde nicht vor der Schraube ausreißt">Gewinde mm</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="bolt-cell" title={r.name}>
                <span>{r.name}</span>
              </td>
              <td
                className={r.pHead == null ? '' : r.pHead <= 1 ? 'good' : 'bad'}
                title={`p = ${fmt(r.bearing_pressure)} MPa${r.bearing_limit ? `, p_G = ${fmt(r.bearing_limit)} MPa (${r.bearing_limit_source})` : ', p_G unbekannt (Rm beim Werkstoff angeben)'}`}
              >
                {r.pHead == null ? `${fmt(r.bearing_pressure)} MPa` : pct(r.pHead)}
              </td>
              <td className={r.pNut == null ? '' : r.pNut <= 1 ? 'good' : 'bad'} title={r.nut_pressure != null ? `p = ${fmt(r.nut_pressure)} MPa${r.nut_limit ? `, p_G = ${fmt(r.nut_limit)} MPa` : ''}` : 'Gewindebohrung'}>
                {r.pNut != null ? pct(r.pNut) : r.nut_pressure != null ? `${fmt(r.nut_pressure)} MPa` : '–'}
              </td>
              <td
                className={r.engagement == null || r.engagement_min == null ? '' : r.engOk ? 'good' : 'bad'}
                title={r.engagement != null ? `eingeschraubt ${fmt(r.engagement)} mm, nötig ${r.engagement_min != null ? fmt(r.engagement_min) + ' mm' : '– (Rm des Teils fehlt)'}` : 'mit Mutter'}
              >
                {r.engagement != null ? `${mm1(r.engagement)}${r.engagement_min != null ? ` / ${mm1(r.engagement_min)}` : ''}` : '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pre && (
        <p className="hint">
          Anziehmomente: {rows.filter((r) => r.preload > 0).map((r) => `${r.name} ${fmt(r.torque)} N·m`).join(' · ')}
        </p>
      )}
      <p className="hint">
        σ_red = √((F_S/A_s + M_b/W)² + 3·(0,5·M_G/W_p + Q/A_s)²) gegen Rp0,2
        {pre
          ? ', mit Gewindetorsion aus dem Anziehen; vorgespannt nötig S ≥ 1 (VDI 2230: Schraube wird absichtlich hoch ausgenutzt)'
          : `, nötig S ≥ ${fmt(sF)}`}
        . Flächenpressung gegen p_G (VDI 2230), Einschraubtiefe: Innengewinde soll mindestens die Bruchkraft der Schraube tragen
        (l_e ≥ Rm_S·A_s / (0,6·Rm·0,75·π·d)). Bei Vorschlägen aus Bohrungen ist angenommen, dass die Schraube durch die ganze
        Gewindebohrung reicht.
      </p>
    </div>
  )
}

// Fugen verschraubter Teile mit Kontakt: aufliegend/klafft, Restklemmkraft, Pressung, Rutschen
function JointCard({ result }) {
  const joints = result.joints ?? []
  if (!joints.length) return null
  const nameOf = (id) => (result.bodies ?? []).find((b) => b.body === id)?.name ?? `Körper ${id}`
  const pct = (x) => `${(100 * x).toFixed(0)} %`
  const force = (v) => (Math.abs(v) < 0.05 ? '≈ 0 N' : Math.abs(v) < 1000 ? `${fmt(v)} N` : `${fmt(v / 1000)} kN`)
  const bolted = (result.bolts ?? []).length > 0
  return (
    <div className="proof bodies-card">
      <div className="item-head">
        <I.IcLink size={15} />
        <strong>Fugen (Kontakt)</strong>
      </div>
      {joints.map((j, i) => {
        const gap = 1 - j.closed
        return (
          <div key={i} className="joint">
            <b>
              {nameOf(j.body_a)} ↔ {nameOf(j.body_b)}
            </b>
            <Stat
              label="liegt auf"
              value={(gap > 0.005 ? pct(j.closed) : 'ganz') + (j.closed_preload != null && Math.abs(j.closed_preload - j.closed) > 0.005 ? ` (angezogen ${pct(j.closed_preload)})` : '')}
            />
            <Stat label={bolted ? 'Restklemmkraft' : 'Druckkraft'} value={force(j.pressure_force)} />
            <Stat label="max. Flächenpressung" value={`${fmt(j.max_pressure)} MPa`} />
            <Stat
              label="Querkraft über Reibung"
              value={
                j.friction_limit == null
                  ? `${force(j.friction_force)} (haftet)`
                  : j.friction_limit > 0
                    ? `${force(j.friction_force)} von ${force(j.friction_limit)} (${pct(j.friction_force / j.friction_limit)})`
                    : 'reibungsfrei'
              }
            />
          </div>
        )
      })}
      <p className="hint">
        {bolted ? (
          <>
            {(result.bolts ?? []).some((b) => b.preload_min != null) && 'Fuge mit der kleinsten Vorspannung (nach Streuung und Setzen) bewertet. '}
            Außerhalb der Druckkegel um die Schrauben liegen Platten oft nicht auf – das ist normal. Öffnet erst die Last die Fuge oder reicht der
            Reibschluss µ·F_K nicht, steht ein Hinweis unter Details. Gerechnet: erst Schrauben anziehen, dann Last.
          </>
        ) : (
          'Kontakt: Druck wird übertragen, Zug nicht (die Teile heben ab); quer hält die Reibung bis µ·Pressung, darüber rutschen sie.'
        )}
      </p>
    </div>
  )
}

// Baugruppe: Kennwerte je Körper und Kräfte zwischen den Körpern
function BodiesCard({ result }) {
  const bodies = result.bodies ?? []
  const bonds = (result.welds ?? []).filter((w) => w.name?.startsWith('Verbindung'))
  if (bodies.length < 2 && !bonds.length) return null
  const nameOf = (id) => bodies.find((b) => b.body === id)?.name ?? `Körper ${id}`
  const pairs = []
  for (const b of bodies) for (const [o, f] of b.interfaces ?? []) if (b.body < o) pairs.push([b.name, nameOf(o), f])
  return (
    <div className="proof bodies-card">
      <div className="item-head">
        <I.IcPart size={15} />
        <strong>Körper der Baugruppe</strong>
      </div>
      {bodies.length > 1 && (
        <table>
          <thead>
            <tr>
              <th />
              <th>σv max</th>
              <th>u max</th>
              <th>S</th>
            </tr>
          </thead>
          <tbody>
            {bodies.map((b) => (
              <tr key={b.body} title={b.material}>
                <td>{b.name}</td>
                <td>{fmt(b.max_von_mises)} MPa</td>
                <td>{fmt(b.max_displacement)} mm</td>
                <td className={b.safety == null ? '' : b.safety >= 1 ? 'good' : 'bad'}>{b.safety == null ? '–' : fmt(b.safety)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(pairs.length > 0 || bonds.length > 0) && (
        <>
          <span className="mat-head">Kräfte zwischen den Körpern</span>
          {pairs.map(([a, o, f]) => (
            <div key={a + o} title={`(${fmtVec(f)}) N`}>
              <Stat label={`${a} ↔ ${o}`} value={`${fmt(Math.hypot(...f))} N`} />
            </div>
          ))}
          {bonds.map((w) => (
            <div key={w.name} title={`(${fmtVec(w.force)}) N`}>
              <Stat label={w.name} value={`${fmt(Math.hypot(...w.force))} N`} />
            </div>
          ))}
        </>
      )}
      <p className="hint">Spannungen je Körper nur aus seinen eigenen Elementen; Sicherheit mit dem Werkstoff des Körpers.</p>
    </div>
  )
}

// Ergebnis: Urteil oben (grün/rot), Größe wählen, Kennwerte, Details zum Aufklappen
function ResultSidebar({ result, material, proof, quantity, setQuantity, stale, canRerun, onRerun, reference, current, onPin, onUnpin, detailsOpen, setDetailsOpen, mass, bolts = [], boltFatigue = false }) {
  const rho = Number(material.rho)
  const massG = mass ?? (rho > 0 ? (result.solid_volume / 1000) * rho : null)
  const rows = proofRows(result, proof)
  const wrows = weldRows(result, material)
  const weldBad = wrows.some((w) => w.util != null && w.util > 1)
  const brows = boltRows(result, bolts, Number(proof.sF) > 0 ? Number(proof.sF) : 1, boltFatigue)
  const sF = Number(proof.sF) > 0 ? Number(proof.sF) : 1
  const boltBad = brows.some((b) => b.safety < b.need || !b.pressOk || !b.engOk || !b.fatOk)
  const sf = result.safety
  const hasYield = material.yield !== '' && material.yield != null
  let tone
  let title
  const lines = []
  if (rows.length) {
    const ok = rows.every((r) => r[3] <= 1) && !weldBad && !boltBad
    tone = ok ? 'good' : 'bad'
    title = ok ? 'Nachweis erfüllt' : 'Nachweis nicht erfüllt'
    for (const [lab, have, need] of rows)
      lines.push(
        lab === 'Verformung' ? (
          <>
            Verformung <b>{fmt(have)} mm</b>, zulässig {fmt(need)} mm
          </>
        ) : (
          <>
            {lab === 'Bruch (Rm)' ? 'Bruch' : hasYield ? 'Fließen' : 'Festigkeit'} <b>S = {fmt(have)}</b>, nötig {fmt(need)}
          </>
        ),
      )
    if (weldBad) lines.push(<>Schweißnaht überlastet – siehe unten</>)
    if (boltBad) lines.push(<>Schraube nicht ausreichend – siehe unten</>)
  } else if (sf != null) {
    tone = sf >= 1.5 ? 'good' : sf >= 1 ? 'ok' : 'bad'
    title = `Sicherheit S = ${fmt(sf)}`
    lines.push(sf < 1 ? 'Festigkeit überschritten' : 'ohne Nachweis – erforderliche Sicherheit beim Werkstoff angeben')
  } else {
    tone = 'neutral'
    title = 'Ergebnis'
    lines.push('Für Sicherheit und Nachweis Re oder Rm beim Werkstoff angeben')
  }
  const basis = result.governing
    ? `mit Schichtaufbau, maßgeblich: ${result.governing}`
    : hasYield
      ? `gegen Fließen, Re = ${fmt(Number(material.yield))} MPa`
      : material.tensile !== '' && material.tensile != null
        ? `gegen Bruch, Rm = ${fmt(Number(material.tensile))} MPa`
        : ''
  // Baugruppe: der Körper mit der kleinsten Sicherheit bestimmt das Urteil
  const weakest = (result.bodies ?? []).filter((b) => b.safety != null).sort((a, b) => a.safety - b.safety)[0]
  const basisText =
    result.bodies?.length > 1 && weakest ? `Baugruppe · maßgeblich: ${weakest.name} (${weakest.material})` : `${material.name}${basis ? ` · ${basis}` : ''}`
  const singular = result.warnings.some((w) => w.includes('direkt an einem Lager'))
  // nur Größen, die es für dieses Ergebnis gibt (Sicherheit nur mit Festigkeitswerten, Schicht/Infill nur beim 3D-Druck)
  const avail = (k) => !(FIELD_OF[k] && FIELD_OF[k][0] !== 'von_mises' && !result[FIELD_OF[k][0]] && !['sigma1', 'sigma3'].includes(k))
  const loadMag = Math.hypot(...result.total_load) || 1
  const balance = Math.hypot(...result.total_load.map((v, k) => v + result.total_reaction[k]))
  return (
    <div className="result-side">
      {stale && (
        <div className="notice warn">
          <TriangleAlert size={16} />
          <div>
            Modell geändert – das Ergebnis gehört zum vorherigen Stand.{' '}
            {canRerun && (
              <button className="link inline" onClick={onRerun}>
                Neu rechnen
              </button>
            )}
          </div>
        </div>
      )}
      <div className={'verdict ' + tone}>
        {tone === 'good' ? <Check size={22} /> : tone === 'neutral' ? <CircleGauge size={22} /> : <TriangleAlert size={22} />}
        <div>
          <div className="verdict-title">{title}</div>
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <div className="verdict-basis">{basisText}</div>
          {singular && <div className="verdict-basis">Spitze direkt an einem Lager – dort nicht bewerten (siehe Details)</div>}
        </div>
      </div>
      <WeldCard result={result} material={material} />
      <BoltCard rows={brows} sF={sF} fatigue={boltFatigue} />
      <JointCard result={result} />
      <BodiesCard result={result} />
      <div className="quantities" role="radiogroup" aria-label="Ergebnisgröße">
        {Object.entries(QUANTITIES)
          .filter(([k]) => avail(k))
          .map(([k, q]) => (
            <button key={k} role="radio" aria-checked={quantity === k} className={'q' + (quantity === k ? ' on' : '')} onClick={() => setQuantity(k)}>
              <span>{q.label}</span>
              <em>{q.hint}</em>
            </button>
          ))}
      </div>
      <div className="card">
        <Stat label="max. Vergleichsspannung σv" value={`${fmt(result.max_von_mises.value)} MPa`} />
        <Stat label="max. Verformung" value={`${fmt(result.max_displacement.value)} mm`} />
        {massG != null && <Stat label="Masse" value={massG >= 1000 ? `${fmt(massG / 1000)} kg` : `${fmt(massG)} g`} />}
      </div>
      {reference && !stale ? (
        <Compare reference={reference} current={current} onUnpin={onUnpin} />
      ) : (
        !reference && (
          <button className="link" onClick={onPin}>
            Ergebnis zum Vergleichen merken
          </button>
        )
      )}
      <button className="more-head" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>
        {detailsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Details: Lagerkräfte, Hinweise, Rechnung
      </button>
      {detailsOpen && (
        <div className="card details">
          <Stat label="Hauptspannung σ1 / σ3" value={`${fmt(result.max_sigma1.value)} / ${fmt(result.min_sigma3.value)} MPa`} />
          {result.safety_break != null && hasYield && Math.abs(result.safety_break - (sf ?? 0)) > 1e-6 && <Stat label="Sicherheit gegen Bruch" value={`S = ${fmt(result.safety_break)}`} />}
          {result.reactions.map((r, i) => (
            <Stat key={i} label={`Lagerkraft Lager ${i + 1}`} value={fmtVec(clean(r, loadMag)) + ' N'} />
          ))}
          <Stat label="Gleichgewicht" value={balance < 1e-6 * loadMag ? 'erfüllt' : `Abweichung ${fmt(balance)} N`} />
          <Stat
            label="Rechnung"
            value={`${result.equations.toLocaleString('de-DE')} Unbekannte · ${fmt(result.seconds)} s${result.iterations != null ? ` · ${result.iterations} Iterationen` : ''}`}
          />
          {result.warnings.map((w) => (
            <div key={w} className="detail-warn">
              <TriangleAlert size={14} />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}
      <p className="hint">Tipp: Auf das Bauteil klicken zeigt die Werte an dieser Stelle (Messen).</p>
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

// Rundungsrauschen (z. B. 3e-9 N bei 1500 N Last, iterativer Löser ~1e-7) als 0 anzeigen
function clean(v, ref) {
  return v.map((x) => (Math.abs(x) < 1e-6 * ref ? 0 : x))
}

// Reibung in Fugen mit Kontakt (gilt für alle Fugen: verschraubte und gewählte Berührflächen)
function FrictionControl({ jointFric, setJointFric }) {
  return (
    <div className="row friction-row">
      <div className="segmented small">
        {[
          ['mu', 'Reibung'],
          ['stick', 'haftet'],
          ['free', 'reibungsfrei'],
        ].map(([k, l]) => (
          <button key={k} className={jointFric.mode === k ? 'on' : ''} onClick={() => setJointFric({ ...jointFric, mode: k })}>
            {l}
          </button>
        ))}
      </div>
      {jointFric.mode === 'mu' && (
        <label className="field inline-field">
          <span>µ</span>
          <input value={jointFric.mu} aria-label="Reibwert der Fuge" onChange={(e) => setJointFric({ ...jointFric, mu: e.target.value })} />
        </label>
      )}
    </div>
  )
}

// Berührflächen zwischen Körpern: verklebt (Standard) oder Kontakt (drückt, hebt ab, rutscht)
const touchKey = (mesh, a, b) => {
  const nameOf = (id) => mesh?.bodies?.find((x) => x.body === id)?.name ?? `Körper ${id}`
  return `${nameOf(a)}|${nameOf(b)}`
}
function TouchSection({ mesh, contacts, setContacts, jointFric, setJointFric }) {
  const pairs = mesh?.touching ?? []
  if (!pairs.length) return null
  const nameOf = (id) => mesh.bodies?.find((x) => x.body === id)?.name ?? `Körper ${id}`
  const any = pairs.some(([a, b]) => contacts[touchKey(mesh, a, b)])
  return (
    <>
      <div className="props-head">
        <h3>Berührflächen</h3>
      </div>
      <p className="hint">
        Wo sich Teile berühren, hängen sie normalerweise fest zusammen (verklebt). Mit „Kontakt“ drücken sie nur aufeinander: sie können abheben und
        – je nach Reibung – rutschen. Fugen verschraubter Teile stellst du bei den Schrauben ein.
      </p>
      <div className="bolt-list">
        {pairs.map(([a, b, area]) => {
          const k = touchKey(mesh, a, b)
          const on = !!contacts[k]
          return (
            <div key={k} className="bolt-row touch-row">
              <span className="bolt-name">
                <b>
                  {nameOf(a)} ↔ {nameOf(b)}
                </b>
                <small>{fmt(area)} mm² Berührfläche</small>
              </span>
              <div className="segmented small">
                <button className={!on ? 'on' : ''} onClick={() => setContacts({ ...contacts, [k]: false })}>
                  verklebt
                </button>
                <button className={on ? 'on' : ''} onClick={() => setContacts({ ...contacts, [k]: true })}>
                  Kontakt
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {any && (
        <>
          <FrictionControl jointFric={jointFric} setJointFric={setJointFric} />
          <p className="hint">
            Ein Teil, das nur über Kontakt gehalten wird, braucht Halt: Lager, Schraube, Reibung bei Andruck – sonst löst es sich (Hinweis im Ergebnis).
          </p>
        </>
      )}
      <hr className="sep-line" />
    </>
  )
}

// Schrauben: aus dem CAD erkannt bzw. aus fluchtenden Bohrungen vorgeschlagen; Festigkeitsklasse je Schraube,
// Vorspannung (VDI 2230) und Fuge (Kontakt mit Reibung oder verklebt)
function BoltSection({
  bolts,
  setBolts,
  selBolt,
  setSelBolt,
  openJoints,
  setOpenJoints,
  jointFric,
  setJointFric,
  tight,
  setTight,
  handBolts,
  setHandBolts,
  boltPick,
  setBoltPick,
  keepFasteners,
  onKeepFasteners,
}) {
  const upd = (id, patch) => setBolts(bolts.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  const cad = bolts.filter((b) => b.source === 'cad')
  const holes = bolts.filter((b) => b.source === 'bohrung')
  const hand = bolts.filter((b) => b.source === 'hand')
  // Schraube von Hand ändern: Größe (Kopf/Mutter 1,6·d), umdrehen (Kopf auf die andere Seite), löschen
  const updHand = (name, f) => setHandBolts(handBolts.map((h) => (h.name === name ? { ...h, bolt: f(h.bolt) } : h)))
  const flip = (b) => ({ ...b, axis: b.axis.map((v) => -v), head_t: -b.nut_t, nut_t: -b.head_t })
  const perBolt = tight.mode === 'moment' ? ['ma', 'N·m', 'Anziehmoment M_A (leer = nach VDI 2230)'] : tight.mode === 'kraft' ? ['fv', 'kN', 'Vorspannkraft F_V (leer = nach VDI 2230)'] : null
  const row = (b) => (
    <div key={b.id} className={'bolt-row' + (selBolt === b.id ? ' on' : '') + (b.on ? '' : ' off')} onClick={() => setSelBolt(selBolt === b.id ? null : b.id)}>
      <input type="checkbox" checked={b.on} title={b.on ? 'wird gerechnet' : 'nicht rechnen'} onClick={(e) => e.stopPropagation()} onChange={(e) => upd(b.id, { on: e.target.checked })} />
      <span className="bolt-name" title={b.parts?.length ? 'ersetzt: ' + b.parts.join(', ') : ''}>
        <b>{b.name}</b>
        <small>
          M{fmt(b.bolt.d)} · {b.bolt.nut_t != null ? 'mit Mutter' : 'Gewindebohrung'}
          {b.parts?.length > 1 ? ` · ${b.parts.length - 1} Zubehör` : ''}
        </small>
      </span>
      {perBolt && b.on && (
        <span className="input-unit bolt-val" onClick={(e) => e.stopPropagation()} title={perBolt[2]}>
          <input value={b[perBolt[0]]} placeholder="VDI" aria-label={perBolt[2]} onChange={(e) => upd(b.id, { [perBolt[0]]: e.target.value })} />
          <em>{perBolt[1]}</em>
        </span>
      )}
      {b.source === 'hand' && (
        <span className="hand-tools" onClick={(e) => e.stopPropagation()}>
          <select value={b.bolt.d} title="Gewindegröße" onChange={(e) => updHand(b.name, (x) => ({ ...x, d: Number(e.target.value), head_d: 1.6 * Number(e.target.value), nut_d: x.nut_t != null ? 1.6 * Number(e.target.value) : null }))}>
            {M_SIZES.map((m) => (
              <option key={m} value={m}>
                M{m}
              </option>
            ))}
          </select>
          {b.bolt.nut_t != null && (
            <button className="icon-btn" title="Kopf auf die andere Seite" onClick={() => updHand(b.name, flip)}>
              ⇅
            </button>
          )}
          <button className="icon-btn" title="Schraube löschen" onClick={() => setHandBolts(handBolts.filter((h) => h.name !== b.name))}>
            <Trash2 size={13} />
          </button>
        </span>
      )}
      <select value={b.cls} onClick={(e) => e.stopPropagation()} onChange={(e) => upd(b.id, { cls: e.target.value })} title="Festigkeitsklasse">
        {Object.keys(BOLT_CLASSES).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  )
  const setT = (patch) => setTight({ ...tight, ...patch })
  return (
    <>
      <div className="props-head">
        <h3>Schrauben</h3>
        <span className="spacer" />
        {bolts.length > 1 && (
          <select
            className="chip"
            value=""
            title="Klasse für alle eingeschalteten Schrauben"
            onChange={(e) => e.target.value && setBolts(bolts.map((b) => (b.on ? { ...b, cls: e.target.value } : b)))}
          >
            <option value="">alle: …</option>
            {Object.keys(BOLT_CLASSES).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>
      {cad.length > 0 && (
        <>
          <span className="mat-head">Aus dem CAD erkannt – werden als Schraubenelement gerechnet</span>
          <div className="bolt-list">{cad.map(row)}</div>
        </>
      )}
      {holes.length > 0 && (
        <>
          <span className="mat-head">Vorschläge aus Bohrungen – anhaken, wenn dort eine Schraube sitzt</span>
          <div className="bolt-list">{holes.map(row)}</div>
        </>
      )}
      {hand.length > 0 && (
        <>
          <span className="mat-head">Von Hand angelegt</span>
          <div className="bolt-list">{hand.map(row)}</div>
        </>
      )}
      {bolts.length === 0 && <p className="hint">Keine Schrauben gefunden (weder Normteile im CAD noch fluchtende Bohrungen in mehreren Teilen).</p>}
      <button className={'btn wide' + (boltPick ? ' on' : '')} onClick={() => setBoltPick(!boltPick)}>
        <Plus size={14} /> {boltPick ? 'Bohrung anklicken …' : 'Schraube an Bohrung anlegen'}
      </button>
      {bolts.length > 0 && (
        <>
          <span className="mat-head">Vorspannung</span>
          <select value={tight.mode} onChange={(e) => setT({ mode: e.target.value })} aria-label="Vorspannung">
            {Object.entries(TIGHTEN).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {tight.mode !== 'none' && (
            <div className="grid3">
              {tight.mode === 'vdi' && <NumField label="Ausnutzung ν" unit="%" value={tight.nu} onChange={(v) => setT({ nu: v })} />}
              {tight.mode !== 'kraft' && <NumField label="µ Gewinde" unit="" value={tight.muG} onChange={(v) => setT({ muG: v })} />}
              {tight.mode !== 'kraft' && <NumField label="µ Kopf" unit="" value={tight.muK} onChange={(v) => setT({ muK: v })} />}
            </div>
          )}
          <p className="hint">
            {tight.mode === 'vdi'
              ? 'Vorspannkraft so, dass beim Anziehen Zug und Gewindetorsion zusammen ν·Rp0,2 erreichen (VDI 2230, üblich 90 %). Anziehmoment steht im Ergebnis. '
              : tight.mode === 'moment'
                ? 'Vorspannkraft aus dem Anziehmoment je Schraube und den Reibwerten (VDI 2230). '
                : tight.mode === 'kraft'
                  ? 'Vorspannkraft je Schraube direkt (z. B. aus Messung). '
                  : 'Schrauben ohne Vorspannung – die Fuge hebt schon bei kleiner Zuglast ab. '}
            Gerechnet wird in zwei Schritten: erst anziehen, dann kommt die Last dazu.
          </p>
          {tight.mode !== 'none' && (
            <>
              <div className="row">
                <label className="field grow">
                  <span>Anziehverfahren (Streuung)</span>
                  <select value={tight.method ?? 'schluessel'} onChange={(e) => setT({ method: e.target.value })}>
                    {Object.entries(TIGHTEN_METHODS).map(([k, [l]]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                {tight.method === 'eigen' && (
                  <label className="field mini">
                    <span>α_A</span>
                    <input value={tight.alpha ?? ''} onChange={(e) => setT({ alpha: e.target.value })} />
                  </label>
                )}
              </div>
              <label className="check">
                <input type="checkbox" checked={tight.setting ?? true} onChange={(e) => setT({ setting: e.target.checked })} /> Setzen berücksichtigen
                (Vorspannkraftverlust F_Z)
              </label>
              <label className="check">
                <input type="checkbox" checked={!!tight.fatigue} onChange={(e) => setT({ fatigue: e.target.checked })} /> Dauerfestigkeit prüfen (Last schwellt
                zwischen 0 und Betriebslast)
              </label>
              {scatterOf(tight) && (
                <p className="hint">
                  Mit Streuung wird zweimal gerechnet: größte Vorspannung für Schraube und Teile, kleinste (nach dem Setzen) für die Fuge – klafft
                  oder rutscht sie dann?
                </p>
              )}
            </>
          )}
          <span className="mat-head">Fuge zwischen den verschraubten Teilen</span>
          <div className="segmented small">
            <button className={openJoints ? 'on' : ''} onClick={() => setOpenJoints(true)} title="Die Teile drücken aufeinander, können abheben und rutschen">
              Kontakt
            </button>
            <button className={!openJoints ? 'on' : ''} onClick={() => setOpenJoints(false)} title="Die Teile sind an der Berührfläche fest verbunden">
              verklebt
            </button>
          </div>
          {openJoints && <FrictionControl jointFric={jointFric} setJointFric={setJointFric} />}
          <p className="hint">
            {openJoints
              ? 'Kontakt: Druck geht über die Fuge, bei Zug hebt sie ab (klafft); quer hält die Reibung µ·Pressung, darüber rutschen die Teile und die Schrauben werden auf Abscherung belastet. Stahl/Stahl trocken etwa µ = 0,1 … 0,2.'
              : 'Verklebt: die Teile hängen an der Berührfläche fest zusammen, die Schrauben tragen nur einen kleinen Teil – Schraubenkräfte zu klein.'}
          </p>
        </>
      )}
      {cad.length > 0 || keepFasteners ? (
        <label className="check">
          <input type="checkbox" checked={keepFasteners} onChange={(e) => onKeepFasteners(e.target.checked)} /> Schrauben aus dem CAD als Körper rechnen (neu vernetzen)
        </label>
      ) : null}
      <hr className="sep-line" />
    </>
  )
}

// Schweißnähte: Spalte suchen, Nähte anlegen (Fläche A wird über den Spalt an Fläche B gekoppelt)
function WeldSection({ welds, setWelds, gaps, setGaps, active, setActive, onFind }) {
  const upd = (id, patch) => setWelds(welds.map((w) => (w.id === id ? { ...w, ...patch } : w)))
  const has = (c) => welds.some((w) => (w.a.includes(c.a) && w.b.includes(c.b)) || (w.a.includes(c.b) && w.b.includes(c.a)))
  const take = (cands) => {
    const add = cands.filter((c) => !has(c)).map((c) => ({ ...newWeld(), a: [c.a], b: [c.b] }))
    setWelds([...welds, ...add])
  }
  const open = gaps.list?.filter((c) => !has(c)) ?? []
  return (
    <>
      <div className="props-head">
        <h3>Verbindungen</h3>
      </div>
      <p className="hint">
        Schweißnähte für gekantete Bleche mit Spalt an den Ecken (werden später geschweißt) oder getrennte Teile: Fläche A – meist die schmale
        Stirnfläche – wird über den Spalt fest mit Fläche B verbunden. Später auch Kontakte und Schrauben in Baugruppen.
      </p>
      <div className="row">
        <label className="field">
          <span>Spalt bis</span>
          <div className="input-unit">
            <input value={gaps.max} onChange={(e) => setGaps({ ...gaps, max: e.target.value })} />
            <em>mm</em>
          </div>
        </label>
        <button className="btn" onClick={onFind}>
          <Spline size={14} /> Spalte suchen
        </button>
      </div>
      {gaps.list && (
        <div className="gap-list">
          {gaps.list.length === 0 && <p className="hint">Keine einander gegenüberliegenden ebenen Flächen mit so kleinem Spalt gefunden.</p>}
          {open.map((c) => (
            <div key={`${c.a}-${c.b}`} className="gap-row">
              <span>
                Spalt {fmt(c.gap)} mm · {fmt(c.area)} mm² <em>(Fläche {c.a} ↔ {c.b})</em>
              </span>
              <button className="btn small" onClick={() => take([c])}>
                <Plus size={13} /> Naht
              </button>
            </div>
          ))}
          {open.length > 1 && (
            <button className="btn wide" onClick={() => take(open)}>
              <Plus size={14} /> Alle {open.length} als Naht übernehmen
            </button>
          )}
        </div>
      )}
      {welds.map((w, i) => {
        const pickA = active?.id === w.id && active.type === 'weldA'
        const pickB = active?.id === w.id && active.type === 'weldB'
        return (
          <div key={w.id} className={'item' + (pickA || pickB ? ' active weld' : '')}>
            <div className="item-head">
              <Spline size={14} color={WELD_A} />
              <strong>
                {w.kind === 'bond' ? 'Verbindung' : 'Naht'} {i + 1}
              </strong>
              <span className="spacer" />
              <button className="icon-btn" title="Löschen" onClick={() => { setWelds(welds.filter((x) => x.id !== w.id)); if (pickA || pickB) setActive(null) }}>
                <Trash2 size={14} />
              </button>
            </div>
            <select value={w.kind} onChange={(e) => upd(w.id, { kind: e.target.value })}>
              <option value="butt">Stumpfnaht, durchgeschweißt (a = Blechdicke)</option>
              <option value="fillet">Kehlnaht mit a-Maß</option>
              <option value="bond">flächig verbunden (verklebt, fest verschraubt) – ohne Nahtnachweis</option>
            </select>
            <div className="grid2">
              {w.kind === 'fillet' && <NumField label="a-Maß" unit="mm" value={w.throat} onChange={(v) => upd(w.id, { throat: v })} />}
              <NumField label="Spalt bis (leer = auto)" unit="mm" value={w.maxGap} onChange={(v) => upd(w.id, { maxGap: v })} />
            </div>
            <div className="weld-picks">
              <button className={'btn pick' + (pickA ? ' on' : '')} onClick={() => setActive(pickA ? null : { type: 'weldA', id: w.id })}>
                <span className="swatch" style={{ background: w.kind === 'bond' ? BOND_A : WELD_A }} /> {pickA ? 'Fertig' : 'Fläche A'}
                <span className="count">{w.a.length}</span>
              </button>
              <button className={'btn pick' + (pickB ? ' on' : '')} onClick={() => setActive(pickB ? null : { type: 'weldB', id: w.id })}>
                <span className="swatch" style={{ background: w.kind === 'bond' ? BOND_B : WELD_B }} /> {pickB ? 'Fertig' : 'Fläche B'}
                <span className="count">{w.b.length}</span>
              </button>
            </div>
          </div>
        )
      })}
      <button className="btn wide" onClick={() => { const w = newWeld(); setWelds([...welds, w]); setActive({ type: 'weldA', id: w.id }) }}>
        <Plus size={15} /> Naht von Hand (Fläche A und B anklicken)
      </button>
    </>
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

function StudyPanel({ study, setStudy, params, rows, canRun, onRun, onCsv, note }) {
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
         Kommt das Teil aus Onshape, stehen hier die Variablen des Teilestudios (#dicke …) zur Wahl; läuft Projekt-FEM live mit SolidCraft, die Parameter des SolidCraft-Designs. Das CAD baut die Geometrie je Wert neu auf, danach wird der alte Wert wieder eingesetzt.
        </p>
        <label className="field">
          <span>Parameter</span>
          <select
            value={param.key}
            onChange={(e) => setStudy({ param: e.target.value, values: defaults[e.target.value] ?? (params.find((p) => p.key === e.target.value)?.values || study.values) })}
          >
            {params.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {note && <p className="hint">{note}</p>}
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
          <NumField label="p_G Schrauben" unit="MPa" value={m.pG ?? ''} onChange={set('pG')} />
        </div>
        <p className="hint">p_G: Grenzflächenpressung unter Schraubenköpfen und Muttern – leer = Richtwert nach VDI 2230 aus dem Namen, sonst Rm.</p>
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

// Schweißnaht-Nachweis, vereinfachtes Verfahren EN 1993-1-8 (4.5.3.3): Linienkraft / a ≤ f_vw,d = f_u / (√3 · β_w · γ_M2)
const GAMMA_M2 = 1.25
function betaW(name = '') {
  const n = name.toUpperCase()
  if (/S\s*4[26]0/.test(n)) return 1.0
  if (/S\s*355/.test(n)) return 0.9
  if (/S\s*275/.test(n)) return 0.85
  if (/1\.4[0-9]{3}|EDELSTAHL|V2A|V4A/.test(n)) return 1.0
  return 0.8
}
function weldRows(result, material) {
  const fu = Number(material.tensile)
  const bw = betaW(material.name)
  const fvw = fu > 0 ? fu / (Math.sqrt(3) * bw * GAMMA_M2) : null
  // flächige Verbindungen (Baugruppe) haben keinen Nahtnachweis
  return (result.welds ?? []).filter((w) => !w.name?.startsWith('Verbindung')).map((w, i) => ({
    ...w,
    label: w.name || `Naht ${i + 1}`,
    force: Math.hypot(...w.force),
    fvw,
    util: fvw ? w.stress_max / fvw : null,
    bw,
  }))
}

function WeldCard({ result, material }) {
  const rows = weldRows(result, material)
  if (!rows.length) return null
  const ok = rows.every((r) => r.util == null || r.util <= 1)
  const fvw = rows[0].fvw
  return (
    <div className={'proof ' + (ok ? 'good' : 'bad')}>
      <div className="item-head">
        <Spline size={15} />
        <strong>Schweißnähte{fvw ? (ok ? ' – Nachweis erfüllt' : ' – Nachweis NICHT erfüllt') : ''}</strong>
      </div>
      <table className="weld-table">
        <thead>
          <tr>
            <th />
            <th>Kraft</th>
            <th>l / a</th>
            <th>τw max</th>
            {fvw && <th>Ausn.</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} title={`übertragen: senkrecht ${fmt(r.force_normal)} N, längs ${fmt(r.force_shear)} N · Linienkraft Mittel ${fmt(r.line_force_mean)} N/mm, größte ${fmt(r.line_force_max)} N/mm · Spalt ${fmt(r.gap_min)}–${fmt(r.gap_max)} mm`}>
              <td>{r.label}</td>
              <td>{fmt(r.force)} N</td>
              <td>
                {fmt(r.length)} / {fmt(r.throat)} mm
              </td>
              <td>{fmt(r.stress_max)} MPa</td>
              {fvw && <td className={r.util <= 1 ? 'good' : 'bad'}>{(100 * r.util).toFixed(0)} %</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        τw = größte Linienkraft entlang der Naht / a-Maß{fvw ? ` · zulässig f_vw,d = Rm / (√3·β_w·γ_M2) = ${fmt(fvw)} MPa (β_w = ${rows[0].bw}, γ_M2 = ${GAMMA_M2})` : ' · für den Nachweis Rm beim Werkstoff angeben'}. Vereinfachtes Verfahren EN 1993-1-8, Nahtenden
        und Kerben nicht gesondert bewertet.
      </p>
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

function GeometryPanel({ ops, setOps, pending, info, warnings, picking, onPick, drawing, onDraw, onCancelDraw, onApply, busy, modified, onExport, mesh }) {
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
        <span>grob, schnell</span>
        <span>fein, genau</span>
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
      {onAimToggle && <div className="dir-links">
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
      </div>}
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

