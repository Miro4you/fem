//! Schrauben, Muttern und Scheiben in Baugruppen erkennen: am Namen aus dem CAD (Normteile wie „ISO 4762 M8x25“,
//! „DIN 934 M8“, „Scheibe ISO 7089“) und an der Form (Schaft = längster Zylinder, Kopf am dickeren Ende).
//! Erkannte Teile werden nicht vernetzt, sondern als Schraubenelement gerechnet (siehe `bolt`).

use nalgebra::{Matrix3, SymmetricEigen, Vector3};

use crate::bolt::Bolt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Bolt,
    Nut,
    Washer,
}

/// Körper der STEP-Datei (vor dem Vernetzen): Nummer, Name, Oberflächendreiecke je CAD-Fläche
#[derive(Debug, Clone)]
pub struct Solid {
    pub tag: i32,
    pub name: String,
    pub surfaces: Vec<Vec<[[f64; 3]; 3]>>,
}

/// erkannte Schraube: Verbindungselement, Festigkeitsklasse aus dem Namen, Körper (Schraube, Mutter, Scheiben)
#[derive(Debug, Clone, serde::Serialize)]
pub struct Detected {
    pub bolt: Bolt,
    pub class: Option<String>,
    pub volumes: Vec<i32>,
    /// Namen der ersetzten Körper (für die Anzeige)
    pub parts: Vec<String>,
}

fn has_word(s: &str, w: &str) -> bool {
    s.split(|c: char| !c.is_alphanumeric()).any(|t| t == w)
}

/// Art des Normteils aus dem Namen
pub fn kind_from_name(name: &str) -> Option<Kind> {
    let n = name.to_lowercase();
    let norm = |list: &[&str]| list.iter().any(|k| n.replace(' ', "").contains(k));
    if norm(&["iso4032", "iso4035", "iso4033", "iso7040", "iso10511", "iso4161", "din934", "din985", "din439", "din6923", "din936"])
        || n.contains("mutter")
        || has_word(&n, "nut")
        || n.contains("hex nut")
    {
        return Some(Kind::Nut);
    }
    if norm(&["iso7089", "iso7090", "iso7091", "iso7092", "iso7093", "din125", "din433", "din9021", "din127", "din6796", "din7349"])
        || n.contains("scheibe")
        || n.contains("washer")
    {
        return Some(Kind::Washer);
    }
    let bolt_norm = norm(&[
        "iso4762", "iso4014", "iso4017", "iso7380", "iso10642", "iso7045", "iso7046", "iso1207", "iso14579", "iso14580",
        "iso14583", "iso8765", "iso8676", "din912", "din931", "din933", "din7984", "din7991", "din7985", "din84", "din965", "din963",
    ]);
    let words = n.contains("schraube") || n.contains("screw") || has_word(&n, "bolt") || n.contains("bolt ");
    // „M8x25“, „M8 x 25“, „M8×25“
    let mx = {
        let t = n.replace(' ', "");
        t.char_indices().any(|(i, c)| {
            c == 'm' && (i == 0 || !t[..i].chars().last().unwrap().is_alphabetic()) && {
                let rest = &t[i + 1..];
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
                !digits.is_empty() && rest[digits.len()..].starts_with(['x', '×'])
            }
        })
    };
    (bolt_norm || words || mx).then_some(Kind::Bolt)
}

/// Festigkeitsklasse aus dem Namen („… 10.9“, „A2-70“, „A4“)
pub fn class_from_name(name: &str) -> Option<String> {
    let n = name.to_uppercase().replace(' ', "");
    for c in ["12.9", "10.9", "8.8", "5.6", "4.6"] {
        if n.contains(c) {
            return Some(c.into());
        }
    }
    for c in ["A2-80", "A2-70", "A4-80", "A4-70", "A2-50", "A4-50"] {
        if n.contains(c) || n.contains(&c.replace('-', "")) {
            return Some(c.into());
        }
    }
    if n.contains("A4") {
        return Some("A4-70".into());
    }
    if n.contains("A2") || n.contains("EDELSTAHL") || n.contains("STAINLESS") {
        return Some("A2-70".into());
    }
    None
}

const M_SIZES: [f64; 15] = [3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 22.0, 24.0, 27.0, 30.0];

/// Nenndurchmesser: nächste Regelgewinde-Größe, wenn sie passt
pub fn nominal(d: f64) -> f64 {
    M_SIZES.iter().copied().min_by(|a, b| (a - d).abs().partial_cmp(&(b - d).abs()).unwrap()).filter(|m| (m - d).abs() < 0.12 * m).unwrap_or(d)
}

/// Zylinder (zusammengefasst aus Teilflächen): Achse, Mittelpunkt, Radius, Bereich entlang der Achse
#[derive(Debug, Clone)]
struct Cyl {
    axis: Vector3<f64>,
    center: Vector3<f64>,
    r: f64,
    t0: f64,
    t1: f64,
}

