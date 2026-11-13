// Skizzen über den Löser von FreeCAD (planegcs, WebAssembly) lösen – Übersetzung unseres Skizzenformats.
// Stand G0: Übersetzung und Lösen; Einbau in den Skizzierer folgt in G2 (CAD_LITE_TODO.md).
import { init_planegcs_module, GcsWrapper, SolveStatus } from '@salusoft89/planegcs'

let modP = null
/// Löser laden (einmal); wasmUrl im Browser über Vite (`…/planegcs.wasm?url`), in Node weglassen
export function loadGcs(wasmUrl) {
  modP ??= init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined)
  return modP
}

const rad = (deg) => (deg * Math.PI) / 180

/// Unsere Skizze → planegcs-Grundelemente
export function toPlanegcs(sk) {
  const out = []
  const P = (id) => sk.pts[id]
  for (const [id, p] of Object.entries(sk.pts)) out.push({ id: `p:${id}`, type: 'point', x: p.x, y: p.y, fixed: !!p.fix })
  const kind = new Map()
  for (const e of sk.ents) {
    kind.set(e.id, e.t)
    if (e.t === 'line') out.push({ id: e.id, type: 'line', p1_id: `p:${e.a}`, p2_id: `p:${e.b}` })
    else if (e.t === 'circle') {
      out.push({ id: e.id, type: 'circle', c_id: `p:${e.c}`, radius: e.r })
      if (e.fix) out.push({ id: `${e.id}:r`, type: 'circle_radius', c_id: e.id, radius: e.r })
    } else if (e.t === 'arc') {
      const c = P(e.c)
      const a = P(e.a)
      const b = P(e.b)
      const a0 = Math.atan2(a.y - c.y, a.x - c.x)
      let a1 = Math.atan2(b.y - c.y, b.x - c.x)
      while (a1 <= a0) a1 += 2 * Math.PI
      out.push({ id: e.id, type: 'arc', c_id: `p:${e.c}`, start_id: `p:${e.a}`, end_id: `p:${e.b}`, start_angle: a0, end_angle: a1, radius: Math.hypot(a.x - c.x, a.y - c.y) })
      out.push({ id: `${e.id}:rules`, type: 'arc_rules', a_id: e.id })
    }
  }
  const p = (id) => `p:${id}`
  for (const c of sk.cons) {
    const id = `c:${c.id}`
    const k1 = kind.get(c.e1)
    const k2 = kind.get(c.e2)
    switch (c.t) {
      case 'h':
        out.push({ id, type: 'horizontal_pp', p1_id: p(c.a), p2_id: p(c.b) })
        break
      case 'v':
        out.push({ id, type: 'vertical_pp', p1_id: p(c.a), p2_id: p(c.b) })
        break
      case 'co':
        out.push({ id, type: 'p2p_coincident', p1_id: p(c.a), p2_id: p(c.b) })
        break
      case 'on': {
        const k = kind.get(c.e)
        out.push(k === 'line' ? { id, type: 'point_on_line_pl', p_id: p(c.p), l_id: c.e } : k === 'arc' ? { id, type: 'point_on_arc', p_id: p(c.p), a_id: c.e } : { id, type: 'point_on_circle', p_id: p(c.p), c_id: c.e })
        break
      }
      case 'par':
        out.push({ id, type: 'parallel', l1_id: c.e1, l2_id: c.e2 })
        break
      case 'perp':
        out.push({ id, type: 'perpendicular_ll', l1_id: c.e1, l2_id: c.e2 })
        break
      case 'eq':
        if (k1 === 'line') out.push({ id, type: 'equal_length', l1_id: c.e1, l2_id: c.e2 })
        else if (k1 === 'circle' && k2 === 'circle') out.push({ id, type: 'equal_radius_cc', c1_id: c.e1, c2_id: c.e2 })
        else if (k1 === 'arc' && k2 === 'arc') out.push({ id, type: 'equal_radius_aa', a1_id: c.e1, a2_id: c.e2 })
        else out.push({ id, type: 'equal_radius_ca', c1_id: k1 === 'circle' ? c.e1 : c.e2, a2_id: k1 === 'circle' ? c.e2 : c.e1 })
        break
      case 'tan': {
        const [l, o] = k1 === 'line' ? [c.e1, c.e2] : [c.e2, c.e1]
        const ko = kind.get(o)
        if (kind.get(l) === 'line') out.push(ko === 'arc' ? { id, type: 'tangent_la', l_id: l, a_id: o } : { id, type: 'tangent_lc', l_id: l, c_id: o })
        else if (k1 === 'arc' && k2 === 'arc') out.push({ id, type: 'tangent_aa', a1_id: c.e1, a2_id: c.e2 })
        else if (k1 === 'circle' && k2 === 'circle') out.push({ id, type: 'tangent_cc', c1_id: c.e1, c2_id: c.e2 })
        else out.push({ id, type: 'tangent_ca', c_id: k1 === 'circle' ? c.e1 : c.e2, a_id: k1 === 'circle' ? c.e2 : c.e1 })
        break
      }
      case 'mid': {
        const l = sk.ents.find((e) => e.id === c.e)
        out.push({ id, type: 'p2p_symmetric_ppp', p1_id: p(l.a), p2_id: p(l.b), p_id: p(c.p) })
        break
      }
      case 'sym':
        out.push({ id, type: 'p2p_symmetric_ppl', p1_id: p(c.a), p2_id: p(c.b), l_id: c.e })
        break
      case 'dist':
        out.push({ id, type: 'p2p_distance', p1_id: p(c.a), p2_id: p(c.b), distance: c.v })
        break
      case 'dx':
      case 'dy': {
        const k = c.t === 'dx' ? 'x' : 'y'
        const s = Math.sign(P(c.b)[k] - P(c.a)[k]) || 1
        out.push({ id, type: 'difference', param1: { o_id: p(c.a), prop: k }, param2: { o_id: p(c.b), prop: k }, difference: s * c.v })
        break
      }
      case 'dpl':
        out.push({ id, type: 'p2l_distance', p_id: p(c.p), l_id: c.e, distance: c.v })
        break
      case 'rad':
        out.push(kind.get(c.e) === 'arc' ? { id, type: 'arc_radius', a_id: c.e, radius: c.v } : { id, type: 'circle_radius', c_id: c.e, radius: c.v })
        break
      case 'dia':
        out.push(kind.get(c.e) === 'arc' ? { id, type: 'arc_diameter', a_id: c.e, diameter: c.v } : { id, type: 'circle_diameter', c_id: c.e, diameter: c.v })
        break
      case 'ang': {
        // Winkel zwischen den Linienrichtungen (Vorzeichen aus der aktuellen Lage)
        const d = (l) => {
          const e = sk.ents.find((x) => x.id === l)
          return [P(e.b).x - P(e.a).x, P(e.b).y - P(e.a).y]
        }
        const [u, w] = [d(c.e1), d(c.e2)]
        const f = (c.f1 ?? 1) * (c.f2 ?? 1)
        const cur = Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1])
        const want = rad(c.v)
        const sign = Math.sign(cur) || 1
        out.push({ id, type: 'l2l_angle_ll', l1_id: c.e1, l2_id: c.e2, angle: f > 0 ? sign * want : sign * (Math.PI - want) })
        break
      }
      default:
        break
    }
  }
  return out
}

/// Skizze lösen → { ok, sketch (gelöst), conflicting, redundant, ms }
export async function solveWithGcs(sk, wasmUrl) {
  const mod = await loadGcs(wasmUrl)
  const t = performance.now()
  const w = new GcsWrapper(new mod.GcsSystem(), mod)
  try {
    w.push_primitives_and_params(toPlanegcs(sk))
    const st = w.solve()
    w.apply_solution()
    const s = structuredClone(sk)
    for (const prim of w.sketch_index.get_primitives()) {
      if (prim.type === 'point' && prim.id.startsWith('p:')) {
        const q = s.pts[prim.id.slice(2)]
        q.x = prim.x
        q.y = prim.y
      } else if (prim.type === 'circle') {
        const e = s.ents.find((x) => x.id === prim.id)
        if (e) e.r = prim.radius
      }
    }
    return {
      ok: st === SolveStatus.Success || st === SolveStatus.Converged,
      sketch: s,
      conflicting: w.get_gcs_conflicting_constraints(),
      redundant: w.get_gcs_redundant_constraints(),
      ms: performance.now() - t,
    }
  } finally {
    w.destroy_gcs_module?.()
  }
}
