//! Validierung gegen Lehrbuchlösungen. Läuft als Test (`cargo test`) und
//! über die Kommandozeile (`projekt-fem validieren`).

use crate::generate::box_mesh;
use crate::model::{Axis, Fix, Load, Model, Selection};
use crate::{solve, Material, Order, Result};

#[derive(Debug, Clone)]
pub struct Check {
    pub case: String,
    pub quantity: String,
    pub fem: f64,
    pub theory: f64,
    /// zulässige relative Abweichung
    pub tolerance: f64,
}

impl Check {
    pub fn rel_error(&self) -> f64 {
        (self.fem - self.theory) / self.theory.abs().max(1e-300)
    }

    pub fn passed(&self) -> bool {
        self.rel_error().abs() <= self.tolerance
    }
}

fn mean(it: impl Iterator<Item = f64>) -> f64 {
    let (s, n) = it.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    s / n as f64
}

/// Zugstab mit Symmetrielagerung: einachsiger Spannungszustand, exakt lösbar.
/// σ = F/A, Δl = F·l/(E·A), Querkontraktion Δb = −ν·ε·b
pub fn zugstab(order: Order) -> Result<Vec<Check>> {
    let (l, b, h, f) = (100.0, 10.0, 10.0, 1000.0);
    let mat = Material::steel();
    let model = Model::new(box_mesh([l, b, h], [10, 2, 2], order)?, mat.clone())
        .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
        .group("y0", Selection::Plane { axis: Axis::Y, value: 0.0 })
        .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group("ende", Selection::Plane { axis: Axis::X, value: l })
        .support("x0", Fix::only(Axis::X))
        .support("y0", Fix::only(Axis::Y))
        .support("z0", Fix::only(Axis::Z))
        .load(Load::Force { group: "ende".into(), force: [f, 0.0, 0.0] });
    let res = solve(&model)?;
    let m = &model.mesh;
    let tol = m.tolerance();
    let a = b * h;
    let eps = f / (a * mat.e);
    let name = format!("Zugstab ({})", order_name(order));
    let sxx_max = res.stress.iter().map(|s| s[0]).fold(f64::NEG_INFINITY, f64::max);
    let sxx_min = res.stress.iter().map(|s| s[0]).fold(f64::INFINITY, f64::min);
    Ok(vec![
        check(&name, "σx max [MPa]", sxx_max, f / a, 1e-6),
        check(&name, "σx min [MPa]", sxx_min, f / a, 1e-6),
        check(
            &name,
            "Δl [mm]",
            mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| (p[0] - l).abs() < tol).map(|(_, u)| u[0])),
            f * l / (mat.e * a),
            1e-6,
        ),
        check(
            &name,
            "Δb Querkontraktion [mm]",
            mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| (p[1] - b).abs() < tol).map(|(_, u)| u[1])),
            -mat.nu * eps * b,
            1e-6,
        ),
        check(&name, "Lagerkraft Fx [N]", -res.reactions[0].1[0], f, 1e-6),
    ])
}

/// Kragbalken mit Einzellast am Ende (Timoshenko-Balken als Referenz).
/// w = F·l³/(3·E·I) + F·l/(κ·G·A), σ(l/2) = F·(l/2)/W
pub fn kragbalken(order: Order, cells: [usize; 3]) -> Result<Vec<Check>> {
    let (l, b, h, f) = (200.0, 10.0, 10.0, 100.0);
    let mat = Material::steel();
    let model = Model::new(box_mesh([l, b, h], cells, order)?, mat.clone())
        .group("einspannung", Selection::Plane { axis: Axis::X, value: 0.0 })
        .group("ende", Selection::Plane { axis: Axis::X, value: l })
        .support("einspannung", Fix::all())
        .load(Load::Force { group: "ende".into(), force: [0.0, 0.0, -f] });
    let res = solve(&model)?;
    let m = &model.mesh;
    let tol = m.tolerance();
    let i = b * h.powi(3) / 12.0;
    let w_theory = f * l.powi(3) / (3.0 * mat.e * i) + f * l / (5.0 / 6.0 * mat.shear_modulus() * b * h);
    let w_fem = -mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| (p[0] - l).abs() < tol).map(|(_, u)| u[2]));
    let sigma_fem = mean(
        m.nodes
            .iter()
            .zip(&res.stress)
            .filter(|(p, _)| (p[0] - l / 2.0).abs() < tol && (p[2] - h).abs() < tol)
            .map(|(_, s)| s[0]),
    );
    let name = format!("Kragbalken ({}, {}×{}×{} Zellen)", order_name(order), cells[0], cells[1], cells[2]);
    Ok(vec![
        check(&name, "Durchbiegung Ende [mm]", w_fem, w_theory, 0.02),
        check(&name, "Biegespannung σx bei l/2 oben [MPa]", sigma_fem, f * (l / 2.0) / (b * h * h / 6.0), 0.03),
        check(&name, "Lagerkraft Fz [N]", res.reactions[0].1[2], f, 1e-6),
    ])
}

