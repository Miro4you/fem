# Projekt-FEM

**Festigkeitsberechnung (FEM) für Konstrukteure, Maker und den 3D-Druck – vom CAD-Teil zum Ergebnis in Minuten.**

STEP-Datei öffnen oder direkt aus dem CAD schicken, Lager und Lasten auf Flächen klicken, rechnen: Spannungen,
Verformung, Sicherheit und Festigkeitsnachweis – auch für 3D-Druckteile mit Schichtaufbau, Wänden und Infill und für
geschweißte Bleche. Ändert man das Teil im CAD (Onshape, SolidWorks, Fusion, SolidCraft …), rechnet Projekt-FEM die
neue Version mit denselben Lagern und Lasten nach. Eigener Rechenkern in Rust, Desktop-App für Linux und macOS,
Bedienung auch im Browser über das Heimnetz.

> Arbeitsname, der endgültige Name kommt noch. Privates Projekt, Stand November 2026.

![Hebel: Vergleichsspannung, Sicherheit und Festigkeitsnachweis](docs/bilder/ergebnis-hebel.png)

## Funktionen

| Bereich | Was geht |
|---|---|
| **Geometrie & Netz** | STEP-Import, automatische Vernetzung (Gmsh, quadratische Tetraeder TET10), feiner an Bohrungen/Radien und in Lastbereichen, Netzgröße per Schieberegler |
| **Lager** | fest, reibungsfrei/Symmetrie (auch schräge Flächen), Richtungen einzeln, zylindrisch (Bolzen/Gelenk) |
| **Lasten** | Kraft (Komponenten oder Betrag + Richtung, im Bild ziehbar), Druck, Moment, Lagerlast (Bolzen/Welle), Strömung/Wind – jeweils auf ganzer Fläche oder nur in einem gezeichneten **Wirkbereich** (Kreis, Rechteck, Wellenabschnitt) |
| **Ergebnisse** | Vergleichsspannung, Verschiebung, Hauptspannungen, Sicherheit, Materialausnutzung, Schnittansicht, Messpunkt, **Verformungsanimation** (Last 0 → 100 %) und **Video-Export** mit Farbskala, Lagerkräfte mit Gleichgewichtskontrolle, Warnungen (Singularität, Fließen, große Verformung) |
| **Nachweis & Bericht** | Werkstoffdatenbank (Stahl, Alu, Kunststoffe, Druckwerkstoffe, eigene), Masse, Festigkeitsnachweis mit erforderlichen Sicherheiten, PDF-Bericht, MathPad-Rechenblatt, ParaView-Export |
| **3D-Druck** | Schichtaufbau mit Werten in und quer zu den Schichten, Aufbaurichtung frei optimieren (≈ 400 Richtungen) inkl. Überhänge, Wände + Infill (Gyroid, Gitter, Waben …), Kalibrierung mit eigenem Zugstab |
| **Schweißnähte** | Spalte an Blechecken automatisch finden, Stumpf-/Kehlnaht, Nahtkraft und Nachweis nach EN 1993-1-8 (vereinfacht) |
| **Studien** | Parameterstudie (Netz, Füllgrad, Maße, **Onshape-Variablen**, **SolidCraft-Parameter**), Vergleich mit voriger Version |
| **Weitere Analysen** | Eigenfrequenzen, Knicken (Lanczos), Leichtbau-Vorschlag (Topologieoptimierung, STL-Export), Stabwerk (Balken, Rahmen, Fachwerke mit IPE-Profilen) |
| **Geometrie anpassen** | Radien/Bohrungen ändern, Material per Skizze hinzufügen oder entfernen, Ergebnis mit vorher vergleichen |
| **CAD-Anbindung** | Onshape (Lesezeichen + API), SolidWorks (Makro), Fusion (Add-in), SolidCraft (live), NX, Solid Edge, „Senden an“ für jedes CAD – Ergebnis zurück ins CAD |
| **Heimnetz** | starker PC rechnet, Laptop/Arbeits-PC bedient im Browser – ohne Installation |
| **Rechenkern** | Rust, direkter Löser (Cholesky) und iterativer Löser (PCG + algebraisches Mehrgitter) bis über 2 Mio. Unbekannte, 56 Lehrbuchprüfungen |

