//! Iterativer Löser: vorkonditionierte konjugierte Gradienten (PCG) mit Mehrgitter-Vorkonditionierer.
//!
//! Die Steifigkeitsmatrix wird knotenweise in 3×3-Blöcken gespeichert (beide Hälften), ohne Zerlegung.
//! Speicherbedarf deutlich unter dem des direkten Lösers, siehe `Amg::stats`.

use std::sync::atomic::{AtomicU64, Ordering};

use nalgebra::DMatrix;
use rayon::prelude::*;

use crate::amg::Amg;
use crate::solver::NodeFrames;
use crate::sparse::Bsr;
use crate::{FemError, Result};

/// Besetzungsstruktur aus der Element-Konnektivität (Knoten sind gekoppelt, wenn sie ein Element teilen).
fn pattern(n_nodes: usize, conn: &[usize], npe: usize, extra: &[(Vec<usize>, DMatrix<f64>)]) -> (Vec<usize>, Vec<u32>) {
    // Knoten → Zusatzelemente (Kopplungen von Schweißnähten)
    let mut extra_of: Vec<Vec<u32>> = vec![Vec::new(); if extra.is_empty() { 0 } else { n_nodes }];
    for (i, (nodes, _)) in extra.iter().enumerate() {
        for &n in nodes {
            extra_of[n].push(i as u32);
        }
    }
    // Knoten → Elemente
    let mut start = vec![0usize; n_nodes + 1];
    for &n in conn {
        start[n + 1] += 1;
    }
    for i in 0..n_nodes {
        start[i + 1] += start[i];
    }
    let mut fill = start.clone();
    let mut elems = vec![0u32; conn.len()];
    for (i, &n) in conn.iter().enumerate() {
        elems[fill[n]] = (i / npe) as u32;
        fill[n] += 1;
    }
    let rows: Vec<Vec<u32>> = (0..n_nodes)
        .into_par_iter()
        .map(|n| {
            let mut nb: Vec<u32> = elems[start[n]..start[n + 1]]
                .iter()
                .flat_map(|&e| conn[e as usize * npe..(e as usize + 1) * npe].iter().map(|&m| m as u32))
                .collect();
            if let Some(xs) = extra_of.get(n) {
                for &x in xs {
                    nb.extend(extra[x as usize].0.iter().map(|&m| m as u32));
                }
            }
            nb.push(n as u32); // auch unbenutzte Knoten bekommen einen Diagonalblock
            nb.sort_unstable();
            nb.dedup();
            nb
        })
        .collect();
    let mut row_ptr = Vec::with_capacity(n_nodes + 1);
    row_ptr.push(0);
    for r in &rows {
        row_ptr.push(row_ptr.last().unwrap() + r.len());
    }
    (row_ptr, rows.into_iter().flatten().collect())
}

/// Assembliertes Gleichungssystem mit eingearbeiteten Randbedingungen
/// (vorgegebene Freiheitsgrade: Zeile/Spalte = Einheitsvektor, rechte Seite = Vorgabewert).
pub struct System {
    pub k: Bsr,
    pub b: Vec<f64>,
}

/// Baut das System. `ke(e)` liefert die Elementsteifigkeit (Freiheitsgrade knotenweise x,y,z).
pub fn assemble(
    n_nodes: usize,
    conn: &[usize],
    npe: usize,
    prescribed: &[Option<f64>],
    f_ext: &[f64],
    ke: impl Fn(usize) -> Result<DMatrix<f64>> + Sync,
    extra: &[(Vec<usize>, DMatrix<f64>)],
) -> Result<System> {
    let (ptr, col) = pattern(n_nodes, conn, npe, extra);
    let mut k = Bsr { nrows: n_nodes, ncols: n_nodes, br: 3, bc: 3, ptr, col, val: Vec::new() };

    // Elemente parallel, Addition über atomare Operationen (keine Zwischenkopie der Elementmatrizen)
    let val: Vec<AtomicU64> = (0..9 * k.col.len()).map(|_| AtomicU64::new(0)).collect();
    let rhs: Vec<AtomicU64> = (0..3 * n_nodes).map(|_| AtomicU64::new(0)).collect();
    let add = |cell: &AtomicU64, v: f64| {
        let _ = cell.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| Some((f64::from_bits(old) + v).to_bits()));
    };
    let n_elem = conn.len() / npe;
    (0..n_elem + extra.len()).into_par_iter().try_for_each(|e| -> Result<()> {
        let (owned, nodes): (DMatrix<f64>, &[usize]) =
            if e < n_elem { (ke(e)?, &conn[e * npe..(e + 1) * npe]) } else { (extra[e - n_elem].1.clone(), &extra[e - n_elem].0) };
        let m = owned;
        for (a, &na) in nodes.iter().enumerate() {
            for (b, &nb) in nodes.iter().enumerate() {
                let p = k.find(na, nb).expect("Block in Besetzungsstruktur");
                for r in 0..3 {
                    let gr = 3 * na + r;
                    if prescribed[gr].is_some() {
                        continue;
                    }
                    for c in 0..3 {
                        let v = m[(3 * a + r, 3 * b + c)];
                        match prescribed[3 * nb + c] {
                            None => add(&val[9 * p + 3 * r + c], v),
                            Some(u) if u != 0.0 => add(&rhs[gr], -v * u),
                            Some(_) => {}
                        }
                    }
                }
            }
        }
        Ok(())
    })?;

    // In-place-Umwandlung (gleiche Größe → keine zweite Kopie im Speicher)
    k.val = val.into_iter().map(|a| f64::from_bits(a.into_inner())).collect();
    let mut b: Vec<f64> = rhs.into_iter().map(|a| f64::from_bits(a.into_inner())).collect();
    for (i, p) in prescribed.iter().enumerate() {
        match p {
            Some(u) => {
                let d = k.find(i / 3, i / 3).expect("Diagonalblock");
                let r = i % 3;
                k.val[9 * d + 3 * r + r] = 1.0;
                b[i] = *u;
            }
            None => b[i] += f_ext[i],
        }
    }
    Ok(System { k, b })
}

