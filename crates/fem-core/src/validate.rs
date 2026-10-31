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

/// Alle Referenzfälle, die bestanden werden müssen. Die Lochplatte nur, wenn Gmsh vorhanden ist.
pub fn all() -> Result<Vec<Check>> {
    let mut v = zugstab(Order::Linear)?;
    v.extend(zugstab(Order::Quadratic)?);
    v.extend(kragbalken(Order::Quadratic, [20, 2, 2])?);
    v.extend(kragbalken(Order::Quadratic, [40, 2, 4])?);
    let step = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/geometrie/lochplatte.step");
    if crate::gmsh::find_gmsh().is_some() && step.exists() {
        v.extend(lochplatte(&step)?);
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
