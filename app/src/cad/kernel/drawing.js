// Technische Zeichnung als SVG: Vorderansicht, Seitenansicht von links, Draufsicht (Projektionsmethode 1 nach
// DIN ISO 5456-2) und eine Isometrie auf einem A4-/A3-Blatt mit Schriftfeld und Gesamtmaßen.
// Sichtbare Kanten breit und durchgezogen, verdeckte Kanten schmal gestrichelt (verdeckte Linien über HLR von OpenCASCADE).
import { drawProjection, ProjectionCamera, makeBox } from 'replicad'

// Blickrichtung zum Betrachter hin und Bild-x (rechts); Bild-y ergibt sich daraus (bei allen drei: z bzw. y nach oben)
const VIEWS = {
  front: { dir: [0, -1, 0], x: [1, 0, 0], label: 'Vorderansicht' },
  left: { dir: [-1, 0, 0], x: [0, -1, 0], label: 'Seitenansicht von links' },
  top: { dir: [0, 0, 1], x: [1, 0, 0], label: 'Draufsicht' },
  iso: { dir: [1, -1, 1], x: [1, 1, 0], label: 'Isometrie' },
}
// genormte Maßstäbe (DIN ISO 5455), groß nach klein
const SCALES = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100], [1, 200], [1, 500], [1, 1000]]

