//! Tetraeder-Elemente (TET4 linear, TET10 quadratisch) und Dreiecks-Randflächen.
//!
//! Knotenreihenfolge wie Gmsh: Ecken 0–3, Seitenmitten auf den Kanten
//! (0,1) (1,2) (2,0) (0,3) (2,3) (1,3).

use nalgebra::{DMatrix, Matrix3, Vector3};

use crate::material::DMat;

/// Kanten des Tetraeders, Index = Seitenmittenknoten − 4.
pub const TET_EDGES: [(usize, usize); 6] = [(0, 1), (1, 2), (2, 0), (0, 3), (2, 3), (1, 3)];

/// Flächen (Eckknoten) mit nach außen zeigender Normale bei positivem Volumen.
pub const TET_FACES: [[usize; 3]; 4] = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];

/// Lokale Ecken einer Fläche → lokaler Index der Seitenmitte der Tetraeder-Kante.
pub fn edge_index(a: usize, b: usize) -> usize {
    for (k, &(i, j)) in TET_EDGES.iter().enumerate() {
        if (i == a && j == b) || (i == b && j == a) {
            return 4 + k;
        }
    }
    unreachable!("keine Tetraederkante: {a}-{b}")
}

/// Natürliche Koordinaten (ξ, η, ζ) der Elementknoten.
pub fn tet_node_coords(npe: usize) -> Vec<[f64; 3]> {
    let corners = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut v = corners.to_vec();
    if npe == 10 {
        for &(a, b) in &TET_EDGES {
            let (p, q) = (corners[a], corners[b]);
            v.push([(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, (p[2] + q[2]) / 2.0]);
        }
    }
    v
}

/// Gauß-Integrationspunkte im Einheitstetraeder: (ξ, η, ζ, Gewicht).
pub fn tet_gauss(npe: usize) -> Vec<[f64; 4]> {
    if npe == 4 {
        vec![[0.25, 0.25, 0.25, 1.0 / 6.0]]
    } else {
        let a = 0.585_410_196_624_968_5;
        let b = 0.138_196_601_125_010_5;
        let w = 1.0 / 24.0;
        vec![[b, b, b, w], [a, b, b, w], [b, a, b, w], [b, b, a, w]]
    }
}

/// Ableitungen der Formfunktionen nach (ξ, η, ζ): Zeile k = d/dξ_k, Spalte = Knoten.
pub fn tet_dshape(npe: usize, xi: [f64; 3]) -> DMatrix<f64> {
    let l = [1.0 - xi[0] - xi[1] - xi[2], xi[0], xi[1], xi[2]];
    // dL_j/dξ_k
    let dl = [[-1.0, -1.0, -1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut d = DMatrix::zeros(3, npe);
    for k in 0..3 {
        if npe == 4 {
            for i in 0..4 {
                d[(k, i)] = dl[i][k];
            }
        } else {
            for i in 0..4 {
                d[(k, i)] = (4.0 * l[i] - 1.0) * dl[i][k];
            }
            for (e, &(a, b)) in TET_EDGES.iter().enumerate() {
                d[(k, 4 + e)] = 4.0 * (l[a] * dl[b][k] + l[b] * dl[a][k]);
            }
        }
    }
    d
}

/// Ableitungen der Formfunktionen nach (x, y, z) und det J.
pub fn tet_dshape_global(coords: &[[f64; 3]], xi: [f64; 3]) -> (DMatrix<f64>, f64) {
    let npe = coords.len();
    let dn = tet_dshape(npe, xi);
    let mut j = Matrix3::zeros();
    for i in 0..npe {
        for k in 0..3 {
            for m in 0..3 {
                j[(k, m)] += dn[(k, i)] * coords[i][m];
            }
        }
    }
    let det = j.determinant();
    let jinv = j.try_inverse().unwrap_or_else(Matrix3::zeros);
    (DMatrix::from_column_slice(3, 3, jinv.as_slice()) * dn, det)
}

/// B-Matrix (6 × 3n), Voigt-Reihenfolge xx, yy, zz, xy, yz, zx.
pub fn b_matrix(dndx: &DMatrix<f64>) -> DMatrix<f64> {
    let n = dndx.ncols();
    let mut b = DMatrix::zeros(6, 3 * n);
    for i in 0..n {
        let (a, bb, c) = (dndx[(0, i)], dndx[(1, i)], dndx[(2, i)]);
        let col = 3 * i;
        b[(0, col)] = a;
        b[(1, col + 1)] = bb;
        b[(2, col + 2)] = c;
        b[(3, col)] = bb;
        b[(3, col + 1)] = a;
        b[(4, col + 1)] = c;
        b[(4, col + 2)] = bb;
        b[(5, col)] = c;
        b[(5, col + 2)] = a;
    }
    b
}

/// Element-Steifigkeitsmatrix. Gibt `None` zurück, wenn das Element entartet ist.
pub fn tet_stiffness(coords: &[[f64; 3]], d: &DMat) -> Option<DMatrix<f64>> {
    let npe = coords.len();
    let d = DMatrix::from_column_slice(6, 6, d.as_slice());
    let mut ke = DMatrix::zeros(3 * npe, 3 * npe);
    for g in tet_gauss(npe) {
        let (dndx, det) = tet_dshape_global(coords, [g[0], g[1], g[2]]);
        if det <= 1e-300 {
            return None;
        }
        let b = b_matrix(&dndx);
        ke += b.transpose() * &d * &b * (det * g[3]);
    }
    Some(ke)
}

/// Spannungen (Voigt) an den Elementknoten aus den Knotenverschiebungen.
pub fn tet_nodal_stress(coords: &[[f64; 3]], u: &[f64], d: &DMat) -> Vec<[f64; 6]> {
    let ue = nalgebra::DVector::from_column_slice(u);
    tet_node_coords(coords.len())
        .into_iter()
        .map(|xi| {
            let (dndx, _) = tet_dshape_global(coords, xi);
            let s = d * nalgebra::SVector::<f64, 6>::from_iterator((b_matrix(&dndx) * &ue).iter().copied());
            [s[0], s[1], s[2], s[3], s[4], s[5]]
        })
        .collect()
}

/// Formfunktionen an (ξ, η, ζ)
pub fn tet_shape(npe: usize, xi: [f64; 3]) -> Vec<f64> {
    let l = [1.0 - xi[0] - xi[1] - xi[2], xi[0], xi[1], xi[2]];
    if npe == 4 {
        return l.to_vec();
    }
    let mut n: Vec<f64> = l.iter().map(|&li| li * (2.0 * li - 1.0)).collect();
    for &(a, b) in &TET_EDGES {
        n.push(4.0 * l[a] * l[b]);
    }
    n
}

/// Genauere Integrationsregel im Einheitstetraeder (kollabierter 4×4×4-Gauß, exakt bis Grad 7):
/// ξ = u, η = v·(1 − u), ζ = w·(1 − u)·(1 − v). Rückgabe (ξ, η, ζ, Gewicht), Summe der Gewichte = 1/6.
pub fn tet_gauss_high() -> Vec<[f64; 4]> {
    let x = [0.861_136_311_594_052_6, 0.339_981_043_584_856_3];
    let w = [0.347_854_845_137_453_9, 0.652_145_154_862_546_1];
    let mut pts1: Vec<(f64, f64)> = Vec::new();
    for k in 0..2 {
        for s in [-1.0f64, 1.0] {
            pts1.push(((1.0 + s * x[k]) / 2.0, w[k] / 2.0));
        }
    }
    let mut out = Vec::with_capacity(64);
    for &(u, wu) in &pts1 {
        for &(v, wv) in &pts1 {
            for &(t, wt) in &pts1 {
                let xi = [u, v * (1.0 - u), t * (1.0 - u) * (1.0 - v)];
                out.push([xi[0], xi[1], xi[2], wu * wv * wt * (1.0 - u).powi(2) * (1.0 - v)]);
            }
        }
    }
    out
}

/// Konsistente Massenmatrix (3n × 3n), Dichte `rho` in Masse/Volumen der Modelleinheiten (mm, N → t/mm³)
pub fn tet_mass(coords: &[[f64; 3]], rho: f64) -> DMatrix<f64> {
    let npe = coords.len();
    let mut m = DMatrix::zeros(3 * npe, 3 * npe);
    for g in tet_gauss_high() {
        let xi = [g[0], g[1], g[2]];
        let n = tet_shape(npe, xi);
        let (_, det) = tet_dshape_global(coords, xi);
        let f = rho * det * g[3];
        for a in 0..npe {
            for b in 0..npe {
                let v = f * n[a] * n[b];
                for k in 0..3 {
                    m[(3 * a + k, 3 * b + k)] += v;
                }
            }
        }
    }
    m
}

/// Geometrische Steifigkeit (Spannungsversteifung) aus den Knotenverschiebungen eines Grundzustands:
/// K_G[3a+i, 3b+i] = ∫ ∇N_aᵀ·S·∇N_b dV, S = Spannungstensor an den Gauß-Punkten
pub fn tet_geometric_stiffness(coords: &[[f64; 3]], u: &[f64], d: &DMat) -> DMatrix<f64> {
    let npe = coords.len();
    let ue = nalgebra::DVector::from_column_slice(u);
    let mut kg = DMatrix::zeros(3 * npe, 3 * npe);
    for g in tet_gauss(npe) {
        let (dndx, det) = tet_dshape_global(coords, [g[0], g[1], g[2]]);
        let sv = d * nalgebra::SVector::<f64, 6>::from_iterator((b_matrix(&dndx) * &ue).iter().copied());
        let sm = Matrix3::new(sv[0], sv[3], sv[5], sv[3], sv[1], sv[4], sv[5], sv[4], sv[2]);
        let f = det * g[3];
        for a in 0..npe {
            let ga = Vector3::new(dndx[(0, a)], dndx[(1, a)], dndx[(2, a)]);
            let sa = sm * ga;
            for b in 0..npe {
                let v = f * sa.dot(&Vector3::new(dndx[(0, b)], dndx[(1, b)], dndx[(2, b)]));
                for k in 0..3 {
                    kg[(3 * a + k, 3 * b + k)] += v;
                }
            }
        }
    }
    kg
}

pub fn tet_volume(coords: &[[f64; 3]]) -> f64 {
    let p = |i: usize| Vector3::from(coords[i]);
    (p(1) - p(0)).cross(&(p(2) - p(0))).dot(&(p(3) - p(0))) / 6.0
}

// --- Randflächen (TRI3 / TRI6) ---------------------------------------------

/// Gauß-Punkte im Einheitsdreieck (ξ, η, Gewicht), exakt bis Grad 2.
const TRI_GAUSS: [[f64; 3]; 3] = [
    [1.0 / 6.0, 1.0 / 6.0, 1.0 / 6.0],
    [2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0],
    [1.0 / 6.0, 2.0 / 3.0, 1.0 / 6.0],
];

fn tri_shape(n: usize, xi: f64, eta: f64) -> (Vec<f64>, Vec<[f64; 2]>) {
    let l = [1.0 - xi - eta, xi, eta];
    let dl = [[-1.0, -1.0], [1.0, 0.0], [0.0, 1.0]];
    if n == 3 {
        (l.to_vec(), dl.to_vec())
    } else {
        // Seitenmitten auf (0,1) (1,2) (2,0)
        let edges = [(0, 1), (1, 2), (2, 0)];
        let mut nn = Vec::with_capacity(6);
        let mut dn = Vec::with_capacity(6);
        for i in 0..3 {
            nn.push(l[i] * (2.0 * l[i] - 1.0));
            dn.push([(4.0 * l[i] - 1.0) * dl[i][0], (4.0 * l[i] - 1.0) * dl[i][1]]);
        }
        for &(a, b) in &edges {
            nn.push(4.0 * l[a] * l[b]);
            dn.push([
                4.0 * (l[a] * dl[b][0] + l[b] * dl[a][0]),
                4.0 * (l[a] * dl[b][1] + l[b] * dl[a][1]),
            ]);
        }
        (nn, dn)
    }
}

/// Integrationspunkte einer Randfläche: (Formfunktionen, Flächennormale · dA).
/// Die Normale zeigt nach außen, ihre Länge ist das Flächenelement.
pub fn tri_integration(coords: &[[f64; 3]]) -> Vec<(Vec<f64>, Vector3<f64>)> {
    TRI_GAUSS
        .iter()
        .map(|g| {
            let (nn, dn) = tri_shape(coords.len(), g[0], g[1]);
            let mut t1 = Vector3::zeros();
            let mut t2 = Vector3::zeros();
            for (i, c) in coords.iter().enumerate() {
                let p = Vector3::from(*c);
                t1 += p * dn[i][0];
                t2 += p * dn[i][1];
            }
            (nn, t1.cross(&t2) * g[2])
        })
        .collect()
}

/// Integrationspunkt einer Randfläche
pub struct SurfacePoint {
    /// Formfunktionen der Flächenknoten
    pub n: Vec<f64>,
    /// Außennormale · dA
    pub nda: Vector3<f64>,
    /// Lage des Punkts
    pub x: Vector3<f64>,
}

/// Wie `tri_integration`, aber jedes Dreieck in `sub × sub` Teildreiecke zerlegt
/// (feinere Abtastung, wenn nur ein Teil der Fläche belastet ist).
pub fn tri_integration_points(coords: &[[f64; 3]], sub: usize) -> Vec<SurfacePoint> {
    let sub = sub.max(1);
    let h = 1.0 / sub as f64;
    let mut cells = Vec::with_capacity(sub * sub);
    for i in 0..sub {
        for j in 0..sub - i {
            let (a, b) = (i as f64 * h, j as f64 * h);
            cells.push([[a, b], [a + h, b], [a, b + h]]);
            if i + j + 1 < sub {
                cells.push([[a + h, b], [a + h, b + h], [a, b + h]]);
            }
        }
    }
    let mut out = Vec::with_capacity(cells.len() * TRI_GAUSS.len());
    for c in cells {
        for g in TRI_GAUSS {
            let xi = c[0][0] + g[0] * (c[1][0] - c[0][0]) + g[1] * (c[2][0] - c[0][0]);
            let eta = c[0][1] + g[0] * (c[1][1] - c[0][1]) + g[1] * (c[2][1] - c[0][1]);
            let (nn, dn) = tri_shape(coords.len(), xi, eta);
            let (mut t1, mut t2, mut x) = (Vector3::zeros(), Vector3::zeros(), Vector3::zeros());
            for (i, p) in coords.iter().enumerate() {
                let p = Vector3::from(*p);
                t1 += p * dn[i][0];
                t2 += p * dn[i][1];
                x += p * nn[i];
            }
            out.push(SurfacePoint { n: nn, nda: t1.cross(&t2) * g[2] * h * h, x });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Material;

    fn ref_tet(npe: usize) -> Vec<[f64; 3]> {
        // leicht verzerrtes Element, damit nichts zufällig symmetrisch ist
        let mut c = tet_node_coords(npe);
        for p in c.iter_mut() {
            *p = [2.0 * p[0] + 0.3 * p[1], 1.5 * p[1] + 0.2 * p[2], 1.8 * p[2] + 0.1 * p[0]];
        }
        c
    }

    #[test]
    fn formfunktionen_summieren_zu_eins_ableitung_null() {
        for npe in [4, 10] {
            let d = tet_dshape(npe, [0.2, 0.3, 0.1]);
            for k in 0..3 {
                let s: f64 = (0..npe).map(|i| d[(k, i)]).sum();
                assert!(s.abs() < 1e-12);
            }
        }
    }

    #[test]
    fn steifigkeit_symmetrisch_und_starrkoerper_frei() {
        let d = Material::steel().d_matrix();
        for npe in [4, 10] {
            let c = ref_tet(npe);
            let k = tet_stiffness(&c, &d).unwrap();
            assert!((&k - k.transpose()).abs().max() < 1e-6 * k.abs().max());
            // Starrkörperbewegungen: 3 Translationen + 3 Rotationen → keine Kräfte
            for mode in 0..6 {
                let mut u = nalgebra::DVector::zeros(3 * npe);
                for (i, p) in c.iter().enumerate() {
                    let v = match mode {
                        0..=2 => {
                            let mut t = [0.0; 3];
                            t[mode] = 1.0;
                            t
                        }
                        3 => [0.0, -p[2], p[1]],
                        4 => [p[2], 0.0, -p[0]],
                        _ => [-p[1], p[0], 0.0],
                    };
                    for m in 0..3 {
                        u[3 * i + m] = v[m];
                    }
                }
                let f = &k * u;
                assert!(f.abs().max() < 1e-8 * k.abs().max(), "npe={npe} mode={mode}");
            }
        }
    }

    #[test]
    fn unterteilte_integration_gleiche_flaeche() {
        // gekrümmtes TRI6
        let c = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [1.0, -0.2, 0.3], [1.1, 1.6, 0.1], [0.0, 1.5, 0.2]];
        let a1: Vector3<f64> = tri_integration(&c).iter().map(|(_, n)| n).sum();
        for sub in [1, 3, 6] {
            let pts = tri_integration_points(&c, sub);
            let a2: Vector3<f64> = pts.iter().map(|p| p.nda).sum();
            assert!((a1 - a2).norm() < 1e-12, "sub {sub}");
            // Formfunktionen summieren sich zu 1
            assert!(pts.iter().all(|p| (p.n.iter().sum::<f64>() - 1.0).abs() < 1e-12));
        }
    }

    #[test]
    fn masse_und_hohe_integration() {
        let w: f64 = tet_gauss_high().iter().map(|g| g[3]).sum();
        assert!((w - 1.0 / 6.0).abs() < 1e-14);
        // ∫ ξ²·η² über das Einheitstetraeder = 2!·2!·0!/(4+3)! ·… = 4/5040
        let i: f64 = tet_gauss_high().iter().map(|g| g[0] * g[0] * g[1] * g[1] * g[3]).sum();
        assert!((i - 4.0 / 5040.0).abs() < 1e-15, "{i}");
        for npe in [4, 10] {
            let c = ref_tet(npe);
            let v = tet_volume(&c[..4]);
            let m = tet_mass(&c, 2.0);
            // Summe je Richtung = Gesamtmasse, symmetrisch
            let total: f64 = (0..npe).flat_map(|a| (0..npe).map(move |b| (a, b))).map(|(a, b)| m[(3 * a, 3 * b)]).sum();
            assert!((total - 2.0 * v).abs() < 1e-12 * v, "{npe}: {total} vs {}", 2.0 * v);
            assert!((m.clone() - m.transpose()).abs().max() < 1e-14);
        }
    }

    #[test]
    fn flaeche_des_dreiecks() {
        let c = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]];
        let a: f64 = tri_integration(&c).iter().map(|(_, n)| n.z).sum();
        assert!((a - 3.0).abs() < 1e-12);
    }
}
