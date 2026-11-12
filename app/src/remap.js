// Flächen nach einer Geometrieänderung wiederfinden (Konstruktion übernehmen, neue CAD-Version, Parameterstudie).
import { dot, sub, unit, norm } from './region.js'

// gleiche Flächenart: Ebene mit gleicher Normale bzw. Zylinder mit gleichem Radius und paralleler Achse
function sameKind(a, b) {
  if (a.normal && b.normal) return dot(a.normal, b.normal) > 0.999
  if (a.cylinder && b.cylinder) {
    const ra = a.cylinder.radius
    const rb = b.cylinder.radius
    return Math.abs(ra - rb) <= 0.01 * Math.max(ra, rb) && Math.abs(dot(unit(a.cylinder.axis), unit(b.cylinder.axis))) > 0.999
  }
  return !a.normal && !a.cylinder && !b.normal && !b.cylinder
}

/// Flächen nach einer Geometrieänderung wiederfinden: gleiche Art (Ebene mit gleicher Normale bzw.
/// Zylinder mit gleichem Radius), nächster Schwerpunkt. Ergebnis: alte Nummer → neue Nummer oder null.
export function remapSurfaces(oldSurfs, newSurfs) {
  const map = new Map()
  for (const a of oldSurfs) {
    let best = null
    let bestD = Infinity
    for (const b of newSurfs) {
      if (!sameKind(a, b)) continue
      const d = norm(sub(b.center, a.center))
      if (d < bestD) (best = b), (bestD = d)
    }
    map.set(a.tag, best && bestD < Math.max(0.5, 0.3 * Math.sqrt(a.area)) ? best.tag : null)
  }
  return map
}