fn tri_area_normal(t: &[[f64; 3]; 3]) -> (f64, Vector3<f64>) {
    let a = Vector3::from(t[0]);
    let n = (Vector3::from(t[1]) - a).cross(&(Vector3::from(t[2]) - a));
    let l = n.norm();
    (0.5 * l, if l > 0.0 { n / l } else { n })
}

fn cylinders(s: &Solid) -> Vec<Cyl> {
    let mut out: Vec<Cyl> = Vec::new();
    for surf in &s.surfaces {
        let mut m = Matrix3::zeros();
        let mut total = 0.0;
        for t in surf {
            let (a, n) = tri_area_normal(t);
            m += n * n.transpose() * a;
            total += a;
        }
        if total <= 0.0 {
            continue;
        }
        let eig = SymmetricEigen::new(m / total);
        let mut idx = [0usize, 1, 2];
        idx.sort_by(|&i, &j| eig.eigenvalues[i].partial_cmp(&eig.eigenvalues[j]).unwrap());
        let (l0, l1) = (eig.eigenvalues[idx[0]], eig.eigenvalues[idx[1]]);
        // Zylinder: Normalen stehen senkrecht auf der Achse und sind rundum verteilt
        if !(l0 < 0.03 && l1 > 0.15) {
            continue;
        }
        let axis = eig.eigenvectors.column(idx[0]).into_owned().normalize();
        let pts: Vec<Vector3<f64>> = surf.iter().flat_map(|t| t.iter().map(|p| Vector3::from(*p))).collect();
        // Mittelpunkt: Kreis durch die projizierten Punkte (Schwerpunkt reicht bei vollen bzw. halben Zylindern nicht → Kasa-Ausgleich)
        let e1 = if axis.x.abs() < 0.9 { Vector3::x() } else { Vector3::y() };
        let e1 = (e1 - axis * axis.dot(&e1)).normalize();
        let e2 = axis.cross(&e1);
        let (mut sx, mut sy, mut sxx, mut syy, mut sxy, mut sxz, mut syz, mut sz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        let k = pts.len() as f64;
        for p in &pts {
            let (x, y) = (p.dot(&e1), p.dot(&e2));
            let z = x * x + y * y;
            sx += x;
            sy += y;
            sxx += x * x;
            syy += y * y;
            sxy += x * y;
            sxz += x * z;
            syz += y * z;
            sz += z;
        }
        let a = nalgebra::Matrix3::new(sxx, sxy, sx, sxy, syy, sy, sx, sy, k);
        let Some(sol) = a.lu().solve(&Vector3::new(sxz, syz, sz)) else { continue };
        let (cx, cy) = (sol[0] / 2.0, sol[1] / 2.0);
        let r = (sol[2] + cx * cx + cy * cy).max(0.0).sqrt();
        let center = e1 * cx + e2 * cy;
        let ts: Vec<f64> = pts.iter().map(|p| p.dot(&axis)).collect();
        let (t0, t1) = ts.iter().fold((f64::MAX, f64::MIN), |(a, b), &t| (a.min(t), b.max(t)));
        if !(r > 0.0) {
            continue;
        }
        // Teilflächen desselben Zylinders zusammenfassen
        let same = out.iter_mut().find(|c| {
            c.axis.dot(&axis).abs() > 0.999 && ((c.center - center) - c.axis * (c.center - center).dot(&c.axis)).norm() < 0.05 * r && (c.r - r).abs() < 0.03 * r
        });
        match same {
            Some(c) => {
                let s = c.axis.dot(&axis).signum();
                c.t0 = c.t0.min((s * t0).min(s * t1));
                c.t1 = c.t1.max((s * t0).max(s * t1));
            }
            None => out.push(Cyl { axis, center, r, t0, t1 }),
        }
    }
    out
}

fn all_points(s: &Solid) -> Vec<Vector3<f64>> {
    s.surfaces.iter().flatten().flat_map(|t| t.iter().map(|p| Vector3::from(*p))).collect()
}

/// Schrauben (mit Muttern und Scheiben) in den Körpern einer Baugruppe finden
pub fn detect(solids: &[Solid]) -> Vec<Detected> {
    let mut out: Vec<Detected> = Vec::new();
    let kinds: Vec<Option<Kind>> = solids.iter().map(|s| kind_from_name(&s.name)).collect();
    for (i, s) in solids.iter().enumerate() {
        if kinds[i] != Some(Kind::Bolt) {
            continue;
        }
        let cyls = cylinders(s);
        // Schaft: längster Zylinder im Verhältnis zum Radius
        let Some(shaft) = cyls.iter().max_by(|a, b| ((a.t1 - a.t0) / a.r).partial_cmp(&((b.t1 - b.t0) / b.r)).unwrap()) else { continue };
        if shaft.t1 - shaft.t0 < 1.0 * shaft.r {
            continue;
        }
        let pts = all_points(s);
        let a = shaft.axis;
        let ts: Vec<f64> = pts.iter().map(|p| p.dot(&a)).collect();
        let (tmin, tmax) = ts.iter().fold((f64::MAX, f64::MIN), |(x, y), &t| (x.min(t), y.max(t)));
        // Kopf am Ende mit mehr Überstand über den Schaft hinaus
        let head_low = (shaft.t0 - tmin) > (tmax - shaft.t1);
        let n = if head_low { a } else { -a };
        // Ursprung auf der Achse; t entlang n (Kopf → Gewinde)
        let origin = shaft.center + a * 0.0;
        let tt = |p: &Vector3<f64>| (p - origin).dot(&n);
        let (head_t, end_t) = if head_low { (shaft.t0 - origin.dot(&a), shaft.t1 - origin.dot(&a)) } else { (-(shaft.t1 - origin.dot(&a)), -(shaft.t0 - origin.dot(&a))) };
        let radial = |p: &Vector3<f64>| {
            let v = p - origin;
            (v - n * v.dot(&n)).norm()
        };
        let d = nominal(2.0 * shaft.r);
        let head_r = pts.iter().filter(|p| tt(p) < head_t + 0.02 * d).map(radial).fold(0.0, f64::max);
        let mut bolt = Bolt {
            name: s.name.clone(),
            d,
            stress_area: None,
            e: 210000.0,
            origin: origin.into(),
            axis: n.into(),
            head_t,
            head_d: (2.0 * head_r).clamp(1.3 * d, 2.5 * d),
            nut_t: None,
            nut_d: None,
            thread_t0: head_t + 0.05 * d,
            thread_t1: end_t,
        };
        let mut volumes = vec![s.tag];
        let mut parts = vec![s.name.clone()];
        // Mutter und Scheiben auf derselben Achse
        let mut extra: Vec<(Kind, f64, f64, f64, i32, String)> = Vec::new();
        for (j, o) in solids.iter().enumerate() {
            let Some(k @ (Kind::Nut | Kind::Washer)) = kinds[j] else { continue };
            let inner = cylinders(o).into_iter().min_by(|x, y| x.r.partial_cmp(&y.r).unwrap());
            let Some(c) = inner else { continue };
            let off = c.center - origin;
            if c.axis.dot(&n).abs() < 0.995 || (off - n * off.dot(&n)).norm() > 0.25 * d || c.r > 0.75 * d {
                continue;
            }
            let op = all_points(o);
            let (o0, o1) = op.iter().map(&tt).fold((f64::MAX, f64::MIN), |(x, y), t| (x.min(t), y.max(t)));
            let outer = op.iter().map(radial).fold(0.0, f64::max);
            // muss am Schaft liegen
            if o1 < head_t - 0.1 * d || o0 > end_t + 0.1 * d {
                continue;
            }
            extra.push((k, o0, o1, outer, o.tag, o.name.clone()));
        }
        // Scheibe unter dem Kopf → Auflage verschiebt sich
        extra.sort_by(|x, y| x.1.partial_cmp(&y.1).unwrap());
        for (k, o0, o1, outer, tag, name) in &extra {
            if *k == Kind::Washer && (o0 - bolt.head_t).abs() < 0.15 * d {
                bolt.head_t = *o1;
                bolt.head_d = bolt.head_d.max(2.0 * outer).min(2.6 * d);
                volumes.push(*tag);
                parts.push(name.clone());
            }
        }
        if let Some((_, o0, _, outer, tag, name)) = extra.iter().find(|e| e.0 == Kind::Nut) {
            let mut nut_t = *o0;
            // Scheibe vor der Mutter
            for (k, w0, w1, wout, wtag, wname) in &extra {
                if *k == Kind::Washer && (w1 - nut_t).abs() < 0.15 * d && !volumes.contains(wtag) {
                    nut_t = *w0;
                    bolt.nut_d = Some(2.0 * wout);
                    volumes.push(*wtag);
                    parts.push(wname.clone());
                }
            }
            bolt.nut_t = Some(nut_t);
            bolt.nut_d = Some(bolt.nut_d.unwrap_or(1.7 * outer).clamp(1.3 * d, 2.6 * d));
            volumes.push(*tag);
            parts.push(name.clone());
        }
        out.push(Detected { class: class_from_name(&s.name), bolt, volumes, parts });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namen() {
        assert_eq!(kind_from_name("ISO 4762 M8x25 - 10.9"), Some(Kind::Bolt));
        assert_eq!(kind_from_name("Socket Head Cap Screw M6 x 20"), Some(Kind::Bolt));
        assert_eq!(kind_from_name("Sechskantmutter ISO 4032 M8"), Some(Kind::Nut));
        assert_eq!(kind_from_name("Hex Nut M10"), Some(Kind::Nut));
        assert_eq!(kind_from_name("Scheibe ISO 7089 8"), Some(Kind::Washer));
        assert_eq!(kind_from_name("Nutenstein"), None);
        assert_eq!(kind_from_name("Grundplatte"), None);
        assert_eq!(kind_from_name("Halter M8"), None);
        assert_eq!(class_from_name("ISO 4762 M8x25 10.9"), Some("10.9".into()));
        assert_eq!(class_from_name("DIN 912 M6x16 A2"), Some("A2-70".into()));
        assert_eq!(class_from_name("Schraube M8"), None);
        assert_eq!(nominal(7.98), 8.0);
        assert_eq!(nominal(6.8), 6.8);
    }
}
