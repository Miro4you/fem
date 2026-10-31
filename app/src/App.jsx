import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderOpen, Save, FileUp, Play, Plus, Trash2, MousePointerClick, Anchor, ArrowDownToLine,
  TriangleAlert, Download, Grid3x3, Loader2, X, Check, Box as BoxIcon, Layers, CircleGauge, PenLine, Wifi, Copy, Move3d,
} from 'lucide-react'
import Viewport from './components/Viewport.jsx'
import Legend from './components/Legend.jsx'
import * as api from './api.js'
import { MATERIALS } from './materials.js'
import { fmt, fmtVec } from './format.js'
import { regionFromDrag, regionAnchor, regionNumbers, selectionCylinder, axisName, SHAPES } from './region.js'

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
  safety: { label: 'Sicherheit', unit: '', hint: 'gegen Fließen' },
}

let nextId = 1
const newSupport = () => ({
  id: nextId++, kind: 'fixed', axes: { x: true, y: true, z: true }, cyl: { radial: true, axial: true, tangential: false },
  surfaces: [], region: null,
})
const newLoad = () => ({
  id: nextId++, kind: 'force', force: [0, 0, -1000], pressure: 1, moment: [0, 0, 100], surfaces: [], region: null,
})

const LOAD_KINDS = {
  force: 'Kraft (gleichmäßig verteilt)',
  pressure: 'Druck',
  moment: 'Moment',
  bearing: 'Lagerlast (Bolzen/Welle, halber Umfang)',
}

