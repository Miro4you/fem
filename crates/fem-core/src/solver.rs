use faer::linalg::solvers::Solve;
use faer::sparse::{SparseColMat, Triplet};
use faer::{Col, Side};
use nalgebra::Vector3;
use rayon::prelude::*;

use crate::element::{tet_nodal_stress, tet_stiffness, tri_integration};
use crate::model::{Load, Model};
use crate::results::{principal, von_mises, Results};
use crate::{FemError, Result};

/// Lineare statische Rechnung: K·u = f, gelöst mit dünnbesetzter Cholesky-Zerlegung.
pub fn solve(model: &Model) -> Result<Results> {
    model.material.check()?;
    let mesh = &model.mesh;
    let n_nodes = mesh.nodes.len();
    let ndof = 3 * n_nodes;
    let d = model.material.d_matrix();
    let faces = mesh.boundary_faces();

    // --- Randbedingungen ---------------------------------------------------
    let mut prescribed: Vec<Option<f64>> = vec![None; ndof];
    // Knoten ohne Element (z. B. Geometriepunkte aus Gmsh) festhalten
    let mut used = vec![false; n_nodes];
    for &n in &mesh.conn {
        used[n] = true;
    }
    for (n, _) in used.iter().enumerate().filter(|(_, &u)| !u) {
        for k in 0..3 {
            prescribed[3 * n + k] = Some(0.0);
        }
    }
    let mut support_nodes = Vec::new();
    for s in &model.supports {
        let mut nodes: Vec<usize> = model
            .group_faces(&s.group, &faces)?
            .into_iter()
            .flat_map(|f| faces[f].nodes.clone())
            .collect();
        nodes.sort_unstable();
        nodes.dedup();
        for &n in &nodes {
            for (k, v) in s.fix.components().iter().enumerate() {
                if v.is_some() {
                    prescribed[3 * n + k] = *v;
                }
            }
        }
        support_nodes.push((s.group.clone(), nodes));
    }

    // --- Lasten --------------------------------------------------------------
    let mut f_ext = vec![0.0; ndof];
    for load in &model.loads {
        let ids = model.group_faces(load.group(), &faces)?;
        let total_area: f64 = ids
            .iter()
            .map(|&i| tri_integration(&face_coords(model, &faces[i].nodes)).iter().map(|(_, n)| n.norm()).sum::<f64>())
            .sum();
        for &i in &ids {
            let nodes = &faces[i].nodes;
            for (nn, nda) in tri_integration(&face_coords(model, nodes)) {
                let da = nda.norm();
                let t: Vector3<f64> = match load {
                    Load::Force { force, .. } => Vector3::from(*force) / total_area,
                    Load::Traction { traction, .. } => Vector3::from(*traction),
                    Load::Pressure { pressure, .. } => -nda / da * *pressure,
                };
                for (a, &node) in nodes.iter().enumerate() {
                    for k in 0..3 {
                        f_ext[3 * node + k] += nn[a] * t[k] * da;
                    }
                }
            }
        }
    }

    // --- Gleichungsnummern ---------------------------------------------------
    let mut eq = vec![usize::MAX; ndof];
    let mut neq = 0;
    for i in 0..ndof {
        if prescribed[i].is_none() {
            eq[i] = neq;
            neq += 1;
        }
    }
    if neq == 0 {
        return Err(FemError::Input("alle Freiheitsgrade sind festgehalten".into()));
    }
    let u_presc: Vec<f64> = prescribed.iter().map(|p| p.unwrap_or(0.0)).collect();

    // --- Assemblierung (parallel je Element) -------------------------------
    let npe = mesh.npe;
    let per_elem: Vec<Result<(Vec<Triplet<usize, usize, f64>>, Vec<(usize, f64)>)>> = (0..mesh.n_elems())
        .into_par_iter()
        .map(|e| {
            let ke = tet_stiffness(&mesh.elem_coords(e), &d).ok_or(FemError::DegenerateElement(e))?;
            let dofs: Vec<usize> = mesh.elem(e).iter().flat_map(|&n| [3 * n, 3 * n + 1, 3 * n + 2]).collect();
            let mut trip = Vec::with_capacity(npe * npe * 5);
            let mut rhs = Vec::new();
            for (a, &ga) in dofs.iter().enumerate() {
                let ra = eq[ga];
                if ra == usize::MAX {
                    continue;
                }
                for (b, &gb) in dofs.iter().enumerate() {
                    let cb = eq[gb];
                    if cb == usize::MAX {
                        // vorgegebene Verschiebung → rechte Seite
                        if u_presc[gb] != 0.0 {
                            rhs.push((ra, -ke[(a, b)] * u_presc[gb]));
                        }
                    } else if ra >= cb {
                        trip.push(Triplet::new(ra, cb, ke[(a, b)]));
                    }
                }
            }
            Ok((trip, rhs))
        })
        .collect();

    let mut b = Col::<f64>::zeros(neq);
    for i in 0..ndof {
        if eq[i] != usize::MAX {
            b[eq[i]] = f_ext[i];
        }
    }
    let mut triplets = Vec::new();
    for r in per_elem {
        let (t, rhs) = r?;
        triplets.extend(t);
        for (i, v) in rhs {
            b[i] += v;
        }
    }

    let k = SparseColMat::<usize, f64>::try_new_from_triplets(neq, neq, &triplets)
        .map_err(|e| FemError::Input(format!("Matrixaufbau fehlgeschlagen: {e:?}")))?;
    drop(triplets);
    let llt = k.sp_cholesky(Side::Lower).map_err(|_| FemError::Underconstrained)?;
    let x = llt.solve(&b);
    if x.iter().any(|v| !v.is_finite()) {
        return Err(FemError::Underconstrained);
    }

    let mut u = u_presc;
    for i in 0..ndof {
        if eq[i] != usize::MAX {
            u[i] = x[eq[i]];
        }
    }

    // --- Spannungen und Reaktionen -------------------------------------------
    let per_elem: Vec<(Vec<[f64; 6]>, Vec<f64>)> = (0..mesh.n_elems())
        .into_par_iter()
        .map(|e| {
            let coords = mesh.elem_coords(e);
            let ue: Vec<f64> = mesh.elem(e).iter().flat_map(|&n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect();
            let ke = tet_stiffness(&coords, &d).expect("bereits geprüft");
            let fe = ke * nalgebra::DVector::from_column_slice(&ue);
            (tet_nodal_stress(&coords, &ue, &d), fe.as_slice().to_vec())
        })
        .collect();

    let mut stress = vec![[0.0; 6]; n_nodes];
    let mut count = vec![0u32; n_nodes];
    let mut f_int = vec![0.0; ndof];
    for (e, (s, fe)) in per_elem.iter().enumerate() {
        for (a, &n) in mesh.elem(e).iter().enumerate() {
            for c in 0..6 {
                stress[n][c] += s[a][c];
            }
            count[n] += 1;
            for k in 0..3 {
                f_int[3 * n + k] += fe[3 * a + k];
            }
        }
    }
    for (s, &c) in stress.iter_mut().zip(&count) {
        if c > 0 {
            s.iter_mut().for_each(|v| *v /= c as f64);
        }
    }

    let reactions = support_nodes
        .into_iter()
        .map(|(name, nodes)| {
            let mut r = [0.0; 3];
            for n in nodes {
                for k in 0..3 {
                    if prescribed[3 * n + k].is_some() {
                        r[k] += f_int[3 * n + k] - f_ext[3 * n + k];
                    }
                }
            }
            (name, r)
        })
        .collect();

    let mut total_load = [0.0; 3];
    let mut total_reaction = [0.0; 3];
    for i in 0..ndof {
        total_load[i % 3] += f_ext[i];
        if prescribed[i].is_some() {
            total_reaction[i % 3] += f_int[i] - f_ext[i];
        }
    }

    Ok(Results {
        displacement: (0..n_nodes).map(|n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect(),
        von_mises: stress.iter().map(von_mises).collect(),
        principal: stress.iter().map(principal).collect(),
        stress,
        reactions,
        total_load,
        total_reaction,
        n_equations: neq,
    })
}

fn face_coords(model: &Model, nodes: &[usize]) -> Vec<[f64; 3]> {
    nodes.iter().map(|&n| model.mesh.nodes[n]).collect()
}