/// Zugstab mit Mittelbohrung (STEP-Geometrie, Gmsh-Netz), Kerbspannung nach Peterson:
/// σmax = Kt · F / ((W − d) · t),  Kt = 3 − 3,14·(d/W) + 3,667·(d/W)² − 1,527·(d/W)³
pub fn lochplatte(step: &std::path::Path) -> Result<Vec<Check>> {
    let (l, w, t, d, f): (f64, f64, f64, f64, f64) = (200.0, 50.0, 5.0, 10.0, 2000.0);
    let opts = crate::gmsh::MeshOptions { size: Some(2.5), curvature_points: 48, ..Default::default() };
    let model = Model::new(crate::gmsh::mesh_step(step, &opts)?, Material::steel())
        .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
        .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group("ende", Selection::Plane { axis: Axis::X, value: l })
        .support("x0", Fix { x: Some(0.0), y: Some(0.0), z: None })
        .support("z0", Fix::only(Axis::Z))
        .load(Load::Force { group: "ende".into(), force: [f, 0.0, 0.0] });
    let res = solve(&model)?;
    let r = d / w;
    let kt = 3.0 - 3.14 * r + 3.667 * r * r - 1.527 * r.powi(3);
    // Die Formel gilt für den ebenen Spannungszustand → Mittelwert über die Dicke am Lochrand.
    // (Über die Dicke schwankt σx im 3D-Modell um einige Prozent – echter 3D-Effekt.)
    let tol = 0.01 * d;
    let edge = model.mesh.nodes.iter().zip(&res.stress).filter(|(p, _)| {
        (p[0] - l / 2.0).abs() < tol && ((p[1] - (w - d) / 2.0).abs() < tol || (p[1] - (w + d) / 2.0).abs() < tol)
    });
    let sxx_edge = mean(edge.map(|(_, s)| s[0]));
    let name = format!("Lochplatte d/W = {r} (STEP, Gmsh, {} Elemente)", model.mesh.n_elems());
    Ok(vec![
        check(&name, "Kerbspannung σx am Lochrand, Mittel über Dicke [MPa]", sxx_edge, kt * f / ((w - d) * t), 0.02),
        check(&name, "Lagerkraft Fx [N]", -res.total_reaction[0], f, 1e-6),
    ])
}

/// Welle Ø20 × 100 (STEP, Gmsh), bei z = 0 eingespannt.
/// a) Torsionsmoment T auf der Stirnfläche: τ = 16·T/(π·d³), Verdrehwinkel φ = T·L/(G·Ip)
/// b) Lagerlast F (nur halber Umfang belastet) auf dem Wellenabschnitt z = 80…100:
///    Biegespannung bei z = 50: σ = F·(90 − 50)/W, W = π·d³/32
pub fn welle(step: &std::path::Path) -> Result<Vec<Check>> {
    use crate::region::Region;
    let (d, l, t, f): (f64, f64, f64, f64) = (20.0, 100.0, 100_000.0, 1000.0);
    let opts = crate::gmsh::MeshOptions { size: Some(2.5), curvature_points: 32, ..Default::default() };
    let mesh = crate::gmsh::mesh_step(step, &opts)?;
    let mat = Material::steel();
    let tol = 0.01 * d;
    let on_surface = |p: &[f64; 3]| ((p[0] * p[0] + p[1] * p[1]).sqrt() - d / 2.0).abs() < tol;
    let name = format!("Welle Ø{d} (STEP, Gmsh, {} Elemente)", mesh.n_elems());

    let torsion = Model::new(mesh.clone(), mat.clone())
        .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group("ende", Selection::Plane { axis: Axis::Z, value: l })
        .support("z0", Fix::all())
        .load(Load::Moment { group: "ende".into(), moment: [0.0, 0.0, t] });
    let res = solve(&torsion)?;
    let m = &torsion.mesh;
    let tau = mean(m.nodes.iter().zip(&res.stress).filter(|(p, _)| on_surface(p) && (p[2] - l / 2.0).abs() < 5.0).map(|(_, s)| {
        (s[4] * s[4] + s[5] * s[5]).sqrt()
    }));
    let phi = mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| on_surface(p) && (p[2] - l).abs() < tol).map(|(p, u)| {
        (p[0] * u[1] - p[1] * u[0]) / (p[0] * p[0] + p[1] * p[1])
    }));
    let ip = std::f64::consts::PI * d.powi(4) / 32.0;

    let band = Region::Band {
        origin: [0.0; 3],
        axis: [0.0, 0.0, 1.0],
        reference: [1.0, 0.0, 0.0],
        start: 80.0,
        end: 100.0,
        angle_from: 0.0,
        angle_to: 360.0,
    };
    let bearing = Model::new(mesh, mat.clone())
        .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group_in("mantel", Selection::Box { min: [-d, -d, -1.0], max: [d, d, l + 1.0] }, Some(band))
        .support("z0", Fix::all())
        .load(Load::Bearing { group: "mantel".into(), force: [0.0, f, 0.0] });
    let res_b = solve(&bearing)?;
    let mb = &bearing.mesh;
    let sigma = mean(mb.nodes.iter().zip(&res_b.stress).filter(|(p, _)| (p[1] + d / 2.0).abs() < tol && (p[2] - 50.0).abs() < 2.0).map(|(_, s)| s[2]));
    let w = std::f64::consts::PI * d.powi(3) / 32.0;

    Ok(vec![
        check(&name, "Torsion: τ am Umfang bei l/2 [MPa]", tau, 16.0 * t / (std::f64::consts::PI * d.powi(3)), 0.02),
        check(&name, "Torsion: Verdrehwinkel am Ende [rad]", phi, t * l / (mat.shear_modulus() * ip), 0.02),
        check(&name, "Lagerlast: Summe der Lasten Fy [N]", res_b.total_load[1], f, 1e-6),
        check(&name, "Lagerlast: Biegespannung σz bei z = 50 [MPa]", sigma, f * 40.0 / w, 0.03),
    ])
}

