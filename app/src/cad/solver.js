// Skizzen-Löser: Punkte so verschieben, dass alle Bedingungen und Maße stimmen.
//
// Unbekannte: x, y jedes nicht festen Punkts und der Radius jedes Kreises. Jede Bedingung liefert ein oder
// zwei Gleichungen (Restwert = 0). Gelöst wird mit Newton-Schritten kleinster Norm – so bewegt sich die Skizze
// möglichst wenig, und der gezogene Punkt bleibt möglichst unter der Maus.
//
// Skizze: { pts: {id: {x, y, fix}}, ents: [{id, t: 'line'|'circle'|'arc'|'point', …}], cons: [{id, t, …}] }

const EPS = 1e-12

const hyp = Math.hypot

/// Bedingungen, die ein Maß tragen (Wert `v`)
export const DIM_TYPES = new Set(['dist', 'dx', 'dy', 'dpl', 'rad', 'dia', 'ang'])

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a <= -Math.PI) a += 2 * Math.PI
  return a
}

/// Gleichungssystem aufbauen: Unbekannte nummerieren, je Bedingung Restwert-Funktionen anlegen.
function build(sk) {
  const index = new Map() // 'p:id:x' | 'r:id' → Nummer
  const x = []
  const names = []
  const add = (key, value) => {
    index.set(key, x.length)
    x.push(value)
    names.push(key)
  }
  for (const [id, p] of Object.entries(sk.pts)) {
    if (p.fix) continue
    add(`p:${id}:x`, p.x)
    add(`p:${id}:y`, p.y)
  }
  const ent = new Map(sk.ents.map((e) => [e.id, e]))
  for (const e of sk.ents) if (e.t === 'circle' && !e.fix) add(`r:${e.id}`, e.r)

  // Zugriff auf einen Punkt bzw. Radius: liefert [Nummern …] und eine Lesefunktion
  const P = (id) => {
    const p = sk.pts[id]
    if (!p) return null
    const ix = index.get(`p:${id}:x`)
    return ix == null ? { idx: [], get: () => [p.x, p.y] } : { idx: [ix, ix + 1], get: (v) => [v[ix], v[ix + 1]] }
  }
  const R = (e) => {
    if (e.t === 'circle') {
      const i = index.get(`r:${e.id}`)
      return i == null ? { idx: [], get: () => e.r } : { idx: [i], get: (v) => v[i] }
    }
    const c = P(e.c)
    const a = P(e.a)
    return {
      idx: [...c.idx, ...a.idx],
      get: (v) => {
        const [cx, cy] = c.get(v)
        const [ax, ay] = a.get(v)
        return hyp(ax - cx, ay - cy)
      },
    }
  }
  let L = 1
  {
    const xs = Object.values(sk.pts).map((p) => p.x)
    const ys = Object.values(sk.pts).map((p) => p.y)
    if (xs.length) L = Math.max(1, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  }

  const eqs = [] // { con, idx: [Unbekannte], f(v) }
  const eq = (con, parts, f) => eqs.push({ con, idx: [...new Set(parts.flatMap((p) => p.idx))], f })
  const dirOf = (e) => {
    const a = P(e.a)
    const b = P(e.b)
    return {
      idx: [...a.idx, ...b.idx],
      get: (v) => {
        const [ax, ay] = a.get(v)
        const [bx, by] = b.get(v)
        return [bx - ax, by - ay]
      },
    }
  }
  // Abstand eines Punkts von der Geraden durch a, b (mit Vorzeichen)
  const signedDist = (p, a, b) => (v) => {
    const [px, py] = p.get(v)
    const [ax, ay] = a.get(v)
    const [bx, by] = b.get(v)
    const dx = bx - ax
    const dy = by - ay
    return (dx * (py - ay) - dy * (px - ax)) / Math.max(hyp(dx, dy), EPS)
  }

  // Bögen: Anfang und Ende gleich weit vom Mittelpunkt
  for (const e of sk.ents) {
    if (e.t !== 'arc') continue
    const c = P(e.c)
    const a = P(e.a)
    const b = P(e.b)
    eq(null, [c, a, b], (v) => {
      const [cx, cy] = c.get(v)
      const [ax, ay] = a.get(v)
      const [bx, by] = b.get(v)
      return hyp(ax - cx, ay - cy) - hyp(bx - cx, by - cy)
    })
  }

  for (const c of sk.cons) {
    const t = c.t
    if (t === 'h' || t === 'v') {
      const a = P(c.a)
      const b = P(c.b)
      if (!a || !b) continue
      const k = t === 'h' ? 1 : 0
      eq(c, [a, b], (v) => a.get(v)[k] - b.get(v)[k])
    } else if (t === 'on') {
      const p = P(c.p)
      const e = ent.get(c.e)
      if (!p || !e) continue
      if (e.t === 'line') {
        const a = P(e.a)
        const b = P(e.b)
        eq(c, [p, a, b], signedDist(p, a, b))
      } else {
        const ctr = P(e.c)
        const r = R(e)
        eq(c, [p, ctr, r], (v) => {
          const [px, py] = p.get(v)
          const [cx, cy] = ctr.get(v)
          return hyp(px - cx, py - cy) - r.get(v)
        })
      }
    } else if (t === 'par' || t === 'perp') {
      const e1 = ent.get(c.e1)
      const e2 = ent.get(c.e2)
      if (e1?.t !== 'line' || e2?.t !== 'line') continue
      const d1 = dirOf(e1)
      const d2 = dirOf(e2)
      eq(c, [d1, d2], (v) => {
        const [ux, uy] = d1.get(v)
        const [wx, wy] = d2.get(v)
        const n = Math.max(hyp(ux, uy) * hyp(wx, wy), EPS)
        return (L * (t === 'par' ? ux * wy - uy * wx : ux * wx + uy * wy)) / n
      })
    } else if (t === 'eq') {
      const e1 = ent.get(c.e1)
      const e2 = ent.get(c.e2)
      if (!e1 || !e2) continue
      if (e1.t === 'line' && e2.t === 'line') {
        const d1 = dirOf(e1)
        const d2 = dirOf(e2)
        eq(c, [d1, d2], (v) => hyp(...d1.get(v)) - hyp(...d2.get(v)))
      } else if (e1.t !== 'line' && e2.t !== 'line') {
        const r1 = R(e1)
        const r2 = R(e2)
        eq(c, [r1, r2], (v) => r1.get(v) - r2.get(v))
      }
    } else if (t === 'tan') {
      const e1 = ent.get(c.e1)
      const e2 = ent.get(c.e2)
      if (!e1 || !e2) continue
      const line = e1.t === 'line' ? e1 : e2.t === 'line' ? e2 : null
      const round = e1.t !== 'line' ? e1 : e2
      if (line && round.t !== 'line') {
        const a = P(line.a)
        const b = P(line.b)
        const ctr = P(round.c)
        const r = R(round)
        const sd = signedDist(ctr, a, b)
        if (c.s == null) c.s = sd(x) >= 0 ? 1 : -1
        eq(c, [a, b, ctr, r], (v) => c.s * sd(v) - r.get(v))
      } else if (!line) {
        const c1 = P(e1.c)
        const c2 = P(e2.c)
        const r1 = R(e1)
        const r2 = R(e2)
        if (c.inner == null) {
          const [ax, ay] = c1.get(x)
          const [bx, by] = c2.get(x)
          const d = hyp(ax - bx, ay - by)
          c.inner = Math.abs(d - Math.abs(r1.get(x) - r2.get(x))) < Math.abs(d - (r1.get(x) + r2.get(x)))
        }
        eq(c, [c1, c2, r1, r2], (v) => {
          const [ax, ay] = c1.get(v)
          const [bx, by] = c2.get(v)
          const d = hyp(ax - bx, ay - by)
          return c.inner ? d - Math.abs(r1.get(v) - r2.get(v)) : d - (r1.get(v) + r2.get(v))
        })
      }
    } else if (t === 'mid') {
      const p = P(c.p)
      const e = ent.get(c.e)
      if (!p || e?.t !== 'line') continue
      const a = P(e.a)
      const b = P(e.b)
      for (const k of [0, 1]) eq(c, [p, a, b], (v) => (a.get(v)[k] + b.get(v)[k]) / 2 - p.get(v)[k])
    } else if (t === 'sym') {
      // p und q spiegelbildlich zur Linie e
      const p = P(c.p)
      const q = P(c.q)
      const e = ent.get(c.e)
      if (!p || !q || e?.t !== 'line') continue
      const a = P(e.a)
      const b = P(e.b)
      const sp = signedDist(p, a, b)
      const sq = signedDist(q, a, b)
      eq(c, [p, q, a, b], (v) => sp(v) + sq(v))
      const d = dirOf(e)
      eq(c, [p, q, d], (v) => {
        const [px, py] = p.get(v)
        const [qx, qy] = q.get(v)
        const [ux, uy] = d.get(v)
        return ((qx - px) * ux + (qy - py) * uy) / Math.max(hyp(ux, uy), EPS)
      })
    } else if (t === 'co' || (t === 'dist' && !(c.v > 0))) {
      // Punkte fallen zusammen
      const a = P(c.a)
      const b = P(c.b)
      if (!a || !b) continue
      for (const k of [0, 1]) eq(c, [a, b], (v) => a.get(v)[k] - b.get(v)[k])
    } else if (t === 'dist' || t === 'dx' || t === 'dy') {
      const a = P(c.a)
      const b = P(c.b)
      if (!a || !b) continue
      if (t === 'dist') {
        eq(c, [a, b], (v) => {
          const [ax, ay] = a.get(v)
          const [bx, by] = b.get(v)
          return hyp(bx - ax, by - ay) - c.v
        })
      } else {
        const k = t === 'dx' ? 0 : 1
        if (c.s == null) c.s = b.get(x)[k] - a.get(x)[k] >= 0 ? 1 : -1
        eq(c, [a, b], (v) => c.s * (b.get(v)[k] - a.get(v)[k]) - c.v)
      }
    } else if (t === 'dpl') {
      const p = P(c.p)
      const e = ent.get(c.e)
      if (!p || e?.t !== 'line') continue
      const a = P(e.a)
      const b = P(e.b)
      const sd = signedDist(p, a, b)
      if (c.s == null) c.s = sd(x) >= 0 ? 1 : -1
      eq(c, [p, a, b], (v) => c.s * sd(v) - c.v)
    } else if (t === 'rad' || t === 'dia') {
      const e = ent.get(c.e)
      if (!e || e.t === 'line') continue
      const r = R(e)
      eq(c, [r], (v) => (t === 'dia' ? 2 : 1) * r.get(v) - c.v)
    } else if (t === 'ang') {
      const e1 = ent.get(c.e1)
      const e2 = ent.get(c.e2)
      if (e1?.t !== 'line' || e2?.t !== 'line') continue
      const d1 = dirOf(e1)
      const d2 = dirOf(e2)
      const angle = (v) => {
        const [ux, uy] = d1.get(v)
        const [wx, wy] = d2.get(v)
        const f1 = c.f1 ?? 1
        const f2 = c.f2 ?? 1
        return Math.atan2(f1 * f2 * (ux * wy - uy * wx), f1 * f2 * (ux * wx + uy * wy))
      }
      if (c.s == null) c.s = angle(x) >= 0 ? 1 : -1
      eq(c, [d1, d2], (v) => L * wrapAngle(c.s * angle(v) - (c.v * Math.PI) / 180))
    }
  }
  return { x, names, index, eqs, L }
}

function residuals(sys, v) {
  const r = new Float64Array(sys.eqs.length)
  for (let i = 0; i < sys.eqs.length; i++) r[i] = sys.eqs[i].f(v)
  return r
}

/// Jacobi-Matrix (dicht, m × n) per Differenzenquotient – jede Gleichung hängt nur von wenigen Unbekannten ab
function jacobian(sys, v) {
  const m = sys.eqs.length
  const n = v.length
  const J = Array.from({ length: m }, () => new Float64Array(n))
  const h = 1e-6 * sys.L
  for (let i = 0; i < m; i++) {
    const e = sys.eqs[i]
    for (const k of e.idx) {
      const old = v[k]
      v[k] = old + h
      const fp = e.f(v)
      v[k] = old - h
      const fm = e.f(v)
      v[k] = old
      J[i][k] = (fp - fm) / (2 * h)
    }
  }
  return J
}

/// Löst A y = b (A symmetrisch positiv semidefinit, m × m) mit Gauß und Spaltenpivot; A, b werden überschrieben.
function solveDense(A, b) {
  const m = b.length
  for (let c = 0; c < m; c++) {
    let p = c
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    if (Math.abs(A[p][c]) < 1e-300) continue
    if (p !== c) {
      ;[A[p], A[c]] = [A[c], A[p]]
      ;[b[p], b[c]] = [b[c], b[p]]
    }
    for (let r = c + 1; r < m; r++) {
      const f = A[r][c] / A[c][c]
      if (!f) continue
      for (let k = c; k < m; k++) A[r][k] -= f * A[c][k]
      b[r] -= f * b[c]
    }
  }
  const y = new Float64Array(m)
  for (let r = m - 1; r >= 0; r--) {
    let s = b[r]
    for (let k = r + 1; k < m; k++) s -= A[r][k] * y[k]
    y[r] = Math.abs(A[r][r]) < 1e-300 ? 0 : s / A[r][r]
  }
  return y
}

const maxAbs = (r) => {
  let m = 0
  for (const v of r) m = Math.max(m, Math.abs(v))
  return m
}

/// Rang der Jacobi-Matrix und welche Unbekannten festliegen (Zeilenraum per Gram-Schmidt)
function analyse(J, n) {
  const basis = []
  const scale = Math.max(1e-300, ...J.map((row) => hyp(...row)))
  for (const row of J) {
    const w = Float64Array.from(row)
    for (let pass = 0; pass < 2; pass++)
      for (const q of basis) {
        let d = 0
        for (let k = 0; k < n; k++) d += q[k] * w[k]
        if (d) for (let k = 0; k < n; k++) w[k] -= d * q[k]
      }
    const len = hyp(...w)
    if (len > 1e-7 * scale) {
      for (let k = 0; k < n; k++) w[k] /= len
      basis.push(w)
    }
  }
  const fixed = new Uint8Array(n)
  for (let k = 0; k < n; k++) {
    let s = 0
    for (const q of basis) s += q[k] * q[k]
    fixed[k] = s > 1 - 1e-6 ? 1 : 0
  }
  return { rank: basis.length, fixed }
}

/// Löst die Skizze (verändert `sk.pts` und Kreisradien).
/// drag: { pts: {id: [x, y]}, radius: {id: r} } – Zielwerte der gezogenen Elemente.
/// → { ok, dof, free: Set der unterbestimmten Punkt-/Kreis-IDs, redundant: Anzahl überzähliger Gleichungen }
export function solve(sk, { drag = null, analyse: wantAnalyse = true, maxIter = 60 } = {}) {
  const sys = build(sk)
  const n = sys.x.length
  const v = Float64Array.from(sys.x)
  const w = new Float64Array(n).fill(1) // Trägheit je Unbekannter: groß = bleibt eher stehen
  if (drag) {
    for (const [id, [px, py]] of Object.entries(drag.pts ?? {})) {
      const i = sys.index.get(`p:${id}:x`)
      if (i == null) continue
      v[i] = px
      v[i + 1] = py
      w[i] = w[i + 1] = 1e8
    }
    for (const [id, r] of Object.entries(drag.radius ?? {})) {
      const i = sys.index.get(`r:${id}`)
      if (i == null) continue
      v[i] = Math.max(r, 1e-6)
      w[i] = 1e8
    }
  }
  const m = sys.eqs.length
  const tol = 1e-11 * sys.L
  let r = residuals(sys, v)
  let err = maxAbs(r)
  let ok = err < tol
  for (let it = 0; it < maxIter && !ok && m > 0; it++) {
    const J = jacobian(sys, v)
    // (J W⁻¹ Jᵀ + λ) y = r,  Δ = −W⁻¹ Jᵀ y
    const A = Array.from({ length: m }, () => new Float64Array(m))
    let trace = 0
    for (let i = 0; i < m; i++) {
      for (let j = i; j < m; j++) {
        let s = 0
        const a = J[i]
        const b = J[j]
        for (const k of sys.eqs[i].idx) s += (a[k] * b[k]) / w[k]
        A[i][j] = A[j][i] = s
      }
      trace += A[i][i]
    }
    const lam = 1e-10 * (trace / m || 1)
    for (let i = 0; i < m; i++) A[i][i] += lam
    const y = solveDense(A, Float64Array.from(r))
    const step = new Float64Array(n)
    for (let i = 0; i < m; i++) for (const k of sys.eqs[i].idx) step[k] -= (J[i][k] * y[i]) / w[k]
    // Schrittweite halbieren, solange es schlechter wird
    let f = 1
    let next = null
    let nerr = Infinity
    for (let ls = 0; ls < 10; ls++) {
      const cand = Float64Array.from(v, (x0, k) => x0 + f * step[k])
      const rr = residuals(sys, cand)
      const e = maxAbs(rr)
      if (e < nerr) {
        nerr = e
        next = [cand, rr]
      }
      if (e < err) break
      f /= 2
    }
    if (!next || !(nerr < err * 0.9999) ) {
      if (next && nerr < tol) {
        v.set(next[0])
        r = next[1]
        err = nerr
      }
      break
    }
    v.set(next[0])
    r = next[1]
    err = nerr
    ok = err < tol
  }
  ok = err < Math.max(tol, 1e-7 * sys.L)
  if (!ok) return { ok: false, error: err, dof: null, free: new Set(), redundant: 0 }

  // Ergebnis zurückschreiben
  for (const [id, p] of Object.entries(sk.pts)) {
    const i = sys.index.get(`p:${id}:x`)
    if (i == null) continue
    p.x = v[i]
    p.y = v[i + 1]
  }
  for (const e of sk.ents) {
    const i = e.t === 'circle' ? sys.index.get(`r:${e.id}`) : null
    if (i != null) e.r = Math.max(v[i], 1e-9)
  }

  const out = { ok: true, dof: null, free: new Set(), redundant: 0 }
  if (wantAnalyse) {
    const { rank, fixed } = m ? analyse(jacobian(sys, v), n) : { rank: 0, fixed: new Uint8Array(n) }
    out.dof = n - rank
    out.redundant = m - rank
    sys.names.forEach((name, k) => {
      if (!fixed[k]) out.free.add(name.split(':')[1])
    })
  }
  return out
}

/// Prüft, ob eine neue Bedingung etwas festlegt (Rang steigt) und lösbar ist.
/// → 'ok' | 'redundant' (legt nichts Neues fest) | 'conflict' (widerspricht anderen)
export function tryConstraint(sk, con) {
  const before = solve(structuredClone(sk))
  const trial = structuredClone(sk)
  trial.cons.push(structuredClone(con))
  const after = solve(trial)
  if (!after.ok) return { verdict: 'conflict' }
  if (before.ok && after.redundant > before.redundant) return { verdict: 'redundant' }
  return { verdict: 'ok', sketch: trial, result: after }
}
