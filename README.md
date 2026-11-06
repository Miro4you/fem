# Projekt-FEM

Privates FEM-Programm (Machbarkeitsstudie) für Festigkeitsanalysen – läuft auf Linux und macOS.
Arbeitsname, der endgültige Name kommt später.

## Stand: Phase 2 – Desktop-App

**App:** STEP öffnen → automatisch vernetzen (Gmsh, TET10, feiner an Bohrungen/Radien) → Werkstoff wählen →
Lager und Lasten per Klick auf CAD-Flächen → Rechnen → farbige Ergebnisse (von Mises, Verschiebung, σ1, σ3,
Sicherheit) mit Verformung, Maximum-Markierung, Messpunkt per Klick, Warnungen (Singularität am Lager,
Fließen, große Verformung), Gleichgewichtskontrolle, Projekt speichern/laden (`.fem.json`), Export `.vtu`.

Lagerarten: fest eingespannt · reibungsfreie Auflage/Symmetrie (beliebige, auch schräge Flächen) · Richtungen einzeln ·
zylindrische Lagerung (Bolzen/Gelenk: radial, axial, Drehung je einzeln sperrbar).
Lasten: Kraft (gleichmäßig verteilt, Richtung frei oder senkrecht auf die Fläche) · Druck · Moment ·
Lagerlast (Bolzen/Welle: nur der halbe Umfang, cos-verteilt).

**Wirkbereich:** Lasten und Lager können statt auf der ganzen Fläche nur auf einem Teil wirken. Den Bereich
zieht man mit der Maus direkt auf der Fläche auf: Kreis, Rechteck oder Abschnitt einer Welle/Bohrung (axial von–bis,
optional nur ein Winkelbereich). Danach lassen sich die Maße als Zahlen anpassen. Die Lastresultierende stimmt
exakt; wie scharf der Rand abgebildet wird, hängt vom Netz ab (Elemente deutlich kleiner als der Bereich wählen).

### Rechenkern

- Lineare Statik für 3D-Volumenkörper, Tetraeder-Elemente **TET10** (quadratisch, Standard) und TET4
- Werkstoff linear-elastisch, isotrop (E, ν, optional Streckgrenze)
- Lager: Richtungen einzeln festhalten (Einspannung, Loslager, Symmetrie); lokale Lager je Knoten:
  reibungsfrei senkrecht zur Fläche (auch schräg), zylindrisch (radial/tangential/axial)
- Lasten: Gesamtkraft auf Fläche, Flächenlast (Vektor), Druck, Moment (linear verteilt, wie starres Anschlussteil),
  Lagerlast (cos-Verteilung auf der gedrückten Zylinderhälfte); jeweils optional nur in einem Wirkbereich
- Ergebnisse: Verschiebungen, Vergleichsspannung (von Mises), Hauptspannungen, Lagerreaktionen,
  Gleichgewichtskontrolle, Sicherheit gegen Fließen
- Gleichungslöser: direkt (Cholesky) bei kleinen Modellen, ab 50 000 Unbekannten automatisch **iterativ**
  (CG mit algebraischem Mehrgitter-Vorkonditionierer, Smoothed Aggregation mit Starrkörpermoden)