/// Zugstab, beliebig im Raum gedreht, nur über reibungsfreie Auflagen auf den drei (schrägen)
/// Symmetrieflächen gelagert: exakt σ = F/A, Δl = F·l/(E·A).
pub fn zugstab_schraeg(kind: crate::SolverKind) -> Result<Vec<Check>> {
    use crate::model::LocalFix;
    use nalgebra::{Rotation3, Vector3};
    let (l, b, h, f) = (100.0, 10.0, 10.0, 1000.0);
    let mat = Material::steel();
    let mut mesh = box_mesh([l, b, h], [10, 2, 2], Order::Quadratic)?;
    let rot = Rotation3::from_euler_angles(0.4, -0.7, 1.1);
    // Gruppen im ungedrehten Netz bestimmen (Flächenindizes ändern sich durch die Drehung nicht)
    let faces = mesh.boundary_faces();
    let sel = |s: Selection| Selection::Faces(s.select(&mesh, &faces));
    let (x0, y0, z0, ende) = (
        sel(Selection::Plane { axis: Axis::X, value: 0.0 }),
        sel(Selection::Plane { axis: Axis::Y, value: 0.0 }),
        sel(Selection::Plane { axis: Axis::Z, value: 0.0 }),
        sel(Selection::Plane { axis: Axis::X, value: l }),
    );
    for p in mesh.nodes.iter_mut() {
        *p = (rot * Vector3::from(*p)).into();
    }
    let dir = rot * Vector3::x();
    let model = Model::new(mesh, mat.clone())
        .group("x0", x0)
        .group("y0", y0)
        .group("z0", z0)
        .group("ende", ende)
        .support_local("x0", LocalFix::Normal)
        .support_local("y0", LocalFix::Normal)
        .support_local("z0", LocalFix::Normal)
        .load(Load::Force { group: "ende".into(), force: (dir * f).into() })
        .solver(kind);
    let res = solve(&model)?;
    let name = format!("Zugstab schräg im Raum, reibungsfreie Auflagen ({})", if kind == crate::SolverKind::Iterative { "iterativ" } else { "direkt" });
    let vm_max = res.von_mises.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let vm_min = res.von_mises.iter().copied().fold(f64::INFINITY, f64::min);
    let dl = res.displacement.iter().map(|u| Vector3::from(*u).dot(&dir)).fold(f64::NEG_INFINITY, f64::max);
    Ok(vec![
        check(&name, "Vergleichsspannung max [MPa]", vm_max, f / (b * h), 1e-5),
        check(&name, "Vergleichsspannung min [MPa]", vm_min, f / (b * h), 1e-5),
        check(&name, "Δl [mm]", dl, f * l / (mat.e * b * h), 1e-5),
        check(&name, "Lagerkraft in Stabrichtung [N]", -Vector3::from(res.total_reaction).dot(&dir), f, 1e-6),
    ])
}

