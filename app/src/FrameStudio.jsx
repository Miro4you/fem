// Stabwerk (Phase 4): Balken, Rahmen und Fachwerke – Eingabe in Tabellen, eigene 3D-Ansicht.
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Plus, Trash2, Play, Box, ArrowUp, ArrowDown } from 'lucide-react'
import { CadControls } from './components/CadControls.js'
import { bandColor, BANDS, cssBandColor } from './colormap.js'
import { fmt } from './format.js'
import { MATERIALS } from './materials.js'

// Walzprofile IPE (DIN 1025-5): A [cm²], Iy [cm⁴], Wy [cm³], Iz [cm⁴], Wz [cm³], It [cm⁴], Flanschdicke tf [mm]
const IPE = {
  100: [10.3, 171, 34.2, 15.9, 5.79, 1.2, 5.7],
  120: [13.2, 318, 53.0, 27.7, 8.65, 1.74, 6.3],
  140: [16.4, 541, 77.3, 44.9, 12.3, 2.45, 6.9],
  160: [20.1, 869, 109, 68.3, 16.7, 3.6, 7.4],
  180: [23.9, 1317, 146, 101, 22.2, 4.79, 8.0],
  200: [28.5, 1943, 194, 142, 28.5, 6.98, 8.5],
  220: [33.4, 2772, 252, 205, 37.3, 9.07, 9.2],
  240: [39.1, 3892, 324, 284, 47.3, 12.9, 9.8],
  270: [45.9, 5790, 429, 420, 62.2, 15.9, 10.2],
  300: [53.8, 8356, 557, 604, 80.5, 20.1, 10.7],
}

const KINDS = { rect: 'Rechteck b×h', round: 'Rund d', tube: 'Rohr d×t', recttube: 'Rechteckrohr b×h×t', ipe: 'IPE' }

export function profileLabel(p) {
  if (p.kind === 'rect') return `Rechteck ${fmt(Number(p.b))}×${fmt(Number(p.h))}`
  if (p.kind === 'round') return `Rund ${fmt(Number(p.d))}`
  if (p.kind === 'tube') return `Rohr ${fmt(Number(p.d))}×${fmt(Number(p.t))}`
  if (p.kind === 'recttube') return `Rechteckrohr ${fmt(Number(p.b))}×${fmt(Number(p.h))}×${fmt(Number(p.t))}`
  return `IPE ${p.ipe}`
}

function profilePayload(p) {
  const n = (v) => Number(v)
  if (p.kind === 'rect') return { type: 'rect', b: n(p.b), h: n(p.h) }
  if (p.kind === 'round') return { type: 'round', d: n(p.d) }
  if (p.kind === 'tube') return { type: 'tube', d: n(p.d), t: n(p.t) }
  if (p.kind === 'recttube') return { type: 'recttube', b: n(p.b), h: n(p.h), t: n(p.t) }
  const [a, iy, wy, iz, wz, it, tf] = IPE[p.ipe]
  return { type: 'custom', a: a * 100, iy: iy * 1e4, wy: wy * 1e3, iz: iz * 1e4, wz: wz * 1e3, it: it * 1e4, wt: (it * 1e4) / tf }
}

// Lagerarten (ux, uy, uz, φx, φy, φz festgehalten)
const SUPPORTS = {
  fest: ['fest eingespannt', [1, 1, 1, 1, 1, 1]],
  gelenk: ['gelenkig, fest (Verschiebungen)', [1, 1, 1, 1, 0, 0]],
  los_x: ['Loslager (in x verschieblich)', [0, 1, 1, 0, 0, 0]],
  los_y: ['Loslager (in y verschieblich)', [1, 0, 1, 0, 0, 0]],
}

