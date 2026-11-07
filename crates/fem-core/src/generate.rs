//! Einfache eingebaute Netzgeneratoren (für Tests und Lehrbuchfälle).
//! Beliebige Geometrie kommt später über STEP + Gmsh.

use crate::mesh::{Mesh, Order};
use crate::Result;

/// Quader von (0,0,0) bis `size`, unterteilt in `cells` Würfelzellen,
/// jede Zelle in 6 Tetraeder zerlegt (Kuhn-Zerlegung, konform).
pub fn box_mesh(size: [f64; 3], cells: [usize; 3], order: Order) -> Result<Mesh> {
    if cells.iter().any(|&c| c == 0) || size.iter().any(|&s| !(s > 0.0)) {
        return Err(crate::FemError::Input("Quader braucht positive Maße und mindestens 1 Zelle je Richtung".into()));
    }
    let [nx, ny, nz] = cells;
    let id = |i: usize, j: usize, k: usize| i + (nx + 1) * (j + (ny + 1) * k);
    let mut nodes = Vec::with_capacity((nx + 1) * (ny + 1) * (nz + 1));
    for k in 0..=nz {
        for j in 0..=ny {
            for i in 0..=nx {
                nodes.push([
                    size[0] * i as f64 / nx as f64,
                    size[1] * j as f64 / ny as f64,
                    size[2] * k as f64 / nz as f64,
                ]);
            }
        }
    }
    const PERMS: [[usize; 3]; 6] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let mut conn = Vec::with_capacity(nx * ny * nz * 24);
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                for p in PERMS {
                    // Pfad entlang der Würfelkanten von (0,0,0) nach (1,1,1)
                    let mut ijk = [i, j, k];
                    conn.push(id(ijk[0], ijk[1], ijk[2]));
                    for axis in p {
                        ijk[axis] += 1;
                        conn.push(id(ijk[0], ijk[1], ijk[2]));
                    }
                }
            }
        }
    }
    let mut mesh = Mesh { nodes, npe: 4, conn, surface_tags: Default::default(), elem_body: vec![], body_names: vec![] };
    mesh.fix_orientation()?;
    if order == Order::Quadratic {
        mesh = mesh.to_quadratic();
    }
    Ok(mesh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quader_volumen_und_oberflaeche() {
        for order in [Order::Linear, Order::Quadratic] {
            let m = box_mesh([2.0, 3.0, 4.0], [2, 3, 2], order).unwrap();
            assert!((m.volume() - 24.0).abs() < 1e-10);
            let faces = m.boundary_faces();
            // jede Außenseite der Zellen = 2 Dreiecke
            assert_eq!(faces.len(), 2 * 2 * (2 * 3 + 2 * 2 + 3 * 2));
            let area: f64 = faces
                .iter()
                .map(|f| {
                    let c: Vec<[f64; 3]> = f.nodes.iter().map(|&n| m.nodes[n]).collect();
                    crate::element::tri_integration(&c).iter().map(|(_, n)| n.norm()).sum::<f64>()
                })
                .sum();
            assert!((area - 2.0 * (6.0 + 8.0 + 12.0)).abs() < 1e-10);
        }
    }
}
