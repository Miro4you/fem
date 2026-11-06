//! Leichtbau: Topologieoptimierung nach dem SIMP-Verfahren (Bendsøe/Sigmund).
//!
//! Gesucht ist die steifste Verteilung eines vorgegebenen Materialanteils. Jedes Element bekommt eine
//! Dichte x ∈ [0, 1], seine Steifigkeit ist (x_min + x^p·(1 − x_min))·K_e. Je Durchlauf: rechnen,
//! Empfindlichkeiten der Nachgiebigkeit bestimmen, über den Filterradius glätten (gegen Schachbrettmuster),
//! Dichten nach dem Optimalitätskriterium anpassen. Flächen mit Lagern und Lasten bleiben voll.

use std::collections::HashMap;

use nalgebra::{DVector, Vector3};
use rayon::prelude::*;
use serde::Serialize;

use crate::element::{tet_stiffness, tet_volume, TET_FACES};
use crate::mesh::Mesh;
use crate::model::Model;
use crate::solver::{solve_with, SolveOptions};
use crate::Result;

#[derive(Debug, Clone)]
pub struct TopoParams {
    /// Materialanteil, der übrig bleiben soll (z. B. 0,4)
    pub volume_fraction: f64,
    /// höchstens so viele Durchläufe
    pub iterations: usize,
    /// Filterradius [mm] (typisch 2–3 Elementgrößen)
    pub filter_radius: f64,
    /// SIMP-Exponent
    pub penal: f64,
    /// größte Dichteänderung je Durchlauf
    pub move_limit: f64,
}

impl Default for TopoParams {
    fn default() -> Self {
        TopoParams { volume_fraction: 0.4, iterations: 30, filter_radius: 0.0, penal: 3.0, move_limit: 0.2 }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TopoResult {
    /// Dichte je Element
    pub density: Vec<f64>,
    /// je Durchlauf: (Nachgiebigkeit in N·mm, Volumenanteil)
    pub history: Vec<(f64, f64)>,
    /// Elemente, die fest auf 1 bleiben (an Lagern/Lasten)
    pub passive: Vec<bool>,
}

const X_MIN: f64 = 1e-3;

/// Führt die Optimierung aus. Lager und Lasten kommen aus dem Modell.
pub fn optimize(model: &Model, p: &TopoParams) -> Result<TopoResult> {
    let mesh = &model.mesh;
    let ne = mesh.n_elems();
    let faces = mesh.boundary_faces();
    let d = model.material.d_matrix();

    // Elemente an Lager- und Lastflächen bleiben voll
    let mut keep_node = vec![false; mesh.nodes.len()];
    let groups = model.supports.iter().map(|s| s.group.as_str()).chain(model.loads.iter().map(|l| l.group()));
    for g in groups {
        for f in model.group_faces(g, &faces)? {
            for &n in &faces[f].nodes {
                keep_node[n] = true;
            }
        }
    }
    let passive: Vec<bool> = (0..ne).map(|e| mesh.elem(e).iter().any(|&n| keep_node[n])).collect();
    let vol: Vec<f64> = (0..ne).map(|e| tet_volume(&mesh.elem_coords(e)[..4]).abs()).collect();
    let vtot: f64 = vol.iter().sum();
    let centroid: Vec<Vector3<f64>> =
        (0..ne).map(|e| mesh.elem_coords(e)[..4].iter().map(|c| Vector3::from(*c)).sum::<Vector3<f64>>() / 4.0).collect();

    // Filter: Nachbarn im Radius r mit Gewicht r − Abstand
    let r = if p.filter_radius > 0.0 { p.filter_radius } else { 2.5 * (vtot / ne as f64).cbrt() };
    let key = |v: &Vector3<f64>| [(v.x / r).floor() as i64, (v.y / r).floor() as i64, (v.z / r).floor() as i64];
    let mut grid: HashMap<[i64; 3], Vec<u32>> = HashMap::new();
    for (e, c) in centroid.iter().enumerate() {
        grid.entry(key(c)).or_default().push(e as u32);
    }
    let neighbors: Vec<Vec<(u32, f32)>> = (0..ne)
        .into_par_iter()
        .map(|e| {
            let c = centroid[e];
            let k = key(&c);
            let mut out = Vec::new();
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if let Some(list) = grid.get(&[k[0] + dx, k[1] + dy, k[2] + dz]) {
                            for &f in list {
                                let w = r - (centroid[f as usize] - c).norm();
                                if w > 0.0 {
                                    out.push((f, w as f32));
                                }
                            }
                        }
                    }
                }
            }
            out
        })
        .collect();

    let budget = p.volume_fraction.clamp(0.05, 1.0) * vtot;
    let mut x: Vec<f64> = passive.iter().map(|&a| if a { 1.0 } else { p.volume_fraction }).collect();
    let mut history = Vec::new();
    let progress = &model.progress;

    for it in 0..p.iterations {
        let scale: Vec<f64> = x.iter().map(|&xe| X_MIN + xe.powf(p.penal) * (1.0 - X_MIN)).collect();
        progress.report(&format!("Leichtbau: Durchlauf {} von {} – rechnen", it + 1, p.iterations), Some(it as f64 / p.iterations as f64));
        let res = solve_with(model, &SolveOptions { element_scale: Some(&scale), tolerance: Some(1e-7) })?;
        let u = &res.displacement;
        // Elementnachgiebigkeit mit vollem Werkstoff: c_e = u_eᵀ·K_e·u_e
        let ce: Vec<f64> = (0..ne)
            .into_par_iter()
            .map(|e| {
                let coords = mesh.elem_coords(e);
                let ke = tet_stiffness(&coords, &d).expect("Element geprüft");
                let ue = DVector::from_iterator(3 * mesh.npe, mesh.elem(e).iter().flat_map(|&n| u[n]));
                ue.dot(&(&ke * &ue))
            })
            .collect();
        let compliance: f64 = ce.iter().zip(&scale).map(|(c, s)| c * s).sum();
        let used: f64 = x.iter().zip(&vol).map(|(a, v)| a * v).sum();
        history.push((compliance, used / vtot));
        // Empfindlichkeit dc/dx (≤ 0), gefiltert
        let dc: Vec<f64> = (0..ne).map(|e| -p.penal * x[e].powf(p.penal - 1.0) * (1.0 - X_MIN) * ce[e]).collect();
        let dcf: Vec<f64> = (0..ne)
            .into_par_iter()
            .map(|e| {
                let (mut num, mut den) = (0.0, 0.0);
                for &(f, w) in &neighbors[e] {
                    let f = f as usize;
                    num += w as f64 * x[f] * dc[f];
                    den += w as f64;
                }
                num / (x[e].max(1e-3) * den.max(1e-300))
            })
            .collect();
        // Optimalitätskriterium: Lagrange-Faktor per Bisektion so, dass das Volumen eingehalten wird
        let (mut l1, mut l2): (f64, f64) = (1e-12, 1e12);
        let mut xnew = x.clone();
        while (l2 - l1) / (l1 + l2) > 1e-6 {
            let lm = (l1 * l2).sqrt();
            let mut v = 0.0;
            for e in 0..ne {
                xnew[e] = if passive[e] {
                    1.0
                } else {
                    let be = (-dcf[e] / (lm * vol[e])).max(0.0).sqrt();
                    (x[e] * be).clamp((x[e] - p.move_limit).max(0.0), (x[e] + p.move_limit).min(1.0))
                };
                v += xnew[e] * vol[e];
            }
            if v > budget {
                l1 = lm;
            } else {
                l2 = lm;
            }
        }
        let change = x.iter().zip(&xnew).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        x = xnew;
        if it >= 5 && change < 0.01 {
            break;
        }
    }
    progress.report("Leichtbau: fertig", Some(1.0));
    Ok(TopoResult { density: x, history, passive })
}

