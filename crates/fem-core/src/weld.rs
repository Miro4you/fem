//! Schweißnähte: zwei Flächen über einen kleinen Spalt fest verbinden.
//!
//! Typischer Fall: gekantete Bleche mit geschlossenen Ecken (im CAD bleibt ein Spalt von 0,1–1 mm), die
//! später verschweißt werden. Ohne Naht sind die Bleche an der Ecke lose; mit Naht wird jeder Knoten der
//! Fläche A mit dem nächsten Punkt der Gegenfläche B gekoppelt (Strafverfahren: sehr steife Feder je
//! Richtung, „Kopplung“). Über die Kopplungskräfte ergibt sich die Kraft, die die Naht überträgt, und ihr
//! Verlauf entlang der Naht (Linienkraft N/mm) → Nahtspannung τ_w = Linienkraft / a.
//!
//! Gleiches Verfahren eignet sich später für verklebte Baugruppen.

use nalgebra::{DMatrix, Matrix3, SymmetricEigen, Vector3};
use serde::{Deserialize, Serialize};

use crate::mesh::{Face, Mesh};
use crate::model::Model;
use crate::{FemError, Result};

/// Steifigkeit der Kopplung im Verhältnis zu E · Netzweite (Strafverfahren; Fehler ≈ 1/PENALTY)
const PENALTY: f64 = 1e3;

/// Schweißnaht zwischen zwei Flächengruppen
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Weld {
    pub name: String,
    /// Flächengruppe, deren Knoten angekoppelt werden (meist die schmale Stirnfläche des Blechs)
    pub a: String,
    /// Gegenfläche
    pub b: String,
    /// größter Spalt, der überbrückt wird [mm]; `None` = kleinster Abstand + halbe Netzweite
    #[serde(default)]
    pub max_gap: Option<f64>,
    /// a-Maß (Nahtdicke) [mm]; `None` = durchgeschweißte Stumpfnaht, a = Breite der Fläche A
    #[serde(default)]
    pub throat: Option<f64>,
}

/// Kopplung eines Knotens der Fläche A an einen Punkt der Fläche B: u_A − Σ N_i·u_Bi = 0
#[derive(Debug, Clone)]
pub struct Tie {
    pub weld: usize,
    /// [Knoten A, Knoten der Gegenfläche …]
    pub nodes: Vec<usize>,
    /// [1, −N_1, …]
    pub w: Vec<f64>,
    pub alpha: f64,
}

impl Tie {
    /// Steifigkeitsmatrix (3m × 3m, global): α · w_i·w_j · I
    pub fn stiffness(&self) -> DMatrix<f64> {
        let m = self.nodes.len();
        let mut k = DMatrix::zeros(3 * m, 3 * m);
        for i in 0..m {
            for j in 0..m {
                let v = self.alpha * self.w[i] * self.w[j];
                for c in 0..3 {
                    k[(3 * i + c, 3 * j + c)] = v;
                }
            }
        }
        k
    }

    /// Klaffung u_A − Σ N·u_B (global)
    fn gap(&self, u: &[f64]) -> Vector3<f64> {
        let mut g = Vector3::zeros();
        for (n, w) in self.nodes.iter().zip(&self.w) {
            g += Vector3::new(u[3 * n], u[3 * n + 1], u[3 * n + 2]) * *w;
        }
        g
    }

    /// Kraft, die die Naht auf den Knoten der Fläche A ausübt
    pub fn force_on_a(&self, u: &[f64]) -> Vector3<f64> {
        -self.gap(u) * self.alpha
    }
}

/// Lage einer Naht (für die Auswertung)
#[derive(Debug, Clone)]
pub struct WeldGeom {
    /// angekoppelte Knoten der Fläche A (je einer pro Kopplung, gleiche Reihenfolge)
    pub matched: Vec<usize>,
    pub unmatched: usize,
    pub gap_min: f64,
    pub gap_max: f64,
    /// mittlere Außennormale der Fläche A
    pub normal: Vector3<f64>,
    /// Nahtrichtung (längste Ausdehnung der angekoppelten Knoten)
    pub axis: Vector3<f64>,
    pub origin: Vector3<f64>,
    pub length: f64,
    pub width: f64,
    pub h: f64,
}

pub struct Prepared {
    pub ties: Vec<Tie>,
    pub geom: Vec<WeldGeom>,
}

