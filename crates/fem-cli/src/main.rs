//! Kommandozeile für Projekt-FEM.
//!
//!   projekt-fem rechnen <fall.toml> [-o ergebnis.vtu] [--loeser auto|direkt|iterativ]
//!   projekt-fem validieren

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use fem_core::generate::box_mesh;
use fem_core::{validate, Axis, Fix, Load, Material, Model, Order, Selection, SolverKind};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    mesh: MeshDef,
    material: Material,
    #[serde(default)]
    group: Vec<GroupDef>,
    #[serde(default)]
    support: Vec<SupportDef>,
    #[serde(default)]
    load: Vec<LoadDef>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum MeshDef {
    /// Quader von (0,0,0) bis size
    Box {
        size: [f64; 3],
        cells: [usize; 3],
        #[serde(default = "default_order")]
        order: u8,
    },
}

fn default_order() -> u8 {
    2
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupDef {
    name: String,
    plane: Option<PlaneDef>,
    #[serde(rename = "box")]
    bbox: Option<BoxDef>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaneDef {
    axis: Axis,
    value: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BoxDef {
    min: [f64; 3],
    max: [f64; 3],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SupportDef {
    group: String,
    /// festgehaltene Richtungen, Standard: alle (feste Einspannung)
    fix: Option<Vec<Axis>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoadDef {
    group: String,
    force: Option<[f64; 3]>,
    traction: Option<[f64; 3]>,
    pressure: Option<f64>,
}

fn build_model(case: Case) -> Result<Model> {
    let mesh = match case.mesh {
        MeshDef::Box { size, cells, order } => {
            let order = match order {
                1 => Order::Linear,
                2 => Order::Quadratic,
                o => bail!("Ansatzordnung {o} gibt es nicht (1 = TET4, 2 = TET10)"),
            };
            box_mesh(size, cells, order)?
        }
    };
    let mut model = Model::new(mesh, case.material);
    for g in case.group {
        let sel = match (g.plane, g.bbox) {
            (Some(p), None) => Selection::Plane { axis: p.axis, value: p.value },
            (None, Some(b)) => Selection::Box { min: b.min, max: b.max },
            _ => bail!("Gruppe „{}“: genau eine Auswahl angeben (plane oder box)", g.name),
        };
        model = model.group(&g.name, sel);
    }
    for s in case.support {
        let fix = match s.fix {
            None => Fix::all(),
            Some(axes) => {
                let mut f = Fix::default();
                for a in axes {
                    f.set(a, Some(0.0));
                }
                f
            }
        };
        model = model.support(&s.group, fix);
    }
    for l in case.load {
        let load = match (l.force, l.traction, l.pressure) {
            (Some(force), None, None) => Load::Force { group: l.group, force },
            (None, Some(traction), None) => Load::Traction { group: l.group, traction },
            (None, None, Some(pressure)) => Load::Pressure { group: l.group, pressure },
            _ => bail!("Last auf „{}“: genau eines von force, traction oder pressure angeben", l.group),
        };
        model = model.load(load);
    }
    if model.supports.is_empty() {
        bail!("keine Lagerung definiert ([[support]])");
    }
    Ok(model)
}

fn run(path: &Path, out: Option<PathBuf>, solver: SolverKind) -> Result<()> {
    let text = std::fs::read_to_string(path).with_context(|| format!("{} nicht lesbar", path.display()))?;
    let case: Case = toml::from_str(&text).with_context(|| format!("Fehler in {}", path.display()))?;

    let t0 = Instant::now();
    let model = build_model(case)?.solver(solver);
    let mesh = &model.mesh;
    println!(
        "Netz:       {} Knoten, {} Elemente ({}), Volumen {:.4}",
        mesh.nodes.len(),
        mesh.n_elems(),
        if mesh.npe == 10 { "TET10" } else { "TET4" },
        mesh.volume()
    );
    let res = fem_core::solve(&model)?;
    let method = match res.iterations {
        Some(n) => format!("iterativ, {n} Iterationen"),
        None => "direkt".into(),
    };
    println!("Rechnung:   {} Unbekannte in {:.2} s ({method})", res.n_equations, t0.elapsed().as_secs_f64());

    let (n, u) = res.max_displacement();
    let p = mesh.nodes[n];
    println!("\nmax. Verschiebung:       {u:.6}  bei ({:.3}, {:.3}, {:.3})", p[0], p[1], p[2]);
    let (n, s) = res.max_von_mises();
    let p = mesh.nodes[n];
    println!("max. Vergleichsspannung: {s:.3}  bei ({:.3}, {:.3}, {:.3})  [von Mises]", p[0], p[1], p[2]);
    let s1 = res.principal.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
    let s3 = res.principal.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
    println!("Hauptspannungen:         σ1 max {s1:.3}   σ3 min {s3:.3}");
    if let Some(sf) = res.safety_factor(&model.material) {
        let re = model.material.yield_strength.unwrap();
        let verdict = if sf >= 1.0 { "hält (elastisch)" } else { "FLIESST – Bauteil versagt" };
        println!("Sicherheit gegen Fließen: S = {re} / {s:.3} = {sf:.2}  → {verdict}");
    }
    println!("\nLagerreaktionen:");
    for (name, r) in &res.reactions {
        println!("  {name:20} Fx {:>12.4}  Fy {:>12.4}  Fz {:>12.4}", r[0], r[1], r[2]);
    }

    let (l, r) = (res.total_load, res.total_reaction);
    println!("  {:20} Fx {:>12.4}  Fy {:>12.4}  Fz {:>12.4}", "Summe aller Lager", r[0], r[1], r[2]);
    println!("  {:20} Fx {:>12.4}  Fy {:>12.4}  Fz {:>12.4}", "Summe aller Lasten", l[0], l[1], l[2]);
    if res.reactions.len() > 1 {
        println!("  (Knoten, die zu mehreren Lagergruppen gehören, zählen in jeder Gruppe mit)");
    }

    let out = out.unwrap_or_else(|| path.with_extension("vtu"));
    let mut file = std::io::BufWriter::new(std::fs::File::create(&out).with_context(|| format!("{} nicht schreibbar", out.display()))?);
    fem_core::vtk::write_vtu(&mut file, mesh, &res)?;
    println!("\nErgebnis gespeichert: {} (z. B. mit ParaView öffnen)", out.display());
    Ok(())
}

fn validate_all() -> Result<()> {
    let checks = validate::all()?;
    let mut last = String::new();
    for c in &checks {
        if c.case != last {
            println!("\n{}", c.case);
            last = c.case.clone();
        }
        println!(
            "  {:38} FEM {:>12.6}   Theorie {:>12.6}   {:+7.3} %  {}",
            c.quantity,
            c.fem,
            c.theory,
            100.0 * c.rel_error(),
            if c.passed() { "ok" } else { "NICHT BESTANDEN" }
        );
    }
    let failed = checks.iter().filter(|c| !c.passed()).count();
    println!("\n{} von {} Prüfungen bestanden", checks.len() - failed, checks.len());
    if failed > 0 {
        bail!("{failed} Prüfung(en) nicht bestanden");
    }
    Ok(())
}

const USAGE: &str = "Projekt-FEM – lineare Statik für 3D-Bauteile

Verwendung:
  projekt-fem rechnen <fall.toml> [-o ergebnis.vtu]   Rechnung ausführen
  projekt-fem validieren                              Lehrbuchfälle gegen Theorie prüfen

Optionen für „rechnen“:
  -o <datei.vtu>                     Ergebnisdatei (Standard: neben der Eingabedatei)
  --loeser auto|direkt|iterativ      Gleichungslöser (Standard auto: iterativ ab 50 000 Unbekannten)";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("rechnen" | "run") if args.len() >= 2 => {
            let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1));
            let out = opt("-o").map(PathBuf::from);
            match opt("--loeser").map(String::as_str) {
                None | Some("auto") => run(Path::new(&args[1]), out, SolverKind::Auto),
                Some("direkt") => run(Path::new(&args[1]), out, SolverKind::Direct),
                Some("iterativ") => run(Path::new(&args[1]), out, SolverKind::Iterative),
                Some(o) => Err(anyhow::anyhow!("unbekannter Löser „{o}“ (auto, direkt oder iterativ)")),
            }
        }
        Some("validieren" | "validate") => validate_all(),
        _ => {
            println!("{USAGE}");
            return;
        }
    };
    if let Err(e) = result {
        eprintln!("Fehler: {e:#}");
        std::process::exit(1);
    }
}