const num = (v, d = 2) => {
  const r = Math.round(v * 10 ** d) / 10 ** d
  return String(r === 0 ? 0 : r).replace('.', ',')
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function project(shape, v, hidden) {
  const norm = (a) => {
    const l = Math.hypot(...a)
    return a.map((x) => x / l)
  }
  const cam = new ProjectionCamera([0, 0, 0], norm(v.dir), norm(v.x))
  const d = drawProjection(shape, cam)
  const paths = (dr) => {
    try {
      return dr.toSVGPaths().flat(Infinity)
    } catch {
      return []
    }
  }
  let bounds = null
  try {
    bounds = d.visible.boundingBox.bounds
  } catch {
    bounds = null
  }
  const out = { visible: paths(d.visible), hidden: hidden ? paths(d.hidden) : [], bounds }
  d.visible.delete?.()
  d.hidden.delete?.()
  return out
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a) => {
  const l = Math.hypot(...a)
  return a.map((x) => x / l)
}

// Mittellinien der Bohrungen und Wellen: Achse quer zur Blickrichtung → Strich-Punkt-Linie über die Länge,
// Achse in Blickrichtung → Mittelkreuz. axes: [{ c0, axis, s0, s1, r }]
function axisLines(axes, v, s, tx, ty) {
  const xd = unit(v.x)
  const dd = unit(v.dir)
  const yd = cross(dd, xd)
  const to = (p) => [tx + s * dot(p, xd), ty - s * dot(p, yd)]
  const over = 2.5 // Überstand auf dem Blatt in mm
  const out = []
  const seen = []
  for (const a of axes) {
    const c = Math.abs(dot(a.axis, dd))
    if (c > 0.999) {
      const [x, y] = to(a.c0)
      const h = s * a.r + over
      if (seen.some(([sx, sy, sh]) => Math.hypot(sx - x, sy - y) < 0.05 && sh >= h)) continue
      seen.push([x, y, h])
      out.push(`<line x1="${(x - h).toFixed(3)}" y1="${y.toFixed(3)}" x2="${(x + h).toFixed(3)}" y2="${y.toFixed(3)}"/>`)
      out.push(`<line x1="${x.toFixed(3)}" y1="${(y - h).toFixed(3)}" x2="${x.toFixed(3)}" y2="${(y + h).toFixed(3)}"/>`)
    } else if (c < 0.001) {
      const e = over / s
      const p0 = a.c0.map((q, i) => q + a.axis[i] * (a.s0 - e))
      const p1 = a.c0.map((q, i) => q + a.axis[i] * (a.s1 + e))
      const [x0, y0] = to(p0)
      const [x1, y1] = to(p1)
      out.push(`<line x1="${x0.toFixed(3)}" y1="${y0.toFixed(3)}" x2="${x1.toFixed(3)}" y2="${y1.toFixed(3)}"/>`)
    }
  }
  return out.length ? `<g class="ctr">${out.join('')}</g>` : ''
}

// Bohrungsangaben „n× Ød“ mit Hinweislinie in der Ansicht, in der die Bohrungen als Kreise erscheinen
// (jeder Durchmesser einmal auf dem Blatt; done merkt sich die schon beschrifteten)
function boreNotes(axes, v, s, tx, ty, done) {
  const xd = unit(v.x)
  const dd = unit(v.dir)
  const yd = cross(dd, xd)
  const groups = new Map()
  for (const a of axes) {
    if (Math.abs(dot(a.axis, dd)) < 0.999) continue
    for (const d of a.bores ?? []) {
      if (done.has(d)) continue
      if (!groups.has(d)) groups.set(d, [])
      groups.get(d).push(a)
    }
  }
  const out = []
  for (const [d, list] of groups) {
    done.add(d)
    // Kreis rechts oben als Anker
    const a = list.reduce((best, x) => (dot(x.c0, xd) - dot(x.c0, yd) > dot(best.c0, xd) - dot(best.c0, yd) ? x : best))
    const cx = tx + s * dot(a.c0, xd)
    const cy = ty - s * dot(a.c0, yd)
    const rr = (s * d) / 2
    const px = cx + rr * Math.SQRT1_2
    const py = cy - rr * Math.SQRT1_2
    const qx = px + 7
    const qy = py - 7
    // Lochkreis: mindestens drei gleiche Bohrungen gleich weit von ihrer Mitte → Strich-Punkt-Kreis und „LK Ø…“
    let lk = ''
    if (list.length >= 3) {
      const pts = list.map((x) => [tx + s * dot(x.c0, xd), ty - s * dot(x.c0, yd)])
      const m = [0, 1].map((k) => pts.reduce((acc, q) => acc + q[k], 0) / pts.length)
      const rs = pts.map((q) => Math.hypot(q[0] - m[0], q[1] - m[1]))
      if (rs[0] > 1 && rs.every((r) => Math.abs(r - rs[0]) < 1e-3 * Math.max(1, rs[0]))) {
        out.push(`<circle class="lk" cx="${m[0].toFixed(3)}" cy="${m[1].toFixed(3)}" r="${rs[0].toFixed(3)}"/>`)
        lk = `, LK Ø${num((2 * rs[0]) / s)}`
      }
    }
    const text = `${list.length > 1 ? `${list.length}× ` : ''}Ø${num(d)}${lk}`
    const tw = text.length * 2.1 + 1
    out.push(`<line x1="${px.toFixed(3)}" y1="${py.toFixed(3)}" x2="${qx.toFixed(3)}" y2="${qy.toFixed(3)}"/>`)
    out.push(`<line x1="${qx.toFixed(3)}" y1="${qy.toFixed(3)}" x2="${(qx + tw).toFixed(3)}" y2="${qy.toFixed(3)}"/>`)
    // Pfeil auf den Kreis
    const ux = Math.SQRT1_2
    const uy = -Math.SQRT1_2
    const ah = 2.5
    const aw = 0.9
    const bx = px + ux * ah
    const by = py + uy * ah
    out.push(`<path class="ar" d="M${px.toFixed(3)} ${py.toFixed(3)} L${(bx - uy * aw).toFixed(3)} ${(by + ux * aw).toFixed(3)} L${(bx + uy * aw).toFixed(3)} ${(by - ux * aw).toFixed(3)} Z"/>`)
    out.push(`<text x="${(qx + 0.5).toFixed(3)}" y="${(qy - 1).toFixed(3)}">${esc(text)}</text>`)
  }
  return out.length ? `<g class="dim">${out.join('')}</g>` : ''
}

// Schnitt A–A: vordere Hälfte (y < Mitte) weg, Rest von vorn ohne verdeckte Kanten; Schnittflächen als Dreiecke
// (Bildkoordinaten der Ansicht) für die Schraffur
function sectionFront(shape, bbox, v, yc) {
  const [lo, hi] = bbox
  const pad = 1 + 0.01 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  const tool = makeBox([lo[0] - pad, lo[1] - pad, lo[2] - pad], [hi[0] + pad, yc, hi[2] + pad])
  let cut = null
  try {
    cut = shape.clone().cut(tool)
    const p = project(cut, v, false)
    const xd = unit(v.x)
    const yd = cross(unit(v.dir), xd)
    const tol = 1e-6 * Math.max(1, hi[1] - lo[1])
    const secIds = new Set()
    for (const f of cut.faces) {
      if (f.geomType !== 'PLANE') continue
      const c = f.center
      const pt = [c.x, c.y, c.z]
      const n = f.normalAt(c)
      if (Math.abs(Math.abs(n.y) - 1) < 1e-6 && Math.abs(pt[1] - yc) < tol) secIds.add(f.hashCode)
    }
    const m = cut.mesh({ tolerance: 0.01, angularTolerance: 0.2 })
    const tris = []
    for (const g of m.faceGroups) {
      if (!secIds.has(g.faceId)) continue
      for (let k = g.start; k < g.start + g.count; k += 3) {
        tris.push(
          [0, 1, 2].map((j) => {
            const i = m.triangles[k + j]
            const q = [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]]
            return [dot(q, xd), -dot(q, yd)]
          }),
        )
      }
    }
    return { visible: p.visible, tris }
  } finally {
    try {
      tool.delete()
      cut?.delete()
    } catch {
      /* schon freigegeben */
    }
  }
}

