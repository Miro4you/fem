# Projekt-FEM

Privates FEM-Programm (Machbarkeitsstudie) für Festigkeitsanalysen – läuft auf Linux und macOS.
Arbeitsname, der endgültige Name kommt später.

## Stand: Phase 2 – Desktop-App

**App:** STEP öffnen → automatisch vernetzen (Gmsh, TET10, feiner an Bohrungen/Radien) → Werkstoff wählen →
Lager und Lasten per Klick auf CAD-Flächen → Rechnen → farbige Ergebnisse (von Mises, Verschiebung, σ1, σ3,
Sicherheit) mit Verformung, Maximum-Markierung, Messpunkt per Klick, Warnungen (Singularität am Lager,
Fließen, große Verformung), Gleichgewichtskontrolle, Projekt speichern/laden (`.fem.json`), Export `.vtu`.

Lagerarten: fest eingespannt · reibungsfreie Auflage/Symmetrie (ebene, achsparallele Flächen) · Richtungen einzeln.
Lasten: Kraft (gleichmäßig verteilt, Richtung frei oder senkrecht auf die Fläche) · Druck.

### Rechenkern

- Lineare Statik für 3D-Volumenkörper, Tetraeder-Elemente **TET10** (quadratisch, Standard) und TET4
- Werkstoff linear-elastisch, isotrop (E, ν, optional Streckgrenze)
- Lager: Richtungen einzeln festhalten (Einspannung, Loslager, Symmetrie)
- Lasten: Gesamtkraft auf Fläche, Flächenlast (Vektor), Druck
- Ergebnisse: Verschiebungen, Vergleichsspannung (von Mises), Hauptspannungen, Lagerreaktionen,
  Gleichgewichtskontrolle, Sicherheit gegen Fließen
- Gleichungslöser: direkt (Cholesky) bei kleinen Modellen, ab 50 000 Unbekannten automatisch **iterativ**
  (CG mit algebraischem Mehrgitter-Vorkonditionierer, Smoothed Aggregation mit Starrkörpermoden)
- Export als `.vtu` (anschauen z. B. mit [ParaView](https://www.paraview.org/))
- Eingebauter Quader-Vernetzer (beliebige Geometrie über STEP/Gmsh kommt in Phase 2)

## Bauen und benutzen

Voraussetzungen: Rust, Node.js, **Gmsh** (`uv tool install gmsh` – Linux und Mac; oder `brew install gmsh`).
Unter Linux zusätzlich `webkit2gtk-4.1`.

> Hinweis uv-Gmsh: Das Startskript `~/.local/share/uv/tools/gmsh/bin/gmsh` hat die Shebang-Zeile
> `#!/usr/bin/env python` – auf `#!<uv-tool-dir>/gmsh/bin/python` ändern, sonst fehlt das gmsh-Modul.
> Alternativ den Pfad zu Gmsh in `FEM_GMSH` setzen.

**App:**
```sh
cd app && npm install
npx tauri dev                    # Entwicklung
npx tauri build --no-bundle      # → target/release/projekt-fem-app
```

**Kommandozeile:**

```sh
cargo build --release
./target/release/projekt-fem validieren                          # Lehrbuchfälle prüfen
./target/release/projekt-fem rechnen examples/kragbalken.toml    # Beispiel rechnen
#   Option --loeser auto|direkt|iterativ  (Standard auto)
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
| Lochplatte d/W = 0,2 (STEP + Gmsh) | Kerbspannung (Peterson-Kt), Mittel über Dicke | +0,5 % |

Beispiel `platte_druck.toml` (Viertelplatte mit Symmetrie): Durchbiegung 0,166 mm vs. Kirchhoff 0,159 mm,
Spannung 9,3 vs. 9,2 MPa – Unterschied durch die in der Plattentheorie vernachlässigte Dicke.

## Bekannte Grenzen

- **Spannungsspitzen an starren Einspannungen/Kanten sind Singularitäten:** Sie wachsen bei Netzverfeinerung
  immer weiter (Kragbalken-Einspannkante: 128 MPa grob, 169 MPa fein; Theorie 120 MPa). Werte mit Abstand zur
  Einspannung auswerten. → Warnung in der Oberfläche geplant.
- Rechenzeit/Speicher (4 Kerne, Hebel `Daten/Hebel.step`, TET10):

  | Netz | Unbekannte | direkt | iterativ (Mehrgitter) |
  |---|---|---|---|
  | 1 mm | 318 000 | 37 s, 2,9 GB | 15 s, 0,8 GB |
  | 0,6 mm | 1,3 Mio. | – (> 25 GB) | 70 s, 3,4 GB |
  | 0,5 mm | 2,2 Mio. | – | 137 s, 5,5 GB |

  Ergebnisse beider Löser stimmen überein (Abbruch bei ‖r‖/‖f‖ < 10⁻⁹).
- Reibungsfreie Auflage nur für ebene, achsparallele Flächen (schräge Flächen brauchen lokale Koordinaten – später).
- Lasten wirken gleichmäßig über die Fläche; eine Lagerlast (Bolzen in Bohrung, nur halbe Fläche) kommt später.
- Lagergruppen-Summen: Knoten auf gemeinsamen Kanten zählen in jeder Gruppe; maßgeblich ist „Summe aller Lager".

## Roadmap

1. ✅ **Rechenkern (Rust):** lineare Statik 3D (TET4/TET10), Validierung an Lehrbuchfällen
2. ✅ **Desktop-App (Tauri):** STEP-Import + Vernetzung (Gmsh), 3D-Ansicht, Lager/Lasten per Klick, geführter Ablauf
3. **Nachweis & Bericht:** Werkstoffdatenbank, automatische Sicherheiten, PDF-Bericht, Parameterstudien, MathPad-Anbindung
4. **Weitere Elemente:** Balken/Rahmen/Fachwerk, Schalen (Bleche)
5. **Dynamik & Stabilität:** Eigenfrequenzen, Knicken/Beulen
6. **Strömung (überschlägig):** OpenFOAM-Anbindung, Strömungslasten → Festigkeit

## Aufbau

```
crates/fem-core   Rechenkern (Bibliothek): element, mesh, generate, model, solver, results, vtk, validate,
                  pcg + amg + sparse (iterativer Löser)
crates/fem-cli    Kommandozeile `projekt-fem`
app/              Desktop-App (Tauri 2 + React + three.js), Backend in app/src-tauri
examples/         Beispielfälle, examples/geometrie: STEP-Testteile (+ .geo-Quellen)
```