/// Balken mit zwei Bolzenbohrungen als Gelenke (zylindrische Lagerung: radial + axial fest, drehbar),
/// Einzellast in der Mitte: Einfeldträger, w = F·L³/(48·E·I) + F·L/(4·κ·G·A), σ(x) = F/2·x / W
pub fn balken_gelenk(step: &std::path::Path) -> Result<Vec<Check>> {
    use crate::model::LocalFix;
    use crate::region::Region;
    let (lb, b, h, f): (f64, f64, f64, f64) = (180.0, 10.0, 20.0, 1000.0);
    let opts = crate::gmsh::MeshOptions { size: Some(2.0), curvature_points: 24, ..Default::default() };
    let mat = Material::steel();
    let pin = |x: f64| LocalFix::Cylindrical { origin: [x, 0.0, h / 2.0], axis: [0.0, 1.0, 0.0], radial: true, tangential: false, axial: true };
    let hole = |x: f64| Selection::Box { min: [x - 4.5, -1.0, h / 2.0 - 4.5], max: [x + 4.5, b + 1.0, h / 2.0 + 4.5] };
    let model = Model::new(crate::gmsh::mesh_step(step, &opts)?, mat.clone())
        .group("bolzen links", hole(10.0))
        .group("bolzen rechts", hole(190.0))
        .group_in(
            "oben mitte",
            Selection::Plane { axis: Axis::Z, value: h },
            Some(Region::Rect { center: [100.0, b / 2.0, h], normal: [0.0, 0.0, 1.0], u: [1.0, 0.0, 0.0], width: 6.0, height: b }),
        )
        .support_local("bolzen links", pin(10.0))
        .support_local("bolzen rechts", pin(190.0))
        .load(Load::Force { group: "oben mitte".into(), force: [0.0, 0.0, -f] });
    let res = solve(&model)?;
    let m = &model.mesh;
    let tol = 0.3;
    let w = -mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| (p[0] - 100.0).abs() < tol && (p[2] - h / 2.0).abs() < 1.0).map(|(_, u)| u[2]));
    let i = b * h.powi(3) / 12.0;
    let w_theory = f * lb.powi(3) / (48.0 * mat.e * i) + f * lb / (4.0 * (5.0 / 6.0) * mat.shear_modulus() * b * h);
    // Biegespannung unten bei x = 70 (Abstand 60 vom linken Bolzen)
    let sigma = mean(m.nodes.iter().zip(&res.stress).filter(|(p, _)| (p[0] - 70.0).abs() < tol && p[2].abs() < 1e-6).map(|(_, s)| s[0]));
    let name = format!("Balken mit zwei Gelenkbolzen (STEP, Gmsh, {} Elemente)", m.n_elems());
    Ok(vec![
        check(&name, "Durchbiegung Mitte [mm]", w, w_theory, 0.04),
        check(&name, "Biegespannung σx unten bei x = 70 [MPa]", sigma, f / 2.0 * 60.0 / (b * h * h / 6.0), 0.03),
        check(&name, "Lagerkraft links Fz [N]", res.reactions[0].1[2], f / 2.0, 0.01),
    ])
}

/// 3D-Druck: Zugstab (PLA-Richtwerte, transversal isotrop), einmal in der Schicht belastet (Aufbaurichtung z),
/// einmal quer zu den Schichten (Aufbaurichtung x). Exakt: Δl = F·l/(A·E), Δb = −ν·σ/E·b, Auslastung = σ/R.
pub fn zugstab_gedruckt() -> Result<Vec<Check>> {
    use crate::material::Layers;
    let (l, b, h, f) = (100.0, 10.0, 10.0, 1000.0);
    let sigma = f / (b * h);
    let mut out = Vec::new();
    for (dir, quer) in [([0.0, 0.0, 1.0], false), ([1.0, 0.0, 0.0], true)] {
        let mat = Material {
            name: "PLA (Richtwerte)".into(),
            e: 3300.0,
            nu: 0.35,
            yield_strength: None,
            tensile_strength: Some(50.0),
            layers: Some(Layers { build_dir: dir, e_z: 2600.0, nu_z: Some(0.3), g_z: None, yield_z: None, tensile_z: Some(28.0), shear_z: None }),
            infill: None,
            density: None,
        };
        let model = Model::new(box_mesh([l, b, h], [10, 2, 2], Order::Quadratic)?, mat.clone())
            .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
            .group("y0", Selection::Plane { axis: Axis::Y, value: 0.0 })
            .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
            .group("ende", Selection::Plane { axis: Axis::X, value: l })
            .support("x0", Fix::only(Axis::X))
            .support("y0", Fix::only(Axis::Y))
            .support("z0", Fix::only(Axis::Z))
            .load(Load::Force { group: "ende".into(), force: [f, 0.0, 0.0] });
        let res = solve(&model)?;
        let dl = res.displacement.iter().map(|u| u[0]).fold(f64::NEG_INFINITY, f64::max);
        let db = res.displacement.iter().map(|u| u[1]).fold(f64::INFINITY, f64::min);
        let (e, nu, r) = if quer { (2600.0, 0.3, 28.0) } else { (3300.0, 0.35, 50.0) };
        let name = format!("3D-Druck-Zugstab {} (PLA-Richtwerte)", if quer { "quer zu den Schichten" } else { "in der Schicht" });
        let u_max = res.max_utilization().map(|(_, u)| u).unwrap_or(0.0);
        out.extend([
            check(&name, "Δl [mm]", dl, f * l / (b * h * e), 1e-6),
            check(&name, "Querkontraktion Δb [mm]", db, -nu * sigma / 3300.0 * b, 1e-6),
            check(&name, "Auslastung", u_max, sigma / r, 1e-6),
        ]);
    }
    Ok(out)
}

