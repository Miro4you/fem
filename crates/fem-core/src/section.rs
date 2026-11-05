//! Schnitt durch das Netz mit einer Ebene: Dreiecke der Schnittfläche mit interpolierten Knotenwerten
//! (zum Hineinschauen in das Bauteil, z. B. Infill oder innere Spannungen).

use std::collections::HashMap;

use nalgebra::Vector3;

use crate::mesh::Mesh;

#[derive(Debug, Clone, Default)]
pub struct Cut {
    /// Eckpunkte, flach x,y,z
    pub positions: Vec<f64>,
    pub triangles: Vec<u32>,
    /// je Feld ein Wert pro Eckpunkt
    pub values: Vec<Vec<f64>>,
    /// Verschiebung je Eckpunkt (für die verformte Darstellung)
    pub displacement: Vec<f64>,
}

/// Schneidet alle Elemente (Eckknoten, lineare Interpolation) mit der Ebene durch `point` mit Normale `normal`.
pub fn cut(mesh: &Mesh, point: [f64; 3], normal: [f64; 3], fields: &[&[f64]], disp: &[[f64; 3]]) -> Cut {
    let n = Vector3::from(normal).normalize();
    let p0 = Vector3::from(point);
    let dist: Vec<f64> = mesh.nodes.iter().map(|p| (Vector3::from(*p) - p0).dot(&n)).collect();
    let mut out = Cut { values: vec![Vec::new(); fields.len()], ..Default::default() };
    let mut index: HashMap<(usize, usize), u32> = HashMap::new();
    let mut vertex = |a: usize, b: usize, out: &mut Cut| -> u32 {
        let key = (a.min(b), a.max(b));
        if let Some(&i) = index.get(&key) {
            return i;
        }
        let (a, b) = key;
        let t = dist[a] / (dist[a] - dist[b]);
        let lerp = |x: f64, y: f64| x + t * (y - x);
        for k in 0..3 {
            out.positions.push(lerp(mesh.nodes[a][k], mesh.nodes[b][k]));
            out.displacement.push(lerp(disp[a][k], disp[b][k]));
        }
        for (f, vals) in fields.iter().zip(out.values.iter_mut()) {
            vals.push(lerp(f[a], f[b]));
        }
        let i = (out.positions.len() / 3 - 1) as u32;
        index.insert(key, i);
        i
    };
    for e in 0..mesh.n_elems() {
        let c = &mesh.elem(e)[..4];
        let (pos, neg): (Vec<usize>, Vec<usize>) = c.iter().copied().partition(|&k| dist[k] >= 0.0);
        match (pos.len(), neg.len()) {
            (1, 3) | (3, 1) => {
                let (s, o) = if pos.len() == 1 { (pos[0], neg) } else { (neg[0], pos) };
                let v: Vec<u32> = o.iter().map(|&k| vertex(s, k, &mut out)).collect();
                out.triangles.extend([v[0], v[1], v[2]]);
            }
            (2, 2) => {
                let q00 = vertex(pos[0], neg[0], &mut out);
                let q01 = vertex(pos[0], neg[1], &mut out);
                let q11 = vertex(pos[1], neg[1], &mut out);
                let q10 = vertex(pos[1], neg[0], &mut out);
                out.triangles.extend([q00, q01, q11, q00, q11, q10]);
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::box_mesh;
    use crate::Order;

    #[test]
    fn schnitt_flaeche_und_werte() {
        let m = box_mesh([10.0, 4.0, 6.0], [5, 2, 3], Order::Linear).unwrap();
        // Feld = x-Koordinate: auf der Schnittebene x = 3,3 überall 3,3
        let fx: Vec<f64> = m.nodes.iter().map(|p| p[0]).collect();
        let d = vec![[0.0; 3]; m.nodes.len()];
        let c = cut(&m, [3.3, 0.0, 0.0], [1.0, 0.0, 0.0], &[&fx], &d);
        let area: f64 = c
            .triangles
            .chunks(3)
            .map(|t| {
                let p = |i: u32| Vector3::new(c.positions[3 * i as usize], c.positions[3 * i as usize + 1], c.positions[3 * i as usize + 2]);
                (p(t[1]) - p(t[0])).cross(&(p(t[2]) - p(t[0]))).norm() / 2.0
            })
            .sum();
        assert!((area - 24.0).abs() < 1e-9, "{area}");
        assert!(c.values[0].iter().all(|v| (v - 3.3).abs() < 1e-12));
    }
}
