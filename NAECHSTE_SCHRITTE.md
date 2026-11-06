# Nächste Schritte (Stand 06.11.26)

**Aktuell: Felix testet nach `TESTPROTOKOLL.md`.**

## 1. Ansys-Vergleich Hebel (wartet auf Felix)
Geometrie: `Daten/Hebel.step` (Onshape, in Metern gespeichert → wird korrekt in mm gelesen).
100 × 70 × 5 mm, Nabe R20 mit Rechteckaufnahme 20 × 12, Arm 20 breit, Bohrung Ø8 bei (70, −40), Radien R3 Nabe→Arm.

CAD-Flächen: 1, 2, 3, 11 = Rechteckaufnahme · 13 = Bohrung Ø8 · 16, 17 = R3-Radien · 14/15 = Ober-/Unterseite.

**Vorschlag-Setup (bitte in Ansys genau so):**
- Werkstoff: E = 210 000 MPa, ν = 0,3
- Lager: Rechteckaufnahme (Flächen 1, 2, 3, 11) fest eingespannt
- Last: 1000 N in −y auf Bohrung Ø8 (in Ansys „Force“, NICHT „Bearing Load“)
- Netz quadratisch, z. B. 1 mm

**Projekt-FEM-Ergebnis (Netzstudie):**

| Netz | max. Verschiebung | max. Vergleichsspannung |
|---|---|---|
| 4 mm | 0,1748 mm | 200,5 MPa |
| 2 mm | 0,1750 mm | 209,3 MPa |
| 1 mm | 0,1752 mm | 211,5 MPa |
| 0,6 mm | 0,1753 mm | 216,5 MPa |
| 0,5 mm | 0,1753 mm | 228,6 MPa ⚠ |

Bis 1 mm liegt das Maximum im R3-Radius (nicht am Lager) → guter Vergleichsort.
Ab ca. 0,5 mm wandert es an die Ecke der Rechteckaufnahme (Singularität an der starren Einspannung, wächst mit
feinerem Netz weiter) → in Ansys die Spannung **im R3-Radius** vergleichen, nicht nur das globale Maximum.

**Von Ansys gebraucht:** max. Gesamtverformung, max. Vergleichsspannung + Ort, Spannung im R3-Radius, Lagerreaktion.
Danach: als fester Prüffall in `validate.rs` einbauen.

## 2. Felix testet die App
Start: App-Menü „Projekt-FEM“ oder `target/release/projekt-fem-app`. Rückmeldung zu Bedienung und Fehlern.

## 3. Bekannte Baustellen
- ✅ Speicher: iterativer Löser (CG + Mehrgitter) eingebaut, schaltet ab 50 000 Unbekannten automatisch um.
  Hebel 0,6 mm (1,3 Mio. Unbekannte) jetzt 70 s / 3,4 GB statt Absturz. Mögliche Ergänzung: Fortschrittsanzeige
  in der App während langer Rechnungen.
- ✅ Lagerlast (Bolzen drückt nur auf eine Bohrungshälfte, cos-verteilt) + Moment als Last
- ✅ Rückmeldung Felix (1. Test): CAD-Drehen ohne Anschlag um den Punkt unter der Maus, Zoom zur Maus;
  Auswahlfelder im dunklen Modus lesbar; Last als Betrag + Richtung (Achsknöpfe, Winkel, Fläche anklicken);
  Schieberegler für die Netzgröße mit Schätzung der Elementzahl
- ✅ Heimnetz: Desktop-App gibt die Oberfläche als Webseite frei (Knopf „Heimnetz“), gerechnet wird auf dem
  starken PC; alternativ `projekt-fem-app --server` ohne Fenster → Felix: vom Laptop/Arbeits-PC testen
  (Arbeits-PC nur, wenn er im selben Netz ist bzw. per VPN – nicht ins Internet freigeben)
- ✅ Wirkbereich: Last/Lager nur auf einem gezeichneten Kreis/Rechteck oder Wellen-/Bohrungsabschnitt
  → Felix: bitte in der App ausprobieren (Last anlegen → „Wirkbereich“ wählen → im Bild aufziehen)
- Idee: Netz im Wirkbereich automatisch verfeinern (Gmsh-Größenfeld), damit kleine Bereiche scharf abgebildet werden
- ✅ Reibungsfreie Lagerung auf schrägen Flächen (lokale Knotenbasen)
- ✅ Zylindrische Lagerung (Bolzen/Gelenk), Lastpfeil im Bild ausrichten (Frei/XY/YZ/XZ, 5°-Raster)
- ✅ 3D-Druck: Schichtaufbau (E, Rp/Re, Rm je XY und Z), Aufbaurichtung wählen/vergleichen, Schichthaftung als
  eigene Auslastung. Ideen: Füllgrad/Wandlinien berücksichtigen, Ausrichtung frei optimieren (nicht nur X/Y/Z),
  Stützstrukturen/Überhänge bewerten, Materialdatenbank mit Herstellerwerten
- Geometrie anpassen: Felix ist mit der Bearbeitung noch nicht zufrieden → Wunschablauf klären
- ✅ Geometrie anpassen (grobe Abschätzung): Reiter „Geometrie“ – Radius/Bohrung ändern, Material hinzu/weg per
  Skizze, Vorher/Nachher-Vergleich. Später möglich: Linienzug-Skizze, Kanten neu verrunden, Fasen
