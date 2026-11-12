// 3D-Ansicht der Konstruktion: Körper, Hauptebenen, Auswahl von Flächen/Kanten und der Skizzierer.
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as THREE from 'three'
import { CadControls } from '../components/CadControls.js'
import { ViewCube, Triad, VIEWS } from '../components/Viewport.jsx'
import { IcHome, IcFit } from '../ui/icons.jsx'
import {
  basis,
  to3d,
  P,
  polyline,
  midOf,
  snap,
  pointAt,
  hvHint,
  addEnt,
  addCon,
  addPoint,
  distTo,
  dimFor,
  dimGeometry,
  measure,
  isDim,
  CON_GLYPH,
  solved,
  entPoints,
  radiusOf,
  STD_PLANES,
} from './sketch.js'

const PLANE_COLORS = { XY: 0x3b82f6, XZ: 0x16a34a, YZ: 0xdc2626 }
const PLANE_NAMES = { XY: 'Oben', XZ: 'Vorne', YZ: 'Rechts' }
const BODY = new THREE.Color('#b9c0c8')
const HOVER = new THREE.Color('#ffffff')
const SELECT = new THREE.Color('#f59e0b')
const FACE_PICK = new THREE.Color('#60a5fa')

const front = (m) => {
  m.depthTest = false
  m.transparent = true
  return m
}

function clearGroup(g) {
  g.traverse((o) => (o.geometry?.dispose(), o.material?.dispose()))
  g.clear()
}

/// Punkt in einem Linienzug (gerade/ungerade über alle Ränder)
function insideLoops(q, loops) {
  let n = 0
  for (const lp of loops)
    for (let k = 0; k < lp.length - 1; k++) {
      const [x0, y0] = lp[k]
      const [x1, y1] = lp[k + 1]
      if (y0 > q[1] !== y1 > q[1] && x0 + ((q[1] - y0) * (x1 - x0)) / (y1 - y0) > q[0]) n++
    }
  return n % 2 === 1
}