// Maßlinie mit Pfeilen und Zahl (alles in Blatt-mm); vertikal → Zahl gedreht links an der Linie
function dimLine(a, b, offset, text, vertical) {
  const ah = 2.5
  const aw = 0.9
  const parts = []
  if (!vertical) {
    const y = a[1] + offset
    parts.push(`<line x1="${a[0]}" y1="${a[1] + Math.sign(offset) * 1}" x2="${a[0]}" y2="${y + Math.sign(offset) * 2}"/>`)
    parts.push(`<line x1="${b[0]}" y1="${b[1] + Math.sign(offset) * 1}" x2="${b[0]}" y2="${y + Math.sign(offset) * 2}"/>`)
    parts.push(`<line x1="${a[0]}" y1="${y}" x2="${b[0]}" y2="${y}"/>`)
    parts.push(`<path class="ar" d="M${a[0]} ${y} l${ah} ${-aw} v${2 * aw} Z M${b[0]} ${y} l${-ah} ${-aw} v${2 * aw} Z"/>`)
    parts.push(`<text x="${(a[0] + b[0]) / 2}" y="${y - 1}" text-anchor="middle">${esc(text)}</text>`)
  } else {
    const x = a[0] + offset
    parts.push(`<line x1="${a[0] + Math.sign(offset) * 1}" y1="${a[1]}" x2="${x + Math.sign(offset) * 2}" y2="${a[1]}"/>`)
    parts.push(`<line x1="${b[0] + Math.sign(offset) * 1}" y1="${b[1]}" x2="${x + Math.sign(offset) * 2}" y2="${b[1]}"/>`)
    parts.push(`<line x1="${x}" y1="${a[1]}" x2="${x}" y2="${b[1]}"/>`)
    parts.push(`<path class="ar" d="M${x} ${a[1]} l${-aw} ${ah} h${2 * aw} Z M${x} ${b[1]} l${-aw} ${-ah} h${2 * aw} Z"/>`)
    const cy = (a[1] + b[1]) / 2
    parts.push(`<text x="${x - 1}" y="${cy}" text-anchor="middle" transform="rotate(-90 ${x - 1} ${cy})">${esc(text)}</text>`)
  }
  return `<g class="dim">${parts.join('')}</g>`
}

