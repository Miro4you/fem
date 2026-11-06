//! Algebraisches Mehrgitterverfahren (Smoothed Aggregation, nach Vaněk/Mandel/Brezina)
//! als Vorkonditionierer für den iterativen Löser.
//!
//! Benachbarte Knoten werden zu Aggregaten zusammengefasst; jedes Aggregat bekommt auf dem
//! gröberen Gitter die 6 Starrkörperbewegungen (3 Verschiebungen, 3 Drehungen) als Unbekannte.
//! Dadurch bleibt die Konvergenz auch bei feinen Netzen und schlanken Bauteilen gut.
//! Glätter: Tschebyschow-Polynom auf D⁻¹·A (D = Diagonalblöcke), grobstes Gitter: dichte Cholesky-Zerlegung.

use nalgebra::{Cholesky, DMatrix, Dyn};
use rayon::prelude::*;

use crate::solver::NodeFrames;
use crate::sparse::Bsr;
use crate::{FemError, Result};

/// Starrkörperbewegungen je Aggregat
const NS: usize = 6;
/// Ab dieser Größe wird das grobste Gitter direkt gelöst
const COARSE_MAX_DOF: usize = 3000;
const MAX_LEVELS: usize = 12;
const CHEB_DEGREE: usize = 3;

struct Level {
    a: Bsr,
    /// invertierte Diagonalblöcke
    dinv: Vec<f64>,
    /// Spektralradius von D⁻¹·A
    rho: f64,
    /// Prolongation und Restriktion (= Pᵀ) zum nächstgröberen Gitter
    p: Bsr,
    r: Bsr,
}

pub struct Amg {
    levels: Vec<Level>,
    coarse_a: Bsr,
    coarse: Cholesky<f64, Dyn>,
}

impl Amg {
    /// `a`: Steifigkeitsmatrix (3×3-Knotenblöcke), `coords`: Knotenkoordinaten,
    /// `fixed`: vorgegebene Freiheitsgrade (Zeile/Spalte = Einheitsvektor in `a`).
    /// `frames`: lokale Knotenbasen (dort sind auch die Starrkörpermoden lokal anzugeben).
    pub fn new(a: Bsr, coords: &[[f64; 3]], fixed: &[bool], frames: &NodeFrames) -> Result<Amg> {
        let mut b = rigid_body_modes(coords, fixed, frames);
        let mut a = a;
        let mut levels = Vec::new();
        while a.nrows * a.br > COARSE_MAX_DOF && levels.len() + 1 < MAX_LEVELS {
            let (agg, n_agg) = aggregate(&a);
            if n_agg == 0 || n_agg * NS * 10 > a.nrows * a.br * 8 {
                break; // Vergröberung bringt nichts mehr
            }
            let dinv = block_inverses(&a)?;
            let rho = spectral_radius(&a, &dinv);
            let (t, b_coarse) = tentative(&agg, n_agg, a.br, &b);
            let p = smooth_prolongator(&a, &dinv, rho, t);
            let r = p.transpose();
            let mut ac = r.matmul(&a.matmul(&p));
            fix_zero_diagonal(&mut ac);
            levels.push(Level { a, dinv, rho, p, r });
            a = ac;
            b = b_coarse;
        }
        let n = a.nrows * a.br;
        let mut dense = DMatrix::<f64>::zeros(n, n);
        for i in 0..a.nrows {
            for q in a.row(i) {
                let j = a.col[q] as usize;
                for r in 0..a.br {
                    for c in 0..a.bc {
                        dense[(i * a.br + r, j * a.bc + c)] = a.block(q)[r * a.bc + c];
                    }
                }
            }
        }
        let coarse = Cholesky::new(dense).ok_or(FemError::Underconstrained)?;
        Ok(Amg { levels, coarse_a: a, coarse })
    }

    /// Feinste Matrix
    pub fn matrix(&self) -> &Bsr {
        self.levels.first().map(|l| &l.a).unwrap_or(&self.coarse_a)
    }

    /// Anzahl Gitter und Speicherbedarf aller Matrizen in Byte (für Statusmeldungen)
    pub fn stats(&self) -> (usize, usize) {
        let bytes = self.levels.iter().map(|l| l.a.bytes() + l.p.bytes() + l.r.bytes()).sum::<usize>()
            + self.coarse_a.bytes();
        (self.levels.len() + 1, bytes)
    }

