use faer::linalg::solvers::Solve;
use faer::sparse::linalg::solvers::{Llt, SymbolicLlt};
use faer::sparse::{SparseColMat, Triplet};
use faer::{Col, Side};
use nalgebra::{DMatrix, Matrix3, Vector3};
use rayon::prelude::*;

use crate::element::{tet_nodal_stress, tet_stiffness, tri_integration_points, SurfacePoint};
use crate::material::DMat;
use crate::mesh::Face;
use crate::model::{Load, LocalFix, Model, SolverKind};
use crate::results::{principal, von_mises, Results};
use crate::{pcg, FemError, Result};

/// Ab dieser Zahl von Unbekannten wählt `SolverKind::Auto` den iterativen Löser.
pub const AUTO_ITERATIVE_FROM: usize = 50_000;
/// Abbruchgenauigkeit des iterativen Lösers (‖r‖/‖f‖)
pub const PCG_TOLERANCE: f64 = 1e-9;
/// höchstens so viele Durchgänge je Schritt, bis sich Kontakt und Reibung nicht mehr ändern
const MAX_CONTACT_PASSES: usize = 40;
const PCG_MAX_ITER: usize = 2_000;

/// Zusätzliche Einstellungen einer Rechnung (z. B. für die Topologieoptimierung)
#[derive(Debug, Clone, Default)]
pub struct SolveOptions<'a> {
    /// Steifigkeitsfaktor je Element (1 = voller Werkstoff)
    pub element_scale: Option<&'a [f64]>,
    /// Abbruchgenauigkeit des iterativen Lösers (Standard `PCG_TOLERANCE`)
    pub tolerance: Option<f64>,
}

/// Lineare statische Rechnung: K·u = f, gelöst direkt (dünnbesetzte Cholesky-Zerlegung)
/// oder iterativ (PCG), siehe `Model::solver`.
pub fn solve(model: &Model) -> Result<Results> {
    solve_with(model, &SolveOptions::default())
}