/// Ergebnis einer Naht
#[derive(Debug, Clone, Serialize)]
pub struct WeldResult {
    pub name: String,
    /// angekoppelte Knoten / Knoten ohne Gegenfläche (außerhalb des Spalts)
    pub nodes: usize,
    pub unmatched: usize,
    /// Spalt [mm]
    pub gap_min: f64,
    pub gap_max: f64,
    /// Nahtlänge, Breite der Fläche A, a-Maß [mm]
    pub length: f64,
    pub width: f64,
    pub throat: f64,
    /// übertragene Kraft (auf Fläche A) [N], davon senkrecht zu A und in der Fläche
    pub force: [f64; 3],
    pub force_normal: f64,
    pub force_shear: f64,
    /// Linienkraft [N/mm]: Mittel (|F| / Länge) und größter Wert entlang der Naht
    pub line_force_mean: f64,
    pub line_force_max: f64,
    /// Nahtspannung τ_w = Linienkraft / a [MPa] (vereinfachtes Verfahren EN 1993-1-8, 4.5.3.3)
    pub stress_mean: f64,
    pub stress_max: f64,
    /// Ort der größten Linienkraft
    pub max_at: [f64; 3],
    /// Verlauf: (Lage entlang der Naht [mm], Linienkraft [N/mm])
    pub profile: Vec<[f64; 2]>,
    pub start: [f64; 3],
    pub end: [f64; 3],
}

fn v3(p: [f64; 3]) -> Vector3<f64> {
    Vector3::from(p)
}

/// Eckpunkte einer Randfläche
fn corners(mesh: &Mesh, f: &Face) -> [Vector3<f64>; 3] {
    [v3(mesh.nodes[f.nodes[0]]), v3(mesh.nodes[f.nodes[1]]), v3(mesh.nodes[f.nodes[2]])]
}

/// Fläche · Normale (nach außen) eines Randdreiecks (aus den Eckpunkten)
fn area_normal(mesh: &Mesh, f: &Face) -> Vector3<f64> {
    let [a, b, c] = corners(mesh, f);
    (b - a).cross(&(c - a)) * 0.5
}

fn mean_edge(mesh: &Mesh, f: &Face) -> f64 {
    let [a, b, c] = corners(mesh, f);
    ((b - a).norm() + (c - b).norm() + (a - c).norm()) / 3.0
}

