import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FolderOpen, Save, FileUp, Play, Plus, Trash2, MousePointerClick, Anchor, ArrowDownToLine,
  TriangleAlert, Download, Grid3x3, Loader2, X, Check, Box as BoxIcon, Layers, CircleGauge, PenLine, Wifi, Copy,
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
const newSupport = () => ({ id: nextId++, kind: 'fixed', axes: { x: true, y: true, z: true }, surfaces: [], region: null })
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
    [active],
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
    // reibungsfreie Auflage: nur senkrecht zur Fläche gesperrt
    let axis = null
    for (const t of s.surfaces) {
      const n = surfaceInfo.get(t)?.normal
      const k = n ? n.findIndex((v) => Math.abs(v) > 0.9999) : -1
      if (k < 0) return { error: 'Nur für ebene, achsparallele Flächen möglich' }
      if (axis !== null && axis !== k) return { error: 'Alle Flächen müssen dieselbe Ausrichtung haben' }
      axis = k
    }
    if (axis === null) return { fix: null }
    const fix = { x: null, y: null, z: null }
    fix['xyz'[axis]] = 0
    return { fix }
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
        out.push({ tip: tip.map((v, k) => v + (m[k] / len) * L), dir: m, length: L, color: MOMENT_COLOR })
        continue
      }
      if (l.kind === 'pressure') {
        const n = loadNormal(l)
        if (n) dir = n.map((v) => -v * Math.sign(l.pressure || 1))
      }
      if (dir) out.push({ tip, dir, length: 0.16 * diag, color: active?.id === l.id ? LOAD_ACTIVE : LOAD_COLOR })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, surfaceInfo, diag, active, drawing])

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
    try {
      const setup = {
        material: { name: material.name, E: Number(material.E), nu: Number(material.nu), yield: material.yield ? Number(material.yield) : null },
        supports: supports.map((s) => ({ surfaces: s.surfaces, fix: supportFix(s).fix, region: regionNumbers(s.region) })),
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
                    <button className="btn" onClick={() => loadGeometry(stepPath, meshSize, true)}>
                      <Grid3x3 size={15} /> Neu vernetzen
                    </button>
                  </div>
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
                        </select>
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
                            <div className="grid3">
                              {['Mx', 'My', 'Mz'].map((lab, k) => (
                                <NumField key={lab} label={lab} unit="N·m" value={l.moment[k]} onChange={(v) => upd({ moment: l.moment.map((f, j) => (j === k ? v : f)) })} />
                              ))}
                            </div>
                            {cyl && (
                              <button
                                className="link"
                                onClick={() => {
                                  const mag = Math.hypot(...l.moment.map(Number)) || 100
                                  upd({ moment: cyl.axis.map((v) => Number((v * mag).toPrecision(6))) })
                                }}
                              >
                                Richtung: um die Wellenachse (Torsion)
                              </button>
                            )}
                            <p className="hint">Wirkt um den Schwerpunkt des Bereichs, linear verteilt wie bei einem starren Anschlussteil. Drehsinn nach der rechten Hand.</p>
                          </>
                        ) : l.kind === 'bearing' ? (
                          <>
                            <div className="grid3">
                              {['Fx', 'Fy', 'Fz'].map((lab, k) => (
                                <NumField key={lab} label={lab} unit="N" value={l.force[k]} onChange={(v) => upd({ force: l.force.map((f, j) => (j === k ? v : f)) })} />
                              ))}
                            </div>
                            <p className="hint">Kraft, mit der Bolzen bzw. Lager auf das Bauteil drücken. Sie wirkt nur auf der Hälfte, gegen die gedrückt wird (Druck ∝ cos φ).</p>
                          </>
                        ) : l.kind === 'force' ? (
                          <>
                            <div className="grid3">
                              {['Fx', 'Fy', 'Fz'].map((lab, k) => (
                                <NumField key={lab} label={lab} unit="N" value={l.force[k]} onChange={(v) => upd({ force: l.force.map((f, j) => (j === k ? v : f)) })} />
                              ))}
                            </div>
                            {n && (
                              <button
                                className="link"
                                onClick={() => {
                                  const mag = Math.hypot(...l.force.map(Number)) || 1000
                                  upd({ force: n.map((v) => Number((-v * mag).toPrecision(6))) })
                                }}
                              >
                                Richtung: senkrecht auf die Fläche
                              </button>
                            )}
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
            pickable={!!active && view === 'setup'}
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
          />
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
