//! Eigenfrequenzen (K·φ = ω²·M·φ) und lineares Knicken (K·φ = −λ·K_G·φ).
//!
//! Beide über ein Lanczos-Verfahren mit Spektraltransformation: einmal K zerlegen (Cholesky), dann
//! wiederholt z = K⁻¹·B·q. Bei Eigenfrequenzen ist B die Massenmatrix (Skalarprodukt mit M), beim Knicken
//! die geometrische Steifigkeit aus der statischen Lösung (Skalarprodukt mit K). Volle Reorthogonalisierung.

use faer::linalg::solvers::Solve;
use faer::sparse::{SparseColMat, Triplet};
use faer::{Col, Side};
use nalgebra::{DMatrix, SymmetricEigen};
use rayon::prelude::*;
use serde::Serialize;

use crate::element::{tet_geometric_stiffness, tet_mass, tet_stiffness};
use crate::model::Model;
use crate::solver::{constraints, solve, Constraints};
use crate::{FemError, Result};

/// Größte Gleichungszahl für Eigenwertrechnungen (direkte Zerlegung)
pub const MAX_EQUATIONS: usize = 600_000;

#[derive(Debug, Clone, Serialize)]
pub struct Modes {
    /// Eigenfrequenzen [Hz] bzw. Knicklastfaktoren
    pub values: Vec<f64>,
    /// Form je Mode: Verschiebung je Knoten (global), auf größten Betrag 1 normiert
    pub shapes: Vec<Vec<[f64; 3]>>,
}

/// Dünnbesetzte Matrix (CSR, beide Hälften) für Matrix-Vektor-Produkte
struct Csr {
    ptr: Vec<usize>,
    col: Vec<u32>,
    val: Vec<f64>,
}

impl Csr {
    fn from_triplets(n: usize, mut t: Vec<(u32, u32, f64)>) -> Csr {
        t.par_sort_unstable_by_key(|x| (x.0, x.1));
        let mut ptr = vec![0usize; n + 1];
        let mut col = Vec::with_capacity(t.len() / 2);
        let mut val = Vec::with_capacity(t.len() / 2);
        let mut last: Option<(u32, u32)> = None;
        for (r, c, v) in t {
            if last == Some((r, c)) {
                *val.last_mut().unwrap() += v;
            } else {
                col.push(c);
                val.push(v);
                ptr[r as usize + 1] += 1;
                last = Some((r, c));
            }
        }
        for i in 0..n {
            ptr[i + 1] += ptr[i];
        }
        Csr { ptr, col, val }
    }

    fn mul(&self, x: &[f64]) -> Vec<f64> {
        (0..self.ptr.len() - 1)
            .into_par_iter()
            .map(|i| (self.ptr[i]..self.ptr[i + 1]).map(|p| self.val[p] * x[self.col[p] as usize]).sum())
            .collect()
    }
}

/// Reduziertes System: Gleichungsnummern, Cholesky von K, K und B als CSR
struct Reduced {
    eq: Vec<usize>,
    neq: usize,
    llt: faer::sparse::linalg::solvers::Llt<usize, f64>,
    k: Csr,
    b: Csr,
}