    /// z ≈ A⁻¹·r (ein V-Zyklus)
    pub fn apply(&self, r: &[f64], z: &mut [f64]) {
        self.vcycle(0, r, z);
    }

    fn vcycle(&self, l: usize, b: &[f64], x: &mut [f64]) {
        let Some(lev) = self.levels.get(l) else {
            let sol = self.coarse.solve(&DMatrix::from_column_slice(b.len(), 1, b));
            x.copy_from_slice(sol.as_slice());
            return;
        };
        x.fill(0.0);
        chebyshev(lev, b, x);
        let mut res = vec![0.0; b.len()];
        lev.a.mul(x, &mut res);
        res.par_iter_mut().zip(b.par_iter()).for_each(|(r, b)| *r = b - *r);
        let nc = lev.r.nrows * lev.r.br;
        let mut bc = vec![0.0; nc];
        lev.r.mul(&res, &mut bc);
        let mut xc = vec![0.0; nc];
        self.vcycle(l + 1, &bc, &mut xc);
        lev.p.mul(&xc, &mut res);
        x.par_iter_mut().zip(res.par_iter()).for_each(|(x, e)| *x += e);
        chebyshev(lev, b, x);
    }
}

/// Starrkörperbewegungen (Translationen, Drehungen um den Schwerpunkt), an festen Freiheitsgraden null.
fn rigid_body_modes(coords: &[[f64; 3]], fixed: &[bool], frames: &NodeFrames) -> Vec<f64> {
    let n = coords.len().max(1) as f64;
    let mut c = [0.0; 3];
    for p in coords {
        (0..3).for_each(|k| c[k] += p[k] / n);
    }
    let scale = coords
        .iter()
        .map(|p| (0..3).map(|k| (p[k] - c[k]).abs()).fold(0.0, f64::max))
        .fold(0.0, f64::max)
        .max(1e-300);
    let mut b = vec![0.0; coords.len() * 3 * NS];
    for (i, p) in coords.iter().enumerate() {
        let [x, y, z] = [0, 1, 2].map(|k| (p[k] - c[k]) / scale);
        let mut rows = [[1.0, 0.0, 0.0, -y, 0.0, z], [0.0, 1.0, 0.0, x, -z, 0.0], [0.0, 0.0, 1.0, 0.0, y, -x]];
        if let Some(r) = frames.get(i) {
            // Moden in die lokale Knotenbasis drehen
            let g = rows;
            for (d, row) in rows.iter_mut().enumerate() {
                for (m, v) in row.iter_mut().enumerate() {
                    *v = (0..3).map(|k| r[(d, k)] * g[k][m]).sum();
                }
            }
        }
        for (d, row) in rows.iter().enumerate() {
            if !fixed[3 * i + d] {
                b[(3 * i + d) * NS..(3 * i + d + 1) * NS].copy_from_slice(row);
            }
        }
    }
    b
}

fn frob(a: &[f64]) -> f64 {
    a.iter().map(|v| v * v).sum::<f64>().sqrt()
}

/// Standard-Aggregation auf dem Graphen der Nicht-Null-Blöcke. Knoten ohne Kopplung bleiben frei.
fn aggregate(a: &Bsr) -> (Vec<u32>, usize) {
    const NONE: u32 = u32::MAX;
    let n = a.nrows;
    let neighbors = |i: usize| {
        a.row(i).filter(move |&p| a.col[p] as usize != i && frob(a.block(p)) > 0.0).map(move |p| a.col[p] as usize)
    };
    let mut agg = vec![NONE; n];
    let mut n_agg = 0u32;
    // 1. Knoten, deren Nachbarschaft noch ganz frei ist, bilden mit ihr ein Aggregat
    for i in 0..n {
        if agg[i] == NONE && neighbors(i).next().is_some() && neighbors(i).all(|j| agg[j] == NONE) {
            agg[i] = n_agg;
            for j in neighbors(i) {
                agg[j] = n_agg;
            }
            n_agg += 1;
        }
    }
    // 2. Übrige Knoten schließen sich einem benachbarten Aggregat an
    let first = agg.clone();
    for i in 0..n {
        if agg[i] == NONE {
            if let Some(j) = neighbors(i).find(|&j| first[j] != NONE) {
                agg[i] = first[j];
            }
        }
    }
    // 3. Reste bilden neue Aggregate
    for i in 0..n {
        if agg[i] == NONE && neighbors(i).next().is_some() {
            agg[i] = n_agg;
            for j in neighbors(i) {
                if agg[j] == NONE {
                    agg[j] = n_agg;
                }
            }
            n_agg += 1;
        }
    }
    (agg, n_agg as usize)
}