export default function CadView({
  tess,
  nav,
  pick, // null | { faces?: true, planar?: true, cyl?: true, edges?: true, std?: true }
  onPick,
  selected, // { faces: Set, edges: Set, std: Set }
  sketch, // { data, plane, tool, sel, onChange, onSel, info, onMessage, onDimEdit, refs }
  showPlanes,
  regions, // { plane, list: [{ loops, on }], onToggle }
  axisLine, // { plane, a, b } hervorgehobene Achse (Drehen)
  preview, // { color } Körper halbdurchsichtig zeigen
  sketches, // Hintergrund-Skizzen [{ id, plane, data, active }]
  onSketchPick, // (id, open) – Klick/Doppelklick auf eine Hintergrund-Skizze
  ref,
}) {
  const host = useRef(null)
  const ctx = useRef(null)
  const cb = useRef({})
  cb.current = { pick, onPick, sketch, regions, tess, sketches, onSketchPick }
  const [overlay, setOverlay] = useState({ dims: [], glyphs: [] })
  const [hover, setHover] = useState(null) // { face } | { edge } | { std } | Skizze: { pt } | { ent }
  const [edit, setEdit] = useState(null) // Maß bearbeiten { id, x, y, value }
  // Kamera-Achsen (rechts, oben, zum Betrachter) für Ansichtswürfel und Achsenkreuz
  const [cam, setCam] = useState([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
  // Beschriftungen im Raum (Achsen X/Y/Z, Hauptebenen)
  const [labels3d, setLabels3d] = useState([])
  const tmp = useRef(null) // laufende Zeichenaktion

  useImperativeHandle(ref, () => ({
    fit: () => fitAll(),
    lookAt: (plane, sk) => lookAtPlane(plane, sk),
    snapshot: () => {
      const s = ctx.current
      s.renderer.render(s.scene, s.camera)
      return s.renderer.domElement.toDataURL('image/png')
    },
  }))

  // --- Grundaufbau ----------------------------------------------------------------------------
  useEffect(() => {
    const el = host.current
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1e6)
    camera.up.set(0, 0, 1)
    scene.add(camera)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(0.6, 1, 1.2)
    camera.add(key)
    const ray = new THREE.Raycaster()
    const s = {
      renderer,
      scene,
      camera,
      ray,
      body: new THREE.Group(),
      planes: new THREE.Group(),
      axes: new THREE.Group(),
      bgGroup: new THREE.Group(),
      regionGroup: new THREE.Group(),
      axisGroup: new THREE.Group(),
      previewGroup: new THREE.Group(),
      labelPts: [],
      sketch: new THREE.Group(),
      extra: new THREE.Group(),
      dirty: true,
      surf: null,
      size: 100,
      center: new THREE.Vector3(),
    }
    scene.add(s.body, s.planes, s.axes, s.bgGroup, s.regionGroup, s.axisGroup, s.sketch, s.previewGroup, s.extra)
    const pickPoint = (cx, cy) => {
      if (!s.surf) return null
      setRay(cx, cy)
      return ray.intersectObject(s.surf, false)[0]?.point ?? null
    }
    const controls = new CadControls(camera, renderer.domElement, pickPoint)
    s.controls = controls
    controls.addEventListener('change', () => (s.dirty = true))
    function setRay(cx, cy) {
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera)
      return ray
    }
    s.setRay = setRay
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el
      renderer.setSize(w, h)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
      s.dirty = true
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (!s.dirty) return
      s.dirty = false
      renderer.render(scene, camera)
      s.updateOverlay?.()
      // Ansichtswürfel/Achsenkreuz nachführen
      const q = camera.quaternion
      const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((a) => new THREE.Vector3(...a).applyQuaternion(q).toArray())
      setCam((old) => (old.every((v, i) => v.every((x, k) => Math.abs(x - axes[i][k]) < 1e-4)) ? old : axes))
      // Beschriftungen im Raum aufs Bild projizieren
      const w = el.clientWidth
      const h = el.clientHeight
      const lb = s.labelPts.map((l) => {
        const p = l.pos.clone().project(camera)
        return { ...l, x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, visible: p.z < 1 && p.z > -1 }
      })
      setLabels3d((old) => (old.length === lb.length && old.every((o, i) => Math.abs(o.x - lb[i].x) < 0.5 && Math.abs(o.y - lb[i].y) < 0.5 && o.text === lb[i].text && o.visible === lb[i].visible) ? old : lb))
    }
    loop()
    ctx.current = s
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    if (nav) ctx.current.controls.setConfig(nav)
  }, [nav])

  // --- Körper -------------------------------------------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.body.traverse((o) => (o.geometry?.dispose(), o.material?.dispose()))
    s.body.clear()
    s.surf = null
    s.curves = []
    if (tess?.triangles?.length) {
      const n = tess.triangles.length
      const pos = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) pos[3 * i + k] = tess.positions[3 * tess.triangles[i] + k]
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
      g.computeVertexNormals()
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0.05,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
      s.surf = new THREE.Mesh(g, mat)
      s.body.add(s.surf)
      // Kanten
      const segs = []
      for (const c of tess.curves) {
        const p = c.pts
        for (let k = 0; k + 5 < p.length; k += 3) segs.push(p[k], p[k + 1], p[k + 2], p[k + 3], p[k + 4], p[k + 5])
        s.curves.push(c)
      }
      const eg = new THREE.BufferGeometry()
      eg.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(segs), 3))
      s.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x1f2329 }))
      s.body.add(s.edges)
      s.hi = new THREE.Group() // hervorgehobene Kanten
      s.body.add(s.hi)
      const [lo, hi] = tess.bbox
      s.size = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), 1)
      s.center.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
      s.controls.center = s.center.clone()
    } else {
      s.size = 100
      s.center.set(0, 0, 0)
      s.controls.center = s.center.clone()
    }
    // einpassen beim ersten Körper oder wenn er viel größer/kleiner geworden ist
    const hasBody = !!tess?.triangles?.length
    if (!s.fitted || (hasBody && (!s.hadBody || s.size > 2.5 * (s.lastFit ?? 0) * 2 || s.size < 0.2 * (s.lastFit ?? 0) * 2))) {
      // beim ersten Mal isometrisch, danach die Blickrichtung behalten (nur Abstand/Mitte anpassen)
      if (!s.fitted) fitAll()
      else {
        const q = s.camera.quaternion
        fitAll(new THREE.Vector3(0, 0, 1).applyQuaternion(q).toArray(), new THREE.Vector3(0, 1, 0).applyQuaternion(q).toArray())
      }
      s.fitted = true
    }
    s.hadBody = hasBody
    s.dirty = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tess])

  // Farben der Flächen und hervorgehobene Kanten
  useEffect(() => {
    const s = ctx.current
    if (!s.surf || !tess) return
    const col = s.surf.geometry.attributes.color.array
    const c = new THREE.Color()
    const faceSel = selected?.faces ?? new Set()
    for (let t = 0; t < tess.tri_surface.length; t++) {
      const tag = tess.tri_surface[t]
      c.copy(BODY)
      if (faceSel.has(tag)) c.copy(SELECT)
      else if (hover?.face === tag) c.lerp(pick?.faces || pick?.planar || pick?.cyl ? FACE_PICK : HOVER, 0.45)
      for (let k = 0; k < 3; k++) c.toArray(col, 9 * t + 3 * k)
    }
    s.surf.geometry.attributes.color.needsUpdate = true
    s.surf.material.transparent = !!preview
    s.surf.material.opacity = preview ? 0.35 : 1
    s.surf.material.depthWrite = !preview
    s.surf.material.needsUpdate = true
    s.hi.traverse((o) => (o.geometry?.dispose(), o.material?.dispose()))
    s.hi.clear()
    const edgeSel = selected?.edges ?? new Set()
    for (const cu of s.curves) {
      const on = edgeSel.has(cu.tag)
      if (!on && hover?.edge !== cu.tag) continue
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(cu.pts), 3))
      const m = new THREE.LineBasicMaterial({ color: on ? 0xf59e0b : 0x2563eb, depthTest: false, transparent: true })
      const line = new THREE.Line(g, m)
      line.renderOrder = 15
      s.hi.add(line)
    }
    s.dirty = true
  }, [tess, selected, hover, pick, preview])

  // --- Achsen am Ursprung (immer sichtbar) -----------------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.axes.traverse((o) => (o.geometry?.dispose(), o.material?.dispose()))
    s.axes.clear()
    const L = Math.max(20, 0.25 * s.size)
    const ax = []
    for (const [k, dir, color] of [
      ['X', [1, 0, 0], 0xdc2626],
      ['Y', [0, 1, 0], 0x16a34a],
      ['Z', [0, 0, 1], 0x2563eb],
    ]) {
      const end = new THREE.Vector3(...dir).multiplyScalar(L)
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), end]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75, depthTest: false }),
      )
      line.renderOrder = 18
      s.axes.add(line)
      ax.push({ key: 'ax-' + k, text: k, cls: 'cad-axlabel ax-' + k.toLowerCase(), pos: end.clone().multiplyScalar(1.08) })
    }
    const o = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0)]),
      new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, color: 0x6b7280, depthTest: false, transparent: true }),
    )
    o.renderOrder = 18
    s.axes.add(o)
    s.axisLabels = ax
    s.labelPts = [...ax, ...(s.planeLabels ?? [])]
    s.dirty = true
  }, [tess])

  // --- Hauptebenen ----------------------------------------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.planes.traverse((o) => (o.geometry?.dispose(), o.material?.dispose()))
    s.planes.clear()
    s.stdPlanes = []
    s.planeLabels = []
    s.labelPts = [...(s.axisLabels ?? [])]
    if (!showPlanes) {
      s.dirty = true
      return
    }
    const L = Math.max(30, 0.35 * s.size)
    for (const [name, pl] of Object.entries(STD_PLANES)) {
      const b = basis(pl)
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.u), new THREE.Vector3(...b.v), new THREE.Vector3(...b.n))
      const sel = selected?.std?.has(name)
      const hov = hover?.std === name
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(L, L).translate(L / 2, L / 2, 0),
        new THREE.MeshBasicMaterial({ color: PLANE_COLORS[name], transparent: true, opacity: sel ? 0.3 : hov ? 0.22 : 0.08, side: THREE.DoubleSide, depthWrite: false }),
      )
      quad.applyMatrix4(m)
      const frame = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(L, 0, 0), new THREE.Vector3(L, L, 0), new THREE.Vector3(0, L, 0)]),
        new THREE.LineBasicMaterial({ color: PLANE_COLORS[name], transparent: true, opacity: sel || hov ? 0.9 : 0.45 }),
      )
      frame.applyMatrix4(m)
      s.planes.add(quad, frame)
      s.stdPlanes.push({ name, mesh: quad, L })
      // Beschriftung in der Ecke der Ebene
      const corner = new THREE.Vector3(...b.u).multiplyScalar(L * 0.98).add(new THREE.Vector3(...b.v).multiplyScalar(L * 0.98))
      s.planeLabels.push({ key: 'pl-' + name, text: `${name} · ${PLANE_NAMES[name]}`, cls: 'cad-planelabel', pos: corner })
    }
    s.labelPts = [...(s.axisLabels ?? []), ...s.planeLabels]
    s.dirty = true
  }, [showPlanes, selected, hover, tess])

  // --- Skizze, Bereiche, Achse, Hintergrund-Skizzen ------------------------------------------------
  const skData = sketch?.data
  const skPlane = sketch?.plane
  const hoverSk = hover?.pt ? 'p:' + hover.pt : hover?.ent && !hover.bgEnt ? 'e:' + hover.ent : ''
  const hoverBg = hover?.bg ?? null
  const hoverBgEnt = hover?.bgEnt ? hover.ent : null

  // Bereiche (Extrudieren/Drehen): Flächen einmal bauen, Farben getrennt nachführen
  useEffect(() => {
    const s = ctx.current
    clearGroup(s.regionGroup)
    s.regionMeshes = []
    if (regions?.list?.length) {
      const b = basis(regions.plane)
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.u), new THREE.Vector3(...b.v), new THREE.Vector3(...b.n)).setPosition(...b.o)
      regions.list.forEach((r, i) => {
        const loops = r.loops.filter((lp) => lp.length >= 3)
        if (!loops.length) return
        const shapes = loops.map((lp) => new THREE.Shape(lp.map(([x, y]) => new THREE.Vector2(x, y))))
        const [outer, ...holes] = shapes.sort((a, c) => Math.abs(THREE.ShapeUtils.area(c.getPoints())) - Math.abs(THREE.ShapeUtils.area(a.getPoints())))
        outer.holes = holes
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(outer), front(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthWrite: false })))
        mesh.applyMatrix4(m)
        mesh.renderOrder = 12
        mesh.userData.index = i
        s.regionGroup.add(mesh)
        s.regionMeshes[i] = mesh
      })
    }
    s.regionStamp = (s.regionStamp ?? 0) + 1
    s.dirty = true
  }, [regions?.list, regions?.plane])

  const regionState = regions?.state
  const regionHover = regions?.hover ?? -1
  useEffect(() => {
    const s = ctx.current
    for (const [i, mesh] of (s.regionMeshes ?? []).entries()) {
      if (!mesh) continue
      const st = regionState?.[i] ?? {}
      const hov = i === regionHover
      const col = st.on ? 0x2563eb : st.used ? 0x64748b : 0x94a3b8
      mesh.material.color.set(st.hl ? 0xf59e0b : hov ? (st.on ? 0x1d4ed8 : 0x60a5fa) : col)
      mesh.material.opacity = st.hl ? 0.55 : st.on ? (hov ? 0.5 : 0.36) : st.used ? (hov ? 0.4 : 0.28) : hov ? 0.3 : 0.1
    }
    s.dirty = true
  }, [regionState, regionHover, regions?.list])

  // Drehachse
  useEffect(() => {
    const s = ctx.current
    clearGroup(s.axisGroup)
    if (axisLine) {
      const a = to3d(axisLine.plane, axisLine.a)
      const c = to3d(axisLine.plane, axisLine.b)
      const d = new THREE.Vector3(...c).sub(new THREE.Vector3(...a)).normalize().multiplyScalar(s.size)
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a).sub(d), new THREE.Vector3(...c).add(d)])
      const l = new THREE.Line(g, front(new THREE.LineDashedMaterial({ color: 0xdc2626, dashSize: s.size / 60, gapSize: s.size / 90 })))
      l.computeLineDistances()
      l.renderOrder = 25
      s.axisGroup.add(l)
    }
    s.dirty = true
  }, [axisLine])

  // Hintergrund-Skizzen (fertige Skizzen bleiben sichtbar)
  useEffect(() => {
    const s = ctx.current
    clearGroup(s.bgGroup)
    for (const k of sketches ?? []) {
      const strong = k.active || hoverBg === k.id
      const solid = []
      const dashed = []
      for (const e of k.data.ents) {
        if (e.t === 'point') continue
        const pts = polyline(k.data, e, 48).map((q) => to3d(k.plane, q))
        const out = e.cons ? dashed : solid
        for (let i = 0; i + 1 < pts.length; i++) out.push(...pts[i], ...pts[i + 1])
      }
      // Element unter dem Zeiger (z. B. beim Wählen der Drehachse) hervorheben
      const he = hoverBg === k.id && hoverBgEnt && k.data.ents.find((e) => e.id === hoverBgEnt)
      if (he && k.highlightEnts) {
        const pts = polyline(k.data, he, 48).map((q) => new THREE.Vector3(...to3d(k.plane, q)))
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), front(new THREE.LineBasicMaterial({ color: 0xf59e0b })))
        l.renderOrder = 13
        s.bgGroup.add(l)
      }
      const color = strong ? 0x2563eb : 0x64748b
      const opacity = strong ? 0.9 : 0.55
      if (solid.length) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(solid, 3))
        const l = new THREE.LineSegments(g, front(new THREE.LineBasicMaterial({ color, opacity })))
        l.renderOrder = 11
        s.bgGroup.add(l)
      }
      if (dashed.length) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(dashed, 3))
        const l = new THREE.LineSegments(g, front(new THREE.LineDashedMaterial({ color, opacity: opacity * 0.8, dashSize: s.size / 80, gapSize: s.size / 120 })))
        l.computeLineDistances()
        l.renderOrder = 11
        s.bgGroup.add(l)
      }
    }
    s.dirty = true
  }, [sketches, hoverBg, hoverBgEnt])

  // bearbeitete Skizze: Linien (zu wenigen Objekten zusammengefasst), Punkte, Ursprung, Maßlinien
  useEffect(() => {
    const s = ctx.current
    clearGroup(s.sketch)
    if (!skData || !skPlane) {
      s.dirty = true
      return
    }
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)
    const defined = new THREE.Color(dark ? 0xe8eaed : 0x111827)
    const free = new THREE.Color(0x2563eb)
    const selCol = new THREE.Color(0xf59e0b)
    const hovCol = new THREE.Color(0x60a5fa)
    const add = (obj, order) => {
      obj.renderOrder = order
      s.sketch.add(obj)
    }
    const sk = skData
    const freeSet = sketch.info?.free ?? new Set()
    const selE = new Set(sketch.sel?.ents ?? [])
    const selP = new Set(sketch.sel?.pts ?? [])
    const hovE = hoverSk.startsWith('e:') ? hoverSk.slice(2) : null
    const hovP = hoverSk.startsWith('p:') ? hoverSk.slice(2) : null
    const W = (q) => to3d(skPlane, q)
    const buf = { solid: { pos: [], col: [] }, dashed: { pos: [], col: [] } }
    for (const e of sk.ents) {
      if (e.t === 'point') continue
      const pts = polyline(sk, e).map(W)
      const isFree = entPoints(e).some((p) => freeSet.has(p)) || (e.t === 'circle' && freeSet.has(e.id))
      const c = selE.has(e.id) ? selCol : hovE === e.id ? hovCol : isFree ? free : defined
      const out = e.cons ? buf.dashed : buf.solid
      for (let i = 0; i + 1 < pts.length; i++) {
        out.pos.push(...pts[i], ...pts[i + 1])
        out.col.push(c.r, c.g, c.b, c.r, c.g, c.b)
      }
    }
    for (const [k, v] of Object.entries(buf)) {
      if (!v.pos.length) continue
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(v.pos, 3))
      g.setAttribute('color', new THREE.Float32BufferAttribute(v.col, 3))
      const mat = k === 'dashed' ? new THREE.LineDashedMaterial({ vertexColors: true, dashSize: s.size / 80, gapSize: s.size / 120 }) : new THREE.LineBasicMaterial({ vertexColors: true })
      const l = new THREE.LineSegments(g, front(mat))
      if (k === 'dashed') l.computeLineDistances()
      add(l, 22)
    }
    // Punkte
    const ptPos = []
    const ptCol = []
    const shown = new Set(sk.ents.flatMap((e) => (e.t === 'circle' || e.t === 'arc' ? [e.c, ...(e.t === 'arc' ? [e.a, e.b] : [])] : entPoints(e))))
    const c = new THREE.Color()
    for (const id of shown) {
      const p = sk.pts[id]
      if (!p) continue
      ptPos.push(...W([p.x, p.y]))
      c.copy(selP.has(id) ? selCol : hovP === id ? hovCol : p.fix ? new THREE.Color(0x6b7280) : freeSet.has(id) ? free : defined)
      ptCol.push(c.r, c.g, c.b)
    }
    if (ptPos.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(ptPos, 3))
      g.setAttribute('color', new THREE.Float32BufferAttribute(ptCol, 3))
      add(new THREE.Points(g, front(new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true }))), 24)
    }
    // Ursprung der Welt, wenn er in der Skizzenebene liegt
    {
      const b = basis(skPlane)
      if (Math.abs(b.o[0] * b.n[0] + b.o[1] * b.n[1] + b.o[2] * b.n[2]) < 1e-6 * s.size) {
        const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0)])
        add(new THREE.Points(g, front(new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0xdc2626 }))), 23)
      }
    }
    // Maßlinien
    const segs = []
    for (const con of sk.cons) {
      if (!isDim(con)) continue
      const d = dimGeometry(sk, con)
      if (!d || d.arc) continue
      segs.push(...W(d.from), ...W(d.to))
      for (const [a, b] of d.ext) segs.push(...W(a), ...W(b))
    }
    if (segs.length) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
      add(new THREE.LineSegments(g, front(new THREE.LineBasicMaterial({ color: 0x64748b }))), 21)
    }
    s.dirty = true
  }, [skData, skPlane, sketch?.sel, sketch?.info, hoverSk])

  // Vorschau der laufenden Zeichenaktion
  useEffect(() => {
    const s = ctx.current
    clearGroup(s.previewGroup)
    const t = tmp.current
    if (skPlane && t?.preview?.length) {
      for (const pl of t.preview) {
        const g = new THREE.BufferGeometry().setFromPoints(pl.map((q) => new THREE.Vector3(...to3d(skPlane, q))))
        const l = new THREE.Line(g, front(new THREE.LineBasicMaterial({ color: 0x2563eb, opacity: 0.8 })))
        l.renderOrder = 26
        s.previewGroup.add(l)
      }
    }
    if (skPlane && t?.snapAt) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...to3d(skPlane, t.snapAt))])
      const p = new THREE.Points(g, front(new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, color: 0xf59e0b })))
      p.renderOrder = 27
      s.previewGroup.add(p)
    }
    s.dirty = true
  }, [skPlane, sketch?.tool, overlay.tick])

  // --- HTML-Beschriftung (Maße, Bedingungszeichen) ---------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.updateOverlay = () => {
      const sk = cb.current.sketch?.data
      const plane = cb.current.sketch?.plane
      if (!sk || !plane) {
        setOverlay((o) => (o.dims.length || o.glyphs.length ? { dims: [], glyphs: [], tick: o.tick } : o))
        return
      }
      const el = host.current
      const w = el.clientWidth
      const h = el.clientHeight
      const scr = (q) => {
        const p = new THREE.Vector3(...to3d(plane, q)).project(s.camera)
        return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h]
      }
      const dims = sk.cons
        .filter(isDim)
        .map((c) => {
          const d = dimGeometry(sk, c)
          if (!d) return null
          const [x, y] = scr(d.label)
          const v = c.v ?? measure(sk, c)
          const txt = c.t === 'dia' ? `Ø${fmtN(v)}` : c.t === 'rad' ? `R${fmtN(v)}` : c.t === 'ang' ? `${fmtN(v)}°` : fmtN(v)
          return { id: c.id, x, y, txt, name: c.name }
        })
        .filter(Boolean)
      const glyphs = []
      const count = new Map()
      const ent = (id) => sk.ents.find((e) => e.id === id)
      for (const c of sk.cons) {
        const g = CON_GLYPH[c.t]
        if (!g) continue
        let at = null
        if (c.t === 'h' || c.t === 'v') {
          const line = sk.ents.find((e) => e.t === 'line' && ((e.a === c.a && e.b === c.b) || (e.a === c.b && e.b === c.a)))
          at = line ? midOf(sk, line) : [(sk.pts[c.a].x + sk.pts[c.b].x) / 2, (sk.pts[c.a].y + sk.pts[c.b].y) / 2]
        } else if (c.p) at = P(sk, c.p)
        else if (c.e1) at = midOf(sk, ent(c.e1))
        else if (c.a) at = P(sk, c.a)
        if (!at) continue
        const key = at.map((v) => v.toFixed(3)).join()
        const k = count.get(key) ?? 0
        count.set(key, k + 1)
        const [x, y] = scr(at)
        glyphs.push({ id: c.id, x: x + 10 + 13 * k, y: y - 12, g, t: c.t })
        if (c.e2) {
          const [x2, y2] = scr(midOf(sk, ent(c.e2)))
          glyphs.push({ id: c.id + ':2', con: c.id, x: x2 + 10, y: y2 - 12, g, t: c.t })
        }
      }
      setOverlay((o) => ({ dims, glyphs, tick: o.tick }))
    }
    s.dirty = true
  }, [])
  useEffect(() => {
    ctx.current.dirty = true
  }, [sketch?.data, sketch?.plane])

  // --- Hilfen: Pixelgröße, Ebenentreffer ----------------------------------------------------------
  function mmPerPx(plane) {
    const s = ctx.current
    const o = plane ? new THREE.Vector3(...plane.origin) : s.controls.target
    const depth = Math.max(o.clone().sub(s.camera.position).dot(s.camera.getWorldDirection(new THREE.Vector3())), 1e-6)
    return (2 * depth * Math.tan(THREE.MathUtils.degToRad(s.camera.fov / 2))) / Math.max(host.current.clientHeight, 1)
  }
  function onPlane(ev, plane) {
    const s = ctx.current
    const r = s.setRay(ev.clientX, ev.clientY)
    const b = basis(plane)
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...b.n), new THREE.Vector3(...b.o))
    const hit = r.ray.intersectPlane(pl, new THREE.Vector3())
    if (!hit) return null
    const d = hit.toArray().map((v, i) => v - b.o[i])
    return [d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2], d[0] * b.v[0] + d[1] * b.v[1] + d[2] * b.v[2]]
  }

  // 3D-Auswahl: Fläche, Kante oder Hauptebene unter dem Zeiger
  function pick3d(ev, want) {
    const s = ctx.current
    const r = s.setRay(ev.clientX, ev.clientY)
    const hit = s.surf ? r.intersectObject(s.surf, false)[0] : null
    const depth = hit ? hit.distance : Infinity
    if (want.edges && s.curves?.length) {
      // nächste Kante in Bildschirmpixeln, die nicht hinter der getroffenen Fläche liegt
      const el = host.current
      const rect = el.getBoundingClientRect()
      const mx = ev.clientX - rect.left
      const my = ev.clientY - rect.top
      let best = null
      const tol = 7
      const v = new THREE.Vector3()
      for (const c of s.curves) {
        if (want.edges === 'circle' && c.kind !== 'circle') continue
        if (want.edges === 'line' && c.kind !== 'line') continue
        let prev = null
        for (let k = 0; k < c.pts.length; k += 3) {
          v.set(c.pts[k], c.pts[k + 1], c.pts[k + 2])
          const dist = v.distanceTo(s.camera.position)
          v.project(s.camera)
          const cur = [((v.x + 1) / 2) * el.clientWidth, ((1 - v.y) / 2) * el.clientHeight, dist]
          if (prev) {
            const dx = cur[0] - prev[0]
            const dy = cur[1] - prev[1]
            const L2 = dx * dx + dy * dy
            const t = L2 ? Math.max(0, Math.min(1, ((mx - prev[0]) * dx + (my - prev[1]) * dy) / L2)) : 0
            const d = Math.hypot(mx - prev[0] - t * dx, my - prev[1] - t * dy)
            const z = prev[2] + t * (cur[2] - prev[2])
            if (d < tol && z <= depth + 0.01 * s.size && (!best || d < best.d)) best = { d, c }
          }
          prev = cur
        }
      }
      if (best) return { edge: best.c }
    }
    if (hit && (want.faces || want.planar || want.cyl)) {
      const t = cb.current.tess
      const tag = t.tri_surface[hit.faceIndex]
      const face = t.surfaces.find((f) => f.tag === tag)
      if (face && (want.faces || (want.planar && face.kind === 'plane') || (want.cyl && face.kind === 'cylinder'))) return { face }
    }
    if (want.std && s.stdPlanes?.length) {
      const hits = r.intersectObjects(s.stdPlanes.map((p) => p.mesh), false)
      if (hits.length && hits[0].distance < depth) {
        const p = s.stdPlanes.find((x) => x.mesh === hits[0].object)
        return { std: p.name }
      }
    }
    return null
  }

  // --- Maus: Auswahl in 3D und Skizzieren ------------------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    const canvas = s.renderer.domElement
    let down = null
    let drag = null

    const sketchHit = (ev, sk, plane) => {
      const q = onPlane(ev, plane)
      if (!q) return null
      const tol = 8 * mmPerPx(plane)
      let best = null
      for (const [id, p] of Object.entries(sk.pts)) {
        const d = Math.hypot(q[0] - p.x, q[1] - p.y)
        if (d < tol && (!best || d < best.d)) best = { pt: id, d }
      }
      if (best) return { ...best, q }
      for (const e of sk.ents) {
        const d = distTo(sk, e, q)
        if (d < tol && (!best || d < best.d)) best = { ent: e.id, d }
      }
      return best ? { ...best, q } : { q }
    }

    // Linie einer Hintergrund-Skizze unter dem Zeiger → id der Skizze
    const bgHit = (ev) => {
      const list = cb.current.sketches
      if (!list?.length || !cb.current.onSketchPick) return null
      let best = null
      for (const k of list) {
        const q = onPlane(ev, k.plane)
        if (!q) continue
        const tol = 7 * mmPerPx(k.plane)
        for (const e of k.data.ents) {
          if (e.t === 'point') continue
          const d = distTo(k.data, e, q)
          if (d < tol && (!best || d / tol < best.d)) best = { id: k.id, ent: e.id, d: d / tol }
        }
      }
      return best
    }

    const refsOf = (plane) => {
      // Bauteilpunkte und Kreismitten, die in der Skizzenebene liegen (zum Fangen)
      const t = cb.current.tess
      const b = basis(plane)
      const tol = 1e-4 * ctx.current.size
      const out = []
      const addP = (p) => {
        const d = [p[0] - b.o[0], p[1] - b.o[1], p[2] - b.o[2]]
        if (Math.abs(d[0] * b.n[0] + d[1] * b.n[1] + d[2] * b.n[2]) > tol) return
        out.push([d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2], d[0] * b.v[0] + d[1] * b.v[1] + d[2] * b.v[2]])
      }
      // Ursprung (in die Ebene projiziert, wenn er darin liegt)
      addP([0, 0, 0])
      if (!t) return out
      for (const v of t.vertices) addP(v)
      for (const c of t.curves) if (c.kind === 'circle' && c.center) addP(c.center)
      return out
    }

    const finishTool = (msg) => {
      tmp.current = null
      setOverlay((o) => ({ ...o, tick: (o.tick ?? 0) + 1 }))
      if (msg) cb.current.sketch?.onMessage?.(msg)
    }

    // neue Skizze übernehmen (gelöst); bei Widerspruch verwerfen
    const commit = (sk2, what = 'Diese Bedingung widerspricht den vorhandenen') => {
      const r = solved(sk2)
      if (!r.info.ok) {
        cb.current.sketch.onMessage?.(what)
        return false
      }
      cb.current.sketch.onChange(r.sketch, r.info)
      return true
    }

    const onDown = (ev) => {
      down = { x: ev.clientX, y: ev.clientY, button: ev.button }
      const sk = cb.current.sketch
      if (!sk || ev.button !== 0 || ev.shiftKey && sk.tool !== 'select') return
      const plane = sk.plane
      const data = sk.data
      if (sk.tool === 'select') {
        const h = sketchHit(ev, data, plane)
        if (h?.pt || h?.ent) {
          // Ziehen vorbereiten
          const e = h.ent ? data.ents.find((x) => x.id === h.ent) : null
          const pts = h.pt ? [h.pt] : e && e.t !== 'circle' ? entPoints(e) : e ? [] : []
          drag = { q0: h.q, pts: pts.filter((p) => !data.pts[p].fix).map((p) => [p, data.pts[p].x, data.pts[p].y]), circle: e?.t === 'circle' ? e : null, moved: false, hit: h }
          ctx.current.controls.enabled = false
          canvas.setPointerCapture(ev.pointerId)
        }
      }
    }

    const onMove = (ev) => {
      const sk = cb.current.sketch
      const s = ctx.current
      if (drag && sk) {
        const q = onPlane(ev, sk.plane)
        if (!q) return
        const dx = q[0] - drag.q0[0]
        const dy = q[1] - drag.q0[1]
        if (!drag.moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 3) return
        drag.moved = true
        const target = { pts: {}, radius: {} }
        for (const [id, x, y] of drag.pts) target.pts[id] = [x + dx, y + dy]
        if (drag.circle) {
          const c = sk.data.pts[drag.circle.c]
          target.radius[drag.circle.id] = Math.hypot(q[0] - c.x, q[1] - c.y)
        }
        const r = solved(sk.data, { drag: target, analyse: false })
        if (r.info.ok) sk.onChange(r.sketch, null, true)
        return
      }
      if (sk && sk.tool !== 'select') {
        updatePreview(ev, sk)
        return
      }
      // Hervorheben
      if (sk) {
        const h = sketchHit(ev, sk.data, sk.plane)
        const nh = h?.pt ? { pt: h.pt } : h?.ent ? { ent: h.ent } : null
        setHover((o) => (JSON.stringify(o) === JSON.stringify(nh) ? o : nh))
        return
      }
      const want = cb.current.pick
      if (!want) {
        const h = bgHit(ev)
        const nh = h ? { bg: h.id, ent: h.ent, bgEnt: true } : null
        return setHover((o) => (JSON.stringify(o) === JSON.stringify(nh) ? o : nh))
      }
      const h = pick3d(ev, want)
      const nh = h?.face ? { face: h.face.tag } : h?.edge ? { edge: h.edge.tag } : h?.std ? { std: h.std } : null
      setHover((o) => (JSON.stringify(o) === JSON.stringify(nh) ? o : nh))
      s.dirty = true
    }

    function updatePreview(ev, sk) {
      const q = onPlane(ev, sk.plane)
      if (!q) return
      const data = sk.data
      const tol = 9 * mmPerPx(sk.plane)
      const t = tmp.current ?? { tool: sk.tool, pts: [] }
      if (t.tool !== sk.tool) {
        tmp.current = null
        return
      }
      let hit = sk.tool === 'dim' ? null : snap(data, q, tol, refsOf(sk.plane))
      let at = hit ? hit.at : q
      // waagrecht/senkrecht einrasten
      const last = t.pts[t.pts.length - 1]
      if (!hit && last && (sk.tool === 'line')) {
        const hv = hvHint(last.at, q)
        if (hv === 'h') at = [q[0], last.at[1]]
        if (hv === 'v') at = [last.at[0], q[1]]
      }
      t.cur = { at, hit }
      t.snapAt = hit ? hit.at : null
      t.preview = previewOf(sk.tool, t, data)
      tmp.current = t
      if (sk.tool === 'dim') {
        const h = sketchHit(ev, data, sk.plane)
        const nh = h?.pt ? { pt: h.pt } : h?.ent ? { ent: h.ent } : null
        setHover((o) => (JSON.stringify(o) === JSON.stringify(nh) ? o : nh))
      }
      setOverlay((o) => ({ ...o, tick: (o.tick ?? 0) + 1 }))
    }

    function previewOf(tool, t, data) {
      const pts = [...t.pts.map((p) => p.at), t.cur.at]
      if (tool === 'line' && pts.length >= 2) return [[pts[pts.length - 2], pts[pts.length - 1]]]
      if (tool === 'rect' && pts.length === 2) {
        const [a, b] = pts
        return [[a, [b[0], a[1]], b, [a[0], b[1]], a]]
      }
      if (tool === 'circle' && pts.length === 2) {
        const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
        return [Array.from({ length: 65 }, (_, i) => [pts[0][0] + r * Math.cos((i * Math.PI) / 32), pts[0][1] + r * Math.sin((i * Math.PI) / 32)])]
      }
      if (tool === 'arc' && pts.length >= 2) {
        const c = pts[0]
        const r = Math.hypot(pts[1][0] - c[0], pts[1][1] - c[1])
        if (pts.length === 2) return [[c, pts[1]]]
        const a0 = Math.atan2(pts[1][1] - c[1], pts[1][0] - c[0])
        let a1 = Math.atan2(pts[2][1] - c[1], pts[2][0] - c[0])
        while (a1 <= a0) a1 += 2 * Math.PI
        return [Array.from({ length: 49 }, (_, i) => [c[0] + r * Math.cos(a0 + ((a1 - a0) * i) / 48), c[1] + r * Math.sin(a0 + ((a1 - a0) * i) / 48)])]
      }
      if (tool === 'dim' && t.picks?.length) {
        const con = dimFor(data, t.picks, t.cur.at)
        if (!con) return []
        const d = dimGeometry(data, { ...con, at: t.cur.at })
        return d ? [[d.from, d.to], ...d.ext] : []
      }
      return []
    }

    const onUp = (ev) => {
      const sk = cb.current.sketch
      if (drag) {
        const was = drag
        drag = null
        ctx.current.controls.enabled = true
        if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)
        if (was.moved) {
          const r = solved(sk.data)
          sk.onChange(r.sketch, r.info)
          return
        }
      }
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4 || down.button !== 0) return
      if (sk) return sketchClick(ev, sk)
      const want = cb.current.pick
      if (!want) {
        const h = bgHit(ev)
        cb.current.onSketchPick?.(h?.id ?? null, false, h?.ent ?? null)
        return
      }
      const h = pick3d(ev, want)
      cb.current.onPick?.(h, ev)
    }

    function sketchClick(ev, sk) {
      const data = sk.data
      const plane = sk.plane
      const q = onPlane(ev, plane)
      if (!q) return
      if (sk.tool === 'select') {
        const h = sketchHit(ev, data, plane)
        const add = ev.shiftKey || ev.ctrlKey || ev.metaKey
        const cur = sk.sel ?? { pts: [], ents: [], cons: [] }
        if (!h?.pt && !h?.ent) return sk.onSel({ pts: [], ents: [], cons: [] })
        const key = h.pt ? 'pts' : 'ents'
        const id = h.pt ?? h.ent
        const has = cur[key].includes(id)
        const next = add ? { ...cur, [key]: has ? cur[key].filter((x) => x !== id) : [...cur[key], id] } : { pts: [], ents: [], cons: [], [key]: [id] }
        sk.onSel(next)
        return
      }
      if (sk.tool === 'use') {
        // Bauteilkante in die Skizze übernehmen (fest)
        const h = pick3d(ev, { edges: true })
        if (!h?.edge) return sk.onMessage?.('Eine Kante des Bauteils anklicken')
        const c = h.edge
        const s2 = structuredClone(data)
        const b = basis(plane)
        const loc = (p) => {
          const d = [p[0] - b.o[0], p[1] - b.o[1], p[2] - b.o[2]]
          return [d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2], d[0] * b.v[0] + d[1] * b.v[1] + d[2] * b.v[2]]
        }
        if (c.kind === 'circle' && c.center && Math.abs(Math.abs(c.axis[0] * b.n[0] + c.axis[1] * b.n[1] + c.axis[2] * b.n[2]) - 1) < 1e-6) {
          const ctr = addPoint(s2, loc(c.center), true)
          if (c.closed) addEnt(s2, { t: 'circle', c: ctr, r: c.radius, fix: true })
          else {
            const p0 = loc(c.pts.slice(0, 3))
            const p1 = loc(c.pts.slice(-3))
            // Richtung gegen den Uhrzeigersinn in der Skizze
            const mid = loc(c.pts.slice(3 * Math.floor(c.pts.length / 6), 3 * Math.floor(c.pts.length / 6) + 3))
            const cr = (p0[0] - mid[0]) * (p1[1] - mid[1]) - (p0[1] - mid[1]) * (p1[0] - mid[0])
            const [pa, pb] = cr > 0 ? [p0, p1] : [p1, p0]
            addEnt(s2, { t: 'arc', c: ctr, a: addPoint(s2, pa, true), b: addPoint(s2, pb, true) })
          }
        } else if (c.kind === 'line') {
          const a = loc(c.pts.slice(0, 3))
          const e = loc(c.pts.slice(-3))
          const find = (p) => Object.entries(s2.pts).find(([, x]) => x.fix && Math.hypot(x.x - p[0], x.y - p[1]) < 1e-6)?.[0]
          addEnt(s2, { t: 'line', a: find(a) ?? addPoint(s2, a, true), b: find(e) ?? addPoint(s2, e, true) })
        } else return sk.onMessage?.('Nur gerade Kanten und Kreiskanten parallel zur Skizze lassen sich übernehmen')
        commit(s2)
        return
      }
      const tol = 9 * mmPerPx(plane)
      const t = tmp.current?.tool === sk.tool ? tmp.current : { tool: sk.tool, pts: [] }
      if (sk.tool === 'dim') {
        const h = sketchHit(ev, data, plane)
        t.picks = t.picks ?? []
        if ((h?.pt || h?.ent) && t.picks.length < 2 && !(t.picks.length && t.ready)) {
          t.picks.push(h.pt ? { pt: h.pt } : { ent: h.ent })
          // ein Kreis oder eine einzelne Linie: gleich ablegbar; sonst auf das zweite Element warten
          const one = t.picks.length === 1 && h.ent && data.ents.find((e) => e.id === h.ent)?.t !== 'point'
          t.ready = one || t.picks.length === 2
          t.cur = { at: q }
          tmp.current = t
          setOverlay((o) => ({ ...o, tick: (o.tick ?? 0) + 1 }))
          if (!(t.ready && t.picks.length === 2)) return
          return
        }
        if (!t.picks.length) return
        const con = dimFor(data, t.picks, q)
        if (!con) {
          tmp.current = null
          return sk.onMessage?.('Dafür gibt es kein Maß – zwei Punkte, Punkt und Linie, zwei Linien, eine Linie oder einen Kreis wählen')
        }
        const s2 = structuredClone(data)
        const value = measure(s2, con)
        const c = addCon(s2, { ...con, v: Number(value.toFixed(4)), at: q })
        const r = solved(s2)
        tmp.current = null
        if (!r.info.ok) return sk.onMessage?.('Das Maß widerspricht den vorhandenen Bedingungen')
        if (r.info.redundant > (sk.info?.redundant ?? 0)) {
          // überzählig: als reines Messmaß nicht anlegen
          return sk.onMessage?.('Das ist schon festgelegt – kein weiteres Maß nötig')
        }
        sk.onChange(r.sketch, r.info)
        const el = host.current.getBoundingClientRect()
        setEdit({ id: c.id, x: ev.clientX - el.left, y: ev.clientY - el.top, value: fmtN(c.v), fresh: true })
        return
      }
      const hit = snap(data, q, tol, refsOf(plane))
      let at = hit ? hit.at : q
      const last = t.pts[t.pts.length - 1]
      if (!hit && last && sk.tool === 'line') {
        const hv = hvHint(last.at, q)
        if (hv === 'h') at = [q[0], last.at[1]]
        if (hv === 'v') at = [last.at[0], q[1]]
      }
      t.pts.push({ at, hit })
      tmp.current = t
      const s2 = structuredClone(data)
      if (sk.tool === 'point') {
        const id = pointAt(s2, at, hit)
        addEnt(s2, { t: 'point', p: id })
        commit(s2)
        tmp.current = null
        return
      }
      if (sk.tool === 'line' && t.pts.length >= 2) {
        const [p0, p1] = t.pts.slice(-2)
        if (Math.hypot(p1.at[0] - p0.at[0], p1.at[1] - p0.at[1]) < tol / 3) {
          t.pts.pop()
          return finishTool()
        }
        const a = p0.id ?? pointAt(s2, p0.at, p0.hit)
        const b = pointAt(s2, p1.at, p1.hit)
        const e = addEnt(s2, { t: 'line', a, b, cons: sk.construction || undefined })
        const hv = hvHint(p0.at, p1.at)
        if (hv) addCon(s2, { t: hv, a, b })
        if (commit(s2)) {
          p1.id = b
          // Linienzug geschlossen (Anfangspunkt getroffen): fertig
          if (p1.hit?.pt && p1.hit.pt === t.first) return finishTool()
          if (t.pts.length === 2) t.first = a
          t.pts = [p1]
          void e
        } else finishTool()
        return
      }
      if (sk.tool === 'line' && t.pts.length === 1 && t.pts[0].hit?.pt) {
        t.pts[0].id = t.pts[0].hit.pt
        t.first = t.pts[0].hit.pt
      }
      if (sk.tool === 'rect' && t.pts.length === 2) {
        const [A, B] = t.pts
        if (Math.abs(A.at[0] - B.at[0]) < tol / 3 || Math.abs(A.at[1] - B.at[1]) < tol / 3) {
          t.pts.pop()
          return
        }
        const a = pointAt(s2, A.at, A.hit)
        const c = pointAt(s2, B.at, B.hit)
        const b = addPoint(s2, [B.at[0], A.at[1]])
        const d = addPoint(s2, [A.at[0], B.at[1]])
        const cons = sk.construction || undefined
        addEnt(s2, { t: 'line', a, b, cons })
        addEnt(s2, { t: 'line', a: b, b: c, cons })
        addEnt(s2, { t: 'line', a: c, b: d, cons })
        addEnt(s2, { t: 'line', a: d, b: a, cons })
        addCon(s2, { t: 'h', a, b })
        addCon(s2, { t: 'v', a: b, b: c })
        addCon(s2, { t: 'h', a: c, b: d })
        addCon(s2, { t: 'v', a: d, b: a })
        commit(s2)
        return finishTool()
      }
      if (sk.tool === 'circle' && t.pts.length === 2) {
        const [C, R] = t.pts
        const r = Math.hypot(R.at[0] - C.at[0], R.at[1] - C.at[1])
        if (r < tol / 3) {
          t.pts.pop()
          return
        }
        const c = pointAt(s2, C.at, C.hit)
        const e = addEnt(s2, { t: 'circle', c, r, cons: sk.construction || undefined })
        if (R.hit?.pt) addCon(s2, { t: 'on', p: R.hit.pt, e: e.id })
        commit(s2)
        return finishTool()
      }
      if (sk.tool === 'arc' && t.pts.length === 3) {
        const [C, A, B] = t.pts
        const r = Math.hypot(A.at[0] - C.at[0], A.at[1] - C.at[1])
        if (r < tol / 3) {
          t.pts.pop()
          return
        }
        const c = pointAt(s2, C.at, C.hit)
        const a = pointAt(s2, A.at, A.hit)
        // Endpunkt auf den Radius ziehen
        const ang = Math.atan2(B.at[1] - C.at[1], B.at[0] - C.at[0])
        const bAt = B.hit?.pt ? B.at : [C.at[0] + r * Math.cos(ang), C.at[1] + r * Math.sin(ang)]
        const b = pointAt(s2, bAt, B.hit?.pt ? B.hit : null)
        addEnt(s2, { t: 'arc', c, a, b, cons: sk.construction || undefined })
        commit(s2)
        return finishTool()
      }
      setOverlay((o) => ({ ...o, tick: (o.tick ?? 0) + 1 }))
    }

    const onDbl = (ev) => {
      const sk = cb.current.sketch
      if (sk) {
        if (sk.tool === 'line') finishTool()
        return
      }
      // Doppelklick auf eine Hintergrund-Skizze: bearbeiten
      if (!cb.current.pick) {
        const h = bgHit(ev)
        if (h) return cb.current.onSketchPick?.(h.id, true, h.ent)
      }
      // Doppelklick auf ebene Fläche: Blick senkrecht darauf
      const h = pick3d(ev, { planar: true })
      if (h?.face?.normal) lookAtPlane({ origin: h.face.point ?? h.face.center, normal: h.face.normal })
    }
    const onKey = (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLSelectElement) return
      const sk = cb.current.sketch
      if (!sk) return
      if (ev.key === 'Escape') {
        if (tmp.current) {
          ev.stopPropagation()
          finishTool()
        }
      }
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('dblclick', onDbl)
    canvas.addEventListener('pointerleave', () => setHover(null))
    window.addEventListener('keydown', onKey, true)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('dblclick', onDbl)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Werkzeug gewechselt: laufende Aktion verwerfen; linke Taste beim Skizzieren nicht zum Drehen
  useEffect(() => {
    tmp.current = null
    ctx.current.controls.reserveLeft = !!sketch
    setOverlay((o) => ({ ...o, tick: (o.tick ?? 0) + 1 }))
  }, [sketch?.tool, !!sketch])

  // --- Kamera ---------------------------------------------------------------------------------------
  function fitAll(dir = [1, -1.25, 0.85], up = [0, 0, 1]) {
    const s = ctx.current
    // Körper und Skizze (auch ohne Körper, z. B. nach einem Import)
    const box = new THREE.Box3()
    for (const g of [s.body, s.sketch, s.bgGroup, s.regionGroup]) if (g.children.length) box.expandByObject(g)
    const center = box.isEmpty() ? s.center.clone() : box.getCenter(new THREE.Vector3())
    const radius = box.isEmpty() ? s.size / 2 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 5)
    s.lastFit = radius
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(s.camera.fov / 2))) * 1.15
    s.controls.setView(center, new THREE.Vector3(...dir).normalize(), dist, new THREE.Vector3(...up))
    s.dirty = true
  }
  function fitView(name) {
    fitAll(VIEWS[name].dir, VIEWS[name].up)
  }
  function lookAtPlane(plane, sk = null) {
    const s = ctx.current
    const b = basis(plane)
    const o = new THREE.Vector3(...b.o)
    const c = s.center.clone()
    // Mitte des Bauteils in die Ebene projizieren
    const n = new THREE.Vector3(...b.n)
    let target = c.sub(n.clone().multiplyScalar(c.clone().sub(o).dot(n)))
    let radius = Math.max(s.size / 2, 20)
    const ps = sk ? Object.values(sk.pts) : []
    if (ps.length) {
      // auf die Skizze einpassen
      const xs = ps.map((p) => p.x)
      const ys = ps.map((p) => p.y)
      const lo = [Math.min(...xs), Math.min(...ys)]
      const hi = [Math.max(...xs), Math.max(...ys)]
      target = new THREE.Vector3(...to3d(plane, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]))
      const aspect = s.camera.aspect || 1
      radius = Math.max(((hi[0] - lo[0]) / 2) / Math.min(aspect, 1.6), (hi[1] - lo[1]) / 2, 10)
    }
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(s.camera.fov / 2))) * 1.15
    s.controls.setView(target, n, dist, new THREE.Vector3(...b.v))
    s.dirty = true
  }

  // Maßwert setzen
  function applyDim(id, text) {
    const sk = sketch
    if (!sk) return
    const v = Number(String(text).replace(',', '.'))
    if (!(v > 0) && !(v === 0 && sk.data.cons.find((c) => c.id === id)?.t === 'ang')) return sk.onMessage?.('Bitte eine Zahl > 0 eingeben')
    const s2 = structuredClone(sk.data)
    const c = s2.cons.find((x) => x.id === id)
    if (!c) return
    c.v = v
    const r = solved(s2)
    if (!r.info.ok) return sk.onMessage?.('Dieser Wert lässt sich nicht einhalten (widerspricht anderen Maßen oder Bedingungen)')
    sk.onChange(r.sketch, r.info)
  }

  const cursor = sketch ? (sketch.tool === 'select' ? (hover?.pt || hover?.ent ? 'pointer' : 'default') : 'crosshair') : (pick || hover?.bg != null) && hover ? 'pointer' : 'default'
  return (
    <div className="viewport cad-view">
      <div ref={host} className="viewport-canvas" style={{ cursor }} />
      {labels3d
        .filter((l) => l.visible)
        .map((l) => (
          <span key={l.key} className={l.cls} style={{ left: l.x, top: l.y }}>
            {l.text}
          </span>
        ))}
      <div className="view-nav">
        <ViewCube cam={cam} onView={fitView} />
        <div className="view-buttons">
          <button className="icon-btn" title="Isometrisch (Startansicht)" aria-label="Isometrische Ansicht" onClick={() => fitView('iso')}>
            <IcHome />
          </button>
          <button className="icon-btn" title="Alles zeigen" aria-label="Alles zeigen" onClick={() => fitAll(cam[2], cam[1])}>
            <IcFit />
          </button>
          {sketch && (
            <button className="icon-btn cad-normal-btn" title="Senkrecht auf die Skizze schauen" aria-label="Senkrecht auf die Skizze" onClick={() => lookAtPlane(sketch.plane, sketch.data)}>
              ⊥
            </button>
          )}
        </div>
      </div>
      <Triad cam={cam} onView={fitView} />
      {sketch &&
        overlay.dims.map((d) => (
          <button
            key={d.id}
            className={'cad-dim' + (sketch.sel?.cons?.includes(d.id) ? ' on' : '')}
            style={{ left: d.x, top: d.y }}
            title={d.name ? `${d.name} – Doppelklick zum Ändern` : 'Doppelklick zum Ändern'}
            onClick={(e) => {
              e.stopPropagation()
              const add = e.shiftKey || e.ctrlKey || e.metaKey
              const cur = sketch.sel ?? { pts: [], ents: [], cons: [] }
              sketch.onSel(add ? { ...cur, cons: cur.cons.includes(d.id) ? cur.cons.filter((x) => x !== d.id) : [...cur.cons, d.id] } : { pts: [], ents: [], cons: [d.id] })
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              const c = sketch.data.cons.find((x) => x.id === d.id)
              setEdit({ id: d.id, x: d.x, y: d.y, value: fmtN(c.v) })
            }}
          >
            {d.txt}
          </button>
        ))}
      {sketch &&
        (sketch.showGlyphs ?? (sketch.data?.cons?.length ?? 0) <= 40) &&
        overlay.glyphs.map((g) => (
          <button
            key={g.id}
            className={'cad-glyph' + (sketch.sel?.cons?.includes(g.con ?? g.id) ? ' on' : '')}
            style={{ left: g.x, top: g.y }}
            title={'Bedingung – anklicken, Entf löscht'}
            onClick={(e) => {
              e.stopPropagation()
              sketch.onSel({ pts: [], ents: [], cons: [g.con ?? g.id] })
            }}
          >
            {g.g}
          </button>
        ))}
      {edit && sketch && (
        <form
          className="cad-dim-edit"
          style={{ left: edit.x, top: edit.y }}
          onSubmit={(e) => {
            e.preventDefault()
            applyDim(edit.id, edit.value)
            setEdit(null)
          }}
        >
          <input
            autoFocus
            value={edit.value}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            onBlur={() => {
              applyDim(edit.id, edit.value)
              setEdit(null)
            }}
            onKeyDown={(e) => e.key === 'Escape' && setEdit(null)}
          />
        </form>
      )}
      {regions?.list?.length > 0 && (
        <RegionClicks regions={regions} ctx={ctx} onPlane={onPlane} />
      )}
    </div>
  )
}