/// 3D-Druck mit Füllung: Zugstab 10 × 10 mm, Wand 1 mm, Deck-/Bodenschicht 1 mm, 20 % Gitter-Infill.
/// Wand und Kern arbeiten parallel: E·A = E_Wand·A_Wand + E_Kern·A_Kern (Dehnung im ungestörten Mittelteil).
pub fn zugstab_infill(kind: crate::SolverKind) -> Result<Vec<Check>> {
    use crate::material::{Infill, InfillPattern, Layers};
    let (l, b, h, f) = (100.0, 10.0, 10.0, 1000.0);
    let inf = Infill { pattern: InfillPattern::Gitter, density: 0.2, walls: 2, line_width: 0.5, layer_height: 0.2, top_layers: 5, bottom_layers: 5 };
    let mat = Material {
        name: "PLA (Richtwerte)".into(),
        e: 3300.0,
        nu: 0.35,
        yield_strength: None,
        tensile_strength: Some(50.0),
        layers: Some(Layers { build_dir: [0.0, 0.0, 1.0], e_z: 2600.0, nu_z: None, g_z: None, yield_z: None, tensile_z: Some(28.0), shear_z: None }),
        infill: Some(inf.clone()),
        density: None,
    };
    let core = mat.core_material().expect("Kern");
    let model = Model::new(box_mesh([l, b, h], [20, 10, 10], Order::Quadratic)?, mat.clone())
        .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
        .group("y0", Selection::Plane { axis: Axis::Y, value: 0.0 })
        .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group("ende", Selection::Plane { axis: Axis::X, value: l })
        .support("x0", Fix::only(Axis::X))
        .support("y0", Fix::only(Axis::Y))
        .support("z0", Fix::only(Axis::Z))
        .load(Load::Force { group: "ende".into(), force: [f, 0.0, 0.0] })
        .solver(kind);
    let res = solve(&model)?;
    let m = &model.mesh;
    let ux = |x: f64| mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| (p[0] - x).abs() < 1e-6).map(|(_, u)| u[0]));
    let eps = (ux(75.0) - ux(25.0)) / 50.0;
    let a_core = (b - 2.0 * inf.wall_thickness()) * (h - inf.top_thickness() - inf.bottom_thickness());
    let ea = mat.e * (b * h - a_core) + core.e * a_core;
    let name = format!("3D-Druck-Zugstab mit Wand + 20 % Gitter ({})", if kind == crate::SolverKind::Iterative { "iterativ" } else { "direkt" });
    // Auslastung im Mittelteil: Wand σ = E_Wand·ε gegen Rm, Kern σ = E_Kern·ε gegen Rm·Anteil
    let mid = |p: &[f64; 3]| (p[0] - 50.0).abs() < 1e-6;
    let u_wall = res.utilization.as_ref().map(|u| m.nodes.iter().zip(u).filter(|(p, _)| mid(p) && p[1] < 1e-6).map(|(_, v)| *v).fold(0.0, f64::max)).unwrap_or(0.0);
    let core_r = core.tensile_strength.unwrap();
    let u_core = res.utilization_infill.as_ref().map(|u| m.nodes.iter().zip(u).filter(|(p, _)| mid(p) && (p[1] - 5.0).abs() < 1e-6 && (p[2] - 5.0).abs() < 1e-6).map(|(_, v)| *v).fold(0.0, f64::max)).unwrap_or(0.0);
    Ok(vec![
        check(&name, "Dehnsteifigkeit E·A [N]", f / eps, ea, 1e-4),
        check(&name, "Auslastung Wand (Rand, Mitte)", u_wall, mat.e * eps / 50.0, 1e-3),
        check(&name, "Auslastung Infill (Kern, Mitte)", u_core, core.e * eps / core_r, 1e-3),
    ])
}

/// Kragbalken 200 × 10 × 10 (Stahl, eingespannt): Eigenfrequenzen nach Euler-Bernoulli
/// f_i = (β_i·L)² / (2π·L²) · √(E·I / (ρ·A)), β₁L = 1,8751, β₂L = 4,6941; Querschnitt quadratisch → je zwei gleiche.
/// Euler-Knicken (Fall 1, eingespannt–frei): P_kr = π²·E·I / (4·L²).
pub fn kragbalken_dynamik() -> Result<Vec<Check>> {
    let (l, a) = (200.0, 10.0);
    let mat = Material::steel();
    let rho = 7.85e-9; // t/mm³
    let base = || -> Result<Model> {
        Ok(Model::new(box_mesh([l, a, a], [40, 2, 2], Order::Quadratic)?, mat.clone())
            .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
            .group("ende", Selection::Plane { axis: Axis::X, value: l })
            .support("x0", Fix::all()))
    };
    let i = a.powi(4) / 12.0;
    let area = a * a;
    let f = |bl: f64| bl * bl / (2.0 * std::f64::consts::PI * l * l) * (mat.e * i / (rho * area)).sqrt();
    let modes = crate::dynamics::eigenfrequencies(&base()?, rho, 4)?;
    let name = "Kragbalken 200×10×10 Stahl: Eigenfrequenzen / Knicken (TET10)";
    let f_load = 1000.0;
    let buck = crate::dynamics::buckling(&base()?.load(Load::Force { group: "ende".into(), force: [-f_load, 0.0, 0.0] }), 2)?;
    let p_cr = std::f64::consts::PI.powi(2) * mat.e * i / (4.0 * l * l);
    Ok(vec![
        check(name, "1. Biegeeigenfrequenz [Hz]", modes.values[0], f(1.875_104), 0.02),
        check(name, "1. Biegeeigenfrequenz, 2. Richtung [Hz]", modes.values[1], f(1.875_104), 0.02),
        check(name, "2. Biegeeigenfrequenz [Hz]", modes.values[2], f(4.694_091), 0.03),
        check(name, "Knicklast (Euler Fall 1) [N]", buck.values[0] * f_load, p_cr, 0.02),
    ])
}

