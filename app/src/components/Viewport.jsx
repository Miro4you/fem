import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Box, ArrowRight, ArrowUp, ArrowDown } from 'lucide-react'
import { bandTexture, BANDS } from '../colormap.js'

const BASE = new THREE.Color('#b9c0c8')

// Ansichtsrichtungen (Blickrichtung zum Ziel hin, z zeigt nach oben)
const VIEWS = {
  iso: { dir: [1, -1.25, 0.85], icon: Box, title: 'Isometrisch' },
  front: { dir: [0, -1, 0], icon: ArrowUp, title: 'Vorne (−y)' },
  right: { dir: [1, 0, 0], icon: ArrowRight, title: 'Rechts (+x)' },
  top: { dir: [0, 0, 1], icon: ArrowDown, title: 'Oben (+z)' },
}

export default function Viewport({
  mesh,
  mode,
  surfaceTint,
  pickable,
  onPick,
  result,
  showMesh,
  arrows,
  markers,
  onProbe,
}) {
  const host = useRef(null)
  const ctx = useRef(null)
  const cb = useRef({})
  cb.current = { onPick, onProbe, pickable, mode }
  const [hoverTag, setHoverTag] = useState(null)
  const [labels, setLabels] = useState([])

  // --- Grundaufbau (einmalig) ---------------------------------------------
  useEffect(() => {
    const el = host.current
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
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

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.15
    controls.screenSpacePanning = true

    const state = {
      renderer, scene, camera, controls, dirty: true, raf: 0,
      group: new THREE.Group(), surf: null, edges: null, wire: null, ghost: null, arrows: new THREE.Group(),
      texture: bandTexture(), labelNodes: [],
    }
    scene.add(state.group)
    scene.add(state.arrows)
    ctx.current = state

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el
      renderer.setSize(w, h)
      camera.aspect = w / Math.max(h, 1)
      camera.updateProjectionMatrix()
      state.dirty = true
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    controls.addEventListener('change', () => (state.dirty = true))
    const loop = () => {
      state.raf = requestAnimationFrame(loop)
      controls.update()
      if (state.dirty) {
        state.dirty = false
        renderer.render(scene, camera)
        updateLabels()
      }
    }
    const updateLabels = () => {
      const { clientWidth: w, clientHeight: h } = el
      setLabels(
        state.labelNodes.map((m) => {
          const p = new THREE.Vector3(...m.pos).project(camera)
          return { ...m, x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, visible: p.z < 1 }
        }),
      )
    }
    state.updateLabels = updateLabels
    loop()

    // Klick ohne Ziehen = Auswahl
    const ray = new THREE.Raycaster()
    let down = null
    const hit = (ev) => {
      if (!state.surf) return null
      const r = renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      return ray.intersectObject(state.surf, false)[0] ?? null
    }
    const onDown = (ev) => (down = [ev.clientX, ev.clientY])
    const onUp = (ev) => {
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4) return
      const h = hit(ev)
      const { mode, pickable, onPick, onProbe } = cb.current
      if (mode === 'setup' && pickable && h) onPick?.(state.triSurface[h.faceIndex])
      if (mode === 'result') {
        if (!h) return onProbe?.(null)
        // nächster Knoten des getroffenen Dreiecks
        const pos = state.surf.geometry.attributes.position
        let best = null
        for (let k = 0; k < 3; k++) {
          const v = 3 * h.faceIndex + k
          const d = new THREE.Vector3().fromBufferAttribute(pos, v).distanceTo(h.point)
          if (!best || d < best.d) best = { d, node: state.vertNode[v] }
        }
        onProbe?.({ node: best.node, point: h.point.toArray() })
      }
    }
    let hoverPending = false
    const onMove = (ev) => {
      if (hoverPending) return
      hoverPending = true
      requestAnimationFrame(() => {
        hoverPending = false
        const { mode, pickable } = cb.current
        if (mode !== 'setup' || !pickable) return setHoverTag(null)
        const h = hit(ev)
        setHoverTag(h ? state.triSurface[h.faceIndex] : null)
      })
    }
    const canvas = renderer.domElement
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', () => setHoverTag(null))

    return () => {
      cancelAnimationFrame(state.raf)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      el.removeChild(canvas)
    }
  }, [])

  // --- Netz aufbauen ---------------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.group.clear()
    s.surf = s.edges = s.wire = s.ghost = null
    if (!mesh) {
      s.dirty = true
      return
    }
    const nTri = mesh.triangles.length / 3
    const vertNode = new Uint32Array(nTri * 3)
    for (let i = 0; i < nTri * 3; i++) vertNode[i] = mesh.triangles[i]
    s.vertNode = vertNode
    s.triSurface = mesh.tri_surface
    s.base = Float32Array.from(mesh.positions)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nTri * 9), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nTri * 9), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nTri * 9), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nTri * 6), 2))
    s.setupMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.05, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    })
    s.resultMat = new THREE.MeshStandardMaterial({
      map: s.texture, roughness: 0.75, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    })
    s.surf = new THREE.Mesh(geo, s.setupMat)
    s.group.add(s.surf)

    const lineGeo = (pairs) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3))
      g.userData.pairs = pairs
      return g
    }
    s.edges = new THREE.LineSegments(lineGeo(mesh.feature_edges), new THREE.LineBasicMaterial({ color: 0x1f2329 }))
    s.wire = new THREE.LineSegments(
      lineGeo(mesh.mesh_edges),
      new THREE.LineBasicMaterial({ color: 0x2a2f36, transparent: true, opacity: 0.28 }),
    )
    s.ghost = new THREE.LineSegments(
      lineGeo(mesh.feature_edges),
      new THREE.LineBasicMaterial({ color: 0x6b7280, transparent: true, opacity: 0.45 }),
    )
    s.group.add(s.edges, s.wire, s.ghost)
    fitView('iso')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesh])

  // --- Geometrie (Verformung), Farben -----------------------------------------
  useEffect(() => {
    const s = ctx.current
    if (!s.surf) return
    const scale = mode === 'result' && result ? result.scale : 0
    const disp = result?.displacement
    const P = (n, out) => {
      for (let k = 0; k < 3; k++) out[k] = s.base[3 * n + k] + (scale && disp ? scale * disp[3 * n + k] : 0)
      return out
    }
    // Flächen
    const pos = s.surf.geometry.attributes.position.array
    const tmp = [0, 0, 0]
    for (let v = 0; v < s.vertNode.length; v++) {
      P(s.vertNode[v], tmp)
      pos[3 * v] = tmp[0]
      pos[3 * v + 1] = tmp[1]
      pos[3 * v + 2] = tmp[2]
    }
    s.surf.geometry.attributes.position.needsUpdate = true
    smoothNormals(s)
    s.surf.geometry.computeBoundingSphere()
    // Kanten
    for (const [line, deformed] of [[s.edges, true], [s.wire, true], [s.ghost, false]]) {
      const arr = line.geometry.attributes.position.array
      const pairs = line.geometry.userData.pairs
      for (let i = 0; i < pairs.length; i++) {
        const n = pairs[i]
        for (let k = 0; k < 3; k++) arr[3 * i + k] = s.base[3 * n + k] + (deformed && scale && disp ? scale * disp[3 * n + k] : 0)
      }
      line.geometry.attributes.position.needsUpdate = true
      line.geometry.computeBoundingSphere()
    }
    s.ghost.visible = mode === 'result' && scale > 0
    s.wire.visible = !!showMesh
    s.dirty = true
  }, [mesh, mode, result, showMesh])

  useEffect(() => {
    const s = ctx.current
    if (!s.surf) return
    if (mode === 'result' && result) {
      s.surf.material = s.resultMat
      const uv = s.surf.geometry.attributes.uv.array
      const span = result.max - result.min || 1
      for (let v = 0; v < s.vertNode.length; v++) {
        let t = Math.min(Math.max((result.values[s.vertNode[v]] - result.min) / span, 0), 1)
        if (result.reverse) t = 1 - t
        uv[2 * v] = t * (1 - 1e-4) + 0.5e-4
        uv[2 * v + 1] = 0.5
      }
      s.surf.geometry.attributes.uv.needsUpdate = true
    } else {
      s.surf.material = s.setupMat
      const col = s.surf.geometry.attributes.color.array
      const c = new THREE.Color()
      for (let t = 0; t < s.triSurface.length; t++) {
        const tag = s.triSurface[t]
        const tint = surfaceTint?.(tag)
        c.copy(tint ? new THREE.Color(tint) : BASE)
        if (tag === hoverTag) c.lerp(new THREE.Color('#ffffff'), 0.45)
        for (let k = 0; k < 3; k++) c.toArray(col, 9 * t + 3 * k)
      }
      s.surf.geometry.attributes.color.needsUpdate = true
    }
    s.dirty = true
  }, [mesh, mode, result, surfaceTint, hoverTag])

  // --- Pfeile und Markierungen -------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.arrows.clear()
    for (const a of arrows ?? []) {
      const dir = new THREE.Vector3(...a.dir).normalize()
      const origin = new THREE.Vector3(...a.tip).addScaledVector(dir, -a.length)
      const arrow = new THREE.ArrowHelper(dir, origin, a.length, a.color, a.length * 0.28, a.length * 0.14)
      // immer sichtbar, auch wenn der Pfeil im oder hinter dem Bauteil liegt
      arrow.traverse((o) => {
        if (o.material) {
          o.material.depthTest = false
          o.material.transparent = true
        }
        o.renderOrder = 10
      })
      if (arrow.line.material) arrow.line.material.linewidth = 2
      s.arrows.add(arrow)
    }
    s.arrows.visible = mode === 'setup'
    s.dirty = true
  }, [arrows, mode])

  useEffect(() => {
    const s = ctx.current
    const scale = mode === 'result' && result ? result.scale : 0
    s.labelNodes = (markers ?? []).map((m) => {
      const pos = [0, 1, 2].map((k) => s.base[3 * m.node + k] + (scale ? scale * result.displacement[3 * m.node + k] : 0))
      return { ...m, pos }
    })
    s.dirty = true
  }, [markers, mode, result])

  function fitView(name) {
    const s = ctx.current
    if (!mesh) return
    const [lo, hi] = mesh.bbox
    const center = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
    const radius = new THREE.Vector3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]).length() / 2
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(s.camera.fov / 2))) * 1.08
    const dir = new THREE.Vector3(...VIEWS[name].dir).normalize()
    s.camera.position.copy(center).addScaledVector(dir, dist)
    s.camera.up.set(0, 0, 1)
    if (name === 'top') s.camera.up.set(0, 1, 0)
    s.camera.near = dist / 100
    s.camera.far = dist * 100
    s.camera.updateProjectionMatrix()
    s.controls.target.copy(center)
    s.controls.update()
    s.dirty = true
  }

  return (
    <div className="viewport">
      <div ref={host} className="viewport-canvas" style={{ cursor: pickable && hoverTag != null ? 'pointer' : 'default' }} />
      {mesh && (
        <div className="view-buttons">
          {Object.entries(VIEWS).map(([k, v]) => (
            <button key={k} className="icon-btn" title={v.title} onClick={() => fitView(k)}>
              <v.icon size={16} />
            </button>
          ))}
        </div>
      )}
      {labels.filter((l) => l.visible).map((l, i) => (
        <div key={i} className="marker" style={{ left: l.x, top: l.y }}>
          <span className="marker-dot" />
          <span className="marker-label">{l.label}</span>
        </div>
      ))}
    </div>
  )
}