## Bilder

| | |
|---|---|
| ![3D-Druck: Wand/Infill im Schnitt](docs/bilder/3d-druck-infill-schnitt.png) | ![Schweißnähte am Blechkasten](docs/bilder/schweissnaehte-blechkasten.png) |
| **3D-Druck:** Wand (rot) und Gyroid-Infill im Schnitt, Sicherheit getrennt für Wand, Infill und Schichthaftung | **Schweißnähte:** Blechkasten mit vier gefundenen Eckspalten, Nahtkräfte und Nachweis |
| ![Parameterstudie über eine Onshape-Variable](docs/bilder/studie-onshape-variable.png) | ![Stabwerk: Rahmen](docs/bilder/stabwerk-rahmen.png) |
| **Onshape-Variable:** `#dicke` 3–8 mm – Projekt-FEM ändert die Variable in Onshape und rechnet jede Variante | **Stabwerk:** eingespannter Rahmen aus IPE 200, Ausnutzung je Stab |
| ![CAD-Verbindung](docs/bilder/cad-verbindung.png) | |
| **CAD-Verbindung:** SolidCraft live, Onshape-Schlüssel und Lesezeichen, Einstellungen für die Add-ins | |

## Schnellstart

1. **Voraussetzungen:** Rust, Node.js und Gmsh (`uv tool install gmsh` oder `brew install gmsh`); unter Linux zusätzlich
   `webkit2gtk-4.1`. Details unter [Bauen](#bauen-und-benutzen).
2. **Bauen:** `cd app && npm install && npx tauri build --no-bundle` → `target/release/projekt-fem-app`
3. **Rechnen:** App starten → **STEP-Datei öffnen** (z. B. `Daten/Hebel.step` oder `examples/geometrie/`) → Werkstoff →
   **Lager hinzufügen** und Flächen anklicken → **Last hinzufügen** → **Rechnen**.
4. **Aus dem CAD:** oben **„CAD“** – Onshape-Lesezeichen, SolidCraft live; Add-ins für SolidWorks und Fusion in
   [`cad-addins`](cad-addins/README.md).

Ein ausführlicher Prüfablauf aller Funktionen steht in [`TESTPROTOKOLL.md`](TESTPROTOKOLL.md), geplante Schritte in
[`NAECHSTE_SCHRITTE.md`](NAECHSTE_SCHRITTE.md).

## CAD-Anbindung

Knöpfe direkt im CAD: **„In Projekt-FEM rechnen“** schickt das aktive Teil als STEP an Projekt-FEM,
**„Ergebnis holen“** trägt Sicherheit, Vergleichsspannung, Verformung, Masse und Nachweis als Eigenschaften ins Teil ein.
Kommt dasselbe Teil (gleicher Name) in einer neuen Version, überträgt Projekt-FEM Lager, Lasten und Nähte auf die neue
Geometrie, rechnet automatisch neu und zeigt den Vergleich zur vorigen Version.

| CAD | Weg | Ergebnis zurück | Getestet |
|---|---|---|---|
| **Onshape** | Lesezeichen „→ Projekt-FEM“ im Teilestudio (API-Schlüssel in Projekt-FEM) | Teilebeschreibung `[FEM …]` | ✅ mit echtem Onshape, inkl. Studie über Variablen |
| **SolidCraft** | live über den Steuerkanal: folgt jeder Änderung | Parameter `FEM_…` + Design-Eigenschaft | gegen Nachbau des Protokolls |
| **SolidWorks** | VBA-Makro, zwei Makro-Knöpfe | benutzerdefinierte Eigenschaften (`$PRP:"FEM_Sicherheit"`) | ungetestet |
| **Autodesk Fusion** | Add-in, Gruppe „Projekt-FEM“ | Benutzerparameter + Attribute | Ablauf mit Platzhaltern |
| **Siemens NX** | Python-Journale als Benutzerbefehl | Teile-Attribute | Ablauf mit Platzhaltern |
| **Solid Edge** | VBScript | benutzerdefinierte Eigenschaften | ungetestet |
| **jedes andere** | STEP speichern → „Senden an → An Projekt-FEM“ (Windows) / Schnellaktion (Mac) | – | Mac/Linux-Skript getestet |

Anleitung je Programm: [`cad-addins/README.md`](cad-addins/README.md). CAD auf einem anderen Rechner als Projekt-FEM:
Heimnetz-Freigabe einschalten, Adresse und Schlüssel stehen im Dialog „CAD“.

## Funktionen im Detail

### Bedienung

STEP öffnen → automatisch vernetzen → Werkstoff wählen → Lager und Lasten per Klick auf CAD-Flächen → Rechnen →
farbige Ergebnisse mit Verformung, Maximum-Markierung, Messpunkt per Klick, Warnungen und Gleichgewichtskontrolle.
**Animation** (unter „Verformung“): Die Last steigt von 0 auf 100 % und wieder zurück, Verformung und Farben wachsen
mit (½×, 1×, 2× Geschwindigkeit). **Video** speichert zwei Durchläufe als WebM bzw. MP4 mit Bauteilname, Werkstoff,
Kennwerten, Überhöhung und Farbskala – zum Zeigen und Weitergeben. (In der Linux-Desktop-App kann die Aufnahme je nach
WebKit-Version fehlen; dann über die Heimnetz-Ansicht in Chrome/Firefox aufnehmen.)
Projekte speichern/laden (`.fem.json`, im Browser mit eingebetteter STEP-Datei), Fortschrittsanzeige bei großen Netzen.

**Wirkbereich:** Lasten und Lager können statt auf der ganzen Fläche nur auf einem Teil wirken. Den Bereich zieht man
mit der Maus direkt auf der Fläche auf: Kreis, Rechteck oder Abschnitt einer Welle/Bohrung (axial von–bis, optional
nur ein Winkelbereich). Danach lassen sich die Maße als Zahlen anpassen; das Netz wird dort automatisch feiner.

### 3D-Druck: Schichtaufbau, Aufbaurichtung, Wände und Infill

Werkstoff mit „3D-Druck: Schichtaufbau berücksichtigen“: eigene Werte **in der Schicht (XY)** und **quer zu den
Schichten (Z)** für E, Re/Rp0,2 und Rm (transversal isotrop). Vorlagen für FDM (PLA, PETG, ABS, ASA, PC, PA12-CF),
SLS/SLA (PA12, PA11, Resin) und Metall (AlSi10Mg, 316L, Ti-6Al-4V) – Richtwerte für 100 % Füllung, eigene Werte
eintragen, wenn bekannt. Aufbaurichtung X/Y/Z oder „Fläche aufs Druckbett legen“; Schichtlinien und Druckbett werden
angezeigt.

Auslastung je Knoten: max(σv / R_xy, Schichthaftung), Schichthaftung = √((σ_z⁺ / R_z)² + (τ_z / S_z)²) in
Schichtkoordinaten (Druck quer zu den Schichten zählt nicht, S_z = R_z). R = Re/Rp, ohne Streckgrenze Rm.
Ergebnis: Sicherheit gesamt und „Sicherheit Schichthaftung“, maßgebliche Versagensart, Sicherheit gegen Bruch (Rm).
**„Aufbaurichtung vergleichen“** rechnet X, Y und Z; die **Richtungssuche** bewertet rund 400 Richtungen nach Sicherheit
und Stützmaterial (Überhänge ab 45° werden angezeigt) und übernimmt die beste per Klick. Eigene Zugstab-Messwerte
lassen sich als Kalibrierung übernehmen.

**Wände und Infill** („Wände und Infill berücksichtigen“): Füllmuster (Gitter, Linien, Dreiecke, Waben, Gyroid,
Kubisch, Kreuz), Füllgrad, Anzahl Wände × Linienbreite, Deck-/Bodenschichten × Schichthöhe. Elemente in Wand- bzw.
Deckschichtdicke von der Oberfläche bekommen den vollen Werkstoff, der Kern einen Ersatzwerkstoff (Näherung
f(ρ) = k·ρⁿ + (1−k)·ρ⁸ je Muster für E und R, in der Schicht und quer). Teilweise betroffene Elemente werden nach
Volumenanteil gemischt; Auslastung getrennt für Wand und Infill. Das Netz wird an der Oberfläche auf Wandstärke
verfeinert. Ergebnisansichten „Sicherheit Infill“ und „Wand / Infill“, dazu die **Schnittansicht** (X/Y/Z, Position).

Grenzen: Ersatzwerte des Infills sind Näherungen (mit eigenem Zugstab kalibrieren); Stützstrukturen werden nicht
abgebildet; linear-elastisch, kein Kriechen.

### Schweißnähte (Bleche)

Gekantete Bleche mit geschlossenen Ecken haben im CAD einen kleinen Spalt (z. B. 0,1–1 mm) – ohne Naht sind die
Bleche dort lose. Im Reiter Modell unter **„Schweißnähte“**:

- **„Spalte suchen“** findet einander gegenüberliegende ebene Flächen mit Spalt bis zur angegebenen Weite
  (z. B. die vier Ecken eines Blechkastens) → einzeln oder alle als Naht übernehmen.
- Oder von Hand: **Naht hinzufügen** → Fläche A (meist die schmale Stirnfläche) und Fläche B anklicken.
- **Stumpfnaht durchgeschweißt** (a = Blechdicke) oder **Kehlnaht** mit a-Maß; „Spalt bis“ leer = automatisch.

Rechnerisch wird jeder Knoten von Fläche A mit dem nächsten Punkt von Fläche B gekoppelt (sehr steife Verbindung über
den Spalt). Ergebnis je Naht: übertragene Kraft, Linienkraft entlang der Naht, Nahtspannung τw = größte Linienkraft / a
und der Nachweis nach dem vereinfachten Verfahren EN 1993-1-8 (4.5.3.3): τw ≤ f_vw,d = Rm / (√3·β_w·γ_M2), β_w nach
Stahlsorte (S235: 0,8, S355: 0,9 …), γ_M2 = 1,25. Auch Teile aus mehreren getrennten Körpern lassen sich so verbinden.
Gilt für Statik, Eigenfrequenzen, Knicken und Leichtbau. Beispiel: `examples/geometrie/blechkasten.step`.

### Auswerten und Weitergeben

- **Schnittansicht** (Ergebnis): Ebene X/Y/Z verschieben, Schnittfläche zeigt die Werte im Inneren.
- **Festigkeitsnachweis**: erforderliche Sicherheit gegen Fließen und Bruch, zulässige Verformung (Werkstoff-Bereich);
  im Ergebnis Ausnutzung je Nachweis und „erfüllt/nicht erfüllt“.
- **PDF-Bericht**: Bauteil, Netz, Werkstoff (inkl. 3D-Druck), Lager, Lasten, Ergebnisse, Nachweis, Hinweise, Bilder mit
  Farbskala, Annahmen und Grenzen.
- **MathPad**: Export als `.mathpad`-Rechenblatt (Werkstoffwerte, Maximalwerte, Lagerkräfte, Masse und Nachweis als
  Formeln, z. B. `S_F = R_e / σ_v`).
- **Parameterstudie** (Reiter „Studie“): Netzgröße (Konvergenz), Füllgrad, Maße aus „Geometrie anpassen“,
  **Onshape-Variablen** (`#dicke` …) oder **SolidCraft-Parameter** über mehrere Werte – Tabelle, Diagramm, CSV-Export.
- **Werkstoffe**: Vorlagen mit Dichte (Masse im Ergebnis), eigene Werkstoffe speichern
  (`~/.config/projekt-fem/werkstoffe.json`), Werte aus eigenem Zugversuch übernehmen.

### Geometrie anpassen (grobe Abschätzung)

Reiter **„Geometrie“**: Radius oder Bohrung anklicken und neuen Wert eingeben (0 = scharfe Kante bzw. Bohrung zu),
Material hinzufügen oder entfernen über eine Skizze (Rechteck/Kreis) auf einer Fläche mit Höhe bzw. Tiefe
(„durch alles“). „Änderungen anwenden“ ändert die STEP-Datei, vernetzt neu und stellt Lager und Lasten auf die neuen
Flächen um. Danach rechnen: Das Ergebnis wird mit dem vorherigen verglichen (Spannung, Verformung, Sicherheit,
Volumen). Änderungen einzeln an/aus, Projekt speichert sie mit, geänderte STEP lässt sich exportieren.
Braucht das Python-Modul von Gmsh (bei `uv tool install gmsh` dabei; sonst Pfad in `FEM_GMSH_PYTHON`).
Die Änderungen gehen nicht zurück ins CAD-Modell.

### Leichtbau

Ergebnisansicht „Materialausnutzung“ und **Leichtbau-Vorschlag** (Reiter Geometrie): Topologieoptimierung (SIMP,
Empfindlichkeitsfilter, Optimalitätskriterium) mit vorgegebenem Materialanteil; Flächen mit Lagern und Lasten bleiben
voll. Die Form erscheint im Bauteil, Schwellwert einstellbar, Export als STL.

### Eigenfrequenzen und Knicken

Über „Rechnen“: **Statik / Eigenfrequenzen / Knicken**, Anzahl Moden wählbar. Eigenfrequenzen mit konsistenter
TET10-Massenmatrix (Dichte aus dem Werkstoff), lineares Knicken mit geometrischer Steifigkeit aus der statischen
Lösung (Knicklast = Lastfaktor × Last). Lanczos-Verfahren mit Spektraltransformation (direkte Zerlegung, bis
600 000 Unbekannte). Schwing-/Knickform animiert. Infill wird hier nicht berücksichtigt (massiver Werkstoff).

### Strömung / Wind (überschlägig)

Lastart „Strömung / Wind“: Medium (Luft, Wasser, eigene Dichte), Geschwindigkeit, c_w und Strömungsrichtung →
Druck q = ½·ρ·v²·c_w auf allen angeströmten Flächen (Außennormale gegen die Strömung), Gesamtkraft = q × Projektions-
fläche. Keine Sogseite, keine Umströmung – für genaue Strömungslasten wäre eine CFD-Rechnung (z. B. OpenFOAM) nötig.

### Stabwerk: Balken, Rahmen, Fachwerke

Reiter **„Stabwerk“** (ohne STEP-Datei): Knoten, Stäbe, Profile (Rechteck, Rund, Rohr, Rechteckrohr, IPE 100–300),
Lager (eingespannt, gelenkig, Loslager), Knoten- und Streckenlasten, Eigengewicht, ebene oder räumliche Systeme.
3D-Balken nach Euler-Bernoulli (je Stab 10 Abschnitte) bzw. Fachwerkstäbe (nur Normalkraft). Ergebnis: Verformung,
Normalkraft, Biegemoment, Vergleichsspannung σv = |N|/A + |M|/W (mit Torsion), Ausnutzung je Stab, Lagerkräfte.
Vorlagen: Einfeldträger, Kragarm, Fachwerkbinder, Rahmen; Speichern als `.stab.json`.
Stabilität (Knicken/Kippen) der Stäbe wird nicht nachgewiesen.


### Im Heimnetz nutzen (Laptop, Arbeits-PC)

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

### Eingabedatei (TOML)

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

`projekt-fem validieren` vergleicht mit der Theorie (läuft auch bei `cargo test`) – derzeit **56 von 56 Prüfungen** bestanden:

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
| Zugstab aus zwei Hälften mit 0,2 mm Spalt, Schweißnaht (direkt und iterativ) | Δl, Nahtkraft, Nahtspannung | +0,14 % / exakt / exakt |

Beispiel `platte_druck.toml` (Viertelplatte mit Symmetrie): Durchbiegung 0,166 mm vs. Kirchhoff 0,159 mm,
Spannung 9,3 vs. 9,2 MPa – Unterschied durch die in der Plattentheorie vernachlässigte Dicke.

## Bekannte Grenzen

- Linear-elastisch, kleine Verformungen; kein Kontakt, keine Plastizität, kein Kriechen.
- Baugruppen: mehrere Körper werden an gemeinsamen Flächen verklebt oder über Schweißnähte gekoppelt; Werkstoff je
  Körper, Kontakt und Schrauben fehlen noch. Schalenelemente (Bleche) gibt es nicht – Bleche mit feinem Volumennetz
  rechnen (Elementgröße ≈ Blechdicke).

- **Spannungsspitzen an starren Einspannungen/Kanten sind Singularitäten:** Sie wachsen bei Netzverfeinerung
  immer weiter (Kragbalken-Einspannkante: 128 MPa grob, 169 MPa fein; Theorie 120 MPa). Werte mit Abstand zur
  Einspannung auswerten – die Oberfläche warnt, wenn das Maximum an einem Lager liegt.
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

1. ✅ **Rechenkern:** lineare Statik 3D (TET4/TET10), direkter und iterativer Löser, Validierung an Lehrbuchfällen
2. ✅ **Desktop-App:** STEP-Import, Vernetzung, Lager/Lasten per Klick, Wirkbereiche, Heimnetz-Bedienung im Browser
3. ✅ **Nachweis & Bericht:** Werkstoffdatenbank, Festigkeitsnachweis, PDF-Bericht, Parameterstudien, MathPad
4. ✅ **3D-Druck:** Schichtaufbau, Aufbaurichtung, Wände + Infill, Kalibrierung · **Leichtbau** · **Geometrie anpassen**
5. ✅ **Weitere Analysen:** Stabwerk, Eigenfrequenzen, Knicken, Strömung (überschlägig), Schweißnähte
6. ✅ **CAD-Anbindung:** Onshape, SolidWorks, Fusion, SolidCraft, NX, Solid Edge, Parameterstudien über CAD-Variablen
7. **Als Nächstes:** Baugruppen (Werkstoff je Körper, Verbindungen, Kontakt, Schrauben) → Bewegungssimulation mit
   FEM entlang der Bewegung (z. B. Koppelstange und Bolzen) → Onshape-Konfigurationen, SolidWorks-Konfigurationen,
   DXF → Stabwerk, Slicer-Einstellungen (3MF) übernehmen

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

## Aufbau

```
crates/fem-core   Rechenkern: element, mesh, gmsh (Vernetzung), model, solver, pcg + amg + sparse (iterativer Löser),
                  results, material + infill + orientation (3D-Druck), weld (Schweißnähte), dynamics (Eigenfrequenzen,
                  Knicken), topopt (Leichtbau), frame (Stabwerk), section, region (Wirkbereiche), geometry (+ .py),
                  validate (Lehrbuchfälle), vtk
crates/fem-cli    Kommandozeile `projekt-fem` (rechnen, validieren)
app/              Desktop-App (Tauri 2 + React + three.js); Backend app/src-tauri: Befehle, Heimnetz-Server (server.rs),
                  CAD-Empfang (cad.rs), Onshape (onshape.rs), SolidCraft (solidcraft.rs)
cad-addins/       Knöpfe für SolidWorks, Fusion, NX, Solid Edge + „Senden an“ für jedes CAD
examples/         Beispielfälle (TOML), examples/geometrie: STEP-Testteile (+ .geo-Quellen), z. B. blechkasten.step
docs/bilder/      Bilder für diese Beschreibung
```