/// Knotenwerte (Mittel der angrenzenden Elemente)
pub fn nodal_density(mesh: &Mesh, density: &[f64]) -> Vec<f64> {
    let mut sum = vec![0.0; mesh.nodes.len()];
    let mut cnt = vec![0u32; mesh.nodes.len()];
    for e in 0..mesh.n_elems() {
        for &n in mesh.elem(e) {
            sum[n] += density[e];
            cnt[n] += 1;
        }
    }
    sum.iter().zip(&cnt).map(|(s, &c)| if c > 0 { s / c as f64 } else { 0.0 }).collect()
}

/// Oberfläche aller Elemente mit Dichte ≥ `threshold` (Ecken, geglättet). Rückgabe: (Punkte, Dreiecke)
pub fn shape_surface(mesh: &Mesh, density: &[f64], threshold: f64, smooth: usize) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let mut count: HashMap<[usize; 3], (u32, [usize; 3])> = HashMap::new();
    for e in 0..mesh.n_elems() {
        if density[e] < threshold {
            continue;
        }
        let el = mesh.elem(e);
        for f in TET_FACES {
            let tri = [el[f[0]], el[f[1]], el[f[2]]];
            let mut k = tri;
            k.sort_unstable();
            let entry = count.entry(k).or_insert((0, tri));
            entry.0 += 1;
        }
    }
    let mut index: HashMap<usize, u32> = HashMap::new();
    let mut pts: Vec<[f64; 3]> = Vec::new();
    let mut tris = Vec::new();
    for (_, (c, tri)) in count {
        if c != 1 {
            continue;
        }
        let t = tri.map(|n| {
            *index.entry(n).or_insert_with(|| {
                pts.push(mesh.nodes[n]);
                (pts.len() - 1) as u32
            })
        });
        tris.push(t);
    }
    // Taubin-Glättung (ohne Schrumpfen): abwechselnd λ und μ
    let mut nb: Vec<Vec<u32>> = vec![Vec::new(); pts.len()];
    for t in &tris {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            nb[a as usize].push(b);
            nb[b as usize].push(a);
        }
    }
    for v in nb.iter_mut() {
        v.sort_unstable();
        v.dedup();
    }
    for _ in 0..smooth {
        for f in [0.5, -0.53] {
            let old = pts.clone();
            for (i, list) in nb.iter().enumerate() {
                if list.is_empty() {
                    continue;
                }
                let mut m = [0.0; 3];
                for &j in list {
                    (0..3).for_each(|k| m[k] += old[j as usize][k] / list.len() as f64);
                }
                (0..3).for_each(|k| pts[i][k] = old[i][k] + f * (m[k] - old[i][k]));
            }
        }
    }
    (pts, tris)
}

