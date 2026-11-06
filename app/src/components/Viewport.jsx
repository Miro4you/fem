import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as THREE from 'three'
import { CadControls } from './CadControls.js'
import { Box, ArrowRight, ArrowUp, ArrowDown } from 'lucide-react'
import { bandTexture, BANDS } from '../colormap.js'
import { regionGrid } from '../region.js'

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
  drawing,
  planeNormal,
  onDraw,
  overlays,
  aim,
  onAim,
  layers,
  topoShape,
  ref,
}) {
  const host = useRef(null)
  const ctx = useRef(null)
  const cb = useRef({})
  cb.current = { onPick, onProbe, pickable, mode, drawing, planeNormal, onDraw, aim, onAim }
  const [hoverTag, setHoverTag] = useState(null)
  const [labels, setLabels] = useState([])

  // Bild des aktuellen Zustands (für den Bericht), weißer Hintergrund
  useImperativeHandle(ref, () => ({
    snapshot(width = 1400) {
      const s = ctx.current
      s.renderer.render(s.scene, s.camera)
      const src = s.renderer.domElement
      const h = Math.round((width * src.height) / src.width)
      const c = document.createElement('canvas')
      c.width = width
      c.height = h
      const g = c.getContext('2d')
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, width, h)
      g.drawImage(src, 0, 0, width, h)
      // auf den Inhalt zuschneiden (nicht-weiße Pixel) mit etwas Rand
      const px = g.getImageData(0, 0, width, h).data
      let x0 = width, y0 = h, x1 = 0, y1 = 0
      for (let yy = 0; yy < h; yy += 2)
        for (let xx = 0; xx < width; xx += 2) {
          const i = 4 * (yy * width + xx)
          if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) {
            if (xx < x0) x0 = xx
            if (xx > x1) x1 = xx
            if (yy < y0) y0 = yy
            if (yy > y1) y1 = yy
          }
        }
      if (x1 <= x0 || y1 <= y0) return { data: c.toDataURL('image/jpeg', 0.9), width, height: h }
      const pad = Math.round(0.04 * width)
      x0 = Math.max(0, x0 - pad)
      y0 = Math.max(0, y0 - pad)
      x1 = Math.min(width, x1 + pad)
      y1 = Math.min(h, y1 + pad)
      const out = document.createElement('canvas')
      out.width = x1 - x0
      out.height = y1 - y0
      const g2 = out.getContext('2d')
      g2.fillStyle = '#ffffff'
      g2.fillRect(0, 0, out.width, out.height)
      g2.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
      return { data: out.toDataURL('image/jpeg', 0.9), width: out.width, height: out.height }
    },
  }))

  // --- Grundaufbau (einmalig) ---------------------------------------------
  useEffect(() => {
    const el = host.current
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.localClippingEnabled = true
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

    // Bereich zeichnen: muss vor OrbitControls registriert sein, damit das Drehen abgeschaltet werden kann
    const drawRay = new THREE.Raycaster()
    let drag = null
    const rayAt = (ev) => {
      const r = renderer.domElement.getBoundingClientRect()
      drawRay.setFromCamera(
        new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1),
        camera,
      )
      return drawRay
    }
    const dragEvent = (ev, final) => {
      const ray = rayAt(ev)
      let p1 = null
      if (drag.shape === 'band') {
        p1 = state.surf ? ray.intersectObject(state.surf, false)[0]?.point : null
      } else {
        p1 = ray.ray.intersectPlane(drag.plane, new THREE.Vector3())
      }
      if (p1) drag.p1 = p1.toArray()
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).toArray()
      cb.current.onDraw?.({ tag: drag.tag, p0: drag.p0, p1: drag.p1, normal: drag.normal, right, final })
    }
    // Lastpfeil ausrichten: Griff am Pfeilende ziehen
    let aimDrag = null
    const aimDir = (ev) => {
      const a = cb.current.aim
      const ray = rayAt(ev).ray
      const anchor = new THREE.Vector3(...a.anchor)
      let p = null
      const basis = AIM_PLANES[a.plane]
      if (basis) {
        const n = new THREE.Vector3(...basis[0]).cross(new THREE.Vector3(...basis[1]))
        p = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, anchor), new THREE.Vector3())
      } else {
        // frei: Kugel um den Angriffspunkt, sonst nächster Punkt des Strahls
        p = ray.intersectSphere(new THREE.Sphere(anchor, a.length), new THREE.Vector3()) ?? ray.closestPointToPoint(anchor, new THREE.Vector3())
      }
      if (!p) return null
      let d = p.sub(anchor)
      if (a.kind === 'force') d.negate() // Griff am Pfeilende: Kraft zeigt zum Angriffspunkt hin
      if (d.lengthSq() < 1e-12) return null
      return snapDirection(d.normalize(), a.plane, ev.shiftKey ? 0 : 5)
    }
    renderer.domElement.addEventListener('pointerdown', (ev) => {
      if (cb.current.aim && state.aimHandle && ev.button === 0) {
        const h = rayAt(ev).intersectObject(state.aimHandle, false)[0]
        if (h) {
          aimDrag = true
          state.controls.enabled = false
          renderer.domElement.setPointerCapture(ev.pointerId)
          return
        }
      }
    })
    renderer.domElement.addEventListener('pointermove', (ev) => {
      if (!aimDrag) return
      const d = aimDir(ev)
      if (d) cb.current.onAim?.(d, false)
    })
    renderer.domElement.addEventListener('pointerup', (ev) => {
      if (!aimDrag) return
      const d = aimDir(ev)
      if (d) cb.current.onAim?.(d, true)
      aimDrag = null
      state.controls.enabled = true
      state.justDrew = true
    })
    renderer.domElement.addEventListener('pointerdown', (ev) => {
      if (aimDrag) return
      const shape = cb.current.drawing
      if (!shape || !state.surf || ev.button !== 0) return
      const h = rayAt(ev).intersectObject(state.surf, false)[0]
      if (!h) return
      const tag = state.triSurface[h.faceIndex]
      const n = cb.current.planeNormal?.(tag) ?? h.face.normal.toArray()
      const normal = new THREE.Vector3(...n).normalize()
      drag = { shape, tag, p0: h.point.toArray(), p1: h.point.toArray(), normal: normal.toArray(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, h.point) }
      state.controls.enabled = false
      renderer.domElement.setPointerCapture(ev.pointerId)
    })
    renderer.domElement.addEventListener('pointermove', (ev) => {
      if (drag) dragEvent(ev, false)
    })
    renderer.domElement.addEventListener('pointerup', (ev) => {
      if (!drag) return
      dragEvent(ev, true)
      drag = null
      state.controls.enabled = true
      state.justDrew = true
    })

    // Drehpunkt/Zoomziel: Punkt des Bauteils unter der Maus
    const pickRay = new THREE.Raycaster()
    const pickPoint = (cx, cy) => {
      if (!state.surf) return null
      const r = renderer.domElement.getBoundingClientRect()
      pickRay.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera)
      return pickRay.intersectObject(state.surf, false)[0]?.point ?? null
    }
    const controls = new CadControls(camera, renderer.domElement, pickPoint)
    // Drehpunkt beim Drehen kurz anzeigen
    const pivotMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x1f6feb, depthTest: false, transparent: true, opacity: 0.85 }),
    )
    pivotMarker.renderOrder = 20
    pivotMarker.visible = false
    scene.add(pivotMarker)
    controls.addEventListener('rotatestart', (e) => {
      pivotMarker.position.copy(e.pivot)
      pivotMarker.scale.setScalar(camera.position.distanceTo(e.pivot) * 0.006)
      pivotMarker.visible = true
      state.dirty = true
    })
    controls.addEventListener('rotateend', () => {
      pivotMarker.visible = false
      state.dirty = true
    })

    const state = {
      renderer, scene, camera, controls, dirty: true, raf: 0,
      group: new THREE.Group(), surf: null, edges: null, wire: null, ghost: null, arrows: new THREE.Group(),
      texture: bandTexture(), labelNodes: [], overlays: new THREE.Group(), aimGroup: new THREE.Group(), aimHandle: null,
      bed: new THREE.Group(),
      cutMesh: null,
      clip: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
      // Schichtlinien (3D-Druck) im Flächen-Shader
      layerUniforms: { uLayerDir: { value: new THREE.Vector3(0, 0, 1) }, uLayerStep: { value: 1 }, uLayerOn: { value: 0 } },
    }
    scene.add(state.bed)
    scene.add(state.overlays)
    scene.add(state.aimGroup)
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
      if (state.justDrew) return (state.justDrew = false)
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
        const { mode, pickable, drawing } = cb.current
        if (mode !== 'setup' || !(pickable || drawing)) return setHoverTag(null)
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
    s.setupMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, s.layerUniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLayerPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLayerPos = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLayerPos;\nuniform vec3 uLayerDir;\nuniform float uLayerStep;\nuniform float uLayerOn;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if (uLayerOn > 0.5) {
            float t = dot(vLayerPos, uLayerDir) / uLayerStep;
            float d = abs(fract(t + 0.5) - 0.5);
            float w = max(fwidth(t), 1e-4);
            float line = 1.0 - smoothstep(0.5 * w, 1.5 * w, d);
            diffuseColor.rgb *= 1.0 - 0.28 * line;
          }`,
        )
    }
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
      // 3D-Druck: Überhänge (> 45°, nicht auf dem Druckbett) rötlich markieren
      let over = null
      if (layers) {
        const b = new THREE.Vector3(...layers.dir).normalize()
        const pos = s.surf.geometry.attributes.position.array
        let minT = Infinity
        for (let i = 0; i < pos.length; i += 3) minT = Math.min(minT, pos[i] * b.x + pos[i + 1] * b.y + pos[i + 2] * b.z)
        const [lo, hi] = mesh.bbox
        const tol = 1e-3 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
        over = new Uint8Array(s.triSurface.length)
        const a = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3()
        for (let t = 0; t < s.triSurface.length; t++) {
          a.fromArray(pos, 9 * t)
          p1.fromArray(pos, 9 * t + 3).sub(a)
          p2.fromArray(pos, 9 * t + 6).sub(a)
          const n = p1.cross(p2).normalize()
          if (n.dot(b) < -Math.cos(Math.PI / 4)) {
            let onBed = true
            for (let k = 0; k < 3; k++) if (pos[9 * t + 3 * k] * b.x + pos[9 * t + 3 * k + 1] * b.y + pos[9 * t + 3 * k + 2] * b.z - minT > tol) onBed = false
            over[t] = onBed ? 0 : 1
          }
        }
      }
      for (let t = 0; t < s.triSurface.length; t++) {
        const tag = s.triSurface[t]
        const tint = surfaceTint?.(tag)
        c.copy(tint ? new THREE.Color(tint) : BASE)
        if (over?.[t] && !tint) c.lerp(new THREE.Color('#e05252'), 0.55)
        if (tag === hoverTag) c.lerp(new THREE.Color('#ffffff'), 0.45)
        for (let k = 0; k < 3; k++) c.toArray(col, 9 * t + 3 * k)
      }
      s.surf.geometry.attributes.color.needsUpdate = true
    }
    s.dirty = true
  }, [mesh, mode, result, surfaceTint, hoverTag, layers?.dir?.join(',')])

  // --- Leichtbau-Vorschlag: grüne Form im halbdurchsichtigen Bauteil ----------------------------------
  useEffect(() => {
    const s = ctx.current
    if (s.topoMesh) {
      s.scene.remove(s.topoMesh)
      s.topoMesh.geometry.dispose()
      s.topoMesh.material.dispose()
      s.topoMesh = null
    }
    if (s.setupMat) {
      s.setupMat.transparent = !!topoShape
      s.setupMat.opacity = topoShape ? 0.15 : 1
      s.setupMat.depthWrite = !topoShape
      s.setupMat.needsUpdate = true
    }
    if (topoShape && topoShape.triangles.length) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(topoShape.positions), 3))
      geo.setIndex(Array.from(topoShape.triangles))
      geo.computeVertexNormals()
      s.topoMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3fae6a, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }))
      s.scene.add(s.topoMesh)
    }
    s.dirty = true
  }, [topoShape, mesh])

  // --- Schnitt: Oberfläche abschneiden, Schnittfläche einfärben ----------------------------------
  useEffect(() => {
    const s = ctx.current
    if (s.cutMesh) {
      s.group.remove(s.cutMesh)
      s.cutMesh.geometry.dispose()
      s.cutMesh.material.dispose()
      s.cutMesh = null
    }
    const c = mode === 'result' ? result?.cut : null
    const planes = c ? [s.clip] : []
    for (const m of [s.resultMat, s.edges?.material, s.wire?.material, s.ghost?.material]) {
      if (m) {
        m.clippingPlanes = planes
        m.needsUpdate = true
      }
    }
    if (c) {
      // sichtbar bleibt die Seite gegen die Normale: (p − p0)·n ≤ 0. Normale zur Kamera hin drehen,
      // damit die Schnittfläche zum Betrachter zeigt („Seite“ kehrt das in App über die Normale um).
      const n = new THREE.Vector3(...c.plane.normal)
      const toCam = s.camera.position.clone().sub(new THREE.Vector3(...c.plane.point))
      if (toCam.dot(n) < 0) n.negate()
      s.clip.set(n.clone().negate(), n.dot(new THREE.Vector3(...c.plane.point)))
      const m = c.positions.length / 3
      const pos = new Float32Array(c.positions.length)
      const sc = result.scale || 0
      for (let i = 0; i < c.positions.length; i++) pos[i] = c.positions[i] + sc * c.displacement[i]
      const uv = new Float32Array(2 * m)
      const span = result.max - result.min || 1
      for (let i = 0; i < m; i++) {
        let t = Math.min(Math.max((c.values[i] - result.min) / span, 0), 1)
        if (result.reverse) t = 1 - t
        uv[2 * i] = t * (1 - 1e-4) + 0.5e-4
        uv[2 * i + 1] = 0.5
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      geo.setIndex(Array.from(c.triangles))
      geo.computeVertexNormals()
      s.cutMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: s.texture, side: THREE.DoubleSide }))
      s.group.add(s.cutMesh)
    }
    s.dirty = true
  }, [result, mode])

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

  // --- 3D-Druck: Schichtlinien und Druckbett ----------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.bed.traverse((x) => (x.geometry?.dispose(), x.material?.dispose()))
    s.bed.clear()
    const on = !!(layers && mesh)
    s.layerUniforms.uLayerOn.value = on ? 1 : 0
    if (on) {
      const dir = new THREE.Vector3(...layers.dir).normalize()
      const [lo, hi] = mesh.bbox
      const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
      s.layerUniforms.uLayerDir.value.copy(dir)
      s.layerUniforms.uLayerStep.value = size / 70 // nur zur Anschauung, nicht die echte Schichthöhe
      // Druckbett unter dem Bauteil (tiefster Punkt in Aufbaurichtung)
      const center = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
      let minT = Infinity
      for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) minT = Math.min(minT, new THREE.Vector3(x, y, z).sub(center).dot(dir))
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      const pos = center.clone().addScaledVector(dir, minT - 0.01 * size)
      const grid = new THREE.GridHelper(1.1 * size, 22, 0x6b7a90, 0x6b7a90)
      grid.material.transparent = true
      grid.material.opacity = 0.22
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(1.1 * size, 1.1 * size).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x8fa3bf, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }),
      )
      for (const o of [grid, plate]) {
        o.quaternion.copy(q)
        o.position.copy(pos)
        s.bed.add(o)
      }
      const arrow = new THREE.ArrowHelper(dir, pos.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(q), 0.5 * size), 0.25 * size, 0x2e9e5b, 0.06 * size, 0.035 * size)
      s.bed.add(arrow)
    }
    s.dirty = true
  }, [layers?.dir?.join(','), mesh])

  // --- Lastpfeil ausrichten: Griff, Ebene mit Winkelteilung -------------------------------------
  useEffect(() => {
    const s = ctx.current
    s.aimGroup.traverse((x) => (x.geometry?.dispose(), x.material?.dispose()))
    s.aimGroup.clear()
    s.aimHandle = null
    if (aim && mode === 'setup') {
      const anchor = new THREE.Vector3(...aim.anchor)
      const L = aim.length
      const dir = new THREE.Vector3(...aim.dir).normalize()
      const end = anchor.clone().addScaledVector(dir, aim.kind === 'force' ? -L : L)
      const front = (m) => {
        m.depthTest = false
        m.transparent = true
        return m
      }
      const basis = AIM_PLANES[aim.plane]
      if (basis) {
        const u = new THREE.Vector3(...basis[0])
        const v = new THREE.Vector3(...basis[1])
        const pts = []
        for (let i = 0; i <= 96; i++) {
          const t = (i / 96) * 2 * Math.PI
          pts.push(anchor.clone().addScaledVector(u, L * Math.cos(t)).addScaledVector(v, L * Math.sin(t)))
        }
        const disc = new THREE.Mesh(
          new THREE.BufferGeometry().setFromPoints([anchor, ...pts]).setIndex([...Array(96).keys()].flatMap((i) => [0, i + 1, i + 2])),
          front(new THREE.MeshBasicMaterial({ color: aim.color, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })),
        )
        s.aimGroup.add(disc)
        s.aimGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), front(new THREE.LineBasicMaterial({ color: aim.color, opacity: 0.6 }))))
        // Teilung alle 15°, Achsen (0°, 90° …) länger
        const ticks = []
        for (let k = 0; k < 24; k++) {
          const t = (k * 15 * Math.PI) / 180
          const r0 = k % 6 === 0 ? 0 : 0.88
          const c = u.clone().multiplyScalar(Math.cos(t)).addScaledVector(v, Math.sin(t))
          ticks.push(anchor.clone().addScaledVector(c, L * r0), anchor.clone().addScaledVector(c, L))
        }
        s.aimGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), front(new THREE.LineBasicMaterial({ color: aim.color, opacity: 0.45 }))))
      }
      s.aimGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([anchor, end]), front(new THREE.LineBasicMaterial({ color: aim.color }))))
      const handle = new THREE.Mesh(new THREE.SphereGeometry(L * 0.07, 20, 14), front(new THREE.MeshBasicMaterial({ color: aim.color, opacity: 0.95 })))
      handle.position.copy(end)
      handle.renderOrder = 30
      s.aimGroup.add(handle)
      s.aimHandle = handle
    }
    s.dirty = true
  }, [aim, mode])

  // --- Wirkbereiche ------------------------------------------------------------
  useEffect(() => {
    const s = ctx.current
    for (const o of s.overlays.children) o.traverse((x) => (x.geometry?.dispose(), x.material?.dispose()))
    s.overlays.clear()
    if (mesh) {
      const [lo, hi] = mesh.bbox
      const offset = 0.002 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
      for (const o of overlays ?? []) s.overlays.add(regionObject(o, offset))
    }
    s.overlays.visible = mode === 'setup'
    s.dirty = true
  }, [overlays, mesh, mode])

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
    const up = name === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    s.controls.setView(center, dir, dist, up)
    s.dirty = true
  }

  return (
    <div className="viewport">
      <div ref={host} className="viewport-canvas" style={{ cursor: aim ? 'default' : drawing && hoverTag != null ? 'crosshair' : pickable && hoverTag != null ? 'pointer' : 'default' }} />
      {mesh && (
        <div className="view-buttons">
          {Object.entries(VIEWS).map(([k, v]) => (
            <button key={k} className="icon-btn" title={v.title} onClick={() => fitView(k)}>
              <v.icon size={16} />
            </button>
          ))}
        </div>
      )}
      {mesh && <div className="mouse-help">Links ziehen: drehen · Rechts/Mitte ziehen: verschieben · Rad: zoomen (zur Maus)</div>}
      {labels.filter((l) => l.visible).map((l, i) => (
        <div key={i} className="marker" style={{ left: l.x, top: l.y }}>
          <span className="marker-dot" />
          <span className="marker-label">{l.label}</span>
        </div>
      ))}
    </div>
  )
}

// Ebenen für das Ausrichten des Lastpfeils: zwei Richtungen (u, v); Winkel wird von u nach v gemessen
export const AIM_PLANES = {
  xy: [[1, 0, 0], [0, 1, 0]],
  yz: [[0, 1, 0], [0, 0, 1]],
  xz: [[1, 0, 0], [0, 0, 1]],
}

// Richtung auf ganze `step` Grad runden (in der Ebene bzw. als Winkel in XY + Neigung)
function snapDirection(d, plane, step) {
  const basis = AIM_PLANES[plane]
  const snap = (a) => (step ? Math.round(a / step) * step : a)
  const rad = Math.PI / 180
  if (basis) {
    const u = new THREE.Vector3(...basis[0])
    const v = new THREE.Vector3(...basis[1])
    const t = snap(Math.atan2(d.dot(v), d.dot(u)) / rad) * rad
    return u.multiplyScalar(Math.cos(t)).addScaledVector(v, Math.sin(t)).toArray()
  }
  const b = snap(Math.asin(Math.max(-1, Math.min(1, d.z))) / rad) * rad
  const a = snap(Math.atan2(d.y, d.x) / rad) * rad
  return [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)]
}

// Bereich als halbdurchsichtige Fläche mit Umriss
function regionObject({ region, cyl, color, active }, offset) {
  const g = regionGrid(region, cyl, offset)
  const pts = []
  for (let i = 0; i < g.nu; i++) for (let j = 0; j < g.nv; j++) pts.push(...g.P(i, j))
  const idx = []
  for (let i = 0; i + 1 < g.nu; i++)
    for (let j = 0; j + 1 < g.nv; j++) {
      const a = i * g.nv + j, b = a + 1, c = a + g.nv, d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  geo.setIndex(idx)
  const fill = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: active ? 0.55 : 0.4, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
  )
  // Umriss: äußerer Rand (Kreis/Rechteck) bzw. ganzer Rand des Wellenabschnitts
  const ring = []
  const P = (i, j) => g.P(i, j)
  if (g.band) {
    for (let j = 0; j < g.nv; j++) ring.push(P(0, j))
    if (!g.closed) for (let j = g.nv - 1; j >= 0; j--) ring.push(P(1, j))
    else ring.push(null)
    if (g.closed) for (let j = 0; j < g.nv; j++) ring.push(P(1, j))
  } else for (let j = 0; j < g.nv; j++) ring.push(P(g.nu - 1, j))
  const group = new THREE.Group()
  group.add(fill)
  const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
  let seg = []
  const flush = () => {
    if (seg.length > 1) {
      const lg = new THREE.BufferGeometry().setFromPoints(seg.map((p) => new THREE.Vector3(...p)))
      group.add(g.closed || g.band ? new THREE.Line(lg, lineMat) : new THREE.LineLoop(lg, lineMat))
    }
    seg = []
  }
  for (const p of ring) (p ? seg.push(p) : flush())
  if (g.band && !g.closed && seg.length) seg.push(seg[0])
  flush()
  group.renderOrder = 5
  return group
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