/// Ergebnis der Iteration
pub struct Solution {
    pub x: Vec<f64>,
    pub iterations: usize,
    /// erreichtes ‖r‖ / ‖b‖
    pub residual: f64,
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.par_iter().zip(b.par_iter()).map(|(x, y)| x * y).sum()
}

/// Löst K·x = b mit AMG-vorkonditioniertem CG bis ‖r‖/‖b‖ < `tol`.
pub fn solve(
    sys: System,
    coords: &[[f64; 3]],
    fixed: &[bool],
    frames: &NodeFrames,
    tol: f64,
    max_iter: usize,
    progress: &crate::Progress,
) -> Result<Solution> {
    let System { k, b } = sys;
    progress.report("Mehrgitter-Vorkonditionierer vorbereiten", None);
    let amg = Amg::new(k, coords, fixed, frames)?;
    solve_amg(&amg, b, None, tol, max_iter, progress)
}

/// Wie `solve` mit fertigem Vorkonditionierer (Matrix darin) und Startwert `x0` (z. B. die Lösung des vorigen
/// Kontakt-Durchgangs – dann reichen wenige Iterationen)
pub fn solve_amg(amg: &Amg, b: Vec<f64>, x0: Option<&[f64]>, tol: f64, max_iter: usize, progress: &crate::Progress) -> Result<Solution> {
    let k = amg.matrix();
    let n = b.len();

    let b_norm = dot(&b, &b).sqrt();
    let mut x = match x0 {
        Some(x0) if x0.len() == n => x0.to_vec(),
        _ => vec![0.0; n],
    };
    if b_norm == 0.0 {
        return Ok(Solution { x: vec![0.0; n], iterations: 0, residual: 0.0 });
    }
    let mut r = b;
    if x0.is_some() {
        let mut kx = vec![0.0; n];
        k.mul(&x, &mut kx);
        r.par_iter_mut().zip(kx.par_iter()).for_each(|(r, kx)| *r -= kx);
        if dot(&r, &r).sqrt() / b_norm < tol {
            return Ok(Solution { x, iterations: 0, residual: dot(&r, &r).sqrt() / b_norm });
        }
    }
    let mut z = vec![0.0; n];
    amg.apply(&r, &mut z);
    let mut p = z.clone();
    let mut q = vec![0.0; n];
    let mut rz = dot(&r, &z);

    for it in 1..=max_iter {
        k.mul(&p, &mut q);
        let pq = dot(&p, &q);
        if !(pq > 0.0) {
            // Matrix nicht positiv definit → Starrkörperbewegung möglich
            return Err(FemError::Underconstrained);
        }
        let alpha = rz / pq;
        x.par_iter_mut().zip(p.par_iter()).for_each(|(x, p)| *x += alpha * p);
        r.par_iter_mut().zip(q.par_iter()).for_each(|(r, q)| *r -= alpha * q);
        let res = dot(&r, &r).sqrt() / b_norm;
        if it % 5 == 0 {
            progress.check()?;
            // Fortschritt über das Residuum (logarithmisch bis zur Abbruchgenauigkeit)
            let frac = (res.max(1e-300).ln() / tol.ln()).clamp(0.0, 1.0);
            progress.report(&format!("Iteration {it}, Restfehler {res:.1e}"), Some(frac));
        }
        if res < tol {
            return Ok(Solution { x, iterations: it, residual: res });
        }
        amg.apply(&r, &mut z);
        let rz_new = dot(&r, &z);
        let beta = rz_new / rz;
        rz = rz_new;
        p.par_iter_mut().zip(z.par_iter()).for_each(|(p, z)| *p = z + beta * *p);
    }
    Err(FemError::NotConverged(max_iter))
}