/// Zeichnung des Körpers bzw. aller Körper (shape: ein Solid oder ein Compound). bbox: [[x0,y0,z0],[x1,y1,z1]].
/// opts: { title, date, volume, mass, author }. Rückgabe: SVG-Text.
export function drawingSvg(shape, bbox, opts = {}) {
  const [lo, hi] = bbox
  const W = hi[0] - lo[0]
  const D = hi[1] - lo[1]
  const H = hi[2] - lo[2]
  // Blatt: A4 quer, wenn der Maßstab sonst unter 1:1 fiele und A3 1:1 erlaubt, dann A3
  const gap = 22 // Platz zwischen den Ansichten für Maße und Beschriftung
  const pick = (sw, sh) => {
    const areaW = sw - 20 - 10 - 3 * gap
    const areaH = sh - 10 - 10 - 28 - 2 * gap - 4 // Schriftfeld (28 mm) unten frei halten
    for (const [n, d] of SCALES) {
      const s = n / d
      if (s * (W + D) <= areaW && s * (H + D) <= areaH) return { n, d, s }
    }
    const [n, d] = SCALES[SCALES.length - 1]
    return { n, d, s: n / d }
  }
  let sheet = { w: 297, h: 210, name: 'A4' }
  let sc = pick(sheet.w, sheet.h)
  if (sc.s < 1) {
    const a3 = pick(420, 297)
    if (a3.s > sc.s) {
      sheet = { w: 420, h: 297, name: 'A3' }
      sc = a3
    }
  }
  const s = sc.s
  const L = 20
  const T = 10
  const R = sheet.w - 10
  const B = sheet.h - 10
  // Ansichten mittig in ihre Felder: Spalte 1 Breite s·W, Spalte 2 Breite s·D; Zeile 1 Höhe s·H, Zeile 2 Höhe s·D
  const usedW = s * (W + D) + gap
  const usedH = s * (H + D) + gap
  const x0 = L + Math.max(gap, (R - L - usedW) / 2 - 20)
  const y0 = T + Math.max(gap * 0.6, (B - T - 28 - usedH) / 2)
  const place = {
    front: [x0, y0],
    left: [x0 + s * W + gap, y0],
    top: [x0, y0 + s * H + gap],
  }
  const body = []
  const frames = {}
  const notes = []
  const noted = new Set()
  const dims = []
  for (const k of ['top', 'front', 'left']) {
    const v = VIEWS[k]
    const p = project(shape, v, true)
    if (!p.bounds) continue
    // Vorderansicht als Schnitt A–A (Lage und Größe wie die ungeschnittene Ansicht, damit alles fluchtet)
    let sec = null
    if (k === 'front' && opts.section) {
      try {
        sec = sectionFront(shape, bbox, v, (lo[1] + hi[1]) / 2)
      } catch {
        sec = null
      }
      if (sec) {
        p.visible = sec.visible
        p.hidden = []
      }
    }
    const [[bx0, by0], [bx1, by1]] = p.bounds
    const [px, py] = place[k]
    // Zeichnungs-y zeigt nach oben, SVG-Pfade von replicad sind schon gespiegelt (y → −y)
    const tx = px - s * bx0
    const ty = py + s * by1
    const sw = 0.5 / s
    const hw = 0.25 / s
    body.push(`<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s})">`)
    if (p.hidden.length)
      body.push(`<g class="hid" stroke-width="${hw}" stroke-dasharray="${3 / s} ${1.5 / s}">${p.hidden.map((d) => `<path d="${d}"/>`).join('')}</g>`)
    if (sec?.tris.length) {
      const xs = sec.tris.flat().map((q) => q[0])
      const ys = sec.tris.flat().map((q) => q[1])
      const [x0s, x1s, y0s, y1s] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const d = (2.5 / s) * Math.SQRT2
      const lines = []
      for (let c = x0s - (y1s - y0s); c <= x1s; c += d) lines.push(`M${(c).toFixed(4)} ${y1s.toFixed(4)} L${(c + (y1s - y0s)).toFixed(4)} ${y0s.toFixed(4)}`)
      const clip = sec.tris.map((t) => `M${t.map((q) => `${q[0].toFixed(4)} ${q[1].toFixed(4)}`).join(' L')} Z`).join(' ')
      body.push(`<clipPath id="schnitt-a"><path d="${clip}"/></clipPath>`)
      body.push(`<path class="hatch" clip-path="url(#schnitt-a)" stroke-width="${0.18 / s}" d="${lines.join(' ')}"/>`)
    }
    body.push(`<g class="vis" stroke-width="${sw}">${p.visible.map((d) => `<path d="${d}"/>`).join('')}</g>`)
    body.push('</g>')
    body.push(axisLines(opts.axes ?? [], v, s, tx, ty))
    notes.push(boreNotes(opts.axes ?? [], v, s, tx, ty, noted))
    frames[k] = { x: px, y: py, w: s * (bx1 - bx0), h: s * (by1 - by0), sec: !!sec }
  }
  // Schnittverlauf A–A in der Draufsicht: Strichpunktlinie, dicke Enden, Pfeile in Blickrichtung (+y = nach oben)
  const tv = frames.top
  if (frames.front?.sec && tv) {
    const yc = (lo[1] + hi[1]) / 2
    const ySheet = tv.y + tv.h - s * (yc - lo[1])
    const xa = tv.x - 6
    const xb = tv.x + tv.w + 6
    const a = (x, dir) =>
      `<line class="cut-end" x1="${x}" y1="${ySheet}" x2="${x + dir * 6}" y2="${ySheet}"/><path class="ar" d="M${x + dir * 3} ${ySheet - 7} l-0.9 2.5 h1.8 Z"/><line x1="${x + dir * 3}" y1="${ySheet}" x2="${x + dir * 3}" y2="${ySheet - 5}"/><text class="cut-lbl" x="${x + dir * 3 + (dir > 0 ? -4 : 4)}" y="${ySheet - 3}" text-anchor="middle">A</text>`
    dims.push(
      `<g class="dim cut"><line class="cut-mid" x1="${xa + 6}" y1="${ySheet}" x2="${xb - 6}" y2="${ySheet}"/>${a(xa, 1)}${a(xb, -1)}</g>`,
    )
  }
  // Gesamtmaße: Breite und Höhe an der Vorderansicht, Tiefe an der Seitenansicht
  const f = frames.front
  if (f) {
    dims.push(dimLine([f.x, f.y + f.h], [f.x + f.w, f.y + f.h], 8, num(W), false))
    dims.push(dimLine([f.x, f.y + f.h], [f.x, f.y], -8, num(H), true))
  }
  const lv = frames.left
  if (lv) dims.push(dimLine([lv.x, lv.y + lv.h], [lv.x + lv.w, lv.y + lv.h], 8, num(D), false))
  const labels = Object.entries(frames).map(
    ([k, fr]) => `<text class="lbl" x="${fr.x}" y="${fr.y - 3}">${fr.sec ? 'Schnitt A–A' : VIEWS[k].label}</text>`,
  )
  // Isometrie (eigener Maßstab) rechts unten über dem Schriftfeld
  const tbW = 180
  const tbH = 28
  const isoBox = { x: (lv ? lv.x : x0 + s * W + gap), y: (frames.top ? frames.top.y : y0 + s * H + gap), r: R - 4, b: B - tbH - 6 }
  if (isoBox.r - isoBox.x > 30 && isoBox.b - isoBox.y > 25) {
    const p = project(shape, VIEWS.iso, false)
    if (p.bounds) {
      const [[bx0, by0], [bx1, by1]] = p.bounds
      const iw = bx1 - bx0
      const ih = by1 - by0
      const si = Math.min((isoBox.r - isoBox.x) / iw, (isoBox.b - isoBox.y - 6) / ih, s * 1.5)
      const ox = isoBox.x + (isoBox.r - isoBox.x - si * iw) / 2
      const oy = isoBox.y + 6
      body.push(`<g transform="translate(${(ox - si * bx0).toFixed(3)} ${(oy + si * by1).toFixed(3)}) scale(${si})">`)
      body.push(`<g class="vis" stroke-width="${0.35 / si}">${p.visible.map((d) => `<path d="${d}"/>`).join('')}</g></g>`)
      labels.push(`<text class="lbl" x="${ox}" y="${oy - 1}">Isometrie (unmaßstäblich)</text>`)
    }
  }
  // Schriftfeld (vereinfacht nach DIN EN ISO 7200)
  const tx0 = R - tbW
  const ty0 = B - tbH
  const cell = (x, y, label, value, big) =>
    `<text class="tl" x="${x + 1.5}" y="${y + 3.2}">${label}</text><text class="${big ? 'tv big' : 'tv'}" x="${x + 1.5}" y="${y + (big ? 11.5 : 8.3)}">${esc(value)}</text>`
  const vol = opts.volume != null ? `${num(opts.volume / 1000, 2)} cm³` : ''
  const tb = [
    `<rect class="frame" x="${tx0}" y="${ty0}" width="${tbW}" height="${tbH}"/>`,
    `<line x1="${tx0}" y1="${ty0 + 14}" x2="${R}" y2="${ty0 + 14}"/>`,
    `<line x1="${tx0 + 110}" y1="${ty0}" x2="${tx0 + 110}" y2="${B}"/>`,
    `<line x1="${tx0 + 145}" y1="${ty0}" x2="${tx0 + 145}" y2="${B}"/>`,
    `<line x1="${tx0 + 55}" y1="${ty0 + 14}" x2="${tx0 + 55}" y2="${B}"/>`,
    cell(tx0, ty0, 'Benennung', opts.title || 'Konstruktion', true),
    cell(tx0 + 110, ty0, 'Maßstab', `${sc.n}:${sc.d}`),
    cell(tx0 + 145, ty0, 'Format', `${sheet.name} · Blatt 1/1`),
    cell(tx0, ty0 + 14, 'Erstellt mit', opts.author || 'Projekt-FEM'),
    cell(tx0 + 55, ty0 + 14, opts.mass ? 'Masse' : 'Volumen', opts.mass || vol),
    cell(tx0 + 110, ty0 + 14, 'Datum', opts.date || ''),
    cell(tx0 + 145, ty0 + 14, 'Allgemeintoleranz', 'ISO 2768-m'),
    // Symbol Projektionsmethode 1 (Kegelstumpf)
    `<g class="sym" transform="translate(${tx0 + 135} ${ty0 + 4.5})"><path d="M0 1 L6 0 L6 6 L0 5 Z"/><circle cx="-3.5" cy="3" r="2.6"/><circle cx="-3.5" cy="3" r="1.3"/><line x1="-7.5" y1="3" x2="7" y2="3" class="ctr"/></g>`,
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">
<style>
  path, line, rect, circle { fill: none; stroke: #000; stroke-linecap: round; stroke-linejoin: round }
  .dim line { stroke-width: 0.25 }
  .dim .ar { fill: #000; stroke: none }
  text { font-family: 'DejaVu Sans', Arial, sans-serif; fill: #000; stroke: none }
  .dim text { font-size: 3.5px; stroke: #fff; stroke-width: 0.9px; paint-order: stroke; stroke-linejoin: round }
  .lbl { font-size: 3.5px; font-style: italic }
  .tl { font-size: 2.2px; fill: #444 }
  .tv { font-size: 3.5px }
  .tv.big { font-size: 5px; font-weight: bold }
  .frame { stroke-width: 0.5 }
  rect.bg { fill: #fff; stroke: none }
  line { stroke-width: 0.35 }
  .ctr line, .dim .lk { stroke-width: 0.18; stroke-dasharray: 6 1.2 0.6 1.2 }
  .dim line { stroke-width: 0.25 }
  .sym path, .sym circle { stroke-width: 0.3 }
  .hatch { fill: none; stroke: #000 }
  .cut .cut-mid { stroke-width: 0.25; stroke-dasharray: 8 1.5 1 1.5 }
  .cut .cut-end { stroke-width: 0.7 }
  .cut .cut-lbl { font-size: 5px; font-weight: bold }
  .sym .ctr { stroke-width: 0.18; stroke-dasharray: 2 0.6 0.4 0.6 }
</style>
<rect class="bg" width="${sheet.w}" height="${sheet.h}"/>
<rect class="frame" x="${L}" y="${T}" width="${R - L}" height="${B - T}"/>
${body.join('\n')}
${dims.join('\n')}
${notes.join('\n')}
${labels.join('\n')}
${tb.join('\n')}
</svg>
`
}
