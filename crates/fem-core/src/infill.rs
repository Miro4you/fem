//! 3D-Druck-Füllung: Anteil „volle Wand/Deckschicht“ je Element.
//!
//! Wände (Perimeter) liegen an Seitenflächen, Deck- und Bodenschichten an Flächen, die in bzw. gegen die
//! Aufbaurichtung zeigen. Ein Element zählt anteilig als Wand, je nachdem wie viele seiner Stichpunkte
//! näher als die jeweilige Dicke an einer solchen Fläche liegen.

use std::collections::HashMap;

use nalgebra::Vector3;
use rayon::prelude::*;

use crate::element::tri_integration_points;
use crate::material::Infill;
use crate::mesh::{Face, Mesh};

/// Flächen gelten als Deck-/Bodenfläche, wenn ihre Normale höchstens ~45° von der Aufbaurichtung abweicht
const SKIN_COS: f64 = 0.7;

struct Tri {
    p: [Vector3<f64>; 3],
    /// 0 = Seite (Wand), 1 = oben (Deckschicht), 2 = unten (Bodenschicht)
    kind: u8,
}

/// Abstand Punkt–Dreieck (nach Ericson, „Real-Time Collision Detection“)
fn dist_point_tri(p: &Vector3<f64>, t: &[Vector3<f64>; 3]) -> f64 {
    let (a, b, c) = (t[0], t[1], t[2]);
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;
    let d1 = ab.dot(&ap);
    let d2 = ac.dot(&ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return ap.norm();
    }
    let bp = p - b;
    let d3 = ab.dot(&bp);
    let d4 = ac.dot(&bp);
    if d3 >= 0.0 && d4 <= d3 {
        return bp.norm();
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return (p - (a + ab * v)).norm();
    }
    let cp = p - c;
    let d5 = ab.dot(&cp);
    let d6 = ac.dot(&cp);
    if d6 >= 0.0 && d5 <= d6 {
        return cp.norm();
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return (p - (a + ac * w)).norm();
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return (p - (b + (c - b) * w)).norm();
    }
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    (p - (a + ab * v + ac * w)).norm()
}

