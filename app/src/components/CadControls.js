import * as THREE from 'three'

// Kamerasteuerung wie in CAD-Programmen:
//  - linke Maustaste ziehen: frei drehen (ohne Anschlag), um den Punkt unter der Maus
//  - rechte oder mittlere Maustaste (bzw. Umschalt + links): verschieben, der gegriffene Punkt folgt der Maus
//  - Mausrad: zoomen zur Mausposition
export class CadControls extends EventTarget {
  constructor(camera, dom, pickPoint) {
    super()
    this.camera = camera
    this.dom = dom
    // (clientX, clientY) → Punkt auf dem Bauteil oder null
    this.pickPoint = pickPoint
    this.enabled = true
    // Bezugspunkt (Bauteilmitte nach „Einpassen“), Ersatz-Drehpunkt neben dem Bauteil
    this.target = new THREE.Vector3()
    this.rotateSpeed = 0.007
    this.drag = null

    this._down = (e) => this.onDown(e)
    this._move = (e) => this.onMove(e)
    this._up = (e) => this.onUp(e)
    this._wheel = (e) => this.onWheel(e)
    this._menu = (e) => e.preventDefault()
    dom.addEventListener('pointerdown', this._down)
    dom.addEventListener('pointermove', this._move)
    dom.addEventListener('pointerup', this._up)
    dom.addEventListener('pointercancel', this._up)
    dom.addEventListener('wheel', this._wheel, { passive: false })
    dom.addEventListener('contextmenu', this._menu)
  }

  dispose() {
    const d = this.dom
    d.removeEventListener('pointerdown', this._down)
    d.removeEventListener('pointermove', this._move)
    d.removeEventListener('pointerup', this._up)
    d.removeEventListener('pointercancel', this._up)
    d.removeEventListener('wheel', this._wheel)
    d.removeEventListener('contextmenu', this._menu)
  }

  changed() {
    this.updateClipping()
    this.dispatchEvent(new Event('change'))
  }

  // Nah-/Fernebene an den Abstand anpassen, damit beim Heranzoomen nichts abgeschnitten wird
  updateClipping() {
    const dist = this.camera.position.distanceTo(this.target)
    this.camera.near = Math.max(dist / 1000, 1e-4)
    this.camera.far = dist * 1000 + 1
    this.camera.updateProjectionMatrix()
  }

  // Punkt unter der Maus; neben dem Bauteil: Punkt auf der Ebene durch den Bezugspunkt
  pointAt(e) {
    const p = this.pickPoint?.(e.clientX, e.clientY)
    if (p) return p
    const ray = this.rayAt(e)
    const n = this.camera.getWorldDirection(new THREE.Vector3())
    return ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.target), new THREE.Vector3()) ?? this.target.clone()
  }

  rayAt(e) {
    const r = this.dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    const rc = new THREE.Raycaster()
    rc.setFromCamera(ndc, this.camera)
    return rc.ray
  }

  onDown(e) {
    if (!this.enabled) return
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)
    if (e.button !== 0 && !pan) return
    const pivot = this.pointAt(e)
    this.drag = { mode: pan ? 'pan' : 'rotate', x: e.clientX, y: e.clientY, pivot, id: e.pointerId, moved: false }
    this.dom.setPointerCapture(e.pointerId)
  }

  onMove(e) {
    const d = this.drag
    if (!d || !this.enabled) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 3) return
    if (!d.moved) {
      d.moved = true
      if (d.mode === 'rotate') this.dispatchEvent(Object.assign(new Event('rotatestart'), { pivot: d.pivot }))
    }
    d.x = e.clientX
    d.y = e.clientY
    if (d.mode === 'rotate') this.rotate(dx, dy, d.pivot)
    else this.pan(dx, dy, d.pivot)
    this.changed()
  }

  onUp(e) {
    if (!this.drag) return
    if (this.drag.mode === 'rotate' && this.drag.moved) this.dispatchEvent(new Event('rotateend'))
    if (this.dom.hasPointerCapture?.(e.pointerId)) this.dom.releasePointerCapture(e.pointerId)
    this.drag = null
  }

  // Drehung um die Bildschirmachsen durch den Drehpunkt – ohne festes „Oben“, daher ohne Anschlag
  rotate(dx, dy, pivot) {
    const cam = this.camera
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
    const q = new THREE.Quaternion()
      .setFromAxisAngle(up, -dx * this.rotateSpeed)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * this.rotateSpeed))
    cam.position.sub(pivot).applyQuaternion(q).add(pivot)
    this.target.sub(pivot).applyQuaternion(q).add(pivot)
    cam.quaternion.premultiply(q)
    cam.up.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion))
  }

  // Verschieben: der gegriffene Punkt bleibt unter der Maus
  pan(dx, dy, pivot) {
    const cam = this.camera
    const depth = pivot.clone().sub(cam.position).dot(cam.getWorldDirection(new THREE.Vector3()))
    const perPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / this.dom.clientHeight
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion)
    const shift = right.multiplyScalar(-dx * perPx).add(up.multiplyScalar(dy * perPx))
    cam.position.add(shift)
    this.target.add(shift)
  }

  // Zoom zur Maus: Kamera und Bezugspunkt rücken auf den Punkt unter der Maus zu
  onWheel(e) {
    if (!this.enabled) return
    e.preventDefault()
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY
    const s = 1 - Math.exp(delta * 0.0012) // > 0 heran, < 0 weg
    const p = this.pointAt(e)
    const cam = this.camera
    cam.position.addScaledVector(p.clone().sub(cam.position), Math.min(s, 0.9))
    this.target.addScaledVector(p.clone().sub(this.target), Math.min(s, 0.9))
    this.changed()
  }

  // Kamera blickt aus Richtung `dir` auf `center`, `up` zeigt nach oben
  setView(center, dir, dist, up) {
    const cam = this.camera
    this.target.copy(center)
    cam.position.copy(center).addScaledVector(dir, dist)
    cam.up.copy(up)
    cam.lookAt(center)
    this.changed()
  }
}
