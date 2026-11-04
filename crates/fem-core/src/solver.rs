use faer::linalg::solvers::Solve;
use faer::sparse::{SparseColMat, Triplet};
use faer::{Col, Side};
use nalgebra::{DMatrix, Matrix3, Vector3};
use rayon::prelude::*;

use crate::element::{tet_nodal_stress, tet_stiffness, tri_integration_points, SurfacePoint};
use crate::mesh::Face;
use crate::model::{Load, LocalFix, Model, SolverKind};
use crate::results::{principal, von_mises, Results};
use crate::{pcg, FemError, Result};

/// Ab dieser Zahl von Unbekannten wählt `SolverKind::Auto` den iterativen Löser.
pub const AUTO_ITERATIVE_FROM: usize = 50_000;
/// Abbruchgenauigkeit des iterativen Lösers (‖r‖/‖f‖)
pub const PCG_TOLERANCE: f64 = 1e-9;
const PCG_MAX_ITER: usize = 2_000;

/// Lineare statische Rechnung: K·u = f, gelöst direkt (dünnbesetzte Cholesky-Zerlegung)
/// oder iterativ (PCG), siehe `Model::solver`.
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
    // lokal festgehaltene Richtungen je Knoten (Einheitsvektoren, global)
    let mut local_dirs: std::collections::BTreeMap<usize, Vec<Vector3<f64>>> = Default::default();
    for s in &model.supports {
        let mut nodes: Vec<usize> = model
            .group_faces(&s.group, &faces)?
            .into_iter()
            .flat_map(|f| faces[f].nodes.clone())
            .collect();
        nodes.sort_unstable();
        nodes.dedup();
        if let Some(region) = model.group_region(&s.group)? {
            let tol = mesh.tolerance();
            nodes.retain(|&n| region.contains(mesh.nodes[n], tol));
            if nodes.is_empty() {
                return Err(FemError::BadLoad(s.group.clone(), "der Wirkbereich trifft die gewählten Flächen nicht".into()));
            }
        }
        match &s.local {
            None => {
                for &n in &nodes {
                    for (k, v) in s.fix.components().iter().enumerate() {
                        if v.is_some() {
                            prescribed[3 * n + k] = *v;
                        }
                    }
                }
            }
            Some(LocalFix::Normal) => {
                let normals = node_normals(model, &faces, &model.group_faces(&s.group, &faces)?);
                for &n in &nodes {
                    if let Some(nv) = normals.get(&n) {
                        local_dirs.entry(n).or_default().push(*nv);
                    }
                }
            }
            Some(LocalFix::Cylindrical { origin, axis, radial, tangential, axial }) => {
                let a = Vector3::from(*axis).normalize();
                for &n in &nodes {
                    let d = Vector3::from(mesh.nodes[n]) - Vector3::from(*origin);
                    let r = d - a * d.dot(&a);
                    if r.norm() <= mesh.tolerance() {
                        return Err(FemError::BadLoad(s.group.clone(), "Knoten auf der Zylinderachse – Achse prüfen".into()));
                    }
                    let er = r.normalize();
                    let dirs = local_dirs.entry(n).or_default();
                    for (on, v) in [(*radial, er), (*tangential, a.cross(&er)), (*axial, a)] {
                        if on {
                            dirs.push(v);
                        }
                    }
                }
            }
        }
        support_nodes.push((s.group.clone(), nodes));
    }
    // Knoten mit lokalen Lagern: Basis aus den festgehaltenen Richtungen (inkl. globaler Lager am selben Knoten)
    let mut frames = NodeFrames::new(n_nodes);
    for (n, mut dirs) in local_dirs {
        for k in 0..3 {
            if let Some(v) = prescribed[3 * n + k] {
                if v != 0.0 {
                    return Err(FemError::Input("vorgegebene Verschiebung ≠ 0 an einem Knoten mit lokaler Lagerung".into()));
                }
                let mut e = Vector3::zeros();
                e[k] = 1.0;
                dirs.push(e);
            }
        }
        let basis = orthonormal_basis(&dirs);
        let fixed = basis.len();
        if fixed == 0 {
            continue;
        }
        for k in 0..3 {
            prescribed[3 * n + k] = (k < fixed || fixed == 3).then_some(0.0);
        }
        if fixed < 3 {
            frames.set(n, complete_basis(&basis));
        }
    }

    let f_ext = load_vector(model, &faces)?;
    // im Gleichungssystem: lokale Komponenten an Knoten mit lokaler Basis
    let mut f_sys = f_ext.clone();
    frames.to_local(&mut f_sys);
    let elem_k = |e: usize| -> Result<DMatrix<f64>> {
        let mut ke = tet_stiffness(&mesh.elem_coords(e), &d).ok_or(FemError::DegenerateElement(e))?;
        frames.transform_element(mesh.elem(e), &mut ke);
        Ok(ke)
    };

    let neq = prescribed.iter().filter(|p| p.is_none()).count();
    if neq == 0 {
        return Err(FemError::Input("alle Freiheitsgrade sind festgehalten".into()));
    }
    let iterative = match model.solver {
        SolverKind::Direct => false,
        SolverKind::Iterative => true,
        SolverKind::Auto => neq >= AUTO_ITERATIVE_FROM,
    };
    let (u, iterations) = if iterative {
        let sys = pcg::assemble(n_nodes, &mesh.conn, mesh.npe, &prescribed, &f_sys, elem_k)?;
        let fixed: Vec<bool> = prescribed.iter().map(Option::is_some).collect();
        let sol = pcg::solve(sys, &mesh.nodes, &fixed, &frames, PCG_TOLERANCE, PCG_MAX_ITER)?;
        (sol.x, Some(sol.iterations))
    } else {
        (solve_direct(model, &prescribed, &f_sys, &elem_k)?, None)
    };
    let mut u = u;
    frames.to_global(&mut u);

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

    // Lagerkraft am Knoten: nur in den festgehaltenen (ggf. lokalen) Richtungen
    let node_reaction = |n: usize| -> Vector3<f64> {
        let r = Vector3::new(f_int[3 * n] - f_ext[3 * n], f_int[3 * n + 1] - f_ext[3 * n + 1], f_int[3 * n + 2] - f_ext[3 * n + 2]);
        let mask = |v: Vector3<f64>| Vector3::from_fn(|k, _| if prescribed[3 * n + k].is_some() { v[k] } else { 0.0 });
        match frames.get(n) {
            Some(rm) => rm.transpose() * mask(rm * r),
            None => mask(r),
        }
    };
    let reactions = support_nodes
        .into_iter()
        .map(|(name, nodes)| {
            let r: Vector3<f64> = nodes.into_iter().map(node_reaction).sum();
            (name, r.into())
        })
        .collect();

    let mut total_load = [0.0; 3];
    for i in 0..ndof {
        total_load[i % 3] += f_ext[i];
    }
    let total_reaction: Vector3<f64> = (0..n_nodes).map(node_reaction).sum();
    let total_reaction: [f64; 3] = total_reaction.into();

    let util = crate::results::utilization(&model.material, &stress, false);
    let safety_break = crate::results::utilization(&model.material, &stress, true)
        .map(|(u, _)| 1.0 / u.iter().copied().fold(0.0, f64::max).max(1e-300));
    let (utilization, utilization_layers) = match util {
        Some((u, l)) => (Some(u), l),
        None => (None, None),
    };

    Ok(Results {
        utilization,
        utilization_layers,
        safety_break,
        displacement: (0..n_nodes).map(|n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect(),
        von_mises: stress.iter().map(von_mises).collect(),
        principal: stress.iter().map(principal).collect(),
        stress,
        reactions,
        total_load,
        total_reaction,
        n_equations: neq,
        iterations,
    })
}

