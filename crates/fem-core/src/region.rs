//! Wirkbereiche: Teil einer Fläche, auf dem eine Last (oder ein Lager) wirkt,
//! z. B. ein Kreis oder Rechteck auf einer ebenen Fläche oder ein Abschnitt einer Welle.

use nalgebra::{Matrix3, SymmetricEigen, Vector3};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "lowercase")]
pub enum Region {
    /// Kreis in der Ebene durch `center` mit Normale `normal`
    /// (wirkt auf alles innerhalb des Zylinders senkrecht zur Ebene)
    Circle { center: [f64; 3], normal: [f64; 3], radius: f64 },
    /// Rechteck um `center`, Breite entlang `u`, Höhe entlang `normal × u`
    Rect { center: [f64; 3], normal: [f64; 3], u: [f64; 3], width: f64, height: f64 },
    /// Abschnitt einer Welle/Bohrung: Achse durch `origin` in Richtung `axis`,
    /// axial von `start` bis `end` (Abstand von `origin`), Umfang von `angle_from` bis `angle_to`
    /// in Grad, gemessen von `reference` rechtsdrehend um `axis` (Spanne ≥ 360° = ganzer Umfang)
    Band {
        origin: [f64; 3],
        axis: [f64; 3],
        reference: [f64; 3],
        start: f64,
        end: f64,
        #[serde(default)]
        angle_from: f64,
        #[serde(default = "full_turn")]
        angle_to: f64,
    },
}

fn full_turn() -> f64 {
    360.0
}

fn unit(v: [f64; 3]) -> Vector3<f64> {
    let v = Vector3::from(v);
    v / v.norm().max(1e-300)
}

impl Region {
    /// Liegt der Punkt im Bereich? (`tol`: Längentoleranz an den Rändern)
    pub fn contains(&self, p: [f64; 3], tol: f64) -> bool {
        let p = Vector3::from(p);
        match self {
            Region::Circle { center, normal, radius } => {
                let n = unit(*normal);
                let d = p - Vector3::from(*center);
                (d - n * d.dot(&n)).norm() <= radius + tol
            }
            Region::Rect { center, normal, u, width, height } => {
                let n = unit(*normal);
                let u = unit(*u);
                let u = (u - n * u.dot(&n)).normalize();
                let v = n.cross(&u);
                let d = p - Vector3::from(*center);
                d.dot(&u).abs() <= width / 2.0 + tol && d.dot(&v).abs() <= height / 2.0 + tol
            }
            Region::Band { origin, axis, reference, start, end, angle_from, angle_to } => {
                let a = unit(*axis);
                let d = p - Vector3::from(*origin);
                let s = d.dot(&a);
                if s < start.min(*end) - tol || s > start.max(*end) + tol {
                    return false;
                }
                let span = angle_to - angle_from;
                if span.abs() >= 360.0 - 1e-9 {
                    return true;
                }
                let r = unit(*reference);
                let e1 = (r - a * r.dot(&a)).normalize();
                let e2 = a.cross(&e1);
                let radial = d - a * s;
                let rad = radial.norm();
                let phi = radial.dot(&e2).atan2(radial.dot(&e1)).to_degrees();
                // Winkeltoleranz aus Längentoleranz
                let tol_deg = if rad > 0.0 { (tol / rad).to_degrees() } else { 360.0 };
                let (lo, span) = if span >= 0.0 { (*angle_from, span) } else { (*angle_to, -span) };
                (phi - lo + tol_deg).rem_euclid(360.0) <= span + 2.0 * tol_deg
            }
        }
    }
}

/// Zylinderfläche (Welle oder Bohrung), aus einem Oberflächennetz bestimmt
#[derive(Debug, Clone, Serialize)]
pub struct Cylinder {
    /// Punkt auf der Achse am Anfang der Fläche (axial = 0)
    pub origin: [f64; 3],
    pub axis: [f64; 3],
    pub radius: f64,
    /// Länge der Fläche entlang der Achse
    pub length: f64,
    /// Bezugsrichtung für Winkelangaben (senkrecht zur Achse, möglichst eine Koordinatenachse)
    pub reference: [f64; 3],
    /// Bohrung (Material außen) statt Welle (Material innen)
    pub hole: bool,
}