/// Vorläufige Prolongation: je Aggregat orthonormalisierte Starrkörpermoden (QR),
/// R wird zu den Moden des groben Gitters.
fn tentative(agg: &[u32], n_agg: usize, br: usize, b: &[f64]) -> (Bsr, Vec<f64>) {
    let mut members = vec![Vec::new(); n_agg];
    for (i, &g) in agg.iter().enumerate() {
        if g != u32::MAX {
            members[g as usize].push(i);
        }
    }
    // je Aggregat: Q (Zeilen = Freiheitsgrade der Mitglieder) und R
    let qr: Vec<(Vec<f64>, [f64; NS * NS])> = members
        .par_iter()
        .map(|nodes| {
            let m = nodes.len() * br;
            let mut q = vec![0.0; m * NS];
            for (k, &i) in nodes.iter().enumerate() {
                q[k * br * NS..(k + 1) * br * NS].copy_from_slice(&b[i * br * NS..(i + 1) * br * NS]);
            }
            let mut r = [0.0; NS * NS];
            for j in 0..NS {
                let norm0 = (0..m).map(|s| q[s * NS + j].powi(2)).sum::<f64>().sqrt();
                for _ in 0..2 {
                    for i in 0..j {
                        let d: f64 = (0..m).map(|s| q[s * NS + i] * q[s * NS + j]).sum();
                        r[i * NS + j] += d;
                        (0..m).for_each(|s| q[s * NS + j] -= d * q[s * NS + i]);
                    }
                }
                let norm = (0..m).map(|s| q[s * NS + j].powi(2)).sum::<f64>().sqrt();
                if norm > 1e-10 * norm0 && norm > 0.0 {
                    r[j * NS + j] = norm;
                    (0..m).for_each(|s| q[s * NS + j] /= norm);
                } else {
                    (0..m).for_each(|s| q[s * NS + j] = 0.0);
                    (0..j).for_each(|i| r[i * NS + j] = 0.0);
                }
            }
            (q, r)
        })
        .collect();
    let mut pos = vec![0usize; agg.len()];
    for nodes in &members {
        for (k, &i) in nodes.iter().enumerate() {
            pos[i] = k;
        }
    }
    let rows = (0..agg.len())
        .map(|i| match agg[i] {
            u32::MAX => (vec![], vec![]),
            g => {
                let q = &qr[g as usize].0;
                (vec![g], q[pos[i] * br * NS..(pos[i] + 1) * br * NS].to_vec())
            }
        })
        .collect();
    let b_coarse = qr.iter().flat_map(|(_, r)| r.iter().copied()).collect();
    (Bsr::from_rows(n_agg, br, NS, rows), b_coarse)
}

/// P = (I − ω·D⁻¹·A)·T mit ω = 4/(3ρ)
fn smooth_prolongator(a: &Bsr, dinv: &[f64], rho: f64, t: Bsr) -> Bsr {
    let omega = 4.0 / (3.0 * rho);
    let mut p = a.matmul(&t);
    let (br, bc) = (p.br, p.bc);
    let bs = br * bc;
    let ptr = p.ptr.clone();
    let mut rows: Vec<&mut [f64]> = Vec::with_capacity(p.nrows);
    let mut rest = p.val.as_mut_slice();
    for i in 0..p.nrows {
        let (row, tail) = rest.split_at_mut((ptr[i + 1] - ptr[i]) * bs);
        rows.push(row);
        rest = tail;
    }
    rows.into_par_iter().enumerate().for_each(|(i, row)| {
        let d = &dinv[i * br * br..(i + 1) * br * br];
        let mut tmp = vec![0.0; br];
        for blk in row.chunks_mut(bs) {
            for c in 0..bc {
                for r in 0..br {
                    tmp[r] = (0..br).map(|k| d[r * br + k] * blk[k * bc + c]).sum();
                }
                for r in 0..br {
                    blk[r * bc + c] = -omega * tmp[r];
                }
            }
        }
    });
    for i in 0..t.nrows {
        for q in t.row(i) {
            let pp = p.find(i, t.col[q] as usize).expect("T-Block in A·T enthalten");
            for (v, tv) in p.val[pp * bs..(pp + 1) * bs].iter_mut().zip(t.block(q)) {
                *v += tv;
            }
        }
    }
    p
}