/// Wie `solve`, mit zusätzlichen Einstellungen
pub fn solve_with(model: &Model, opts: &SolveOptions) -> Result<Results> {
    model.material.check()?;
    for (_, m) in &model.body_materials {
        m.check()?;
    }
    let mesh = &model.mesh;
    let n_nodes = mesh.nodes.len();
    let ndof = 3 * n_nodes;
    let d = model.material.d_matrix();
    let faces = mesh.boundary_faces();
    let progress = &model.progress;
    // 3D-Druck mit Füllung: Wandanteil je Element, Ersatzwerkstoff für den Kern
    let zones = match (&model.material.infill, model.material.core_material()) {
        (Some(inf), Some(core)) => {
            progress.report("Wände und Füllung zuordnen", None);
            let dir = model.material.layers.as_ref().map(|l| l.build_dir).unwrap_or([0.0, 0.0, 1.0]);
            let d_core = core.d_matrix();
            Some((crate::infill::shell_fractions(mesh, &faces, inf, dir), core, d_core))
        }
        _ => None,
    };
    // Baugruppe: Werkstoff je Körper (Index in body_materials je Element)
    let body_mat: Vec<Option<usize>> = if model.body_materials.is_empty() {
        vec![]
    } else {
        if zones.is_some() {
            return Err(FemError::Input(
                "3D-Druck-Füllung zusammen mit einem eigenen Werkstoff je Körper geht noch nicht – Füllung ausschalten oder alle Körper gleich".into(),
            ));
        }
        (0..mesh.n_elems()).map(|e| model.body_materials.iter().position(|(b, _)| *b == mesh.body_of(e))).collect()
    };
    let d_body: Vec<DMat> = model.body_materials.iter().map(|(_, m)| m.d_matrix()).collect();
    // Steifigkeit je Element: Wand und Kern nach Volumenanteil gemischt (gleiche Dehnung)
    let elem_d = |e: usize| -> DMat {
        let de = match (&zones, body_mat.get(e).copied().flatten()) {
            (_, Some(i)) => d_body[i],
            (Some((f, _, dc)), None) => d * f[e] + dc * (1.0 - f[e]),
            (None, None) => d,
        };
        match opts.element_scale {
            Some(sc) => de * sc[e],
            None => de,
        }
    };

    // --- Randbedingungen ---------------------------------------------------
    let Constraints { prescribed, support_nodes, frames } = constraints(model, &faces)?;
    // Schweißnähte: Kopplungen als Zusatzelemente (in den Knotenbasen)
    let welds = if model.welds.is_empty() {
        None
    } else {
        progress.report("Schweißnähte koppeln", None);
        Some(crate::weld::prepare(model, &faces)?)
    };
    let base_extra = tie_elements(welds.as_ref(), &frames);
    // Schrauben: Kopplung Kopfauflage ↔ Gewinde/Mutter
    let mut bolts: Vec<crate::bolt::Prepared> = if model.bolts.is_empty() {
        vec![]
    } else {
        progress.report("Schrauben koppeln", None);
        model.bolts.iter().map(|b| crate::bolt::prepare(mesh, &faces, b)).collect::<Result<_>>()?
    };
    let preloads: Vec<f64> = model.bolts.iter().map(|b| b.assembly().map(|a| a.f_v).unwrap_or(0.0)).collect();

    progress.report("Lasten verteilen", None);
    let f_ext = load_vector(model, &faces)?;
    let elem_k = |e: usize| -> Result<DMatrix<f64>> {
        let mut ke = tet_stiffness(&mesh.elem_coords(e), &elem_d(e)).ok_or(FemError::DegenerateElement(e))?;
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
    // lineares System mit Zusatzelementen (global) und Lastvektor (global) lösen
    let direct_cache = std::cell::RefCell::new(DirectCache::default());
    let pcg_cache = std::cell::RefCell::new(PcgCache::default());
    let tol_final = opts.tolerance.unwrap_or(PCG_TOLERANCE);
    let solve_lin = |extra: &[(Vec<usize>, DMatrix<f64>)],
                     rhs: &[f64],
                     prescribed: &[Option<f64>],
                     key: Option<u64>,
                     tol: f64|
     -> Result<(Vec<f64>, Option<usize>)> {
        let mut f_sys = rhs.to_vec();
        frames.to_local(&mut f_sys);
        let (u, it) = if iterative {
            let mut pc = pcg_cache.borrow_mut();
            let fixed: Vec<bool> = prescribed.iter().map(Option::is_some).collect();
            // gleiche Matrix wie zuletzt: Vorkonditionierer behalten, nur die rechte Seite neu
            let reuse = matches!((&pc.amg, key), (Some((k0, _, _, p0)), Some(k)) if *k0 == k && p0.as_slice() == prescribed);
            let t0 = std::time::Instant::now();
            let mut t_asm = std::time::Duration::ZERO;
            if !reuse {
                progress.report(&format!("Steifigkeitsmatrix aufbauen ({neq} Unbekannte)"), None);
                let sys = pcg::assemble(n_nodes, &mesh.conn, mesh.npe, prescribed, &f_sys, &elem_k, extra)?;
                t_asm = t0.elapsed();
                // Anteil der rechten Seite aus vorgegebenen Verschiebungen (ohne äußere Lasten)
                let b_presc: Vec<f64> = sys.b.iter().zip(&f_sys).zip(&fixed).map(|((b, f), &fx)| if fx { *b } else { b - f }).collect();
                // nur Kontaktfedern geändert (gleiche Lagerung): grobe Gitter behalten, sonst neu aufbauen
                let keep = !pc.rebuild
                    && matches!(&pc.amg, Some((_, _, _, p0)) if p0.iter().zip(prescribed).all(|(a, b)| a.is_some() == b.is_some()))
                    && sys.k.col.len() == pc.amg.as_ref().map(|a| a.1.matrix().col.len()).unwrap_or(0);
                let amg = match (keep, pc.amg.take()) {
                    (true, Some((_, mut amg, _, _))) => {
                        amg.replace_fine(sys.k)?;
                        amg
                    }
                    _ => {
                        progress.report("Mehrgitter-Vorkonditionierer vorbereiten", None);
                        pc.fresh_iters = None;
                        crate::amg::Amg::new(sys.k, &mesh.nodes, &fixed, &frames)?
                    }
                };
                pc.rebuild = false;
                pc.amg = Some((key.unwrap_or(u64::MAX), amg, b_presc, prescribed.to_vec()));
            }
            let (_, amg, b_presc, _) = pc.amg.as_ref().expect("gesetzt");
            let b: Vec<f64> = b_presc.iter().zip(&f_sys).zip(&fixed).map(|((b, f), &fx)| if fx { *b } else { b + f }).collect();
            // Startwert: Lösung des vorigen Durchgangs (vorgegebene Werte eingesetzt)
            let x0: Option<Vec<f64>> =
                pc.x_last.as_ref().map(|x| x.iter().zip(&b).zip(&fixed).map(|((x, b), &fx)| if fx { *b } else { *x }).collect());
            let t1 = std::time::Instant::now();
            let sol = pcg::solve_amg(amg, b, x0.as_deref(), tol, PCG_MAX_ITER, progress)?;
            if std::env::var("FEM_KONTAKT_DEBUG").is_ok() {
                eprintln!("  PCG: Matrix {t_asm:.2?}, AMG {:.2?}, {} Iterationen {:.2?}", t1 - t0 - t_asm, sol.iterations, t1.elapsed());
            }
            pc.x_last = Some(sol.x.clone());
            // mit behaltenen groben Gittern deutlich mehr Iterationen als frisch aufgebaut → nächstes Mal neu aufbauen
            match pc.fresh_iters {
                None => pc.fresh_iters = Some(sol.iterations.max(10)),
                Some(f) if sol.iterations > 3 * f => pc.rebuild = true,
                _ => {}
            }
            (sol.x, Some(sol.iterations))
        } else {
            progress.report(&format!("Direkter Löser: Matrix aufbauen und zerlegen ({neq} Unbekannte)"), None);
            (solve_direct(model, prescribed, &f_sys, &elem_k, extra, &mut direct_cache.borrow_mut(), key)?, None)
        };
        let mut u = u;
        frames.to_global(&mut u);
        Ok((u, it))
    };
    // Schraubenelemente; `force_mode`: Schrauben mit Vorspannung ohne Längsfeder (Kraft statt Länge vorgegeben)
    let bolt_elems = |bolts: &[crate::bolt::Prepared], force_mode: bool| -> Vec<(Vec<usize>, DMatrix<f64>)> {
        bolts
            .iter()
            .zip(&preloads)
            .map(|(p, &fv)| {
                let mut k = if force_mode && fv > 0.0 { p.stiffness_without_axial() } else { p.stiffness() };
                frames.transform_element(&p.nodes, &mut k);
                (p.nodes.clone(), k)
            })
            .collect()
    };
    // Schraubenkräfte als Knotenlasten: Vorspannkraft (Schritt 1) bzw. Vorspannweg k·s (Schritt 2)
    let bolt_loads = |bolts: &[crate::bolt::Prepared], force_mode: bool| -> Vec<f64> {
        let mut f = vec![0.0; ndof];
        for (p, &fv) in bolts.iter().zip(&preloads) {
            if fv <= 0.0 {
                continue;
            }
            let t = p.tension_forces(if force_mode { fv } else { p.k_ax * p.offset });
            for (j, &n) in p.nodes.iter().enumerate() {
                for c in 0..3 {
                    f[3 * n + c] += t[3 * j + c];
                }
            }
        }
        f
    };
    // Kontakt in geöffneten Fugen
    let e_ref = std::iter::once(&model.material).chain(model.body_materials.iter().map(|(_, m)| m)).map(|m| m.e).fold(0.0, f64::max);
    let mut contact = (!model.joint_pairs.is_empty())
        .then(|| crate::contact::Contact::new(mesh, &model.joint_pairs, e_ref, model.joint_friction))
        .filter(|c| !c.is_empty());
    // rechnen, Kontaktzustände prüfen, wiederholen, bis sich nichts mehr ändert
    let mut contact_iters = 0usize;
    let mut matrix_version = 0u64;
    let mut contact_open_changes = 0usize;
    type Extra = Vec<(Vec<usize>, DMatrix<f64>)>;
    let mut run = |contact: &mut Option<crate::contact::Contact>,
                   bolt_extra: &Extra,
                   rhs: &[f64],
                   presc: &[Option<f64>],
                   label: &str|
     -> Result<(Vec<f64>, Option<usize>)> {
        let mut pass = 0;
        // iterativer Löser: Kontaktzustände mit gröberer Genauigkeit suchen, zum Schluss genau nachrechnen
        let mut tight = contact.is_none() || !iterative;
        loop {
            let mut extra = base_extra.clone();
            extra.extend(bolt_extra.iter().cloned());
            let mut r = rhs.to_vec();
            if let Some(c) = contact.as_ref() {
                for (nodes, mut k) in c.elements() {
                    frames.transform_element(&nodes, &mut k);
                    extra.push((nodes, k));
                }
                for (i, v) in c.forces(ndof).into_iter().enumerate() {
                    r[i] += v;
                }
            }
            // neue Matrix nur bei neuem Schritt oder geänderten Kontaktfedern, sonst nur neue rechte Seite
            if pass == 0 || contact.as_ref().is_some_and(|c| c.matrix_dirty) {
                matrix_version += 1;
            }
            if let Some(c) = contact.as_mut() {
                c.matrix_dirty = false;
            }
            let t_pass = std::time::Instant::now();
            let tol = if tight { tol_final } else { (tol_final * 1e3).max(tol_final).min(1e-6) };
            let (u, it) = solve_lin(&extra, &r, presc, Some(matrix_version), tol)?;
            if std::env::var("FEM_KONTAKT_DEBUG").is_ok() {
                eprintln!("{label}: Durchgang {} in {:.2?}", pass + 1, t_pass.elapsed());
            }
            pass += 1;
            contact_iters += 1;
            let changes = contact.as_mut().map(|c| c.update(&u)).unwrap_or(0);
            if changes == 0 && !tight {
                tight = true;
                continue;
            }
            if changes == 0 || pass >= MAX_CONTACT_PASSES {
                contact_open_changes = changes;
                return Ok((u, it));
            }
            progress.report(&format!("{label}: Kontakt, Durchgang {} ({changes} Änderungen)", pass + 1), None);
        }
    };
    // Schritt 1: Schrauben anziehen (Vorspannkraft vorgegeben), Vorspannweg merken
    if preloads.iter().any(|&f| f > 0.0) {
        progress.report("Schrauben vorspannen", None);
        // nur die Schrauben ziehen an; vorgegebene Verschiebungen kommen erst mit der Betriebslast
        let presc0: Vec<Option<f64>> = prescribed.iter().map(|p| p.map(|_| 0.0)).collect();
        let (u1, _) = run(&mut contact, &bolt_elems(&bolts, true), &bolt_loads(&bolts, true), &presc0, "Vorspannen")?;
        if let Some(c) = contact.as_mut() {
            c.commit_step();
        }
        for (p, &fv) in bolts.iter_mut().zip(&preloads) {
            if fv > 0.0 {
                p.offset = fv / p.k_ax - p.axial_delta(&u1);
            }
        }
    }
    // Schritt 2: Betriebslast (Schraubenlänge festgehalten)
    let mut rhs = f_ext.clone();
    for (i, v) in bolt_loads(&bolts, false).into_iter().enumerate() {
        rhs[i] += v;
    }
    let (u, iterations) = run(&mut contact, &bolt_elems(&bolts, false), &rhs, &prescribed, "Last")?;

    // Krafteinleitung der Schrauben: örtliche Spitzen, nicht im σv-Nachweis
    let bolt_zone = crate::bolt::load_zone(mesh, &model.bolts, &bolts);
    let rated = |n: usize| !bolt_zone.get(n).copied().unwrap_or(false);

    // --- Spannungen und Reaktionen -------------------------------------------
    progress.report("Spannungen berechnen", None);
    // Festigkeiten Wand (Werkstoff) und Kern (Infill): je Elementknoten (Fließen gesamt, Schicht, Bruch)
    let zone_strength = zones.as_ref().map(|(_, core, _)| {
        (
            crate::results::Strength::of(&model.material, false),
            crate::results::Strength::of(&model.material, true),
            crate::results::Strength::of(core, false),
            crate::results::Strength::of(core, true),
        )
    });
    type ZoneUtil = Vec<[f64; 6]>;
    let per_elem: Vec<(Vec<[f64; 6]>, Vec<f64>, Option<ZoneUtil>)> = (0..mesh.n_elems())
        .into_par_iter()
        .map(|e| {
            let coords = mesh.elem_coords(e);
            let ue: Vec<f64> = mesh.elem(e).iter().flat_map(|&n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect();
            let de = elem_d(e);
            let ke = tet_stiffness(&coords, &de).expect("bereits geprüft");
            let fe = ke * nalgebra::DVector::from_column_slice(&ue);
            // Wand und Kern haben dieselbe Dehnung, aber eigene Spannung und Festigkeit
            let zu = match (&zones, &zone_strength) {
                (Some((_, _, dc)), Some((sw, swb, sc, scb))) => {
                    let sig_w = tet_nodal_stress(&coords, &ue, &d);
                    let sig_c = tet_nodal_stress(&coords, &ue, dc);
                    let ev = |st: &Option<crate::results::Strength>, s: &[f64; 6]| st.as_ref().map(|t| t.eval(s)).unwrap_or((0.0, 0.0));
                    Some(
                        sig_w
                            .iter()
                            .zip(&sig_c)
                            .map(|(w, c)| {
                                let (uw, lw) = ev(sw, w);
                                let (uc, lc) = ev(sc, c);
                                [uw, lw, ev(swb, w).0, uc, lc, ev(scb, c).0]
                            })
                            .collect(),
                    )
                }
                _ => None,
            };
            (tet_nodal_stress(&coords, &ue, &de), fe.as_slice().to_vec(), zu)
        })
        .collect();

    let mut stress = vec![[0.0; 6]; n_nodes];
    let mut count = vec![0u32; n_nodes];
    let mut f_int = vec![0.0; ndof];
    for (e, (s, fe, _)) in per_elem.iter().enumerate() {
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
    // Kräfte der Schweißnaht-Kopplungen gehören zu den inneren Kräften (Lagerkräfte an Nahtknoten)
    if let Some(p) = &welds {
        for t in &p.ties {
            let k = t.stiffness();
            let ut: Vec<f64> = t.nodes.iter().flat_map(|&n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect();
            let ft = k * nalgebra::DVector::from_column_slice(&ut);
            for (a, &n) in t.nodes.iter().enumerate() {
                for c in 0..3 {
                    f_int[3 * n + c] += ft[3 * a + c];
                }
            }
        }
    }

    // Schraubenkräfte gehören ebenfalls zu den inneren Kräften (mit Vorspannweg: K·u − Last aus k·s)
    for (p, &fv) in bolts.iter().zip(&preloads) {
        let k = p.stiffness();
        let ut: Vec<f64> = p.nodes.iter().flat_map(|&n| [u[3 * n], u[3 * n + 1], u[3 * n + 2]]).collect();
        let mut ft = k * nalgebra::DVector::from_column_slice(&ut);
        if fv > 0.0 {
            ft -= p.tension_forces(p.k_ax * p.offset);
        }
        for (a, &n) in p.nodes.iter().enumerate() {
            for c in 0..3 {
                f_int[3 * n + c] += ft[3 * a + c];
            }
        }
    }
    // Kontaktkräfte ebenso
    if let Some(c) = &contact {
        c.add_internal(&u, &mut f_int);
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

    let (utilization, utilization_layers, safety_break, utilization_infill, shell_fraction) = match &zones {
        // Baugruppe mit verschiedenen Werkstoffen: Auslastung je Element mit seinem Werkstoff, am Knoten gemittelt
        None if !body_mat.is_empty() => {
            let mats: Vec<&crate::Material> = std::iter::once(&model.material).chain(model.body_materials.iter().map(|(_, m)| m)).collect();
            let st: Vec<_> = mats.iter().map(|m| (crate::results::Strength::of(m, false), crate::results::Strength::of(m, true))).collect();
            let mut acc = vec![[0.0f64; 3]; n_nodes];
            let mut cnt = vec![0u32; n_nodes];
            for (e, (s, _, _)) in per_elem.iter().enumerate() {
                let k = body_mat[e].map(|i| i + 1).unwrap_or(0);
                for (a, &n) in mesh.elem(e).iter().enumerate() {
                    if let Some(t) = &st[k].0 {
                        let (u, l) = t.eval(&s[a]);
                        acc[n][0] += u;
                        acc[n][1] += l;
                    }
                    if let Some(t) = &st[k].1 {
                        acc[n][2] += t.eval(&s[a]).0;
                    }
                    cnt[n] += 1;
                }
            }
            let avg = |n: usize, c: usize| {
                if cnt[n] > 0 {
                    acc[n][c] / cnt[n] as f64
                } else {
                    0.0
                }
            };
            let has = st.iter().any(|x| x.0.is_some());
            let has_brk = st.iter().any(|x| x.1.is_some());
            let layered = mats.iter().any(|m| m.layers.is_some());
            let brk = (0..n_nodes).filter(|&n| rated(n)).map(|n| avg(n, 2)).fold(0.0, f64::max);
            (
                has.then(|| (0..n_nodes).map(|n| avg(n, 0)).collect()),
                (has && layered).then(|| (0..n_nodes).map(|n| avg(n, 1)).collect()),
                (has_brk && brk > 0.0).then(|| 1.0 / brk),
                None,
                None,
            )
        }
        None => {
            let util = crate::results::utilization(&model.material, &stress, false);
            let safety_break = crate::results::utilization(&model.material, &stress, true)
                .map(|(u, _)| 1.0 / u.iter().enumerate().filter(|(n, _)| rated(*n)).map(|(_, v)| *v).fold(0.0, f64::max).max(1e-300));
            match util {
                Some((u, l)) => (Some(u), l, safety_break, None, None),
                None => (None, None, safety_break, None, None),
            }
        }
        Some((frac, _, _)) => {
            // Knotenwerte: Wand und Kern getrennt gemittelt (gewichtet mit ihrem Anteil im Element)
            let mut acc = vec![[0.0f64; 8]; n_nodes]; // wΣ, Wand ges, Wand Schicht, Wand Bruch, kΣ, Kern ges, Kern Schicht, Kern Bruch
            let mut shell = vec![0.0f64; n_nodes];
            for (e, (_, _, zu)) in per_elem.iter().enumerate() {
                let f = frac[e];
                for (a, &n) in mesh.elem(e).iter().enumerate() {
                    let z = zu.as_ref().expect("Zonen")[a];
                    let r = &mut acc[n];
                    r[0] += f;
                    r[1] += f * z[0];
                    r[2] += f * z[1];
                    r[3] += f * z[2];
                    r[4] += 1.0 - f;
                    r[5] += (1.0 - f) * z[3];
                    r[6] += (1.0 - f) * z[4];
                    r[7] += (1.0 - f) * z[5];
                    shell[n] += f;
                }
            }
            let avg = |sum: f64, w: f64| if w > 1e-12 { sum / w } else { 0.0 };
            // Knoten auf der Oberfläche liegen immer in der Wand bzw. Deckschicht
            let mut on_surface = vec![false; n_nodes];
            for f in &faces {
                for &n in &f.nodes {
                    on_surface[n] = true;
                }
            }
            for (n, r) in acc.iter_mut().enumerate() {
                if on_surface[n] && r[0] > 1e-12 {
                    r[4] = 0.0;
                }
            }
            let wall: Vec<f64> = acc.iter().map(|r| avg(r[1], r[0])).collect();
            let core: Vec<f64> = acc.iter().map(|r| avg(r[5], r[4])).collect();
            let total: Vec<f64> = wall.iter().zip(&core).map(|(a, b)| a.max(*b)).collect();
            let layered = model.material.layers.is_some();
            let lay = layered.then(|| acc.iter().map(|r| avg(r[2], r[0]).max(avg(r[6], r[4]))).collect());
            let brk = acc.iter().map(|r| avg(r[3], r[0]).max(avg(r[7], r[4]))).fold(0.0, f64::max);
            let has_brk = model.material.tensile_strength.is_some();
            let shell: Vec<f64> = shell
                .iter()
                .zip(&count)
                .enumerate()
                .map(|(n, (s, &c))| if on_surface[n] { 1.0 } else if c > 0 { s / c as f64 } else { 0.0 })
                .collect();
            let has = model.material.strengths(false).is_some();
            (
                has.then_some(total),
                if has { lay } else { None },
                (has_brk && brk > 0.0).then(|| 1.0 / brk),
                has.then_some(core),
                Some(shell),
            )
        }
    };

    // gefülltes Volumen (für die Masse)
    let solid_volume: f64 = (0..mesh.n_elems())
        .map(|e| {
            let v = crate::element::tet_volume(&mesh.elem_coords(e)[..4]).abs();
            match (&zones, &model.material.infill) {
                (Some((f, _, _)), Some(inf)) => v * (f[e] + (1.0 - f[e]) * inf.density),
                _ => v,
            }
        })
        .sum();

    let welds = welds.map(|p| crate::weld::evaluate(model, &p, &u)).unwrap_or_default();

    // Baugruppe: Kennwerte je Körper – Spannungen nur über die Elemente des Körpers gemittelt
    let mut bodies = Vec::new();
    let body_ids = mesh.bodies();
    // Knoten → Körper (Bitmaske), für die Kräfte an gemeinsamen Flächen
    let node_bodies: Vec<u64> = if body_ids.len() > 1 && body_ids.len() <= 64 {
        let mut nb = vec![0u64; n_nodes];
        for e in 0..mesh.n_elems() {
            let bit = 1u64 << body_ids.binary_search(&mesh.body_of(e)).unwrap_or(0);
            for &n in mesh.elem(e) {
                nb[n] |= bit;
            }
        }
        nb
    } else {
        vec![]
    };
    if body_ids.len() > 1 {
        let mut buf = vec![[0.0f64; 6]; n_nodes];
        let mut cnt = vec![0u32; n_nodes];
        let mut touched = Vec::new();
        for &b in &body_ids {
            let mut volume = 0.0;
            let mut mat = &model.material;
            let me = body_ids.binary_search(&b).unwrap_or(0);
            let mut iface = vec![[0.0f64; 3]; body_ids.len()];
            for e in (0..mesh.n_elems()).filter(|&e| mesh.body_of(e) == b) {
                // innere Knotenkräfte dieses Körpers an Knoten, die er mit anderen Körpern teilt = Kraft der anderen auf ihn
                if !node_bodies.is_empty() {
                    for (a, &n) in mesh.elem(e).iter().enumerate() {
                        let others = node_bodies[n] & !(1u64 << me);
                        if others != 0 {
                            let j = others.trailing_zeros() as usize;
                            for c in 0..3 {
                                iface[j][c] += per_elem[e].1[3 * a + c];
                            }
                        }
                    }
                }
                mat = model.material_of(e);
                volume += crate::element::tet_volume(&mesh.elem_coords(e)[..4]).abs();
                for (a, &n) in mesh.elem(e).iter().enumerate() {
                    if cnt[n] == 0 {
                        touched.push(n);
                    }
                    cnt[n] += 1;
                    for c in 0..6 {
                        buf[n][c] += per_elem[e].0[a][c];
                    }
                }
            }
            let strength = crate::results::Strength::of(mat, false);
            let (mut vm_max, mut u_max, mut util_max) = (0.0f64, 0.0f64, 0.0f64);
            for &n in &touched {
                let s: [f64; 6] = std::array::from_fn(|c| buf[n][c] / cnt[n] as f64);
                u_max = u_max.max((u[3 * n].powi(2) + u[3 * n + 1].powi(2) + u[3 * n + 2].powi(2)).sqrt());
                if !rated(n) {
                    buf[n] = [0.0; 6];
                    cnt[n] = 0;
                    continue;
                }
                vm_max = vm_max.max(von_mises(&s));
                if let Some(t) = &strength {
                    util_max = util_max.max(t.eval(&s).0);
                }
                buf[n] = [0.0; 6];
                cnt[n] = 0;
            }
            touched.clear();
            bodies.push(crate::results::BodyResult {
                body: b,
                name: mesh.body_name(b),
                material: mat.name.clone(),
                volume,
                max_von_mises: vm_max,
                max_displacement: u_max,
                safety: strength.map(|_| 1.0 / util_max.max(1e-300)),
                interfaces: iface
                    .iter()
                    .enumerate()
                    .filter(|(j, f)| *j != me && f.iter().any(|v| v.abs() > 0.0))
                    .map(|(j, f)| (body_ids[j], *f))
                    .collect(),
            });
        }
    }

    let bolt_results = model.bolts.iter().zip(&bolts).map(|(b, p)| crate::bolt::evaluate(b, p, &u)).collect();
    let joints = contact.as_ref().map(|c| c.results()).unwrap_or_default();
    Ok(Results {
        bolts: bolt_results,
        bolt_zone,
        joints,
        contact_passes: contact_iters,
        contact_converged: contact_open_changes == 0,
        bodies,
        welds,
        solid_volume,
        utilization_infill,
        shell_fraction,
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
    extra: &[(Vec<usize>, DMatrix<f64>)],
    cache: &mut DirectCache,
    key: Option<u64>,
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
    let finish = |x: &Col<f64>, mut u: Vec<f64>| -> Result<Vec<f64>> {
        if x.iter().any(|v| !v.is_finite()) {
            return Err(FemError::Underconstrained);
        }
        for i in 0..ndof {
            if eq[i] != usize::MAX {
                u[i] = x[eq[i]];
            }
        }
        Ok(u)
    };
    // gleiche Matrix wie zuletzt (nur andere rechte Seite): Zerlegung wiederverwenden
    if let (Some(k), Some((fk, llt, b_presc, up))) = (key, &cache.factor) {
        if *fk == k && *up == u_presc {
            let mut b = b_presc.clone();
            for i in 0..ndof {
                if eq[i] != usize::MAX {
                    b[eq[i]] += f_ext[i];
                }
            }
            return finish(&llt.solve(&b), u_presc);
        }
    }

    // --- Assemblierung (parallel je Element) -------------------------------
    let npe = mesh.npe;
    let n_elem = mesh.n_elems();
    let per_elem: Vec<Result<(Vec<Triplet<usize, usize, f64>>, Vec<(usize, f64)>)>> = (0..n_elem + extra.len())
        .into_par_iter()
        .map(|e| {
            let (ke, nodes): (DMatrix<f64>, &[usize]) =
                if e < n_elem { (elem_k(e)?, mesh.elem(e)) } else { (extra[e - n_elem].1.clone(), &extra[e - n_elem].0) };
            let dofs: Vec<usize> = nodes.iter().flat_map(|&n| [3 * n, 3 * n + 1, 3 * n + 2]).collect();
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

    // rechte Seite: Anteil aus vorgegebenen Verschiebungen getrennt (bleibt bei gleicher Matrix gleich)
    let mut b_presc = Col::<f64>::zeros(neq);
    let mut triplets = Vec::new();
    for r in per_elem {
        let (t, rhs) = r?;
        triplets.extend(t);
        for (i, v) in rhs {
            b_presc[i] += v;
        }
    }
    let mut b = b_presc.clone();
    for i in 0..ndof {
        if eq[i] != usize::MAX {
            b[eq[i]] += f_ext[i];
        }
    }

    let t_asm = std::time::Instant::now();
    let k = SparseColMat::<usize, f64>::try_new_from_triplets(neq, neq, &triplets)
        .map_err(|e| FemError::Input(format!("Matrixaufbau fehlgeschlagen: {e:?}")))?;
    drop(triplets);
    // symbolische Zerlegung (Umordnung) bei gleichem Besetzungsmuster wiederverwenden
    let same = matches!(&cache.pattern, Some((cp, ri, _)) if cp.as_slice() == k.col_ptr() && ri.as_slice() == k.row_idx());
    if !same {
        let sym = SymbolicLlt::try_new(k.symbolic(), Side::Lower).map_err(|_| FemError::Underconstrained)?;
        cache.pattern = Some((k.col_ptr().to_vec(), k.row_idx().to_vec(), sym));
    }
    let sym = cache.pattern.as_ref().map(|p| p.2.clone()).expect("gesetzt");
    let t_num = std::time::Instant::now();
    let llt = Llt::try_new_with_symbolic(sym, k.as_ref(), Side::Lower).map_err(|_| FemError::Underconstrained)?;
    let t_sol = std::time::Instant::now();
    let x = llt.solve(&b);
    if std::env::var("FEM_KONTAKT_DEBUG").is_ok() {
        eprintln!(
            "  direkt: Matrix {:.2?}, Symbolik {} {:.2?}, Zerlegung {:.2?}, Lösen {:.2?}, {} Einträge",
            t_num - t_asm,
            same,
            t_num.elapsed() - t_sol.elapsed(),
            t_sol - t_num,
            t_sol.elapsed(),
            k.compute_nnz()
        );
    }
    let u = finish(&x, u_presc.clone())?;
    cache.factor = key.map(|k| (k, llt, b_presc, u_presc));
    Ok(u)
}

/// iterativer Löser über mehrere Durchgänge: Vorkonditionierer bei gleicher Matrix, letzte Lösung als Startwert
#[derive(Default)]
pub(crate) struct PcgCache {
    amg: Option<(u64, crate::amg::Amg, Vec<f64>, Vec<Option<f64>>)>,
    x_last: Option<Vec<f64>>,
    /// Iterationen mit frisch aufgebautem Vorkonditionierer (Vergleich, ob die behaltenen Gitter noch taugen)
    fresh_iters: Option<usize>,
    rebuild: bool,
}

/// Zerlegungen für mehrere Rechnungen mit gleichem Besetzungsmuster (Durchgänge für Kontakt und Vorspannung)
#[derive(Default)]
pub(crate) struct DirectCache {
    pattern: Option<(Vec<usize>, Vec<usize>, SymbolicLlt<usize>)>,
    factor: Option<(u64, Llt<usize, f64>, Col<f64>, Vec<f64>)>,
}

/// Kopplungen der Schweißnähte als Zusatzelemente (Knoten, Steifigkeit in den Knotenbasen)
pub(crate) fn bolt_elements(bolts: &[crate::bolt::Prepared], frames: &NodeFrames) -> Vec<(Vec<usize>, DMatrix<f64>)> {
    bolts
        .iter()
        .map(|p| {
            let mut k = p.stiffness();
            frames.transform_element(&p.nodes, &mut k);
            (p.nodes.clone(), k)
        })
        .collect()
}

pub(crate) fn tie_elements(welds: Option<&crate::weld::Prepared>, frames: &NodeFrames) -> Vec<(Vec<usize>, DMatrix<f64>)> {
    welds
        .map(|p| {
            p.ties
                .iter()
                .map(|t| {
                    let mut k = t.stiffness();
                    frames.transform_element(&t.nodes, &mut k);
                    (t.nodes.clone(), k)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Lagerbedingungen: vorgegebene Freiheitsgrade (lokal an Knoten mit eigener Basis), Knoten je Lager, Knotenbasen
pub(crate) struct Constraints {
    pub prescribed: Vec<Option<f64>>,
    pub support_nodes: Vec<(String, Vec<usize>)>,
    pub frames: NodeFrames,
}

pub(crate) fn constraints(model: &Model, faces: &[Face]) -> Result<Constraints> {
    let mesh = &model.mesh;
    let n_nodes = mesh.nodes.len();
    let ndof = 3 * n_nodes;
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

    Ok(Constraints { prescribed, support_nodes, frames })
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

    /// lokale Komponenten an Knoten mit eigener Basis in globale umrechnen
    pub(crate) fn to_global_pub(&self, v: &mut [f64]) {
        self.apply(v, true)
    }

    /// Elementsteifigkeit in die Knotenbasen drehen: K'_ab = R_a · K_ab · R_bᵀ
    pub(crate) fn transform_element(&self, nodes: &[usize], ke: &mut DMatrix<f64>) {
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
        Load::Flow { direction, pressure, .. } => {
            let d = Vector3::from(*direction);
            let d = d / d.norm().max(1e-300);
            let p = *pressure;
            // nur angeströmte Flächen (Außennormale gegen die Strömung): Druck drückt aufs Bauteil
            Box::new(move |q| {
                let n = q.nda.normalize();
                if n.dot(&d) < 0.0 {
                    -n * p
                } else {
                    Vector3::zeros()
                }
            })
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
    fn stroemung_kraft_gleich_druck_mal_projektion() {
        // Quader 40 × 20 × 4, Strömung schräg in der xy-Ebene: angeströmt Stirn (20·4) und Seite (40·4)
        let d = Vector3::new(1.0, 2.0, 0.0).normalize();
        let all = Selection::Box { min: [-1.0, -1.0, -1.0], max: [41.0, 21.0, 5.0] };
        let model = platte().group("alles", all).load(Load::Flow { group: "alles".into(), direction: d.into(), pressure: 0.01 });
        let f = load_vector(&model, &model.mesh.boundary_faces()).unwrap();
        let (fs, _) = resultant(&model, &f, [0.0; 3]);
        // Kraft je angeströmter Fläche = p·A in Richtung −n: Stirn x=0 → +x·80·p, Seite y=0 → +y·160·p
        assert!((fs - Vector3::new(0.8, 1.6, 0.0)).norm() < 1e-9, "{fs:?}");
        // Anteil in Strömungsrichtung = p · projizierte Fläche (80·cos α + 160·sin α)
        let proj = 80.0 * d.x + 160.0 * d.y;
        assert!((fs.dot(&d) - 0.01 * proj).abs() < 1e-9);
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