// Normalen glätten innerhalb einer CAD-Fläche, scharf an Flächengrenzen
function smoothNormals(s) {
  const pos = s.surf.geometry.attributes.position.array
  const nrm = s.surf.geometry.attributes.normal.array
  const acc = new Map()
  const nTri = s.triSurface.length
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3()
  const faceN = new Float32Array(nTri * 3)
  for (let t = 0; t < nTri; t++) {
    a.fromArray(pos, 9 * t)
    b.fromArray(pos, 9 * t + 3)
    c.fromArray(pos, 9 * t + 6)
    n.subVectors(b, a).cross(c.sub(a))
    n.toArray(faceN, 3 * t)
    for (let k = 0; k < 3; k++) {
      const key = s.vertNode[3 * t + k] * 4096 + (s.triSurface[t] & 4095)
      let v = acc.get(key)
      if (!v) acc.set(key, (v = [0, 0, 0]))
      v[0] += n.x
      v[1] += n.y
      v[2] += n.z
    }
  }
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = acc.get(s.vertNode[3 * t + k] * 4096 + (s.triSurface[t] & 4095))
      const l = Math.hypot(v[0], v[1], v[2]) || 1
      nrm[9 * t + 3 * k] = v[0] / l
      nrm[9 * t + 3 * k + 1] = v[1] / l
      nrm[9 * t + 3 * k + 2] = v[2] / l
    }
  }
  s.surf.geometry.attributes.normal.needsUpdate = true
}

export { BANDS }