/// Direkter Löser: freie Freiheitsgrade nummerieren, untere Hälfte von K assemblieren, Cholesky.
fn solve_direct(
    model: &Model,
    prescribed: &[Option<f64>],
    f_ext: &[f64],
    elem_k: &(dyn Fn(usize) -> Result<DMatrix<f64>> + Sync),
) -> Result<Vec<f64>> {
    let mesh = &model.mesh;
    let ndof = prescribed.len();

    // --- Gleichungsnummern ---------------------------------------------------
    let mut eq = vec![usize::MAX; ndof];
    let mut neq = 0;
    for i in 0..ndof {
        if prescribed[i].is_none() {
            eq[i] = neq;
            neq += 1;
        }
    }
    let u_presc: Vec<f64> = prescribed.iter().map(|p| p.unwrap_or(0.0)).collect();

    // --- Assemblierung (parallel je Element) -------------------------------
    let npe = mesh.npe;
    let per_elem: Vec<Result<(Vec<Triplet<usize, usize, f64>>, Vec<(usize, f64)>)>> = (0..mesh.n_elems())
        .into_par_iter()
        .map(|e| {
            let ke = elem_k(e)?;
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
    Ok(u)
}

/// Lokale Basis je Knoten (Zeilen = lokale Richtungen in globalen Koordinaten, u_lokal = R·u_global).
/// Knoten ohne Eintrag rechnen global.
pub struct NodeFrames {
    index: Vec<u32>,
    mats: Vec<Matrix3<f64>>,
}

impl NodeFrames {
    fn new(n_nodes: usize) -> Self {
        NodeFrames { index: vec![u32::MAX; n_nodes], mats: Vec::new() }
    }

    fn set(&mut self, n: usize, r: Matrix3<f64>) {
        self.index[n] = self.mats.len() as u32;
        self.mats.push(r);
    }

    pub fn get(&self, n: usize) -> Option<&Matrix3<f64>> {
        self.index.get(n).and_then(|&i| self.mats.get(i as usize))
    }

    fn apply(&self, v: &mut [f64], transpose: bool) {
        for (n, &i) in self.index.iter().enumerate() {
            if i != u32::MAX {
                let r = &self.mats[i as usize];
                let x = Vector3::new(v[3 * n], v[3 * n + 1], v[3 * n + 2]);
                let y = if transpose { r.transpose() * x } else { r * x };
                v[3 * n..3 * n + 3].copy_from_slice(y.as_slice());
            }
        }
    }

    fn to_local(&self, v: &mut [f64]) {
        self.apply(v, false)
    }

    fn to_global(&self, v: &mut [f64]) {
        self.apply(v, true)
    }

    /// Elementsteifigkeit in die Knotenbasen drehen: K'_ab = R_a · K_ab · R_bᵀ
    fn transform_element(&self, nodes: &[usize], ke: &mut DMatrix<f64>) {
        if self.mats.is_empty() || nodes.iter().all(|&n| self.get(n).is_none()) {
            return;
        }
        let m = nodes.len();
        for (a, &na) in nodes.iter().enumerate() {
            if let Some(r) = self.get(na) {
                for c in 0..3 * m {
                    let x = Vector3::new(ke[(3 * a, c)], ke[(3 * a + 1, c)], ke[(3 * a + 2, c)]);
                    let y = r * x;
                    (0..3).for_each(|k| ke[(3 * a + k, c)] = y[k]);
                }
            }
        }
        for (b, &nb) in nodes.iter().enumerate() {
            if let Some(r) = self.get(nb) {
                for row in 0..3 * m {
                    let x = Vector3::new(ke[(row, 3 * b)], ke[(row, 3 * b + 1)], ke[(row, 3 * b + 2)]);
                    let y = r * x;
                    (0..3).for_each(|k| ke[(row, 3 * b + k)] = y[k]);
                }
            }
        }
    }
}

/// Orthonormalbasis des von `dirs` aufgespannten Raums (festgehaltene Richtungen)
fn orthonormal_basis(dirs: &[Vector3<f64>]) -> Vec<Vector3<f64>> {
    let mut basis: Vec<Vector3<f64>> = Vec::new();
    for d in dirs {
        let mut v = *d;
        for b in &basis {
            v -= b * b.dot(&v);
        }
        if v.norm() > 1e-6 * d.norm() && basis.len() < 3 {
            basis.push(v.normalize());
        }
    }
    basis
}

/// Ergänzt 1–2 Richtungen zu einer Rechtssystem-Basis (Zeilen der Drehmatrix)
fn complete_basis(basis: &[Vector3<f64>]) -> Matrix3<f64> {
    let e1 = basis[0];
    let e2 = if basis.len() > 1 {
        basis[1]
    } else {
        let k = (0..3).min_by(|&i, &j| e1[i].abs().partial_cmp(&e1[j].abs()).unwrap()).unwrap();
        let mut t = Vector3::zeros();
        t[k] = 1.0;
        (t - e1 * e1.dot(&t)).normalize()
    };
    let e3 = e1.cross(&e2);
    Matrix3::from_rows(&[e1.transpose(), e2.transpose(), e3.transpose()])
}

/// Mittlere Außennormale je Knoten über die gewählten Randflächen
fn node_normals(model: &Model, faces: &[Face], ids: &[usize]) -> std::collections::HashMap<usize, Vector3<f64>> {
    let mut acc: std::collections::HashMap<usize, Vector3<f64>> = Default::default();
    for &i in ids {
        let nda: Vector3<f64> = tri_integration_points(&face_coords(model, &faces[i].nodes), 1).iter().map(|p| p.nda).sum();
        for &n in &faces[i].nodes {
            *acc.entry(n).or_insert_with(Vector3::zeros) += nda;
        }
    }
    acc.into_iter().filter(|(_, v)| v.norm() > 0.0).map(|(n, v)| (n, v.normalize())).collect()
}

/// Unterteilung der Randdreiecke, wenn eine Last nur auf einem Wirkbereich wirkt
const REGION_SUBDIVISION: usize = 6;

/// Knotenkräfte aller Lasten (3 je Knoten)
pub fn load_vector(model: &Model, faces: &[Face]) -> Result<Vec<f64>> {
    let mut f_ext = vec![0.0; 3 * model.mesh.nodes.len()];
    for load in &model.loads {
        add_load(model, load, faces, &mut f_ext)?;
    }
    Ok(f_ext)
}

/// Verteilt eine Last auf die Knoten (konsistente Knotenkräfte über die Formfunktionen).
fn add_load(model: &Model, load: &Load, faces: &[Face], f_ext: &mut [f64]) -> Result<()> {
    let name = load.group();
    let bad = |msg: &str| FemError::BadLoad(name.into(), msg.into());
    let region = model.group_region(name)?;
    let tol = model.mesh.tolerance();
    // Integrationspunkte (Fläche, Punkt) im Wirkbereich
    let mut pts = Vec::new();
    for i in model.group_faces(name, faces)? {
        let coords = face_coords(model, &faces[i].nodes);
        let sub = if region.is_some() { REGION_SUBDIVISION } else { 1 };
        for p in tri_integration_points(&coords, sub) {
            if region.is_none_or(|r| r.contains(p.x.into(), tol)) {
                pts.push((i, p));
            }
        }
    }
    let area: f64 = pts.iter().map(|(_, p)| p.nda.norm()).sum();
    if pts.is_empty() || area <= 0.0 {
        return Err(bad("der Wirkbereich trifft die gewählten Flächen nicht"));
    }
    let center: Vector3<f64> = pts.iter().map(|(_, p)| p.x * p.nda.norm()).sum::<Vector3<f64>>() / area;

    // Flächenlast je Integrationspunkt
    let traction: Box<dyn Fn(&SurfacePoint) -> Vector3<f64>> = match load {
        Load::Force { force, .. } => {
            let t = Vector3::from(*force) / area;
            Box::new(move |_| t)
        }
        Load::Traction { traction, .. } => {
            let t = Vector3::from(*traction);
            Box::new(move |_| t)
        }
        Load::Pressure { pressure, .. } => {
            let p = *pressure;
            Box::new(move |q| -q.nda.normalize() * p)
        }
        Load::Moment { moment, .. } => {
            // t = ω × r mit ∫ r × (ω × r) dA = M  →  J·ω = M, J = ∫ (|r|²·I − r·rᵀ) dA
            let mut j = Matrix3::zeros();
            for (_, p) in &pts {
                let r = p.x - center;
                j += (Matrix3::identity() * r.norm_squared() - r * r.transpose()) * p.nda.norm();
            }
            let omega = j.lu().solve(&Vector3::from(*moment)).ok_or_else(|| bad("Moment lässt sich auf diese Fläche nicht verteilen"))?;
            Box::new(move |p| omega.cross(&(p.x - center)))
        }
        Load::Bearing { force, .. } => {
            let f = Vector3::from(*force);
            let fmag = f.norm();
            if fmag == 0.0 {
                return Ok(());
            }
            let dir = f / fmag;
            // Druck p = q·cos φ auf der Seite, gegen die gedrückt wird (Außennormale gegen die Kraft)
            let w = move |p: &SurfacePoint| (-p.nda.normalize().dot(&dir)).max(0.0);
            let norm: f64 = pts.iter().map(|(_, p)| w(p).powi(2) * p.nda.norm()).sum();
            if norm <= 0.0 {
                return Err(bad("keine Seite der Fläche liegt der Kraft gegenüber – Kraftrichtung prüfen"));
            }
            let q = fmag / norm;
            Box::new(move |p| -p.nda.normalize() * q * w(p))
        }
    };

    for (i, p) in &pts {
        let t = traction(p);
        let da = p.nda.norm();
        for (a, &node) in faces[*i].nodes.iter().enumerate() {
            for k in 0..3 {
                f_ext[3 * node + k] += p.n[a] * t[k] * da;
            }
        }
    }
    Ok(())
}

fn face_coords(model: &Model, nodes: &[usize]) -> Vec<[f64; 3]> {
    nodes.iter().map(|&n| model.mesh.nodes[n]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::box_mesh;
    use crate::model::{Axis, Fix, Selection};
    use crate::Region;
    use crate::{Material, Order};

    fn kragbalken(kind: SolverKind) -> Model {
        let mut senkung = Fix::default();
        senkung.set(Axis::Y, Some(-0.01)); // vorgegebene Verschiebung ≠ 0 → rechte Seite
        Model::new(box_mesh([100.0, 10.0, 10.0], [20, 2, 3], Order::Quadratic).unwrap(), Material::steel())
            .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
            .group("ende", Selection::Plane { axis: Axis::X, value: 100.0 })
            .group("oben", Selection::Plane { axis: Axis::Z, value: 10.0 })
            .support("x0", Fix::all())
            .support("ende", senkung)
            .load(Load::Force { group: "ende".into(), force: [0.0, 0.0, -100.0] })
            .load(Load::Pressure { group: "oben".into(), pressure: 0.05 })
            .solver(kind)
    }

    #[test]
    fn iterativ_gleich_direkt() {
        let direct = solve(&kragbalken(SolverKind::Direct)).unwrap();
        let iter = solve(&kragbalken(SolverKind::Iterative)).unwrap();
        assert!(direct.iterations.is_none() && iter.iterations.unwrap() > 0);
        assert_eq!(direct.n_equations, iter.n_equations);
        let (_, umax) = direct.max_displacement();
        for (a, b) in direct.displacement.iter().zip(&iter.displacement) {
            for k in 0..3 {
                assert!((a[k] - b[k]).abs() < 1e-6 * umax, "{a:?} vs {b:?}");
            }
        }
        let (_, smax) = direct.max_von_mises();
        for (a, b) in direct.von_mises.iter().zip(&iter.von_mises) {
            assert!((a - b).abs() < 1e-5 * smax);
        }
        for k in 0..3 {
            assert!((direct.total_reaction[k] - iter.total_reaction[k]).abs() < 1e-5 * 100.0);
        }
    }

    /// Resultierende Kraft und Moment (um `c`) eines Lastvektors
    fn resultant(model: &Model, f: &[f64], c: [f64; 3]) -> (Vector3<f64>, Vector3<f64>) {
        let (mut fs, mut ms) = (Vector3::zeros(), Vector3::zeros());
        for (n, p) in model.mesh.nodes.iter().enumerate() {
            let fi = Vector3::new(f[3 * n], f[3 * n + 1], f[3 * n + 2]);
            fs += fi;
            ms += (Vector3::from(*p) - Vector3::from(c)).cross(&fi);
        }
        (fs, ms)
    }

    fn platte() -> Model {
        Model::new(box_mesh([40.0, 20.0, 4.0], [20, 10, 2], Order::Quadratic).unwrap(), Material::steel())
    }

    #[test]
    fn kraft_nur_im_kreis() {
        let region = Region::Circle { center: [25.0, 8.0, 4.0], normal: [0.0, 0.0, 1.0], radius: 5.0 };
        let model = platte()
            .group_in("oben", Selection::Plane { axis: Axis::Z, value: 4.0 }, Some(region))
            .load(Load::Force { group: "oben".into(), force: [0.0, 0.0, -500.0] });
        let f = load_vector(&model, &model.mesh.boundary_faces()).unwrap();
        let (fs, ms) = resultant(&model, &f, [25.0, 8.0, 4.0]);
        assert!((fs - Vector3::new(0.0, 0.0, -500.0)).norm() < 1e-9);
        // Kraft greift (fast) in der Kreismitte an
        assert!(ms.norm() < 0.02 * 500.0 * 5.0, "{ms:?}");
        // weit außerhalb keine Last
        for (n, p) in model.mesh.nodes.iter().enumerate() {
            if ((p[0] - 25.0).powi(2) + (p[1] - 8.0).powi(2)).sqrt() > 7.0 {
                assert_eq!(f[3 * n + 2], 0.0);
            }
        }
    }

    #[test]
    fn moment_ergibt_reines_moment() {
        let region = Region::Rect { center: [10.0, 10.0, 4.0], normal: [0.0, 0.0, 1.0], u: [1.0, 0.0, 0.0], width: 12.0, height: 8.0 };
        let m = [300.0, -200.0, 1000.0];
        let model = platte()
            .group_in("oben", Selection::Plane { axis: Axis::Z, value: 4.0 }, Some(region))
            .load(Load::Moment { group: "oben".into(), moment: m });
        let f = load_vector(&model, &model.mesh.boundary_faces()).unwrap();
        let (fs, ms) = resultant(&model, &f, [10.0, 10.0, 4.0]);
        assert!(fs.norm() < 1e-9, "{fs:?}");
        assert!((ms - Vector3::from(m)).norm() < 1e-9, "{ms:?}");
    }

    #[test]
    fn bereich_trifft_nichts() {
        let region = Region::Circle { center: [100.0, 100.0, 4.0], normal: [0.0, 0.0, 1.0], radius: 1.0 };
        let model = platte()
            .group_in("oben", Selection::Plane { axis: Axis::Z, value: 4.0 }, Some(region))
            .load(Load::Force { group: "oben".into(), force: [0.0, 0.0, -1.0] });
        assert!(matches!(load_vector(&model, &model.mesh.boundary_faces()), Err(FemError::BadLoad(..))));
    }

    #[test]
    fn iterativ_erkennt_fehlende_lagerung() {
        let model = Model::new(box_mesh([10.0, 1.0, 1.0], [4, 1, 1], Order::Linear).unwrap(), Material::steel())
            .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
            .group("ende", Selection::Plane { axis: Axis::X, value: 10.0 })
            .support("x0", Fix::only(Axis::X))
            .load(Load::Force { group: "ende".into(), force: [0.0, 1.0, 0.0] })
            .solver(SolverKind::Iterative);
        assert!(matches!(solve(&model), Err(FemError::Underconstrained | FemError::NotConverged(_))));
    }
}