// Klicks auf Bereiche (Extrudieren/Drehen) abfangen, ohne den Skizzierer zu stören
function RegionClicks({ regions, ctx, onPlane }) {
  // nur die Teile, die sich selten ändern, als Abhängigkeit (sonst bei jedem Hover neu anmelden)
  const ref = useRef(regions)
  ref.current = regions
  useEffect(() => {
    const canvas = ctx.current.renderer.domElement
    let down = null
    let pending = false
    const find = (e) => {
      const r = ref.current
      const q = onPlane(e, r.plane)
      if (!q) return -1
      // innere Bereiche (kleinere Fläche) vor äußeren – die Ränder liegen genau aufeinander
      let best = -1
      let bestArea = Infinity
      r.list.forEach((x, i) => {
        if (insideLoops(q, x.loops) && (x.area ?? 0) < bestArea) {
          best = i
          bestArea = x.area ?? 0
        }
      })
      return best
    }
    const d = (e) => (down = [e.clientX, e.clientY, e.button])
    const u = (e) => {
      if (!down || down[2] !== 0 || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return
      const i = find(e)
      if (i >= 0) ref.current.onToggle(i, e.altKey)
    }
    const m = (e) => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        const i = find(e)
        if (i !== (ref.current.hover ?? -1)) ref.current.onHover?.(i)
      })
    }
    const leave = () => ref.current.onHover?.(-1)
    canvas.addEventListener('pointerdown', d)
    canvas.addEventListener('pointerup', u)
    canvas.addEventListener('pointermove', m)
    canvas.addEventListener('pointerleave', leave)
    return () => {
      canvas.removeEventListener('pointerdown', d)
      canvas.removeEventListener('pointerup', u)
      canvas.removeEventListener('pointermove', m)
      canvas.removeEventListener('pointerleave', leave)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx])
  return null
}

export function fmtN(v) {
  if (v == null || !Number.isFinite(v)) return '–'
  const r = Math.round(v * 1000) / 1000
  return String(r).replace('.', ',')
}

export { radiusOf }