/// Binäre STL-Datei aus Punkten und Dreiecken
pub fn write_stl(pts: &[[f64; 3]], tris: &[[u32; 3]], out: &mut impl std::io::Write) -> std::io::Result<()> {
    let mut header = [0u8; 80];
    let text = b"Projekt-FEM Leichtbau-Vorschlag";
    header[..text.len()].copy_from_slice(text);
    out.write_all(&header)?;
    out.write_all(&(tris.len() as u32).to_le_bytes())?;
    for t in tris {
        let p = t.map(|i| Vector3::from(pts[i as usize]));
        let n = (p[1] - p[0]).cross(&(p[2] - p[0])).try_normalize(1e-300).unwrap_or_else(Vector3::zeros);
        for v in [n, p[0], p[1], p[2]] {
            for k in 0..3 {
                out.write_all(&(v[k] as f32).to_le_bytes())?;
            }
        }
        out.write_all(&[0, 0])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::box_mesh;
    use crate::model::{Axis, Fix, Load, Selection};
    use crate::{Material, Order};

    #[test]
    fn kragtraeger_material_wandert_nach_aussen() {
        // Kragträger 60 × 4 × 20 (Biegung um y): Material soll in Ober- und Untergurt wandern, die neutrale Faser
        // in der Mitte wird leichter
        let mesh = box_mesh([60.0, 4.0, 20.0], [30, 2, 10], Order::Linear).unwrap();
        let model = Model::new(mesh, Material::steel())
            .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
            .group("ende", Selection::Box { min: [59.0, -1.0, 8.0], max: [61.0, 5.0, 12.0] })
            .support("x0", Fix::all())
            .load(Load::Force { group: "ende".into(), force: [0.0, 0.0, -100.0] });
        let r = optimize(&model, &TopoParams { volume_fraction: 0.5, iterations: 25, ..Default::default() }).unwrap();
        let m = &model.mesh;
        let used: f64 = (0..m.n_elems()).map(|e| r.density[e] * tet_volume(&m.elem_coords(e)[..4]).abs()).sum();
        assert!((used / 4800.0 - 0.5).abs() < 0.02, "Volumen {}", used / 4800.0);
        // Nachgiebigkeit sinkt gegenüber dem ersten Durchlauf (gleichmäßig verteiltes Material)
        let (c0, c1) = (r.history[0].0, r.history.last().unwrap().0);
        assert!(c1 < 0.8 * c0, "{c0} → {c1}");
        // Gurte (z nahe 0 / 20) im Mittelteil dichter als die Mitte (z ≈ 10)
        let dens = |zlo: f64, zhi: f64| {
            let sel: Vec<usize> = (0..m.n_elems())
                .filter(|&e| {
                    let c: Vector3<f64> = m.elem_coords(e)[..4].iter().map(|c| Vector3::from(*c)).sum::<Vector3<f64>>() / 4.0;
                    c.x > 10.0 && c.x < 40.0 && c.z > zlo && c.z < zhi
                })
                .collect();
            sel.iter().map(|&e| r.density[e]).sum::<f64>() / sel.len() as f64
        };
        let (gurt, mitte) = ((dens(0.0, 3.0) + dens(17.0, 20.0)) / 2.0, dens(8.0, 12.0));
        assert!(gurt > mitte + 0.3, "Gurt {gurt:.2}, Mitte {mitte:.2}");
        let (pts, tris) = shape_surface(m, &r.density, 0.5, 2);
        assert!(!pts.is_empty() && !tris.is_empty());
        let mut buf = Vec::new();
        write_stl(&pts, &tris, &mut buf).unwrap();
        assert_eq!(buf.len(), 84 + 50 * tris.len());
    }
}