/// Stabwerk: Einfeldträger mit Einzellast (w = F·L³/(48·E·I), σ = F·L/4/W) und Fachwerk-Dreieck (Stabkräfte)
pub fn stabwerk() -> Result<Vec<Check>> {
    use crate::frame::*;
    let base = |nodes: Vec<[f64; 3]>, members: Vec<Member>, profile: Profile| Frame {
        nodes,
        members,
        profiles: vec![profile],
        e: 210_000.0,
        nu: 0.3,
        strength: Some(235.0),
        density: 7.85e-9,
        self_weight: false,
        planar: false,
        supports: vec![],
        node_loads: vec![],
        member_loads: vec![],
    };
    let mem = |a, b, truss| Member { a, b, profile: 0, truss, angle: 0.0 };
    let mut f = base(vec![[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0], [2000.0, 0.0, 0.0]], vec![mem(0, 1, false), mem(1, 2, false)], Profile::Rect { b: 40.0, h: 80.0 });
    f.supports = vec![FrameSupport { node: 0, fix: [true, true, true, true, false, false] }, FrameSupport { node: 2, fix: [false, true, true, false, false, false] }];
    f.node_loads = vec![NodeLoad { node: 1, f: [0.0, 0.0, -5000.0], m: [0.0; 3] }];
    let r = solve_frame(&f)?;
    let i = 40.0 * 80f64.powi(3) / 12.0;
    let name = "Stabwerk: Einfeldträger 2 m, Rechteck 40×80, F = 5 kN";
    let mut v = vec![
        check(name, "Durchbiegung Mitte [mm]", -r.displacement[1][2], 5000.0 * 2000f64.powi(3) / (48.0 * 210_000.0 * i), 1e-6),
        check(name, "Biegespannung Mitte [MPa]", r.max_sigma_v, 5000.0 * 500.0 / (40.0 * 80.0 * 80.0 / 6.0), 1e-6),
    ];
    let mut t = base(vec![[0.0, 0.0, 0.0], [2000.0, 0.0, 0.0], [1000.0, 0.0, 1000.0]], vec![mem(0, 1, true), mem(0, 2, true), mem(1, 2, true)], Profile::Round { d: 20.0 });
    t.supports = vec![
        FrameSupport { node: 0, fix: [true, true, true, false, false, false] },
        FrameSupport { node: 1, fix: [false, true, true, false, false, false] },
        FrameSupport { node: 2, fix: [false, true, false, false, false, false] },
    ];
    t.node_loads = vec![NodeLoad { node: 2, f: [0.0, 0.0, -10_000.0], m: [0.0; 3] }];
    let rt = solve_frame(&t)?;
    let name = "Stabwerk: Fachwerk-Dreieck 45°, F = 10 kN";
    v.push(check(name, "Untergurt Zugkraft [N]", rt.members[0].stations[0].n, 5000.0, 1e-6));
    v.push(check(name, "Diagonale Druckkraft [N]", -rt.members[1].stations[0].n, 10_000.0 / 2f64.sqrt(), 1e-6));
    Ok(v)
}

/// Geschweißter Zugstab: zwei Hälften 50 mm mit 0,2 mm Spalt, verschiedene Netze, Stumpfnaht.
/// Die Naht muss die ganze Kraft übertragen, der Stab dehnt sich wie aus einem Stück: Δl = F·l/(E·A).
pub fn zugstab_geschweisst(kind: crate::SolverKind) -> Result<Vec<Check>> {
    let (l, b, f, gap) = (50.0, 10.0, 1000.0, 0.2);
    let mat = Material::steel();
    let mut mesh = box_mesh([l, b, b], [5, 2, 2], Order::Quadratic)?;
    let second = box_mesh([l, b, b], [7, 3, 3], Order::Quadratic)?;
    let off = mesh.nodes.len();
    mesh.nodes.extend(second.nodes.iter().map(|p| [p[0] + l + gap, p[1], p[2]]));
    mesh.conn.extend(second.conn.iter().map(|n| n + off));
    let end = 2.0 * l + gap;
    let mut model = Model::new(mesh, mat.clone())
        .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
        .group("y0", Selection::Plane { axis: Axis::Y, value: 0.0 })
        .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group("ende", Selection::Plane { axis: Axis::X, value: end })
        .group("naht_a", Selection::Plane { axis: Axis::X, value: l })
        .group("naht_b", Selection::Plane { axis: Axis::X, value: l + gap })
        .support("x0", Fix::only(Axis::X))
        .support("y0", Fix::only(Axis::Y))
        .support("z0", Fix::only(Axis::Z))
        .load(Load::Force { group: "ende".into(), force: [f, 0.0, 0.0] })
        .solver(kind);
    model.welds.push(crate::weld::Weld { name: "Naht".into(), a: "naht_a".into(), b: "naht_b".into(), max_gap: None, throat: None });
    let res = solve(&model)?;
    let m = &model.mesh;
    let tol = m.tolerance();
    let dl = mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| (p[0] - end).abs() <= tol).map(|(_, u)| u[0]));
    let w = &res.welds[0];
    let name = format!("Zugstab geschweißt, 0,2 mm Spalt ({})", if kind == crate::SolverKind::Iterative { "iterativ" } else { "direkt" });
    Ok(vec![
        check(&name, "Δl [mm]", dl, f * 2.0 * l / (mat.e * b * b), 5e-3),
        check(&name, "Nahtkraft [N]", w.force[0], f, 1e-3),
        check(&name, "Nahtspannung (a = Blechdicke) [MPa]", w.stress_mean, f / (b * b), 1e-3),
    ])
}