/// Nächster Punkt im Dreieck abc zu p (Ericson, Real-Time Collision Detection 5.1.5): baryzentrische Koordinaten
fn closest_on_triangle(p: Vector3<f64>, a: Vector3<f64>, b: Vector3<f64>, c: Vector3<f64>) -> [f64; 3] {
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;
    let d1 = ab.dot(&ap);
    let d2 = ac.dot(&ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return [1.0, 0.0, 0.0];
    }
    let bp = p - b;
    let d3 = ab.dot(&bp);
    let d4 = ac.dot(&bp);
    if d3 >= 0.0 && d4 <= d3 {
        return [0.0, 1.0, 0.0];
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return [1.0 - v, v, 0.0];
    }
    let cp = p - c;
    let d5 = ab.dot(&cp);
    let d6 = ac.dot(&cp);
    if d6 >= 0.0 && d5 <= d6 {
        return [0.0, 0.0, 1.0];
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return [1.0 - w, 0.0, w];
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return [0.0, 1.0 - w, w];
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    [1.0 - v - w, v, w]
}

/// Formfunktionen der Randfläche (3 oder 6 Knoten) an den baryzentrischen Koordinaten l
fn face_shape(n_nodes: usize, l: [f64; 3]) -> Vec<f64> {
    if n_nodes == 6 {
        vec![
            l[0] * (2.0 * l[0] - 1.0),
            l[1] * (2.0 * l[1] - 1.0),
            l[2] * (2.0 * l[2] - 1.0),
            4.0 * l[0] * l[1],
            4.0 * l[1] * l[2],
            4.0 * l[2] * l[0],
        ]
    } else {
        l.to_vec()
    }
}

/// Kopplungen aller Nähte des Modells aufbauen
pub fn prepare(model: &Model, faces: &[Face]) -> Result<Prepared> {
    let mesh = &model.mesh;
    let e_mod = model.material.e;
    let mut ties = Vec::new();
    let mut geom = Vec::new();
    for (wi, w) in model.welds.iter().enumerate() {
        let fa = model.group_faces(&w.a, faces)?;
        let fb = model.group_faces(&w.b, faces)?;
        let region = model.group_region(&w.a)?;
        let tol = mesh.tolerance();
        let mut slaves: Vec<usize> = fa.iter().flat_map(|&f| faces[f].nodes.clone()).collect();
        slaves.sort_unstable();
        slaves.dedup();
        if let Some(r) = region {
            slaves.retain(|&n| r.contains(mesh.nodes[n], tol));
        }
        let b_nodes: std::collections::HashSet<usize> = fb.iter().flat_map(|&f| faces[f].nodes.iter().copied()).collect();
        // Knoten, die schon zu B gehören (gemeinsame Kante), sind bereits verbunden
        slaves.retain(|n| !b_nodes.contains(n));
        if slaves.is_empty() {
            return Err(FemError::BadLoad(w.name.clone(), "Fläche A und B sind dieselben oder schon verbunden".into()));
        }
        // Gegenflächen: Ecken, Mittelpunkt und Umkreisradius (Vorauswahl)
        let masters: Vec<(usize, [Vector3<f64>; 3], Vector3<f64>, f64)> = fb
            .iter()
            .map(|&f| {
                let c = corners(mesh, &faces[f]);
                let m = (c[0] + c[1] + c[2]) / 3.0;
                let r = c.iter().map(|p| (p - m).norm()).fold(0.0, f64::max);
                (f, c, m, r)
            })
            .collect();
        let h_a = fa.iter().map(|&f| mean_edge(mesh, &faces[f])).sum::<f64>() / fa.len() as f64;
        // nächster Punkt auf B je Knoten von A
        let found: Vec<(usize, f64, usize, [f64; 3])> = slaves
            .iter()
            .map(|&n| {
                let p = v3(mesh.nodes[n]);
                let mut best = (f64::INFINITY, usize::MAX, [0.0; 3]);
                for (k, (_, c, m, r)) in masters.iter().enumerate() {
                    if (p - m).norm() - r > best.0 {
                        continue;
                    }
                    let l = closest_on_triangle(p, c[0], c[1], c[2]);
                    let q = c[0] * l[0] + c[1] * l[1] + c[2] * l[2];
                    let d = (p - q).norm();
                    if d < best.0 {
                        best = (d, k, l);
                    }
                }
                (n, best.0, best.1, best.2)
            })
            .collect();
        let gap_min = found.iter().map(|f| f.1).fold(f64::INFINITY, f64::min);
        let max_gap = w.max_gap.unwrap_or(gap_min + (0.5 * h_a).max(0.2));
        let mut matched = Vec::new();
        let mut gap_max = 0.0f64;
        for (n, d, k, l) in &found {
            if *d > max_gap || *k == usize::MAX {
                continue;
            }
            let (f, c, _, _) = &masters[*k];
            let fnodes = &faces[*f].nodes;
            let nn = face_shape(fnodes.len(), *l);
            let h = ((c[1] - c[0]).norm() + (c[2] - c[1]).norm() + (c[0] - c[2]).norm()) / 3.0;
            let mut nodes = vec![*n];
            let mut wts = vec![1.0];
            for (m, v) in fnodes.iter().zip(&nn) {
                if v.abs() > 1e-12 {
                    nodes.push(*m);
                    wts.push(-v);
                }
            }
            ties.push(Tie { weld: wi, nodes, w: wts, alpha: PENALTY * e_mod * h.max(1e-9) });
            matched.push(*n);
            gap_max = gap_max.max(*d);
        }
        if matched.is_empty() {
            return Err(FemError::BadLoad(
                w.name.clone(),
                format!("Fläche A findet keine Gegenfläche B innerhalb von {max_gap:.2} mm (kleinster Abstand {gap_min:.2} mm) – Flächen oder Spalt prüfen"),
            ));
        }
        // Nahtrichtung: Hauptachse der angekoppelten Knoten
        let pts: Vec<Vector3<f64>> = matched.iter().map(|&n| v3(mesh.nodes[n])).collect();
        let origin = pts.iter().sum::<Vector3<f64>>() / pts.len() as f64;
        let mut cov = Matrix3::zeros();
        for p in &pts {
            let d = p - origin;
            cov += d * d.transpose();
        }
        let eig = SymmetricEigen::new(cov);
        let imax = (0..3).max_by(|&i, &j| eig.eigenvalues[i].total_cmp(&eig.eigenvalues[j])).unwrap_or(0);
        let axis = eig.eigenvectors.column(imax).into_owned().normalize();
        let s: Vec<f64> = pts.iter().map(|p| (p - origin).dot(&axis)).collect();
        let (s0, s1) = s.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &x| (a.min(x), b.max(x)));
        let length = (s1 - s0).max(h_a);
        // Fläche von A, soweit angekoppelt → Breite = Fläche / Länge
        let set: std::collections::HashSet<usize> = matched.iter().copied().collect();
        let mut nsum = Vector3::zeros();
        let mut area = 0.0;
        for &f in &fa {
            let an = area_normal(mesh, &faces[f]);
            nsum += an;
            if faces[f].nodes[..3].iter().all(|n| set.contains(n)) {
                area += an.norm();
            }
        }
        let width = if area > 0.0 { area / length } else { h_a };
        let normal = if nsum.norm() > 1e-12 { nsum.normalize() } else { Vector3::zeros() };
        geom.push(WeldGeom {
            matched,
            unmatched: slaves.len() - set.len(),
            gap_min,
            gap_max,
            normal,
            axis,
            origin: origin + axis * (0.5 * (s0 + s1)),
            length,
            width,
            h: h_a,
        });
    }
    Ok(Prepared { ties, geom })
}