export default function App() {
  const [gmsh, setGmsh] = useState(undefined)
  const [stepPath, setStepPath] = useState(null)
  const [mesh, setMesh] = useState(null)
  const [meshSize, setMeshSize] = useState('')
  const [material, setMaterial] = useState(MATERIALS[0])
  const [supports, setSupports] = useState([])
  const [loads, setLoads] = useState([])
  const [active, setActive] = useState(null)
  // Bereich zeichnen: { type: 'support' | 'load', id, shape }
  const [drawing, setDrawing] = useState(null)
  // Lastrichtung im Bild wählen: { id, key: 'force' | 'moment' }
  const [dirPick, setDirPick] = useState(null)
  // Lastpfeil im Bild ausrichten: { id, field: 'force' | 'moment', plane: 'free' | 'xy' | 'yz' | 'xz' }
  const [aim, setAim] = useState(null)
  const [result, setResult] = useState(null)
  const [resultStale, setResultStale] = useState(false)
  const [view, setView] = useState('setup')
  const [quantity, setQuantity] = useState('von_mises')
  const [deform, setDeform] = useState('auto')
  const [showMesh, setShowMesh] = useState(false)
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
  }, [])

  // jede Änderung am Modell macht ein vorhandenes Ergebnis veraltet
  useEffect(() => {
    if (result) setResultStale(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, supports, loads])

  const surfaceInfo = useMemo(() => new Map((mesh?.surfaces ?? []).map((s) => [s.tag, s])), [mesh])
  const diag = useMemo(() => {
    if (!mesh) return 1
    const [lo, hi] = mesh.bbox
    return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  }, [mesh])

  // --- Geometrie ---------------------------------------------------------------
  async function loadGeometry(path, size, keepSetup = false) {
    setBusy('Vernetze Geometrie …')
    setError(null)
    try {
      const m = await api.openStep(path, size ? Number(size) : null)
      setMesh(m)
      setStepPath(path)
      setMeshSize(String(Number(m.mesh_size.toPrecision(3))))
      setResult(null)
      setResultStale(false)
      setView('setup')
      setProbe(null)
      if (!keepSetup) {
        setSupports([])
        setLoads([])
        setActive(null)
        setDrawing(null)
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
    const data = { format: 'projekt-fem', version: 1, step: stepPath, meshSize: Number(meshSize) || null, material, supports, loads }
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
      const m = await loadGeometry(d.step, d.meshSize, true)
      if (!m) return
      setMaterial(d.material)
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
    [active, dirPick, surfaceInfo],
  )

  const surfaceTint = useCallback(
    (tag) => {
      for (const l of loads)
        if (l.surfaces.includes(tag)) return l.region ? LOAD_PALE : active?.id === l.id ? LOAD_ACTIVE : LOAD_COLOR
      for (const s of supports)
        if (s.surfaces.includes(tag)) return s.region ? SUPPORT_PALE : active?.id === s.id ? SUPPORT_ACTIVE : SUPPORT_COLOR
      return null
    },
    [supports, loads, active],
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
    for (const s of supports) push(s, SUPPORT_COLOR, SUPPORT_ACTIVE)
    for (const l of loads) push(l, LOAD_COLOR, LOAD_ACTIVE)
    return out
  }, [supports, loads, surfaceInfo, active, drawing])

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
    if (!loads.length) p.push('Mindestens eine Last anlegen')
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
  }, [mesh, supports, loads, surfaceInfo, drawing])

  async function onSolve() {
    setBusy('Rechne …')
    setError(null)
    setActive(null)
    setDrawing(null)
    setAim(null)
    try {
      const setup = {
        material: { name: material.name, E: Number(material.E), nu: Number(material.nu), yield: material.yield ? Number(material.yield) : null },
        supports: supports.map((s) => {
          const f = supportFix(s)
          return { surfaces: s.surfaces, fix: f.fix, local: f.local ?? null, region: regionNumbers(s.region) }
        }),
        loads: loads.map((l) => {
          const base = { type: l.kind, surfaces: l.surfaces, region: regionNumbers(l.region) }
          if (l.kind === 'pressure') return { ...base, pressure: Number(l.pressure) }
          // Moment in der Oberfläche in N·m, im Rechenkern N·mm
          if (l.kind === 'moment') return { ...base, moment: l.moment.map((v) => Number(v) * 1000) }
          return { ...base, force: l.force.map(Number) }
        }),
      }
      const r = await api.solve(setup)
      setResult(r)
      setResultStale(false)
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

  // --- Ergebnisanzeige ----------------------------------------------------------------
  const display = useMemo(() => {
    if (!result || !mesh) return null
    const n = result.von_mises.length
    let values
    let reverse = false
    if (quantity === 'disp') {
      values = new Float32Array(n)
      for (let i = 0; i < n; i++) values[i] = Math.hypot(result.displacement[3 * i], result.displacement[3 * i + 1], result.displacement[3 * i + 2])
    } else if (quantity === 'safety') {
      const y = Number(material.yield) || 0
      values = Float32Array.from(result.von_mises, (v) => Math.min(y / Math.max(v, 1e-12), 10))
      reverse = true
    } else values = Float32Array.from(result[quantity])
    let min = Infinity, max = -Infinity, imin = 0, imax = 0
    for (let i = 0; i < n; i++) {
      if (values[i] < min) (min = values[i]), (imin = i)
      if (values[i] > max) (max = values[i]), (imax = i)
    }
    const umax = result.max_displacement.value
    const auto = umax > 0 ? (0.05 * diag) / umax : 0
    const scale = deform === 'off' ? 0 : deform === 'true' ? 1 : auto
    return { values, min, max, imin, imax, reverse, displacement: result.displacement, scale, auto }
  }, [result, mesh, quantity, deform, diag, material.yield])

  const markers = useMemo(() => {
    if (!display) return []
    const q = QUANTITIES[quantity]
    const u = q.unit ? ' ' + q.unit : ''
    const m = []
    if (quantity === 'safety') m.push({ node: display.imin, label: `Min ${fmt(display.min)}` })
    else if (quantity === 'sigma3') m.push({ node: display.imin, label: `Min ${fmt(display.min)}${u}` })
    else m.push({ node: display.imax, label: `Max ${fmt(display.max)}${u}` })
    if (probe) m.push({ node: probe.node, label: `${fmt(display.values[probe.node])}${u}`, probe: true })
    return m
  }, [display, quantity, probe])

  const mode = view === 'result' && display ? 'result' : 'setup'
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
          <button className={view === 'result' ? 'on' : ''} disabled={!result} onClick={() => setView('result')}>
            Ergebnis{resultStale && result ? ' (veraltet)' : ''}
          </button>
        </div>
        <div className="actions">
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
                      className={'btn' + (Number(meshSize) !== Number(mesh.mesh_size.toPrecision(3)) ? ' primary' : '')}
                      onClick={() => loadGeometry(stepPath, meshSize, true)}
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
                </Section>
              )}

              {mesh && (
                <Section n={3} title="Werkstoff" done>
                  <select
                    value={MATERIALS.some((m) => m.name === material.name) ? material.name : ''}
                    onChange={(e) => {
                      const m = MATERIALS.find((x) => x.name === e.target.value)
                      setMaterial(m ? { ...m } : { ...material, name: 'Benutzerdefiniert' })
                    }}
                  >
                    {MATERIALS.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                    <option value="">Benutzerdefiniert</option>
                  </select>
                  <div className="grid3">
                    <NumField label="E-Modul" unit="MPa" value={material.E} onChange={(v) => setMaterial({ ...material, E: v, name: 'Benutzerdefiniert' })} />
                    <NumField label="ν" value={material.nu} onChange={(v) => setMaterial({ ...material, nu: v, name: 'Benutzerdefiniert' })} />
                    <NumField label="Re / Rp0,2" unit="MPa" value={material.yield ?? ''} onChange={(v) => setMaterial({ ...material, yield: v, name: 'Benutzerdefiniert' })} />
                  </div>
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
                  <button className="btn primary wide big" disabled={problems.length > 0 || !!busy} onClick={onSolve}>
                    <Play size={16} /> Rechnen
                  </button>
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
              />
            )
          )}
        </aside>

        <section className="stage">
          {!mesh && !busy && (
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
            mesh={mesh}
            mode={mode}
            surfaceTint={surfaceTint}
            pickable={(!!active || !!dirPick) && view === 'setup'}
            onPick={onPick}
            result={display}
            showMesh={showMesh}
            arrows={arrows}
            markers={mode === 'result' ? markers : []}
            onProbe={setProbe}
            drawing={view === 'setup' ? drawing?.shape : null}
            planeNormal={planeNormal}
            onDraw={onDraw}
            overlays={overlays}
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
          {drawing && view === 'setup' && (
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
          {mode === 'result' && display && <Legend display={display} quantity={QUANTITIES[quantity]} />}
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
              {busy}
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

function ResultPanel({ result, material, quantity, setQuantity, deform, setDeform, display, showMesh, setShowMesh, stale, onExport }) {
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
      {sf != null && (
        <div className={'safety ' + sfClass}>
          <CircleGauge size={22} />
          <div>
            <div className="safety-value">S = {fmt(sf)}</div>
            <div className="safety-text">
              Sicherheit gegen Fließen ({material.name}, Re = {fmt(Number(material.yield))} MPa)
              {sf < 1 ? ' – Streckgrenze überschritten' : ''}
            </div>
          </div>
        </div>
      )}
      <div className="card">
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
          <button key={k} className={'q' + (quantity === k ? ' on' : '')} disabled={k === 'safety' && !material.yield} onClick={() => setQuantity(k)}>
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
      <span>{label}</span>
      <div className="input-unit">
        <input value={value} inputMode="decimal" onChange={(e) => onChange(e.target.value.replace(',', '.'))} />
        {unit && <em>{unit}</em>}
      </div>
    </label>
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