/// Grobe Freiheitsgrade ohne Steifigkeit (z. B. Aggregate aus lauter festen Knoten) → Diagonale 1
fn fix_zero_diagonal(a: &mut Bsr) {
    let br = a.br;
    let diag: Vec<usize> = (0..a.nrows).map(|i| a.find(i, i).expect("Diagonalblock")).collect();
    let max = diag.iter().flat_map(|&p| (0..br).map(move |k| (p, k))).map(|(p, k)| a.val[p * br * br + k * br + k]).fold(0.0, f64::max);
    for &p in &diag {
        for k in 0..br {
            let v = &mut a.val[p * br * br + k * br + k];
            if *v <= 1e-12 * max {
                *v = 1.0;
            }
        }
    }
}

fn block_inverses(a: &Bsr) -> Result<Vec<f64>> {
    let br = a.br;
    let blocks: Option<Vec<Vec<f64>>> = (0..a.nrows)
        .into_par_iter()
        .map(|i| {
            let p = a.find(i, i)?;
            let m = DMatrix::from_row_slice(br, br, a.block(p));
            let inv = m.try_inverse()?;
            Some(inv.transpose().as_slice().to_vec()) // zeilenweise
        })
        .collect();
    Ok(blocks.ok_or(FemError::Underconstrained)?.concat())
}

fn apply_dinv(dinv: &[f64], br: usize, r: &[f64], z: &mut [f64]) {
    z.par_chunks_mut(br).zip(r.par_chunks(br)).enumerate().for_each(|(i, (z, r))| {
        let d = &dinv[i * br * br..(i + 1) * br * br];
        for k in 0..br {
            z[k] = (0..br).map(|m| d[k * br + m] * r[m]).sum();
        }
    });
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.par_iter().zip(b.par_iter()).map(|(x, y)| x * y).sum()
}

/// Größter Eigenwert von D⁻¹·A (Potenzmethode)
fn spectral_radius(a: &Bsr, dinv: &[f64]) -> f64 {
    let n = a.nrows * a.br;
    let mut x: Vec<f64> = (0..n).map(|i| ((i as f64 * 0.618_034).fract() - 0.5) + 1e-3).collect();
    let mut y = vec![0.0; n];
    let mut z = vec![0.0; n];
    let mut rho = 1.0;
    for _ in 0..15 {
        let nx = dot(&x, &x).sqrt();
        a.mul(&x, &mut y);
        apply_dinv(dinv, a.br, &y, &mut z);
        rho = dot(&z, &z).sqrt() / nx;
        let nz = dot(&z, &z).sqrt();
        x.par_iter_mut().zip(z.par_iter()).for_each(|(x, z)| *x = z / nz);
    }
    rho
}

/// Tschebyschow-Glättung von A·x = b auf dem Intervall [ρ/30, 1,1·ρ] des Operators D⁻¹·A.
fn chebyshev(lev: &Level, b: &[f64], x: &mut [f64]) {
    let (hi, lo) = (1.1 * lev.rho, lev.rho / 30.0);
    let theta = 0.5 * (hi + lo);
    let delta = 0.5 * (hi - lo);
    let sigma = theta / delta;
    let n = b.len();
    let mut r = vec![0.0; n];
    lev.a.mul(x, &mut r);
    r.par_iter_mut().zip(b.par_iter()).for_each(|(r, b)| *r = b - *r);
    let mut z = vec![0.0; n];
    apply_dinv(&lev.dinv, lev.a.br, &r, &mut z);
    let mut d: Vec<f64> = z.par_iter().map(|z| z / theta).collect();
    let mut ad = vec![0.0; n];
    let mut rho_old = 1.0 / sigma;
    for k in 0..CHEB_DEGREE {
        x.par_iter_mut().zip(d.par_iter()).for_each(|(x, d)| *x += d);
        if k + 1 == CHEB_DEGREE {
            break;
        }
        lev.a.mul(&d, &mut ad);
        r.par_iter_mut().zip(ad.par_iter()).for_each(|(r, ad)| *r -= ad);
        apply_dinv(&lev.dinv, lev.a.br, &r, &mut z);
        let rho_new = 1.0 / (2.0 * sigma - rho_old);
        let (c1, c2) = (rho_new * rho_old, 2.0 * rho_new / delta);
        d.par_iter_mut().zip(z.par_iter()).for_each(|(d, z)| *d = c1 * *d + c2 * z);
        rho_old = rho_new;
    }
}