/// Nahtkräfte und -spannungen aus den Verschiebungen (global)
pub fn evaluate(model: &Model, p: &Prepared, u: &[f64]) -> Vec<WeldResult> {
    let mesh = &model.mesh;
    model
        .welds
        .iter()
        .enumerate()
        .zip(&p.geom)
        .map(|((wi, w), g)| {
            let forces: Vec<(usize, Vector3<f64>)> =
                p.ties.iter().filter(|t| t.weld == wi).map(|t| (t.nodes[0], t.force_on_a(u))).collect();
            let total: Vector3<f64> = forces.iter().map(|(_, f)| f).sum();
            let fn_ = total.dot(&g.normal);
            let ft = (total - g.normal * fn_).norm();
            // Verlauf entlang der Naht: Kräfte in Abschnitte von etwa einer Netzweite sammeln
            let bins = ((g.length / g.h.max(1e-9)).round() as usize).clamp(1, 200);
            let bw = g.length / bins as f64;
            let mut acc = vec![Vector3::zeros(); bins];
            for (n, f) in &forces {
                let s = (v3(mesh.nodes[*n]) - g.origin).dot(&g.axis) + 0.5 * g.length;
                let b = ((s / bw).floor().max(0.0) as usize).min(bins - 1);
                acc[b] += f;
            }
            let profile: Vec<[f64; 2]> = acc.iter().enumerate().map(|(i, f)| [(i as f64 + 0.5) * bw, f.norm() / bw]).collect();
            let (imax, lmax) = profile.iter().enumerate().fold((0, 0.0f64), |(bi, bv), (i, p)| if p[1] > bv { (i, p[1]) } else { (bi, bv) });
            let max_at = g.origin + g.axis * (profile.get(imax).map(|p| p[0]).unwrap_or(0.0) - 0.5 * g.length);
            let throat = w.throat.filter(|a| *a > 0.0).unwrap_or(g.width);
            let lmean = total.norm() / g.length;
            WeldResult {
                name: w.name.clone(),
                nodes: g.matched.len(),
                unmatched: g.unmatched,
                gap_min: g.gap_min,
                gap_max: g.gap_max,
                length: g.length,
                width: g.width,
                throat,
                force: total.into(),
                force_normal: fn_,
                force_shear: ft,
                line_force_mean: lmean,
                line_force_max: lmax,
                stress_mean: lmean / throat,
                stress_max: lmax / throat,
                max_at: max_at.into(),
                profile,
                start: (g.origin - g.axis * (0.5 * g.length)).into(),
                end: (g.origin + g.axis * (0.5 * g.length)).into(),
            }
        })
        .collect()
}

/// Spalt zwischen zwei ebenen Flächen, der vermutlich eine Schweißnaht werden soll
#[derive(Debug, Clone, Serialize)]
pub struct GapCandidate {
    /// kleinere Fläche (wird angekoppelt) und Gegenfläche
    pub a: i32,
    pub b: i32,
    /// Spaltweite [mm]
    pub gap: f64,
    /// überdeckte Fläche [mm²]
    pub area: f64,
    pub center: [f64; 3],
}