/// Wandanteil (0…1) je Element
pub fn shell_fractions(mesh: &Mesh, faces: &[Face], infill: &Infill, build_dir: [f64; 3]) -> Vec<f64> {
    let b = Vector3::from(build_dir).normalize();
    let thick = [infill.wall_thickness(), infill.top_thickness(), infill.bottom_thickness()];
    let tmax = thick.iter().copied().fold(0.0, f64::max);
    if tmax <= 0.0 {
        return vec![0.0; mesh.n_elems()];
    }
    // Randdreiecke (Ecken) mit Art
    let tris: Vec<Tri> = faces
        .iter()
        .map(|f| {
            let p = [0, 1, 2].map(|k| Vector3::from(mesh.nodes[f.nodes[k]]));
            let coords: Vec<[f64; 3]> = f.nodes.iter().map(|&n| mesh.nodes[n]).collect();
            let nda: Vector3<f64> = tri_integration_points(&coords, 1).iter().map(|q| q.nda).sum();
            let c = nda.normalize().dot(&b);
            let kind = if c >= SKIN_COS {
                1
            } else if c <= -SKIN_COS {
                2
            } else {
                0
            };
            Tri { p, kind }
        })
        .collect();
    // Raumraster der Dreiecke
    let cell = tmax.max(1e-9);
    let key = |v: &Vector3<f64>| [(v.x / cell).floor() as i64, (v.y / cell).floor() as i64, (v.z / cell).floor() as i64];
    let mut grid: HashMap<[i64; 3], Vec<u32>> = HashMap::new();
    for (i, t) in tris.iter().enumerate() {
        let lo = t.p.iter().fold(Vector3::repeat(f64::INFINITY), |m, p| m.inf(p));
        let hi = t.p.iter().fold(Vector3::repeat(f64::NEG_INFINITY), |m, p| m.sup(p));
        let (a, z) = (key(&lo), key(&hi));
        for x in a[0]..=z[0] {
            for y in a[1]..=z[1] {
                for zz in a[2]..=z[2] {
                    grid.entry([x, y, zz]).or_default().push(i as u32);
                }
            }
        }
    }
    // Stichpunkte im Tetraeder (baryzentrisch): Mitte + 4 Punkte zu den Ecken hin
    const S: [[f64; 4]; 5] = [
        [0.25, 0.25, 0.25, 0.25],
        [0.585, 0.138, 0.138, 0.139],
        [0.138, 0.585, 0.138, 0.139],
        [0.138, 0.138, 0.585, 0.139],
        [0.138, 0.138, 0.139, 0.585],
    ];
    (0..mesh.n_elems())
        .into_par_iter()
        .map(|e| {
            let c = mesh.elem_coords(e);
            let corners = [0, 1, 2, 3].map(|k| Vector3::from(c[k]));
            let mut inside = 0;
            for w in S {
                let p = corners[0] * w[0] + corners[1] * w[1] + corners[2] * w[2] + corners[3] * w[3];
                let (a, z) = (key(&(p - Vector3::repeat(tmax))), key(&(p + Vector3::repeat(tmax))));
                let mut hit = false;
                'cells: for x in a[0]..=z[0] {
                    for y in a[1]..=z[1] {
                        for zz in a[2]..=z[2] {
                            if let Some(list) = grid.get(&[x, y, zz]) {
                                for &i in list {
                                    let t = &tris[i as usize];
                                    let lim = thick[t.kind as usize];
                                    if lim > 0.0 && dist_point_tri(&p, &t.p) < lim {
                                        hit = true;
                                        break 'cells;
                                    }
                                }
                            }
                        }
                    }
                }
                inside += hit as usize;
            }
            inside as f64 / S.len() as f64
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::box_mesh;
    use crate::material::InfillPattern;
    use crate::Order;

    #[test]
    fn wandanteil_wuerfel() {
        // Würfel 20 mm, Wand 2 mm, Deck/Boden je 2 mm → Kern 16³, Wandvolumen 1 − (16/20)³ = 48,8 %
        let m = box_mesh([20.0, 20.0, 20.0], [20, 20, 20], Order::Linear).unwrap();
        let faces = m.boundary_faces();
        let inf = Infill { pattern: InfillPattern::Gitter, density: 0.2, walls: 4, line_width: 0.5, layer_height: 0.25, top_layers: 8, bottom_layers: 8 };
        let f = shell_fractions(&m, &faces, &inf, [0.0, 0.0, 1.0]);
        let (mut vs, mut v) = (0.0, 0.0);
        for (e, fe) in f.iter().enumerate() {
            let ve = crate::element::tet_volume(&m.elem_coords(e)[..4]).abs();
            vs += fe * ve;
            v += ve;
        }
        assert!((vs / v - 0.488).abs() < 0.01, "{}", vs / v);
        // nur Wände (keine Deck-/Bodenschicht): 1 − (16·16·20)/20³ = 36 %
        let inf2 = Infill { top_layers: 0, bottom_layers: 0, ..inf };
        let f2 = shell_fractions(&m, &faces, &inf2, [0.0, 0.0, 1.0]);
        let vs2: f64 = f2.iter().enumerate().map(|(e, fe)| fe * crate::element::tet_volume(&m.elem_coords(e)[..4]).abs()).sum();
        assert!((vs2 / v - 0.36).abs() < 0.01, "{}", vs2 / v);
    }

    #[test]
    fn abstand_punkt_dreieck() {
        let t = [Vector3::new(0.0, 0.0, 0.0), Vector3::new(1.0, 0.0, 0.0), Vector3::new(0.0, 1.0, 0.0)];
        assert!((dist_point_tri(&Vector3::new(0.2, 0.2, 3.0), &t) - 3.0).abs() < 1e-12);
        assert!((dist_point_tri(&Vector3::new(2.0, 0.0, 0.0), &t) - 1.0).abs() < 1e-12);
        assert!((dist_point_tri(&Vector3::new(1.0, 1.0, 0.0), &t) - 0.5f64.sqrt()).abs() < 1e-12);
    }
}