export const FRAME_TEMPLATES = {
  einfeld: {
    label: 'Einfeldträger (IPE 200, 4 m, Einzellast)',
    model: () => ({
      planar: true, selfWeight: false,
      profiles: [{ kind: 'ipe', ipe: '200' }],
      nodes: [[0, 0, 0], [2000, 0, 0], [4000, 0, 0]],
      members: [{ a: 0, b: 1, profile: 0, truss: false, angle: 0 }, { a: 1, b: 2, profile: 0, truss: false, angle: 0 }],
      supports: [{ node: 0, kind: 'gelenk' }, { node: 2, kind: 'los_x' }],
      nodeLoads: [{ node: 1, f: [0, 0, -20000], m: [0, 0, 0] }],
      memberLoads: [],
    }),
  },
  krag: {
    label: 'Kragarm (Rohr 60×4, Streckenlast)',
    model: () => ({
      planar: true, selfWeight: true,
      profiles: [{ kind: 'tube', d: 60, t: 4 }],
      nodes: [[0, 0, 0], [1500, 0, 0]],
      members: [{ a: 0, b: 1, profile: 0, truss: false, angle: 0 }],
      supports: [{ node: 0, kind: 'fest' }],
      nodeLoads: [{ node: 1, f: [0, 0, -500], m: [0, 0, 0] }],
      memberLoads: [{ member: 0, q: [0, 0, -0.5] }],
    }),
  },
  binder: {
    label: 'Fachwerkbinder (6 m, Rohr 48,3×3,2)',
    model: () => {
      const nodes = [[0, 0, 0], [1500, 0, 0], [3000, 0, 0], [4500, 0, 0], [6000, 0, 0], [1500, 0, 1000], [3000, 0, 1000], [4500, 0, 1000]]
      const bars = [[0, 1], [1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [0, 5], [5, 1], [5, 2], [2, 6], [2, 7], [7, 3], [7, 4]]
      return {
        planar: true, selfWeight: false,
        profiles: [{ kind: 'tube', d: 48.3, t: 3.2 }],
        nodes,
        members: bars.map(([a, b]) => ({ a, b, profile: 0, truss: true, angle: 0 })),
        supports: [{ node: 0, kind: 'gelenk' }, { node: 4, kind: 'los_x' }],
        nodeLoads: [5, 6, 7].map((n) => ({ node: n, f: [0, 0, -8000], m: [0, 0, 0] })),
        memberLoads: [],
      }
    },
  },
  rahmen: {
    label: 'Rahmen (IPE 200, eingespannt, Wind + Dachlast)',
    model: () => ({
      planar: true, selfWeight: true,
      profiles: [{ kind: 'ipe', ipe: '200' }],
      nodes: [[0, 0, 0], [0, 0, 3000], [4000, 0, 3000], [4000, 0, 0]],
      members: [{ a: 0, b: 1, profile: 0, truss: false, angle: 0 }, { a: 1, b: 2, profile: 0, truss: false, angle: 0 }, { a: 2, b: 3, profile: 0, truss: false, angle: 0 }],
      supports: [{ node: 0, kind: 'fest' }, { node: 3, kind: 'fest' }],
      nodeLoads: [{ node: 1, f: [5000, 0, 0], m: [0, 0, 0] }],
      memberLoads: [{ member: 1, q: [0, 0, -5] }],
    }),
  },
}

export function newFrame() {
  return { material: MATERIALS[0].name, ...FRAME_TEMPLATES.einfeld.model() }
}

/// Modell für den Rechenkern
export function framePayload(fr) {
  const mat = MATERIALS.find((m) => m.name === fr.material) ?? MATERIALS[0]
  const strength = Number(mat.yield) > 0 ? Number(mat.yield) : Number(mat.tensile) > 0 ? Number(mat.tensile) : null
  return {
    nodes: fr.nodes.map((p) => p.map(Number)),
    members: fr.members.map((m) => ({ a: Number(m.a), b: Number(m.b), profile: Number(m.profile), truss: !!m.truss, angle: Number(m.angle) || 0 })),
    profiles: fr.profiles.map(profilePayload),
    E: Number(mat.E), nu: Number(mat.nu), strength, density: (Number(mat.rho) || 0) * 1e-9, self_weight: !!fr.selfWeight, planar: !!fr.planar,
    supports: fr.supports.map((s) => ({ node: Number(s.node), fix: SUPPORTS[s.kind][1].map(Boolean) })),
    node_loads: fr.nodeLoads.map((l) => ({ node: Number(l.node), f: l.f.map(Number), m: l.m.map((v) => Number(v) * 1000) })),
    member_loads: fr.memberLoads.map((l) => ({ member: Number(l.member), q: l.q.map(Number) })),
  }
}

// --- kleine Tabellen-Bausteine ----------------------------------------------------------------------
const Cell = ({ value, onChange, w = 56 }) => (
  <input className="cell" style={{ width: w }} value={value} inputMode="decimal" onChange={(e) => onChange(e.target.value.replace(',', '.'))} />
)

export function FrameSidebar({ frame, setFrame, results, onSolve, busy, display, setDisplay, onSave, onOpen }) {
  const set = (patch) => setFrame({ ...frame, ...patch })
  const upd = (key, i, patch) => set({ [key]: frame[key].map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  const del = (key, i) => set({ [key]: frame[key].filter((_, j) => j !== i) })
  const nodeOpts = frame.nodes.map((_, i) => i)
  return (
    <>
      <section className="section">
        <h2>Stabwerk – Balken, Rahmen, Fachwerke</h2>
        <p className="hint">Einheiten mm und N (Momente N·m, Streckenlasten N/mm). Knoten- und Stabnummern siehe Bild.</p>
        <div className="row">
          <select defaultValue="" onChange={(e) => e.target.value && setFrame({ material: frame.material, ...FRAME_TEMPLATES[e.target.value].model() })}>
            <option value="">Vorlage laden …</option>
            {Object.entries(FRAME_TEMPLATES).map(([k, t]) => (
              <option key={k} value={k}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row mat-actions">
          <button className="link" onClick={onOpen}>Öffnen …</button>
          <button className="link" onClick={onSave}>Speichern …</button>
        </div>
        <label className="field">
          <span>Werkstoff</span>
          <select value={frame.material} onChange={(e) => set({ material: e.target.value })}>
            {MATERIALS.filter((m) => !m.print).map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={!!frame.planar} onChange={(e) => set({ planar: e.target.checked })} /> ebenes System (xz-Ebene, y gesperrt)
        </label>
        <label className="check">
          <input type="checkbox" checked={!!frame.selfWeight} onChange={(e) => set({ selfWeight: e.target.checked })} /> Eigengewicht (−z)
        </label>
      </section>

      <section className="section">
        <h2>Profile</h2>
        {frame.profiles.map((p, i) => (
          <div key={i} className="trow">
            <span className="idx">P{i}</span>
            <select value={p.kind} onChange={(e) => upd('profiles', i, { kind: e.target.value, ipe: p.ipe ?? '200', b: p.b ?? 40, h: p.h ?? 80, d: p.d ?? 40, t: p.t ?? 3 })}>
              {Object.entries(KINDS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            {p.kind === 'ipe' ? (
              <select value={p.ipe} onChange={(e) => upd('profiles', i, { ipe: e.target.value })}>
                {Object.keys(IPE).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            ) : (
              <>
                {['rect', 'recttube'].includes(p.kind) && <Cell value={p.b} onChange={(v) => upd('profiles', i, { b: v })} w={44} />}
                {['rect', 'recttube'].includes(p.kind) && <Cell value={p.h} onChange={(v) => upd('profiles', i, { h: v })} w={44} />}
                {['round', 'tube'].includes(p.kind) && <Cell value={p.d} onChange={(v) => upd('profiles', i, { d: v })} w={44} />}
                {['tube', 'recttube'].includes(p.kind) && <Cell value={p.t} onChange={(v) => upd('profiles', i, { t: v })} w={36} />}
              </>
            )}
            <button className="icon-btn" disabled={frame.profiles.length < 2} onClick={() => del('profiles', i)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="link" onClick={() => set({ profiles: [...frame.profiles, { kind: 'rect', b: 40, h: 80 }] })}>
          <Plus size={13} /> Profil
        </button>
      </section>

      <section className="section">
        <h2>Knoten (x, y, z in mm)</h2>
        {frame.nodes.map((p, i) => (
          <div key={i} className="trow">
            <span className="idx">K{i}</span>
            {[0, 1, 2].map((k) => (
              <Cell key={k} value={p[k]} onChange={(v) => upd('nodes', i, Object.assign([...p], { [k]: v }))} w={62} />
            ))}
            <button className="icon-btn" onClick={() => del('nodes', i)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="link" onClick={() => set({ nodes: [...frame.nodes, [0, 0, 0]] })}>
          <Plus size={13} /> Knoten
        </button>
      </section>

      <section className="section">
        <h2>Stäbe (von, bis, Profil)</h2>
        {frame.members.map((m, i) => (
          <div key={i} className="trow">
            <span className="idx">S{i}</span>
            {['a', 'b'].map((k) => (
              <select key={k} value={m[k]} onChange={(e) => upd('members', i, { [k]: Number(e.target.value) })}>
                {nodeOpts.map((n) => (
                  <option key={n} value={n}>
                    K{n}
                  </option>
                ))}
              </select>
            ))}
            <select value={m.profile} onChange={(e) => upd('members', i, { profile: Number(e.target.value) })}>
              {frame.profiles.map((p, j) => (
                <option key={j} value={j}>
                  P{j}
                </option>
              ))}
            </select>
            <label className="check mini-check" title="Fachwerkstab: nur Normalkraft, gelenkig angeschlossen">
              <input type="checkbox" checked={!!m.truss} onChange={(e) => upd('members', i, { truss: e.target.checked })} /> FW
            </label>
            <button className="icon-btn" onClick={() => del('members', i)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="link" onClick={() => set({ members: [...frame.members, { a: 0, b: Math.min(1, frame.nodes.length - 1), profile: 0, truss: false, angle: 0 }] })}>
          <Plus size={13} /> Stab
        </button>
      </section>

      <section className="section">
        <h2>Lager</h2>
        {frame.supports.map((s, i) => (
          <div key={i} className="trow">
            <select value={s.node} onChange={(e) => upd('supports', i, { node: Number(e.target.value) })}>
              {nodeOpts.map((n) => (
                <option key={n} value={n}>
                  K{n}
                </option>
              ))}
            </select>
            <select value={s.kind} onChange={(e) => upd('supports', i, { kind: e.target.value })}>
              {Object.entries(SUPPORTS).map(([k, [l]]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <button className="icon-btn" onClick={() => del('supports', i)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="link" onClick={() => set({ supports: [...frame.supports, { node: 0, kind: 'fest' }] })}>
          <Plus size={13} /> Lager
        </button>
      </section>

      <section className="section">
        <h2>Lasten</h2>
        <span className="mat-head">Knotenlasten: Fx, Fy, Fz [N]</span>
        {frame.nodeLoads.map((l, i) => (
          <div key={i} className="trow">
            <select value={l.node} onChange={(e) => upd('nodeLoads', i, { node: Number(e.target.value) })}>
              {nodeOpts.map((n) => (
                <option key={n} value={n}>
                  K{n}
                </option>
              ))}
            </select>
            {[0, 1, 2].map((k) => (
              <Cell key={k} value={l.f[k]} onChange={(v) => upd('nodeLoads', i, { f: Object.assign([...l.f], { [k]: v }) })} w={58} />
            ))}
            <button className="icon-btn" onClick={() => del('nodeLoads', i)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="link" onClick={() => set({ nodeLoads: [...frame.nodeLoads, { node: 0, f: [0, 0, -1000], m: [0, 0, 0] }] })}>
          <Plus size={13} /> Knotenlast
        </button>
        <span className="mat-head">Streckenlasten: qx, qy, qz [N/mm]</span>
        {frame.memberLoads.map((l, i) => (
          <div key={i} className="trow">
            <select value={l.member} onChange={(e) => upd('memberLoads', i, { member: Number(e.target.value) })}>
              {frame.members.map((_, j) => (
                <option key={j} value={j}>
                  S{j}
                </option>
              ))}
            </select>
            {[0, 1, 2].map((k) => (
              <Cell key={k} value={l.q[k]} onChange={(v) => upd('memberLoads', i, { q: Object.assign([...l.q], { [k]: v }) })} w={58} />
            ))}
            <button className="icon-btn" onClick={() => del('memberLoads', i)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="link" onClick={() => set({ memberLoads: [...frame.memberLoads, { member: 0, q: [0, 0, -1] }] })}>
          <Plus size={13} /> Streckenlast
        </button>
      </section>

      <div className="solve">
        <button className="btn primary wide big" disabled={busy} onClick={onSolve}>
          <Play size={16} /> Stabwerk rechnen
        </button>
      </div>

      {results && (
        <section className="section">
          <h2>Ergebnis</h2>
          {results.safety != null && (
            <div className={'safety ' + (results.safety >= 1.5 ? 'good' : results.safety >= 1 ? 'ok' : 'bad')}>
              <div>
                <div className="safety-value">S = {fmt(results.safety)}</div>
                <div className="safety-text">Sicherheit gegen Fließen ({frame.material})</div>
              </div>
            </div>
          )}
          <div className="card">
            <div className="stat"><span>max. Verschiebung</span><strong>{fmt(results.max_displacement)} mm</strong></div>
            <div className="stat"><span>max. Vergleichsspannung</span><strong>{fmt(results.max_sigma_v)} MPa</strong></div>
            <div className="stat"><span>Summe Lasten</span><strong>{results.total_load.map((v) => fmt(Math.abs(v) < 1e-9 ? 0 : v)).join(' / ')} N</strong></div>
          </div>
          <div className="segmented small">
            {[['util', 'Ausnutzung'], ['n', 'Normalkraft'], ['m', 'Biegemoment']].map(([k, l]) => (
              <button key={k} className={display === k ? 'on' : ''} onClick={() => setDisplay(k)}>
                {l}
              </button>
            ))}
          </div>
          <table className="orient-table">
            <thead>
              <tr>
                <th>Stab</th>
                <th>N [kN]</th>
                <th>M [kN·m]</th>
                <th>σv</th>
                <th>Ausn.</th>
              </tr>
            </thead>
            <tbody>
              {results.members.map((m, i) => {
                const nAbs = m.stations.reduce((a, s) => (Math.abs(s.n) > Math.abs(a) ? s.n : a), 0)
                const mMax = Math.max(...m.stations.map((s) => Math.hypot(s.my, s.mz)))
                return (
                  <tr key={i}>
                    <td>S{i}</td>
                    <td>{fmt(nAbs / 1000)}</td>
                    <td>{fmt(mMax / 1e6)}</td>
                    <td>{fmt(m.max_sigma_v)}</td>
                    <td className={m.utilization > 1 ? 'bad' : m.utilization > 0.67 ? 'ok' : 'good'}>{m.utilization != null ? `${Math.round(100 * m.utilization)} %` : '–'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <span className="mat-head">Lagerkräfte [N] (Zug in N positiv, Druck negativ)</span>
          {results.reactions.map((r, i) => (
            <div key={i} className="stat">
              <span>K{frame.supports[i]?.node}</span>
              <strong>{r.slice(0, 3).map((v) => fmt(Math.abs(v) < 1e-6 ? 0 : v)).join(' / ')}</strong>
            </div>
          ))}
          <p className="hint">Nachweis vereinfacht: σv = |N|/A + |M|/W kombiniert mit Torsion; Stabilität (Knicken/Kippen) separat prüfen.</p>
        </section>
      )}
    </>
  )
}

// --- 3D-Ansicht -------------------------------------------------------------------------------------------
const VIEWS = { iso: [1, -1.3, 0.8], front: [0, -1, 0], top: [0, 0, 1] }

export function FrameView({ frame, results, display }) {
  const host = useRef(null)
  const ctx = useRef(null)
  const [labels, setLabels] = useState([])

  useEffect(() => {
    const el = host.current
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 1e7)
    camera.up.set(0, 0, 1)
    scene.add(camera)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.8))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(0.6, 1, 1.2)
    camera.add(key)
    const controls = new CadControls(camera, renderer.domElement, null)
    const group = new THREE.Group()
    scene.add(group)
    const s = { renderer, scene, camera, controls, group, dirty: true, labelPts: [] }
    ctx.current = s
    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight)
      camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1)
      camera.updateProjectionMatrix()
      s.dirty = true
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    controls.addEventListener('change', () => (s.dirty = true))
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (!s.dirty) return
      s.dirty = false
      renderer.render(scene, camera)
      const w = el.clientWidth, h = el.clientHeight
      setLabels(
        s.labelPts.map((l) => {
          const p = new THREE.Vector3(...l.pos).project(camera)
          return { ...l, x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, visible: p.z < 1 }
        }),
      )
    }
    loop()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])

  const bbox = useMemo(() => {
    const pts = frame.nodes.map((p) => p.map(Number)).filter((p) => p.every(Number.isFinite))
    if (!pts.length) return { c: new THREE.Vector3(), size: 1000 }
    const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])))
    const hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])))
    return { c: new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2), size: Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), 100) }
  }, [frame.nodes])

  function fit(name = 'iso') {
    const s = ctx.current
    const dir = new THREE.Vector3(...VIEWS[name]).normalize()
    s.controls.setView(bbox.c, dir, bbox.size * 1.9, name === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1))
    s.dirty = true
  }
  useEffect(() => fit('iso'), [bbox.size, bbox.c.x, bbox.c.y, bbox.c.z]) // eslint-disable-line react-hooks/exhaustive-deps

  // Szene aufbauen
  const legend = useMemo(() => {
    if (!results) return null
    let vals = []
    for (const m of results.members) for (const st of m.stations) vals.push(display === 'util' ? (m.utilization != null ? st.sigma_v / (m.max_sigma_v / m.utilization || 1) : st.sigma_v) : display === 'n' ? st.n / 1000 : Math.hypot(st.my, st.mz) / 1e6)
    vals = vals.filter(Number.isFinite)
    let min = Math.min(...vals), max = Math.max(...vals)
    if (display === 'util') min = 0
    if (display === 'n') {
      const a = Math.max(Math.abs(min), Math.abs(max)) || 1
      ;(min = -a), (max = a)
    }
    return { min, max, unit: display === 'util' ? '' : display === 'n' ? 'kN' : 'kN·m', label: display === 'util' ? 'Ausnutzung σv / Re' : display === 'n' ? 'Normalkraft (Zug +)' : 'Biegemoment' }
  }, [results, display])

  useEffect(() => {
    const s = ctx.current
    s.group.traverse((o) => (o.geometry?.dispose(), o.material?.dispose?.()))
    s.group.clear()
    const r = bbox.size / 220
    const P = (p) => new THREE.Vector3(...p.map(Number))
    const umax = results?.max_displacement || 0
    const scale = umax > 0 ? (0.06 * bbox.size) / umax : 0
    const valueOf = (m, st) =>
      display === 'util' ? (m.utilization != null ? st.sigma_v / (m.max_sigma_v / m.utilization || 1) : st.sigma_v) : display === 'n' ? st.n / 1000 : Math.hypot(st.my, st.mz) / 1e6
    const cyl = (a, b, color, rad = r) => {
      const d = b.clone().sub(a)
      const len = d.length()
      if (len < 1e-9) return
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 10), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }))
      mesh.position.copy(a).addScaledVector(d, 0.5)
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())
      s.group.add(mesh)
    }
    frame.members.forEach((m, i) => {
      const a = frame.nodes[m.a], b = frame.nodes[m.b]
      if (!a || !b) return
      const res = results?.members?.[i]
      if (res && legend) {
        // unverformt als dünne graue Linie, verformt und eingefärbt
        cyl(P(a), P(b), 0x9aa0a8, r * 0.35)
        const dir = P(b).sub(P(a)).normalize()
        for (let k = 0; k + 1 < res.stations.length; k++) {
          const s0 = res.stations[k], s1 = res.stations[k + 1]
          const p0 = P(a).addScaledVector(dir, s0.x).add(new THREE.Vector3(...s0.u).multiplyScalar(scale))
          const p1 = P(a).addScaledVector(dir, s1.x).add(new THREE.Vector3(...s1.u).multiplyScalar(scale))
          const v = (valueOf(res, s0) + valueOf(res, s1)) / 2
          const t = Math.min(Math.max((v - legend.min) / (legend.max - legend.min || 1), 0), 0.9999)
          cyl(p0, p1, bandColor(Math.floor(t * BANDS)), r * (m.truss ? 0.8 : 1))
        }
      } else {
        cyl(P(a), P(b), m.truss ? 0x6b8fb8 : 0x4a5568, r * (m.truss ? 0.8 : 1))
      }
    })
    frame.nodes.forEach((p) => {
      const sp = new THREE.Mesh(new THREE.SphereGeometry(r * 1.6, 12, 8), new THREE.MeshStandardMaterial({ color: 0x2a2f36 }))
      sp.position.copy(P(p))
      s.group.add(sp)
    })
    for (const sup of frame.supports) {
      const p = frame.nodes[sup.node]
      if (!p) continue
      const fixedRot = sup.kind === 'fest'
      const g = fixedRot ? new THREE.BoxGeometry(r * 10, r * 10, r * 3) : new THREE.ConeGeometry(r * 5, r * 7, 4)
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1f5fd6 }))
      mesh.position.copy(P(p)).add(new THREE.Vector3(0, 0, fixedRot ? -r * 2.5 : -r * 4.5))
      if (!fixedRot) mesh.rotation.x = Math.PI / 2
      s.group.add(mesh)
    }
    const L = bbox.size * 0.12
    const arrow = (at, dir, color) => {
      const d = new THREE.Vector3(...dir)
      if (d.length() < 1e-12) return
      d.normalize()
      const h = new THREE.ArrowHelper(d, at.clone().addScaledVector(d, -L), L, color, L * 0.28, L * 0.14)
      s.group.add(h)
    }
    for (const l of frame.nodeLoads) if (frame.nodes[l.node]) arrow(P(frame.nodes[l.node]), l.f.map(Number), 0xe0700f)
    for (const l of frame.memberLoads) {
      const m = frame.members[l.member]
      if (!m || !frame.nodes[m.a] || !frame.nodes[m.b]) continue
      for (const t of [0.2, 0.5, 0.8]) arrow(P(frame.nodes[m.a]).lerp(P(frame.nodes[m.b]), t), l.q.map(Number), 0xf2a24a)
    }
    s.labelPts = [
      ...frame.nodes.map((p, i) => ({ pos: p.map(Number), text: `K${i}`, kind: 'node' })),
      ...frame.members
        .map((m, i) => (frame.nodes[m.a] && frame.nodes[m.b] ? { pos: [0, 1, 2].map((k) => (Number(frame.nodes[m.a][k]) + Number(frame.nodes[m.b][k])) / 2), text: `S${i}`, kind: 'member' } : null))
        .filter(Boolean),
    ]
    s.dirty = true
  }, [frame, results, display, legend, bbox])

  return (
    <div className="viewport frame-view">
      <div ref={host} className="viewport-canvas" />
      <div className="view-buttons">
        {[['iso', Box], ['front', ArrowUp], ['top', ArrowDown]].map(([k, Icon]) => (
          <button key={k} className="icon-btn" onClick={() => fit(k)}>
            <Icon size={16} />
          </button>
        ))}
      </div>
      {labels.filter((l) => l.visible).map((l, i) => (
        <div key={i} className={'frame-label ' + l.kind} style={{ left: l.x, top: l.y }}>
          {l.text}
        </div>
      ))}
      {legend && (
        <div className="legend frame-legend">
          <div className="legend-title">{legend.label}</div>
          <div className="frame-legend-bar">
            {Array.from({ length: BANDS }, (_, i) => (
              <span key={i} style={{ background: cssBandColor(i) }} />
            ))}
          </div>
          <div className="frame-legend-range">
            <span>{fmt(legend.min)}</span>
            <span>
              {fmt(legend.max)} {legend.unit}
            </span>
          </div>
          <div className="hint">Verformung überhöht</div>
        </div>
      )}
    </div>
  )
}
