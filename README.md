# Projekt-FEM

Privates FEM-Programm (Machbarkeitsstudie) für Festigkeitsanalysen – läuft auf Linux und macOS.
Arbeitsname, der endgültige Name kommt später.

## Stand: Phase 1 – Rechenkern

- Lineare Statik für 3D-Volumenkörper, Tetraeder-Elemente **TET10** (quadratisch, Standard) und TET4
- Werkstoff linear-elastisch, isotrop (E, ν, optional Streckgrenze)
- Lager: Richtungen einzeln festhalten (Einspannung, Loslager, Symmetrie)
- Lasten: Gesamtkraft auf Fläche, Flächenlast (Vektor), Druck
- Ergebnisse: Verschiebungen, Vergleichsspannung (von Mises), Hauptspannungen, Lagerreaktionen,
  Gleichgewichtskontrolle, Sicherheit gegen Fließen
- Export als `.vtu` (anschauen z. B. mit [ParaView](https://www.paraview.org/))
- Eingebauter Quader-Vernetzer (beliebige Geometrie über STEP/Gmsh kommt in Phase 2)

## Bauen und benutzen

Voraussetzung: Rust (`rustup` bzw. `pacman -S rust` / `brew install rust`).

```sh
cargo build --release
./target/release/projekt-fem validieren                          # Lehrbuchfälle prüfen
./target/release/projekt-fem rechnen examples/kragbalken.toml    # Beispiel rechnen
cargo test --release                                             # alle Tests
```

## Eingabedatei (TOML)

Einheiten frei, aber konsistent – empfohlen **mm, N, MPa**. Beispiele in `examples/`.

```toml
[mesh]
type = "box"                 # Quader von (0,0,0) bis size
size = [200.0, 10.0, 10.0]
cells = [40, 2, 4]           # Zellen je Richtung (jede Zelle = 6 Tetraeder)
order = 2                    # 1 = TET4, 2 = TET10 (empfohlen)

[material]
name = "S235"
E = 210000.0
nu = 0.3
yield = 235.0                # optional → Sicherheit gegen Fließen

[[group]]                    # benannte Flächenauswahl
name = "einspannung"
plane = { axis = "x", value = 0.0 }               # oder: box = { min = [...], max = [...] }

[[support]]
group = "einspannung"
fix = ["x", "y", "z"]        # weglassen = alle Richtungen fest

[[load]]
group = "ende"
force = [0.0, 0.0, -100.0]   # oder: traction = [...] (N/mm²) oder: pressure = 0.1 (MPa, drückt aufs Bauteil)
```

## Validierung

`projekt-fem validieren` vergleicht mit der Theorie (läuft auch bei `cargo test`):

| Fall | Größe | Abweichung |
|---|---|---|
| Zugstab TET4/TET10 | σ, Δl, Querkontraktion, Lagerkraft | exakt |
| Kragbalken TET10 (40×2×4) | Durchbiegung (Timoshenko) | −0,5 % |
| Kragbalken TET10 (40×2×4) | Biegespannung bei l/2 | +0,2 % |

Beispiel `platte_druck.toml` (Viertelplatte mit Symmetrie): Durchbiegung 0,166 mm vs. Kirchhoff 0,159 mm,
Spannung 9,3 vs. 9,2 MPa – Unterschied durch die in der Plattentheorie vernachlässigte Dicke.

## Bekannte Grenzen

- **Spannungsspitzen an starren Einspannungen/Kanten sind Singularitäten:** Sie wachsen bei Netzverfeinerung
  immer weiter (Kragbalken-Einspannkante: 128 MPa grob, 169 MPa fein; Theorie 120 MPa). Werte mit Abstand zur
  Einspannung auswerten. → Warnung in der Oberfläche geplant.
- Direkter Löser: ~1 Mio. Unbekannte ≈ 2 min und ~25 GB RAM. Für große Modelle kommt ein iterativer Löser.
- Lagergruppen-Summen: Knoten auf gemeinsamen Kanten zählen in jeder Gruppe; maßgeblich ist „Summe aller Lager".

## Roadmap

1. ✅ **Rechenkern (Rust):** lineare Statik 3D (TET4/TET10), Validierung an Lehrbuchfällen
2. **Desktop-App (Tauri):** STEP-Import + Vernetzung (Gmsh), 3D-Ansicht, Lager/Lasten per Klick, geführter Ablauf
3. **Nachweis & Bericht:** Werkstoffdatenbank, automatische Sicherheiten, PDF-Bericht, Parameterstudien, MathPad-Anbindung
4. **Weitere Elemente:** Balken/Rahmen/Fachwerk, Schalen (Bleche)
5. **Dynamik & Stabilität:** Eigenfrequenzen, Knicken/Beulen
6. **Strömung (überschlägig):** OpenFOAM-Anbindung, Strömungslasten → Festigkeit

## Aufbau

```
crates/fem-core   Rechenkern (Bibliothek): element, mesh, generate, model, solver, results, vtk, validate
crates/fem-cli    Kommandozeile `projekt-fem`
examples/         Beispielfälle
```
