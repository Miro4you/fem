//! 3D-Druck: Aufbaurichtung bewerten – Festigkeit (aus einem vorhandenen Spannungsfeld) und Stützmaterial.
//!
//! Die Sicherheit je Richtung wird aus den Spannungen einer Rechnung abgeschätzt (die Steifigkeitsänderung durch
//! die Drehung wird vernachlässigt). Die besten Richtungen sollten anschließend voll nachgerechnet werden.

use nalgebra::Vector3;
use rayon::prelude::*;
use serde::Serialize;

use crate::element::tri_integration_points;
use crate::material::Material;
use crate::mesh::{Face, Mesh};
use crate::results::Strength;

/// Überhang ab diesem Winkel zur Senkrechten braucht Stützmaterial (Faustregel FDM: 45°)
pub const OVERHANG_DEG: f64 = 45.0;

#[derive(Debug, Clone, Serialize)]
pub struct OrientationScore {
    /// Aufbaurichtung (Einheitsvektor)
    pub dir: [f64; 3],
    /// abgeschätzte Sicherheit (ohne Steifigkeitsänderung)
    pub safety: Option<f64>,
    /// maßgeblich: Schichthaftung?
    pub layer_governs: bool,
    /// Fläche, die Stützmaterial braucht [mm²]
    pub overhang_area: f64,
    /// Auflagefläche auf dem Druckbett [mm²]
    pub bed_area: f64,
    /// Bauhöhe [mm]
    pub height: f64,
}

/// Gleichmäßig verteilte Richtungen auf der Kugel (Fibonacci-Gitter)
pub fn sphere_directions(n: usize) -> Vec<[f64; 3]> {
    let golden = std::f64::consts::PI * (3.0 - 5f64.sqrt());
    (0..n)
        .map(|i| {
            let z = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
            let r = (1.0 - z * z).sqrt();
            let phi = golden * i as f64;
            [r * phi.cos(), r * phi.sin(), z]
        })
        .collect()
}

/// Bewertet die Richtungen `dirs`. `stress`: Knotenspannungen einer Rechnung (darf leer sein → keine Sicherheit).
pub fn scan(mesh: &Mesh, faces: &[Face], material: &Material, stress: &[[f64; 6]], dirs: &[[f64; 3]]) -> Vec<OrientationScore> {
    // Randflächen: Fläche, Normale, Eckpunkte
    let tris: Vec<(f64, Vector3<f64>, [Vector3<f64>; 3])> = faces
        .iter()
        .map(|f| {
            let coords: Vec<[f64; 3]> = f.nodes.iter().map(|&n| mesh.nodes[n]).collect();
            let nda: Vector3<f64> = tri_integration_points(&coords, 1).iter().map(|q| q.nda).sum();
            let a = nda.norm();
            (a, nda / a.max(1e-300), [0, 1, 2].map(|k| Vector3::from(mesh.nodes[f.nodes[k]])))
        })
        .collect();
    let (lo, hi) = mesh.bbox();
    let size = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2) + (hi[2] - lo[2]).powi(2)).sqrt();
    let tol = 1e-3 * size.max(1e-9);
    let cos_over = OVERHANG_DEG.to_radians().cos();
    dirs.par_iter()
        .map(|d| {
            let b = Vector3::from(*d).normalize();
            let proj = mesh.nodes.iter().map(|p| Vector3::from(*p).dot(&b));
            let (min, max) = proj.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, z), t| (a.min(t), z.max(t)));
            let (mut over, mut bed) = (0.0, 0.0);
            for (a, n, p) in &tris {
                let c = n.dot(&b);
                if c < -cos_over {
                    if p.iter().all(|q| q.dot(&b) - min < tol) {
                        bed += a;
                    } else {
                        over += a;
                    }
                }
            }
            let (safety, layer_governs) = if stress.is_empty() {
                (None, false)
            } else {
                let mut m = material.clone();
                if let Some(l) = m.layers.as_mut() {
                    l.build_dir = b.into();
                }
                match Strength::of(&m, false) {
                    Some(st) => {
                        let (u, a) = stress.iter().map(|s| st.eval(s)).fold((0.0f64, 0.0f64), |acc, (u, a)| (acc.0.max(u), acc.1.max(a)));
                        (Some(1.0 / u.max(1e-300)), a >= u - 1e-12)
                    }
                    None => (None, false),
                }
            };
            OrientationScore { dir: b.into(), safety, layer_governs, overhang_area: over, bed_area: bed, height: max - min }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::box_mesh;
    use crate::Order;

    #[test]
    fn quader_ueberhang_und_bett() {
        // Quader liegend (Aufbau +z): Unterseite liegt auf, kein Überhang
        let m = box_mesh([20.0, 10.0, 5.0], [4, 2, 1], Order::Linear).unwrap();
        let faces = m.boundary_faces();
        let r = scan(&m, &faces, &crate::Material::steel(), &[], &[[0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]]);
        assert!((r[0].bed_area - 200.0).abs() < 1e-9 && r[0].overhang_area.abs() < 1e-9 && (r[0].height - 5.0).abs() < 1e-12);
        // auf den Kopf gestellt: Oberseite liegt auf, ebenfalls kein Überhang
        assert!((r[1].bed_area - 200.0).abs() < 1e-9 && r[1].overhang_area.abs() < 1e-9);
        assert!((r[2].bed_area - 50.0).abs() < 1e-9 && (r[2].height - 20.0).abs() < 1e-12);
        assert_eq!(sphere_directions(50).len(), 50);
    }
}