/// Erkennt eine Zylinderfläche. `points`: Punkte auf der Fläche (z. B. Netzknoten),
/// `normals`: Stichproben (Lage, Außennormale, Flächengewicht).
/// `None`, wenn die Fläche kein Zylinder(ausschnitt) ist.
pub fn fit_cylinder(points: &[[f64; 3]], normals: &[([f64; 3], [f64; 3], f64)]) -> Option<Cylinder> {
    if points.len() < 6 || normals.is_empty() {
        return None;
    }
    // Achse: Richtung, zu der alle Normalen senkrecht stehen (kleinster Eigenwert von Σ n·nᵀ)
    let mut m = Matrix3::zeros();
    let mut wsum = 0.0;
    for (_, n, w) in normals {
        let n = unit(*n);
        m += n * n.transpose() * *w;
        wsum += w;
    }
    let eig = SymmetricEigen::new(m / wsum);
    let mut order = [0, 1, 2];
    order.sort_by(|&i, &j| eig.eigenvalues[i].partial_cmp(&eig.eigenvalues[j]).unwrap());
    let (l0, l1) = (eig.eigenvalues[order[0]], eig.eigenvalues[order[1]]);
    // Normalen müssen senkrecht zur Achse liegen und sich in der Ebene ausreichend drehen (≠ eben)
    if l0 > 1e-6 || l1 < 1e-3 {
        return None;
    }
    let mut a: Vector3<f64> = eig.eigenvectors.column(order[0]).into();
    // Achse möglichst in positive Koordinatenrichtung zeigen lassen
    let big = (0..3).max_by(|&i, &j| a[i].abs().partial_cmp(&a[j].abs()).unwrap()).unwrap();
    if a[big] < 0.0 {
        a = -a;
    }
    // Bezugsrichtung: Koordinatenachse, die am wenigsten parallel zur Achse ist
    let ref_k = (0..3).min_by(|&i, &j| a[i].abs().partial_cmp(&a[j].abs()).unwrap()).unwrap();
    let mut r = Vector3::zeros();
    r[ref_k] = 1.0;
    let e1 = (r - a * r.dot(&a)).normalize();
    let e2 = a.cross(&e1);

    // Kreis in der Ebene ⟂ Achse (algebraische Ausgleichsrechnung: x² + y² + D·x + E·y + F = 0)
    let q: Vec<(f64, f64, f64)> = points
        .iter()
        .map(|p| {
            let p = Vector3::from(*p);
            (p.dot(&e1), p.dot(&e2), p.dot(&a))
        })
        .collect();
    let mut ata = Matrix3::zeros();
    let mut atb = Vector3::zeros();
    for &(x, y, _) in &q {
        let row = Vector3::new(x, y, 1.0);
        ata += row * row.transpose();
        atb += row * -(x * x + y * y);
    }
    let sol = ata.lu().solve(&atb)?;
    let (cx, cy) = (-sol[0] / 2.0, -sol[1] / 2.0);
    let radius = (cx * cx + cy * cy - sol[2]).sqrt();
    if !(radius.is_finite() && radius > 0.0) {
        return None;
    }
    let max_dev = q.iter().map(|&(x, y, _)| (((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - radius).abs()).fold(0.0, f64::max);
    if max_dev > 0.01 * radius {
        return None;
    }
    let (smin, smax) = q.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &(_, _, s)| (lo.min(s), hi.max(s)));
    let origin = e1 * cx + e2 * cy + a * smin;
    // Bohrung: Außennormalen zeigen zur Achse hin
    let mut inward = 0.0;
    for (p, n, w) in normals {
        let d = Vector3::from(*p) - origin;
        let radial = d - a * d.dot(&a);
        inward += radial.dot(&unit(*n)) * w;
    }
    Some(Cylinder {
        origin: origin.into(),
        axis: a.into(),
        radius,
        length: smax - smin,
        reference: e1.into(),
        hole: inward < 0.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kreis_und_rechteck() {
        let c = Region::Circle { center: [1.0, 1.0, 0.0], normal: [0.0, 0.0, 1.0], radius: 2.0 };
        assert!(c.contains([2.9, 1.0, 5.0], 1e-9));
        assert!(!c.contains([3.1, 1.0, 0.0], 1e-9));
        let r = Region::Rect { center: [0.0; 3], normal: [0.0, 0.0, 1.0], u: [1.0, 1.0, 0.0], width: 2.0, height: 1.0 };
        let s = 0.5f64.sqrt();
        assert!(r.contains([0.99 * s, 0.99 * s, 0.0], 1e-9));
        assert!(!r.contains([1.01 * s, 1.01 * s, 0.0], 1e-9));
        assert!(r.contains([-0.49 * s, 0.49 * s, 0.0], 1e-9));
        assert!(!r.contains([-0.51 * s, 0.51 * s, 0.0], 1e-9));
    }

    #[test]
    fn wellenabschnitt_mit_winkel() {
        let b = Region::Band {
            origin: [0.0; 3],
            axis: [0.0, 0.0, 1.0],
            reference: [1.0, 0.0, 0.0],
            start: 2.0,
            end: 5.0,
            angle_from: -90.0,
            angle_to: 90.0,
        };
        assert!(b.contains([1.0, 0.0, 3.0], 1e-9));
        assert!(b.contains([0.0, 1.0, 3.0], 1e-6));
        assert!(!b.contains([-1.0, 0.1, 3.0], 1e-9));
        assert!(!b.contains([1.0, 0.0, 6.0], 1e-9));
        // über 180° hinweg
        let b2 = Region::Band { origin: [0.0; 3], axis: [0.0, 0.0, 1.0], reference: [1.0, 0.0, 0.0], start: 0.0, end: 1.0, angle_from: 150.0, angle_to: 210.0 };
        assert!(b2.contains([-1.0, 0.0, 0.5], 1e-9));
        assert!(!b2.contains([1.0, 0.0, 0.5], 1e-9));
    }

    #[test]
    fn zylinder_erkennen() {
        let (r, cx, cy) = (4.0, 10.0, -3.0);
        let mut pts = Vec::new();
        let mut nrm = Vec::new();
        for i in 0..24 {
            let t = i as f64 / 24.0 * std::f64::consts::TAU;
            for z in [1.0, 3.0, 6.0] {
                pts.push([cx + r * t.cos(), cy + r * t.sin(), z]);
                nrm.push((*pts.last().unwrap(), [-t.cos(), -t.sin(), 0.0], 1.0)); // Bohrung: Normale zur Achse
            }
        }
        let c = fit_cylinder(&pts, &nrm).unwrap();
        assert!((c.radius - r).abs() < 1e-9 && (c.length - 5.0).abs() < 1e-9 && c.hole);
        assert!((c.axis[2] - 1.0).abs() < 1e-12);
        assert!((c.origin[0] - cx).abs() < 1e-9 && (c.origin[1] - cy).abs() < 1e-9 && (c.origin[2] - 1.0).abs() < 1e-9);
        // eben → kein Zylinder
        let flat: Vec<_> = pts.iter().map(|p| [p[0], p[1], 0.0]).collect();
        let up: Vec<_> = flat.iter().map(|p| (*p, [0.0, 0.0, 1.0], 1.0)).collect();
        assert!(fit_cylinder(&flat, &up).is_none());
    }
}
