# Nächste Schritte (Stand 31.10.26, aktualisiert)

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
- Offen: Geometrie nach dem Ergebnis anpassen – Felix: STEP-Direktänderung und Onshape-API beide „nicht ganz optimal“
  → klären, wie der Ablauf idealerweise aussehen soll
- Danach: „wenig genutztes Material“ + Topologieoptimierung (Leichtbau)
- Mac-Build testen
- Endgültiger Programmname

## 4. Phase 3 (erst nach Felix' Go)
Werkstoffdatenbank, automatischer Festigkeitsnachweis, PDF-Bericht, Parameterstudien, MathPad-Anbindung.

Danach: Phase 4 Balken/Schalen · Phase 5 Eigenfrequenzen/Knicken · Phase 6 Strömung (OpenFOAM).