/// K und B (je Element `be`) auf den freien Freiheitsgraden aufbauen, K zerlegen
fn reduce(
    model: &Model,
    c: &Constraints,
    be: &(dyn Fn(usize, &[[f64; 3]]) -> DMatrix<f64> + Sync),
) -> Result<Reduced> {
    let mesh = &model.mesh;
    let ndof = 3 * mesh.nodes.len();
    if c.prescribed.iter().any(|p| matches!(p, Some(v) if *v != 0.0)) {
        return Err(FemError::Input("Vorgegebene Verschiebungen ≠ 0 gehen bei Eigenwertrechnungen nicht".into()));
    }
    let mut eq = vec![usize::MAX; ndof];
    let mut neq = 0;
    for i in 0..ndof {
        if c.prescribed[i].is_none() {
            eq[i] = neq;
            neq += 1;
        }
    }
    if neq == 0 {
        return Err(FemError::Input("alle Freiheitsgrade sind festgehalten".into()));
    }
    if neq > MAX_EQUATIONS {
        return Err(FemError::Input(format!(
            "{neq} Unbekannte sind für Eigenfrequenzen/Knicken zu viele (höchstens {MAX_EQUATIONS}) – gröberes Netz wählen"
        )));
    }
    let d = model.material.d_matrix();
    model.progress.report(&format!("Matrizen aufbauen ({neq} Unbekannte)"), None);
    let per: Vec<Result<(Vec<(u32, u32, f64)>, Vec<(u32, u32, f64)>)>> = (0..mesh.n_elems())
        .into_par_iter()
        .map(|e| {
            let coords = mesh.elem_coords(e);
            let mut ke = tet_stiffness(&coords, &d).ok_or(FemError::DegenerateElement(e))?;
            let mut bm = be(e, &coords);
            c.frames.transform_element(mesh.elem(e), &mut ke);
            c.frames.transform_element(mesh.elem(e), &mut bm);
            let dofs: Vec<usize> = mesh.elem(e).iter().flat_map(|&n| [3 * n, 3 * n + 1, 3 * n + 2]).collect();
            let (mut tk, mut tb) = (Vec::new(), Vec::new());
            for (a, &ga) in dofs.iter().enumerate() {
                let r = eq[ga];
                if r == usize::MAX {
                    continue;
                }
                for (b, &gb) in dofs.iter().enumerate() {
                    let cc = eq[gb];
                    if cc == usize::MAX {
                        continue;
                    }
                    tk.push((r as u32, cc as u32, ke[(a, b)]));
                    if bm[(a, b)] != 0.0 {
                        tb.push((r as u32, cc as u32, bm[(a, b)]));
                    }
                }
            }
            Ok((tk, tb))
        })
        .collect();
    let (mut tk, mut tb) = (Vec::new(), Vec::new());
    for r in per {
        let (a, b) = r?;
        tk.extend(a);
        tb.extend(b);
    }
    // Schweißnähte: Kopplungen nur in der Steifigkeit (keine Masse, keine geometrische Steifigkeit)
    if !model.welds.is_empty() {
        let p = crate::weld::prepare(model, &mesh.boundary_faces())?;
        for (nodes, ke) in crate::solver::tie_elements(Some(&p), &c.frames) {
            let dofs: Vec<usize> = nodes.iter().flat_map(|&n| [3 * n, 3 * n + 1, 3 * n + 2]).collect();
            for (a, &ga) in dofs.iter().enumerate() {
                let r = eq[ga];
                if r == usize::MAX {
                    continue;
                }
                for (b, &gb) in dofs.iter().enumerate() {
                    let cc = eq[gb];
                    if cc != usize::MAX && ke[(a, b)] != 0.0 {
                        tk.push((r as u32, cc as u32, ke[(a, b)]));
                    }
                }
            }
        }
    }
    let lower: Vec<Triplet<usize, usize, f64>> =
        tk.iter().filter(|t| t.0 >= t.1).map(|t| Triplet::new(t.0 as usize, t.1 as usize, t.2)).collect();
    let kmat = SparseColMat::<usize, f64>::try_new_from_triplets(neq, neq, &lower)
        .map_err(|e| FemError::Input(format!("Matrixaufbau fehlgeschlagen: {e:?}")))?;
    drop(lower);
    model.progress.report("Steifigkeitsmatrix zerlegen", None);
    let llt = kmat.sp_cholesky(Side::Lower).map_err(|_| FemError::Underconstrained)?;
    Ok(Reduced { eq, neq, llt, k: Csr::from_triplets(neq, tk), b: Csr::from_triplets(neq, tb) })
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.par_iter().zip(b.par_iter()).map(|(x, y)| x * y).sum()
}

/// Lanczos für A = K⁻¹·B, selbstadjungiert im Skalarprodukt mit W (W = M bzw. K).
/// Rückgabe: Ritz-Werte θ und Ritz-Vektoren (reduziert).
fn lanczos(r: &Reduced, w_is_b: bool, steps: usize, progress: &crate::Progress) -> Result<(Vec<f64>, Vec<Vec<f64>>)> {
    let n = r.neq;
    let w_mul = |x: &[f64]| if w_is_b { r.b.mul(x) } else { r.k.mul(x) };
    let apply = |x: &[f64]| -> Vec<f64> {
        let bx = r.b.mul(x);
        let sol = r.llt.solve(Col::<f64>::from_fn(n, |i| bx[i]));
        (0..n).map(|i| sol[i]).collect()
    };
    // Startvektor (deterministisch, „zufällig“)
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut q: Vec<f64> = (0..n)
        .map(|_| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5
        })
        .collect();
    let mut wq = w_mul(&q);
    let nrm = dot(&q, &wq).max(1e-300).sqrt();
    q.iter_mut().for_each(|v| *v /= nrm);
    wq.iter_mut().for_each(|v| *v /= nrm);
    let (mut qs, mut wqs): (Vec<Vec<f64>>, Vec<Vec<f64>>) = (vec![q], vec![wq]);
    let (mut alpha, mut beta) = (Vec::new(), Vec::new());
    let m = steps.min(n);
    for j in 0..m {
        progress.report(&format!("Lanczos-Schritt {} von {m}", j + 1), Some(j as f64 / m as f64));
        let mut z = apply(&qs[j]);
        let a = dot(&wqs[j], &z);
        alpha.push(a);
        // volle Reorthogonalisierung (zweimal)
        for _ in 0..2 {
            for (qi, wqi) in qs.iter().zip(&wqs) {
                let c = dot(wqi, &z);
                z.par_iter_mut().zip(qi.par_iter()).for_each(|(zz, qq)| *zz -= c * qq);
            }
        }
        let wz = w_mul(&z);
        let b = dot(&z, &wz).max(0.0).sqrt();
        if j + 1 == m || b < 1e-12 * a.abs().max(1e-300) {
            break;
        }
        beta.push(b);
        qs.push(z.iter().map(|v| v / b).collect());
        wqs.push(wz.iter().map(|v| v / b).collect());
    }
    let k = alpha.len();
    let mut t = DMatrix::<f64>::zeros(k, k);
    for i in 0..k {
        t[(i, i)] = alpha[i];
        if i + 1 < k {
            t[(i, i + 1)] = beta[i];
            t[(i + 1, i)] = beta[i];
        }
    }
    let eig = SymmetricEigen::new(t);
    let vecs: Vec<Vec<f64>> = (0..k)
        .map(|c| {
            let mut v = vec![0.0; n];
            for (i, qi) in qs.iter().enumerate().take(k) {
                let s = eig.eigenvectors[(i, c)];
                v.iter_mut().zip(qi).for_each(|(a, b)| *a += s * b);
            }
            v
        })
        .collect();
    Ok((eig.eigenvalues.iter().copied().collect(), vecs))
}