- Export als `.vtu` (anschauen z. B. mit [ParaView](https://www.paraview.org/))
- Eingebauter Quader-Vernetzer (beliebige Geometrie über STEP/Gmsh kommt in Phase 2)

## 3D-Druck: Schichtaufbau und Aufbaurichtung

Werkstoff mit „3D-Druck: Schichtaufbau berücksichtigen“: eigene Werte **in der Schicht (XY)** und **quer zu den
Schichten (Z)** für E, Re/Rp0,2 und Rm (transversal isotrop). Vorlagen für FDM (PLA, PETG, ABS, ASA, PC, PA12-CF),
SLS/SLA (PA12, PA11, Resin) und Metall (AlSi10Mg, 316L, Ti-6Al-4V) – Richtwerte für 100 % Füllung, eigene Werte
eintragen, wenn bekannt. Aufbaurichtung X/Y/Z oder „Fläche aufs Druckbett legen“; Schichtlinien und Druckbett werden
angezeigt.

Auslastung je Knoten: max(σv / R_xy, Schichthaftung), Schichthaftung = √((σ_z⁺ / R_z)² + (τ_z / S_z)²) in
Schichtkoordinaten (Druck quer zu den Schichten zählt nicht, S_z = R_z). R = Re/Rp, ohne Streckgrenze Rm.
Ergebnis: Sicherheit gesamt und „Sicherheit Schichthaftung“, maßgebliche Versagensart, Sicherheit gegen Bruch (Rm).
**„Aufbaurichtung vergleichen“** rechnet X, Y und Z und zeigt die beste Ausrichtung.

**Wände und Infill** („Wände und Infill berücksichtigen“): Füllmuster (Gitter, Linien, Dreiecke, Waben, Gyroid,
Kubisch, Kreuz), Füllgrad, Anzahl Wände × Linienbreite, Deck-/Bodenschichten × Schichthöhe. Elemente in Wand- bzw.
Deckschichtdicke von der Oberfläche bekommen den vollen Werkstoff, der Kern einen Ersatzwerkstoff (Näherung
f(ρ) = k·ρⁿ + (1−k)·ρ⁸ je Muster für E und R, in der Schicht und quer). Teilweise betroffene Elemente werden nach
Volumenanteil gemischt; Auslastung getrennt für Wand und Infill. Das Netz wird an der Oberfläche auf Wandstärke
verfeinert. Ergebnisansichten „Sicherheit Infill“ und „Wand / Infill“, dazu die **Schnittansicht** (X/Y/Z, Position).

Grenzen: Ersatzwerte des Infills sind Näherungen (mit eigenem Zugstab kalibrieren); Stützstrukturen werden nicht
abgebildet; linear-elastisch, kein Kriechen.

## Auswerten und Weitergeben

- **Schnittansicht** (Ergebnis): Ebene X/Y/Z verschieben, Schnittfläche zeigt die Werte im Inneren.
- **Festigkeitsnachweis**: erforderliche Sicherheit gegen Fließen und Bruch, zulässige Verformung (Werkstoff-Bereich);
  im Ergebnis Ausnutzung je Nachweis und „erfüllt/nicht erfüllt“.
- **PDF-Bericht**: Bauteil, Netz, Werkstoff (inkl. 3D-Druck), Lager, Lasten, Ergebnisse, Nachweis, Hinweise, Bilder mit
  Farbskala, Annahmen und Grenzen.
- **MathPad**: Export als `.mathpad`-Rechenblatt (Werkstoffwerte, Maximalwerte, Lagerkräfte, Masse und Nachweis als
  Formeln, z. B. `S_F = R_e / σ_v`).
- **Parameterstudie** (Reiter „Studie“): Netzgröße (Konvergenz), Füllgrad oder Maße aus „Geometrie anpassen“ über
  mehrere Werte, Tabelle + Diagramm, CSV-Export.
- **Werkstoffe**: Vorlagen mit Dichte (Masse im Ergebnis), eigene Werkstoffe speichern
  (`~/.config/projekt-fem/werkstoffe.json`), Werte aus eigenem Zugversuch übernehmen.

## Stabwerk: Balken, Rahmen, Fachwerke (Phase 4)

Reiter **„Stabwerk“** (ohne STEP-Datei): Knoten, Stäbe, Profile (Rechteck, Rund, Rohr, Rechteckrohr, IPE 100–300),
Lager (eingespannt, gelenkig, Loslager), Knoten- und Streckenlasten, Eigengewicht, ebene oder räumliche Systeme.
3D-Balken nach Euler-Bernoulli (je Stab 10 Abschnitte) bzw. Fachwerkstäbe (nur Normalkraft). Ergebnis: Verformung,
Normalkraft, Biegemoment, Vergleichsspannung σv = |N|/A + |M|/W (mit Torsion), Ausnutzung je Stab, Lagerkräfte.
Vorlagen: Einfeldträger, Kragarm, Fachwerkbinder, Rahmen; Speichern als `.stab.json`.
Stabilität (Knicken/Kippen) der Stäbe wird nicht nachgewiesen.

**Schalen (Bleche)** sind nicht als eigene Elemente umgesetzt: Dünnwandige Teile lassen sich mit den quadratischen
Volumenelementen rechnen, wenn das Netz in der Blechdicke fein genug ist (Elementgröße ≈ Blechdicke).

## Eigenfrequenzen und Knicken (Phase 5)

Über „Rechnen“: **Statik / Eigenfrequenzen / Knicken**, Anzahl Moden wählbar. Eigenfrequenzen mit konsistenter
TET10-Massenmatrix (Dichte aus dem Werkstoff), lineares Knicken mit geometrischer Steifigkeit aus der statischen
Lösung (Knicklast = Lastfaktor × Last). Lanczos-Verfahren mit Spektraltransformation (direkte Zerlegung, bis
600 000 Unbekannte). Schwing-/Knickform animiert. Infill wird hier nicht berücksichtigt (massiver Werkstoff).

## Strömung / Wind (Phase 6, überschlägig)

Lastart „Strömung / Wind“: Medium (Luft, Wasser, eigene Dichte), Geschwindigkeit, c_w und Strömungsrichtung →
Druck q = ½·ρ·v²·c_w auf allen angeströmten Flächen (Außennormale gegen die Strömung), Gesamtkraft = q × Projektions-
fläche. Keine Sogseite, keine Umströmung – für genaue Strömungslasten wäre eine CFD-Rechnung (z. B. OpenFOAM) nötig.

## Leichtbau

Ergebnisansicht „Materialausnutzung“ und **Leichtbau-Vorschlag** (Reiter Geometrie): Topologieoptimierung (SIMP,
Empfindlichkeitsfilter, Optimalitätskriterium) mit vorgegebenem Materialanteil; Flächen mit Lagern und Lasten bleiben
voll. Die Form erscheint im Bauteil, Schwellwert einstellbar, Export als STL.

## Geometrie anpassen (grobe Abschätzung)

Reiter **„Geometrie“**: Radius oder Bohrung anklicken und neuen Wert eingeben (0 = scharfe Kante bzw. Bohrung zu),
Material hinzufügen oder entfernen über eine Skizze (Rechteck/Kreis) auf einer Fläche mit Höhe bzw. Tiefe
(„durch alles“). „Änderungen anwenden“ ändert die STEP-Datei, vernetzt neu und stellt Lager und Lasten auf die neuen
Flächen um. Danach rechnen: Das Ergebnis wird mit dem vorherigen verglichen (Spannung, Verformung, Sicherheit,
Volumen). Änderungen einzeln an/aus, Projekt speichert sie mit, geänderte STEP lässt sich exportieren.
Braucht das Python-Modul von Gmsh (bei `uv tool install gmsh` dabei; sonst Pfad in `FEM_GMSH_PYTHON`).
Die Änderungen gehen nicht zurück ins CAD-Modell.

## Im Heimnetz nutzen (Laptop, Arbeits-PC)

Der starke Rechner rechnet, andere Geräte bedienen Projekt-FEM im Browser – ohne Installation.

- **Desktop-App:** oben rechts **„Heimnetz“** → „Freigabe aktiv“. Den angezeigten Link (z. B.
  `http://192.168.178.42:8790/#k=…`) auf dem anderen Gerät im Browser öffnen bzw. als Lesezeichen speichern.
  Optional „beim Start automatisch freigeben“.
- **Ohne Fenster** (z. B. als Dienst): `projekt-fem-app --server [--port 8790]` – gibt die Links aus.

Im Browser werden STEP-Dateien hochgeladen; Projekte und `.vtu` kommen als Download. Im Browser gespeicherte Projekte
enthalten die STEP-Datei, gehen also auf jedem Gerät wieder auf. Jeder Browser-Tab hat sein eigenes Modell.

Sicherheit: Zugriff nur mit dem Schlüssel im Link (bleibt gleich, bis man einen neuen erzeugt; gespeichert in
`~/.config/projekt-fem/server.json`). Verbindung unverschlüsselt (http) – nur im eigenen Heimnetz verwenden, nicht
ins Internet freigeben. Falls der Link nicht erreichbar ist: Firewall des Rechners für Port 8790 öffnen
(macOS fragt beim ersten Start nach).

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
                                 #   (baut vorher die Oberfläche; sie wird für den Heimnetz-Server eingebettet)
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
# optional nur ein Teil der Flächen (Wirkbereich):
# region = { shape = "circle", center = [x,y,z], normal = [0,0,1], radius = 5.0 }
# region = { shape = "rect", center = [...], normal = [...], u = [1,0,0], width = 20.0, height = 10.0 }
# region = { shape = "band", origin = [...], axis = [0,0,1], reference = [1,0,0], start = 80.0, end = 100.0,
#            angle_from = 0.0, angle_to = 360.0 }   # Wellenabschnitt: axial von–bis, Winkel in Grad

[[support]]
group = "einspannung"
fix = ["x", "y", "z"]        # weglassen = alle Richtungen fest

[[load]]
group = "ende"
force = [0.0, 0.0, -100.0]   # oder: traction = [...] (N/mm²) oder: pressure = 0.1 (MPa, drückt aufs Bauteil)
                             # oder: moment = [Mx, My, Mz] (N·mm, um den Schwerpunkt des Bereichs)
                             # oder: bearing = [...] (Lagerlast in N: Bolzen/Welle, nur halber Umfang, cos-verteilt)
```

## Validierung

`projekt-fem validieren` vergleicht mit der Theorie (läuft auch bei `cargo test`):

| Fall | Größe | Abweichung |
|---|---|---|
| Zugstab TET4/TET10 | σ, Δl, Querkontraktion, Lagerkraft | exakt |
| Kragbalken TET10 (40×2×4) | Durchbiegung (Timoshenko) | −0,5 % |
| Kragbalken TET10 (40×2×4) | Biegespannung bei l/2 | +0,2 % |
| Lochplatte d/W = 0,2 (STEP + Gmsh) | Kerbspannung (Peterson-Kt), Mittel über Dicke | +0,5 % |
| 3D-Druck-Zugstab in der Schicht / quer zu den Schichten | Δl, Querkontraktion, Auslastung | exakt |
| 3D-Druck-Zugstab mit Wand + 20 % Gitter-Infill | E·A (Wand und Kern parallel), Auslastung Wand/Infill | ±0,01 % |
| Stabwerk: Einfeldträger / Fachwerk-Dreieck | Durchbiegung, Biegespannung / Stabkräfte | exakt |
| Kragbalken 200×10×10 Stahl, Eigenfrequenzen | 1./2. Biegeeigenfrequenz (Euler-Bernoulli) | +0,2 % / −1,0 % |
| Kragbalken 200×10×10 Stahl, Knicken | Euler Fall 1, P_kr = π²EI/(4L²) | +0,2 % |
| Zugstab schräg im Raum, nur reibungsfreie Auflagen | σ, Δl, Lagerkraft (direkt und iterativ) | exakt |
| Balken mit zwei Gelenkbolzen (zylindrische Lagerung) | Durchbiegung / Biegespannung Einfeldträger | −0,6 % / −0,2 % |
| Welle Ø20, Torsionsmoment (STEP + Gmsh) | Schubspannung τ = 16T/(πd³) / Verdrehwinkel | +0,03 % / 0,00 % |
| Welle Ø20, Lagerlast auf Abschnitt z = 80…100 | Biegespannung σ = F·a/W | −0,4 % |

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
- Der Rand eines Wirkbereichs wird nicht ins Netz eingearbeitet (kein „Imprint“ wie in Ansys): Die Last wird an den
  Integrationspunkten abgeschnitten. Bei Bereichen, die nur wenige Elemente groß sind, wirkt der Rand verschmiert.
- Lagerlast: Die Kraft muss quer zur Bohrungsachse zeigen; bei nur teilweise belastetem Umfang kann eine kleine
  Querkomponente entstehen (Anzeige „Summe aller Lasten“ prüfen).
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