struct Planar {
    tag: i32,
    normal: Vector3<f64>,
    center: Vector3<f64>,
    area: f64,
    tris: Vec<[Vector3<f64>; 3]>,
    lo: Vector3<f64>,
    hi: Vector3<f64>,
}

/// Ebene, einander zugewandte Flächen mit Spalt ≤ `max_gap` suchen (z. B. geschlossene Blechecken)
pub fn find_gaps(mesh: &Mesh, faces: &[Face], max_gap: f64) -> Vec<GapCandidate> {
    let mut by_tag: std::collections::BTreeMap<i32, Vec<&Face>> = Default::default();
    for f in faces {
        if let Some(t) = f.tag {
            by_tag.entry(t).or_default().push(f);
        }
    }
    let planar: Vec<Planar> = by_tag
        .into_iter()
        .filter_map(|(tag, fs)| {
            let ans: Vec<Vector3<f64>> = fs.iter().map(|f| area_normal(mesh, f)).collect();
            let sum: Vector3<f64> = ans.iter().sum();
            let area: f64 = ans.iter().map(|a| a.norm()).sum();
            if sum.norm() < 0.999 * area || area <= 0.0 {
                return None; // gekrümmt
            }
            let normal = sum.normalize();
            let tris: Vec<[Vector3<f64>; 3]> = fs.iter().map(|f| corners(mesh, f)).collect();
            let center = tris.iter().zip(&ans).map(|(t, a)| (t[0] + t[1] + t[2]) / 3.0 * a.norm()).sum::<Vector3<f64>>() / area;
            let mut lo = Vector3::repeat(f64::INFINITY);
            let mut hi = Vector3::repeat(f64::NEG_INFINITY);
            for t in &tris {
                for p in t {
                    lo = lo.inf(p);
                    hi = hi.sup(p);
                }
            }
            Some(Planar { tag, normal, center, area, tris, lo, hi })
        })
        .collect();
    let mut out = Vec::new();
    for (i, s) in planar.iter().enumerate() {
        for t in planar.iter().skip(i + 1) {
            if s.normal.dot(&t.normal) > -0.995 {
                continue;
            }
            // kleinere Fläche wird angekoppelt
            let (a, b) = if s.area <= t.area { (s, t) } else { (t, s) };
            // B liegt vor A (außerhalb des Werkstoffs), in Abstand ≤ max_gap
            let d = (b.center - a.center).dot(&a.normal);
            if !(d > 1e-4 && d <= max_gap) {
                continue;
            }
            if (0..3).any(|k| a.lo[k] - max_gap > b.hi[k] || b.lo[k] - max_gap > a.hi[k]) {
                continue;
            }
            // Überdeckung: Dreiecke von A, deren Schwerpunkt über B liegt
            let mut covered = 0.0;
            let mut cen = Vector3::zeros();
            for ta in &a.tris {
                let m = (ta[0] + ta[1] + ta[2]) / 3.0;
                let hit = b.tris.iter().any(|tb| {
                    let l = closest_on_triangle(m, tb[0], tb[1], tb[2]);
                    let q = tb[0] * l[0] + tb[1] * l[1] + tb[2] * l[2];
                    (m - q).norm() <= d * 1.05 + 1e-6
                });
                if hit {
                    let ar = (ta[1] - ta[0]).cross(&(ta[2] - ta[0])).norm() * 0.5;
                    covered += ar;
                    cen += m * ar;
                }
            }
            if covered >= 0.3 * a.area {
                out.push(GapCandidate { a: a.tag, b: b.tag, gap: d, area: covered, center: (cen / covered).into() });
            }
        }
    }
    out.sort_by(|x, y| x.gap.total_cmp(&y.gap));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::box_mesh;
    use crate::model::{Axis, Fix, Load, Selection};
    use crate::{Material, Order};

    /// zwei Quader 10×10×10 mit 0,2 mm Spalt bei x = 10, als ein Netz
    fn two_blocks(gap: f64) -> Mesh {
        let a = box_mesh([10.0, 10.0, 10.0], [3, 3, 3], Order::Quadratic).unwrap();
        let mut b = box_mesh([10.0, 10.0, 10.0], [4, 4, 4], Order::Quadratic).unwrap();
        for p in &mut b.nodes {
            p[0] += 10.0 + gap;
        }
        let off = a.nodes.len();
        let mut m = a;
        m.nodes.extend(b.nodes);
        m.conn.extend(b.conn.iter().map(|n| n + off));
        m
    }

    fn model(weld: bool) -> Model {
        let mut m = Model::new(two_blocks(0.2), Material::steel())
            .group("fest", Selection::Plane { axis: Axis::X, value: 0.0 })
            .group("zug", Selection::Plane { axis: Axis::X, value: 20.2 })
            .group("A", Selection::Plane { axis: Axis::X, value: 10.0 })
            .group("B", Selection::Plane { axis: Axis::X, value: 10.2 })
            .support("fest", Fix::all())
            .load(Load::Force { group: "zug".into(), force: [1000.0, 300.0, 0.0] });
        if weld {
            m.welds.push(Weld { name: "Naht".into(), a: "A".into(), b: "B".into(), max_gap: None, throat: Some(3.0) });
        }
        m
    }

    #[test]
    fn ohne_naht_ist_der_zweite_klotz_lose() {
        assert!(matches!(crate::solve(&model(false)), Err(FemError::Underconstrained)));
    }

    #[test]
    fn naht_uebertraegt_die_ganze_kraft() {
        for solver in [crate::SolverKind::Direct, crate::SolverKind::Iterative] {
            let m = model(true).solver(solver);
            let r = crate::solve(&m).unwrap();
            let w = &r.welds[0];
            // Gleichgewicht: die Naht trägt die ganze Last (Vorzeichen: Kraft auf Fläche A)
            assert!((w.force[0] - 1000.0).abs() < 1.0 && (w.force[1] - 300.0).abs() < 1.0, "{solver:?}: {:?}", w.force);
            assert!((w.force_normal - 1000.0).abs() < 1.0 && (w.force_shear - 300.0).abs() < 1.0);
            assert!((w.length - 10.0).abs() < 1e-6 && (w.width - 10.0).abs() < 1e-6, "{} {}", w.length, w.width);
            assert!((w.gap_min - 0.2).abs() < 1e-9 && w.unmatched == 0);
            let fl = (1000.0f64.powi(2) + 300.0f64.powi(2)).sqrt() / 10.0;
            assert!((w.line_force_mean - fl).abs() < 0.1 && (w.stress_mean - fl / 3.0).abs() < 0.05);
            assert!(w.line_force_max >= w.line_force_mean * 0.99);
            // Längsdehnung wie ein durchgehender Stab von 20 mm (Spalt starr): u = F·L/(E·A)
            let ux = r.displacement.iter().zip(&m.mesh.nodes).filter(|(_, p)| (p[0] - 20.2).abs() < 1e-9).map(|(u, _)| u[0]).sum::<f64>()
                / m.mesh.nodes.iter().filter(|p| (p[0] - 20.2).abs() < 1e-9).count() as f64;
            let expect = 1000.0 * 20.0 / (210_000.0 * 100.0);
            assert!((ux - expect).abs() / expect < 0.05, "{solver:?}: u = {ux}, erwartet ≈ {expect}");
            assert!((r.total_reaction[0] + 1000.0).abs() < 1.0);
        }
    }

    #[test]
    fn spalt_wird_gefunden() {
        let mut mesh = two_blocks(0.3);
        // Flächennummern: x = 10 → 1, x = 10,3 → 2, Rest 3
        let faces = mesh.boundary_faces();
        for f in &faces {
            let xs: Vec<f64> = f.nodes[..3].iter().map(|&n| mesh.nodes[n][0]).collect();
            let tag = if xs.iter().all(|x| (x - 10.0).abs() < 1e-9) {
                1
            } else if xs.iter().all(|x| (x - 10.3).abs() < 1e-9) {
                2
            } else {
                3 + f.elem as i32 // jede übrige Fläche eigen (keine falschen Paare)
            };
            let mut key = [f.nodes[0], f.nodes[1], f.nodes[2]];
            key.sort_unstable();
            mesh.surface_tags.insert(key, tag);
        }
        let faces = mesh.boundary_faces();
        let g = find_gaps(&mesh, &faces, 1.0);
        assert_eq!(g.len(), 1, "{g:?}");
        // beide Flächen gleich groß → welche angekoppelt wird, ist gleichgültig
        assert!(matches!((g[0].a, g[0].b), (1, 2) | (2, 1)), "{g:?}");
        assert!((g[0].gap - 0.3).abs() < 1e-9 && (g[0].area - 100.0).abs() < 1e-6);
        assert!(find_gaps(&mesh, &faces, 0.2).is_empty());
    }
}
