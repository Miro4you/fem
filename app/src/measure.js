// Messen: Flächen (und in der Konstruktion Kanten) anklicken → Maße als Text.
// Eine Auswahl: { point:[x,y,z], surf?: { kind, normal, area, center, radius, axis, origin, length, hole }, edge?: { kind, length, radius } }

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => Math.hypot(a[0], a[1], a[2])
const unit = (a) => {
  const n = norm(a) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}
export const fmtMm = (v, d = 3) => (Number.isFinite(v) ? String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ',') : '–')

/// Fläche der FEM-Ansicht (Netz: normal / cylinder) in die gemeinsame Form bringen
export function surfFromMesh(s) {
  if (!s) return null
  if (s.cylinder) return { kind: 'cylinder', area: s.area, center: s.center, ...s.cylinder }
  if (s.normal) return { kind: 'plane', area: s.area, center: s.center, normal: s.normal }
  return { kind: 'other', area: s.area, center: s.center }
}

/// Text zu einer Auswahl
export function describe(p) {
  if (p.vertex) return `Punkt (${fmtMm(p.vertex[0], 2)}; ${fmtMm(p.vertex[1], 2)}; ${fmtMm(p.vertex[2], 2)}) mm`
  if (p.edge) {
    const e = p.edge
    if (e.kind === 'circle') return e.closed ? `Kreiskante Ø ${fmtMm(2 * e.radius)} mm (R ${fmtMm(e.radius)})` : `Bogenkante R ${fmtMm(e.radius)} mm, Länge ${fmtMm(e.length)} mm`
    return `${e.kind === 'line' ? 'Kante' : 'Kurve'}: Länge ${fmtMm(e.length)} mm`
  }
  const s = p.surf
  if (!s) return 'Punkt'
  if (s.kind === 'cylinder')
    return `${s.hole ? 'Bohrung' : 'Zylinder'} Ø ${fmtMm(2 * s.radius)} mm (R ${fmtMm(s.radius)})${s.length ? `, Länge ${fmtMm(s.length)} mm` : ''}`
  if (s.kind === 'plane') return `Ebene Fläche, ${fmtMm(s.area / 100, 2)} cm²`
  return `Fläche ${fmtMm(s.area / 100, 2)} cm²`
}

/// Ergebnis zweier Auswahlen
export function between(a, b) {
  const out = []
  const d = sub(b.point, a.point)
  out.push(`Abstand der Punkte ${fmtMm(norm(d))} mm (Δx ${fmtMm(d[0], 2)}, Δy ${fmtMm(d[1], 2)}, Δz ${fmtMm(d[2], 2)})`)
  const sa = a.surf
  const sb = b.surf
  if (sa?.kind === 'plane' && sb?.kind === 'plane') {
    const na = unit(sa.normal)
    const nb = unit(sb.normal)
    const c = Math.abs(dot(na, nb))
    const gap = Math.abs(dot(na, sub(sb.center, sa.center)))
    if (c > 0.9999 && gap < 1e-9) out.unshift('Dieselbe Ebene')
    else if (c > 0.9999) out.unshift(`Abstand der parallelen Flächen ${fmtMm(Math.abs(dot(na, sub(sb.center, sa.center))))} mm`)
    else out.unshift(`Winkel zwischen den Flächen ${fmtMm((Math.acos(Math.min(1, dot(na, nb))) * 180) / Math.PI, 2)}°`)
  }
  if (sa?.kind === 'cylinder' && sb?.kind === 'cylinder') {
    const ax = unit(sa.axis)
    if (Math.abs(dot(ax, unit(sb.axis))) > 0.9999) {
      const w = sub(sb.origin, sa.origin)
      const perp = sub(w, ax.map((x) => x * dot(w, ax)))
      const dd = norm(perp)
      out.unshift(dd < 1e-6 * Math.max(1, sa.radius) ? 'Gleiche Achse (koaxial)' : `Achsabstand ${fmtMm(dd)} mm`)
    }
  }
  if ((sa?.kind === 'plane' && sb?.kind === 'cylinder') || (sa?.kind === 'cylinder' && sb?.kind === 'plane')) {
    const [pl, cy] = sa.kind === 'plane' ? [sa, sb] : [sb, sa]
    const n = unit(pl.normal)
    if (Math.abs(dot(n, unit(cy.axis))) < 1e-4) out.unshift(`Abstand Achse – Fläche ${fmtMm(Math.abs(dot(n, sub(cy.origin, pl.center))))} mm`)
  }
  return out
}