- Hinweis: Die „R3“-Radien am Hebel (Flächen 16/17) sind laut Geometrie R6
- ✅ Fortschrittsanzeige, Netzverfeinerung in Wirkbereichen
- ✅ 3D-Druck: Wände + Infill (Schale + Kern), Aufbaurichtung frei optimieren, Überhänge, Kalibrierung
- ✅ Schnittansicht
- ✅ Leichtbau: Materialausnutzung + Topologieoptimierung mit STL-Export
- ✅ Phase 3: Werkstoffdatenbank (Dichte, eigene Werkstoffe), Festigkeitsnachweis, PDF-Bericht,
  Parameterstudien, MathPad-Export
- ✅ Phase 4: Stabwerk (Balken/Rahmen/Fachwerke, Profile inkl. IPE, Vorlagen). Offen: Schalenelemente,
  Stabilitätsnachweis der Stäbe (Biegeknicken/Kippen), Schnittgrößenverläufe als Diagramm
- ✅ Phase 5: Eigenfrequenzen + lineares Knicken (Lanczos), animierte Formen, Prüffälle Kragbalken/Euler
- ✅ Phase 6 (überschlägig): Strömungs-/Windlast (Staudruck × c_w auf angeströmte Flächen). Echte CFD-Kopplung
  (OpenFOAM: Netz, Löser, Druckfeld zurück auf die Oberfläche) wäre ein eigenes Großprojekt
- ✅ CAD-Schnittstelle: Knöpfe „In Projekt-FEM rechnen“ / „Ergebnis holen“ – Onshape (API + Lesezeichen),
  Fusion (Add-in), SolidWorks (Makro), NX (Journale), Solid Edge (Skripte), „Senden an“ für jedes CAD.
  Gleiches Teil → Lager/Lasten übertragen, automatisch neu rechnen, Vergleich. In den echten CAD-Programmen
  noch ungetestet (Felix). Später: Onshape-Konfigurationen/Variablen, Baugruppen aus dem CAD, DXF → Stabwerk
  (AutoCAD), farbiges Ergebnis zurück ins CAD
- ✅ SolidCraft live (Steuerkanal): mitlaufen, neu rechnen, Ergebnis als Parameter/Eigenschaft, Parameterstudie über
  SolidCraft-Parameter. Gegen Nachbau getestet, echtes SolidCraft steht aus. Später: Knopf in SolidCraft, sobald
  dort Plugins laufen; ggf. SolidCraft-Projekt vorstellen (Showcase/Discord)
- ✅ Schweißnähte (Bleche mit Spalt, getrennte Teile): Kopplung über den Spalt, Spaltsuche, Nahtkraft/Linienkraft/τw,
  Nachweis EN 1993-1-8 vereinfacht. Offen: unterbrochene Nähte/Punktschweißen, Kehlnähte an T-Stößen ohne Spalt,
  Ermüdung (Kerbfälle)
- CAD-Schwerpunkt laut Felix: **Onshape** (privat, Hauptsystem), **SolidWorks** (Arbeit), Fusion selten,
  SolidCraft zum Anschauen. Breite Kompatibilität bleibt Ziel (Bekanntheit). Nächste Kandidaten: Parameterstudie über
  ✅ Onshape-Variablen (Teilestudio) – mit echtem Onshape getestet. Offen: Variablen-Studios, Konfigurationen,
  SolidWorks-Konfigurationen. Onshape-Anbindung mit echtem Konto getestet (06.11.)
- **Neu (später, nach Baugruppen): Bewegungssimulation + FEM** – Mechanismus aus der Baugruppe (Gelenke: Drehgelenk,
  Schubgelenk, Bolzen), Antrieb (Drehzahl/Kurbelwinkel oder Kraft/Moment), Starrkörper-Mehrkörperrechnung → Gelenk-
  und Bolzenkräfte über den Bewegungsweg (inkl. Massenkräfte) → Kurve „Kraft über Winkel/Zeit“ → für die kritischen
  Stellungen automatisch FEM je Teil (quasistatisch, z. B. Koppelstange + Bolzen) → Sicherheit über den Bewegungsweg,
  später Dauerfestigkeit (Lastzyklen) und Bolzen auf Abscheren/Lochleibung. Onshape-Mates/Fusion-Gelenke übernehmen.
- **Neu: Baugruppen** – mehrere Körper aus einer STEP-Datei: Werkstoff je Körper, Verbindungen (verklebt/
  verschraubt/Kontakt), Körper ein-/ausblenden, Kräfte zwischen den Körpern auswerten
- Mac: läuft laut Felix (installiert) – Rückmeldung abwarten
- Endgültiger Programmname

## 4. Phase 3 (erst nach Felix' Go)
Werkstoffdatenbank, automatischer Festigkeitsnachweis, PDF-Bericht, Parameterstudien, MathPad-Anbindung.

Danach: Phase 4 Balken/Schalen · Phase 5 Eigenfrequenzen/Knicken · Phase 6 Strömung (OpenFOAM).