/// Alle Referenzfälle, die bestanden werden müssen. Die Lochplatte nur, wenn Gmsh vorhanden ist.
/// Baugruppe: Zugstab aus zwei Körpern (Stahl x < 50, Alu x > 50), an der Trennfläche verbunden.
/// Δl = F·l₁/(E₁·A) + F·l₂/(E₂·A); Spannung überall F/A; Sicherheit je Körper Re/σ (ν = 0).
pub fn zugstab_zwei_werkstoffe(kind: crate::SolverKind) -> Result<Vec<Check>> {
    let (l, b, h, f) = (100.0, 10.0, 10.0, 1000.0);
    // ν = 0: keine Querdehnung, sonst behindern sich die Körper an der Trennfläche (dann keine exakte Lösung)
    let mut steel = Material::steel();
    steel.nu = 0.0;
    let mut alu = steel.clone();
    alu.name = "Alu".into();
    alu.e = 70000.0;
    alu.yield_strength = Some(200.0);
    let mut mesh = box_mesh([l, b, h], [10, 2, 2], Order::Quadratic)?;
    mesh.elem_body = (0..mesh.n_elems())
        .map(|e| {
            let c = mesh.elem_coords(e);
            if (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4.0 < l / 2.0 { 1 } else { 2 }
        })
        .collect();
    let mut model = Model::new(mesh, steel.clone())
        .group("x0", Selection::Plane { axis: Axis::X, value: 0.0 })
        .group("y0", Selection::Plane { axis: Axis::Y, value: 0.0 })
        .group("z0", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group("ende", Selection::Plane { axis: Axis::X, value: l })
        .support("x0", Fix::only(Axis::X))
        .support("y0", Fix::only(Axis::Y))
        .support("z0", Fix::only(Axis::Z))
        .load(Load::Force { group: "ende".into(), force: [f, 0.0, 0.0] });
    model.body_materials = vec![(2, alu.clone())];
    model.solver = kind;
    let res = solve(&model)?;
    let m = &model.mesh;
    let tol = m.tolerance();
    let a = b * h;
    let name = format!("Zugstab Stahl + Alu ({})", if kind == crate::SolverKind::Iterative { "iterativ" } else { "direkt" });
    let sxx_max = res.stress.iter().map(|s| s[0]).fold(f64::NEG_INFINITY, f64::max);
    let alu_res = res.bodies.iter().find(|r| r.body == 2).ok_or(crate::FemError::Input("Körper fehlt".into()))?;
    Ok(vec![
        check(
            &name,
            "Δl [mm]",
            mean(m.nodes.iter().zip(&res.displacement).filter(|(p, _)| (p[0] - l).abs() < tol).map(|(_, u)| u[0])),
            f * (l / 2.0) / (steel.e * a) + f * (l / 2.0) / (alu.e * a),
            1e-6,
        ),
        check(&name, "σx max [MPa]", sxx_max, f / a, 1e-6),
        check(&name, "Sicherheit Alu-Körper", alu_res.safety.unwrap_or(0.0), 200.0 / (f / a), 1e-6),
        check(&name, "Kraft Stahl → Alu an der Trennfläche [N]", alu_res.interfaces.first().map(|x| -x.1[0]).unwrap_or(0.0), f, 1e-6),
        check(&name, "Lagerkraft Fx [N]", -res.reactions[0].1[0], f, 1e-6),
    ])
}

/// Baugruppe: zwei Blöcke 40×40×10 aufeinander, nur über vier Schrauben M8 (Kopf oben, Mutter unten) verbunden.
/// Unterer Block unten fest, oberer Block oben mit F nach oben gezogen → jede Schraube trägt F/4 Zug, keine Querkraft.
pub fn verschraubt(kind: crate::SolverKind) -> Result<Vec<Check>> {
    let (a, h, f) = (40.0, 10.0, 8000.0);
    let lower = box_mesh([a, a, h], [8, 8, 2], Order::Quadratic)?;
    let upper = box_mesh([a, a, h], [8, 8, 2], Order::Quadratic)?;
    let off = lower.nodes.len();
    let mut nodes = lower.nodes.clone();
    nodes.extend(upper.nodes.iter().map(|p| [p[0], p[1], p[2] + h]));
    let mut conn = lower.conn.clone();
    conn.extend(upper.conn.iter().map(|&n| n + off));
    let elem_body = std::iter::repeat_n(1, lower.n_elems()).chain(std::iter::repeat_n(2, upper.n_elems())).collect();
    let mesh = crate::Mesh { nodes, npe: lower.npe, conn, surface_tags: Default::default(), elem_body, body_names: vec![] };
    let mut model = Model::new(mesh, Material::steel())
        .group("unten", Selection::Plane { axis: Axis::Z, value: 0.0 })
        .group("oben", Selection::Plane { axis: Axis::Z, value: 2.0 * h })
        .support("unten", Fix::all())
        .load(Load::Force { group: "oben".into(), force: [0.0, 0.0, f] });
    for (i, (x, y)) in [(10.0, 10.0), (30.0, 10.0), (10.0, 30.0), (30.0, 30.0)].into_iter().enumerate() {
        model.bolts.push(crate::bolt::Bolt {
            name: format!("Schraube {}", i + 1),
            d: 8.0,
            stress_area: None,
            e: 210000.0,
            origin: [x, y, 2.0 * h],
            axis: [0.0, 0.0, -1.0],
            head_t: 0.0,
            head_d: 13.0,
            nut_t: Some(2.0 * h),
            nut_d: Some(13.0),
            thread_t0: 0.0,
            thread_t1: 0.0,
        });
    }
    model.solver = kind;
    let res = solve(&model)?;
    let name = format!("Verschraubt, 4 × M8 ({})", if kind == crate::SolverKind::Iterative { "iterativ" } else { "direkt" });
    let axial: Vec<f64> = res.bolts.iter().map(|b| b.axial).collect();
    let shear = res.bolts.iter().map(|b| b.shear).fold(0.0, f64::max);
    Ok(vec![
        check(&name, "Summe Schraubenkräfte [N]", axial.iter().sum(), f, 1e-6),
        check(&name, "Schraube 1 Zug [N] (Netz nicht ganz symmetrisch)", axial[0], f / 4.0, 1e-3),
        check(&name, "Schraube 4 Zug [N]", axial[3], f / 4.0, 1e-3),
        check(&name, "1 + größte Querkraft / F", shear / f + 1.0, 1.0, 5e-3),
        check(&name, "Lagerkraft Fz [N]", -res.reactions[0].1[2], f, 1e-6),
    ])
}

pub fn all() -> Result<Vec<Check>> {
    let mut v = zugstab(Order::Linear)?;
    v.extend(zugstab(Order::Quadratic)?);
    v.extend(kragbalken(Order::Quadratic, [20, 2, 2])?);
    v.extend(kragbalken(Order::Quadratic, [40, 2, 4])?);
    let step = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/geometrie/lochplatte.step");
    if crate::gmsh::find_gmsh().is_some() && step.exists() {
        v.extend(lochplatte(&step)?);
    }
    v.extend(zugstab_gedruckt()?);
    v.extend(zugstab_infill(crate::SolverKind::Direct)?);
    v.extend(kragbalken_dynamik()?);
    v.extend(stabwerk()?);
    v.extend(zugstab_schraeg(crate::SolverKind::Direct)?);
    v.extend(zugstab_schraeg(crate::SolverKind::Iterative)?);
    v.extend(zugstab_geschweisst(crate::SolverKind::Direct)?);
    v.extend(zugstab_geschweisst(crate::SolverKind::Iterative)?);
    v.extend(zugstab_zwei_werkstoffe(crate::SolverKind::Direct)?);
    v.extend(zugstab_zwei_werkstoffe(crate::SolverKind::Iterative)?);
    v.extend(verschraubt(crate::SolverKind::Direct)?);
    v.extend(verschraubt(crate::SolverKind::Iterative)?);
    let step = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/geometrie/balken_gelenk.step");
    if crate::gmsh::find_gmsh().is_some() && step.exists() {
        v.extend(balken_gelenk(&step)?);
    }
    let step = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/geometrie/welle.step");
    if crate::gmsh::find_gmsh().is_some() && step.exists() {
        v.extend(welle(&step)?);
    }
    Ok(v)
}

fn check(case: &str, quantity: &str, fem: f64, theory: f64, tolerance: f64) -> Check {
    Check { case: case.into(), quantity: quantity.into(), fem, theory, tolerance }
}

fn order_name(o: Order) -> &'static str {
    match o {
        Order::Linear => "TET4",
        Order::Quadratic => "TET10",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn referenzfaelle() {
        let checks = super::all().unwrap();
        let failed: Vec<_> = checks.iter().filter(|c| !c.passed()).collect();
        for c in &checks {
            println!("{:45} {:38} FEM {:>12.6} Theorie {:>12.6} ({:+.3} %)", c.case, c.quantity, c.fem, c.theory, 100.0 * c.rel_error());
        }
        assert!(failed.is_empty(), "nicht bestanden: {failed:#?}");
    }
}
