import * as THREE from 'three'

// Kamerasteuerung wie in CAD-Programmen, wählbar (Einstellungen › Maus & Trackpad):
//  track   – Trackpad (Mac): zwei Finger drehen, Spreizen zoomen, ⇧ + zwei Finger verschieben, Klick wählt nur
//  sw      – SolidWorks: mittlere Taste drehen, Strg + Mitte verschieben, Rad zoomen
//  os      – Onshape: rechte Taste drehen, mittlere (oder Strg + rechte) verschieben, Rad zoomen
//  fu      – Fusion: ⇧ + Mitte drehen, Mitte verschieben, Rad zoomen
//  classic – links drehen, rechts/Mitte (oder ⇧ + links) verschieben, Rad zoomen
// Gedreht wird um den Punkt unter dem Zeiger, gezoomt zum Zeiger hin (abschaltbar).
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
    // Mitte des Bauteils (Drehpunkt, wenn „um den Zeiger drehen“ aus ist)
    this.center = null
    this.rotateSpeed = 0.007
    this.config = { preset: 'classic', pivotAtCursor: true, zoomToCursor: true, invertZoom: false, speed: 1 }
    this.drag = null
    this.wheelRot = null

    this._down = (e) => this.onDown(e)
    this._move = (e) => this.onMove(e)
    this._up = (e) => this.onUp(e)
    this._wheel = (e) => this.onWheel(e)
    this._menu = (e) => e.preventDefault()
    this._gStart = (e) => this.onGesture(e, 'start')
    this._gChange = (e) => this.onGesture(e, 'change')
    this._gEnd = (e) => this.onGesture(e, 'end')
    dom.addEventListener('pointerdown', this._down)
    dom.addEventListener('pointermove', this._move)
    dom.addEventListener('pointerup', this._up)
    dom.addEventListener('pointercancel', this._up)
    dom.addEventListener('wheel', this._wheel, { passive: false })
    dom.addEventListener('contextmenu', this._menu)
    // Safari/WebKit (Mac): Spreizen kommt als Geste, nicht als Strg + Rad
    dom.addEventListener('gesturestart', this._gStart)
    dom.addEventListener('gesturechange', this._gChange)
    dom.addEventListener('gestureend', this._gEnd)
  }

  dispose() {
    const d = this.dom
    d.removeEventListener('pointerdown', this._down)
    d.removeEventListener('pointermove', this._move)
    d.removeEventListener('pointerup', this._up)
    d.removeEventListener('pointercancel', this._up)
    d.removeEventListener('wheel', this._wheel)
    d.removeEventListener('contextmenu', this._menu)
    d.removeEventListener('gesturestart', this._gStart)
    d.removeEventListener('gesturechange', this._gChange)
    d.removeEventListener('gestureend', this._gEnd)
    clearTimeout(this.wheelRot?.timer)
  }

  setConfig(c) {
    this.config = { ...this.config, ...c }
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

  // Drehpunkt: Punkt unter dem Zeiger oder Bauteilmitte
  pivotAt(e) {
    if (!this.config.pivotAtCursor) return (this.center ?? this.target).clone()
    return this.pointAt(e)
  }

  rayAt(e) {
    const r = this.dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    const rc = new THREE.Raycaster()
    rc.setFromCamera(ndc, this.camera)
    return rc.ray
  }

  // welche Bewegung eine gedrückte Taste auslöst (null = nichts, Klick bleibt Auswahl)
  modeFor(e) {
    const b = e.button
    const ctrl = e.ctrlKey || e.metaKey
    switch (this.config.preset) {
      case 'track':
        // Trackpad: Klicken wählt nur; Rechtsklick-Ziehen (zwei Finger gedrückt) verschiebt
        if (b === 2 || b === 1) return 'pan'
        return null
      case 'sw':
        if (b === 1) return ctrl ? 'pan' : 'rotate'
        if (b === 2 && ctrl) return 'pan'
        return null
      case 'os':
        if (b === 2) return ctrl ? 'pan' : 'rotate'
        if (b === 1) return 'pan'
        return null
      case 'fu':
        if (b === 1) return e.shiftKey ? 'rotate' : 'pan'
        return null
      default:
        if (b === 0) return e.shiftKey ? 'pan' : 'rotate'
        if (b === 1 || b === 2) return 'pan'
        return null
    }
  }

  onDown(e) {
    if (!this.enabled) return
    const mode = this.modeFor(e)
    if (!mode) return
    const pivot = mode === 'rotate' ? this.pivotAt(e) : this.pointAt(e)
    this.drag = { mode, x: e.clientX, y: e.clientY, pivot, id: e.pointerId, moved: false }
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
    const k = this.rotateSpeed * (this.config.speed || 1)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion)
    const q = new THREE.Quaternion().setFromAxisAngle(up, -dx * k).multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * k))
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

  // Zoom um den Faktor (> 0 heran) zum Punkt unter dem Zeiger bzw. zur Bildmitte
  zoom(s, e) {
    const p = this.config.zoomToCursor && e ? this.pointAt(e) : this.target.clone()
    const cam = this.camera
    const f = Math.max(Math.min(s, 0.9), -4)
    cam.position.addScaledVector(p.clone().sub(cam.position), f)
    this.target.addScaledVector(p.clone().sub(this.target), f)
    this.changed()
  }

  onWheel(e) {
    if (!this.enabled) return
    e.preventDefault()
    const px = e.deltaMode === 1 ? 30 : e.deltaMode === 2 ? 600 : 1
    const dx = e.deltaX * px
    const dy = e.deltaY * px
    const sign = this.config.invertZoom ? -1 : 1
    if (this.config.preset === 'track' && !e.ctrlKey) {
      // zwei Finger wischen: drehen (⇧: verschieben) um den Punkt, an dem die Geste begann
      const w = this.wheelRot
      const fresh = !w || performance.now() - w.t > 250
      const mode = e.shiftKey ? 'pan' : 'rotate'
      if (fresh || w.mode !== mode) {
        if (w?.mode === 'rotate') this.dispatchEvent(new Event('rotateend'))
        this.wheelRot = { pivot: mode === 'rotate' ? this.pivotAt(e) : this.pointAt(e), mode, t: 0, timer: 0 }
        if (mode === 'rotate') this.dispatchEvent(Object.assign(new Event('rotatestart'), { pivot: this.wheelRot.pivot }))
      }
      const r = this.wheelRot
      r.t = performance.now()
      clearTimeout(r.timer)
      r.timer = setTimeout(() => {
        if (r.mode === 'rotate') this.dispatchEvent(new Event('rotateend'))
        if (this.wheelRot === r) this.wheelRot = null
      }, 300)
      // das Bauteil folgt den Fingern (natürliches Scrollen); mit ⇧ macht WebKit aus senkrechtem Wischen waagerechtes
      if (mode === 'rotate') this.rotate(-dx, -dy, r.pivot)
      else this.pan(-dx, -dy, r.pivot)
      this.changed()
      return
    }
    // Rad bzw. Spreizen (Chrome/Firefox: Strg + Rad); Spreizen ist feiner
    const k = e.ctrlKey ? 0.01 : 0.0012
    this.zoom(-sign * (Math.exp(dy * k) - 1), e)
  }

  onGesture(e, phase) {
    if (!this.enabled) return
    e.preventDefault()
    if (phase === 'start') this.gScale = 1
    else if (phase === 'change') {
      const s = e.scale / (this.gScale || 1)
      this.gScale = e.scale
      this.zoom((this.config.invertZoom ? -1 : 1) * (1 - 1 / s), e)
    }
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