/// Reduzierten Vektor auf alle Knoten (global) bringen, auf größten Betrag 1 normieren
fn expand(model: &Model, c: &Constraints, r: &Reduced, x: &[f64]) -> Vec<[f64; 3]> {
    let n = model.mesh.nodes.len();
    let mut u = vec![0.0; 3 * n];
    for (i, &e) in r.eq.iter().enumerate() {
        if e != usize::MAX {
            u[i] = x[e];
        }
    }
    c.frames.to_global_pub(&mut u);
    let max = (0..n).map(|k| (u[3 * k].powi(2) + u[3 * k + 1].powi(2) + u[3 * k + 2].powi(2)).sqrt()).fold(0.0, f64::max).max(1e-300);
    (0..n).map(|k| [u[3 * k] / max, u[3 * k + 1] / max, u[3 * k + 2] / max]).collect()
}

/// Die `count` kleinsten Eigenfrequenzen [Hz]. `density`: Dichte in t/mm³ (g/cm³ · 1e-9) bei mm, N, MPa.
pub fn eigenfrequencies(model: &Model, density: f64, count: usize) -> Result<Modes> {
    if !(density > 0.0) {
        return Err(FemError::Input("Für Eigenfrequenzen wird die Dichte des Werkstoffs gebraucht".into()));
    }
    model.material.check()?;
    let faces = model.mesh.boundary_faces();
    let c = constraints(model, &faces)?;
    let r = reduce(model, &c, &|_, coords| tet_mass(coords, density))?;
    let steps = (3 * count).max(count + 30);
    let (theta, vecs) = lanczos(&r, true, steps, &model.progress)?;
    // größte θ = kleinste ω² (θ = 1/ω²)
    let mut idx: Vec<usize> = (0..theta.len()).filter(|&i| theta[i] > 0.0).collect();
    idx.sort_by(|&a, &b| theta[b].partial_cmp(&theta[a]).unwrap());
    idx.truncate(count);
    Ok(Modes {
        values: idx.iter().map(|&i| (1.0 / theta[i]).sqrt() / (2.0 * std::f64::consts::PI)).collect(),
        shapes: idx.iter().map(|&i| expand(model, &c, &r, &vecs[i])).collect(),
    })
}

/// Lineares Knicken: die `count` kleinsten positiven Lastfaktoren λ (Knicklast = λ · aufgebrachte Last)
pub fn buckling(model: &Model, count: usize) -> Result<Modes> {
    model.material.check()?;
    model.progress.report("Grundzustand (Statik) rechnen", None);
    let stat = solve(model)?;
    let u: Vec<f64> = stat.displacement.iter().flat_map(|v| *v).collect();
    let d = model.material.d_matrix();
    let mesh = &model.mesh;
    let faces = mesh.boundary_faces();
    let c = constraints(model, &faces)?;
    let r = reduce(model, &c, &|e, coords| {
        let ue: Vec<f64> = mesh.elem(e).iter().flat_map(|&n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect();
        tet_geometric_stiffness(coords, &ue, &d)
    })?;
    let steps = (3 * count).max(count + 30);
    let (theta, vecs) = lanczos(&r, false, steps, &model.progress)?;
    // θ = −1/λ: kleinste positive λ ↔ stärkste negative θ
    let mut idx: Vec<usize> = (0..theta.len()).filter(|&i| theta[i] < 0.0).collect();
    idx.sort_by(|&a, &b| theta[a].partial_cmp(&theta[b]).unwrap());
    idx.truncate(count);
    if idx.is_empty() {
        return Err(FemError::Input("Kein Knicken unter dieser Last – es entstehen keine Druckspannungen, die zum Ausknicken führen".into()));
    }
    Ok(Modes {
        values: idx.iter().map(|&i| -1.0 / theta[i]).collect(),
        shapes: idx.iter().map(|&i| expand(model, &c, &r, &vecs[i])).collect(),
    })
}
