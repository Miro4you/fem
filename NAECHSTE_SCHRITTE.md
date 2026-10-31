# Nächste Schritte (Stand 31.10.26)

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

Maximum im R3-Radius (nicht am Lager) → guter Vergleichsort.

**Von Ansys gebraucht:** max. Gesamtverformung, max. Vergleichsspannung + Ort, Spannung im R3-Radius, Lagerreaktion.
Danach: als fester Prüffall in `validate.rs` einbauen.

## 2. Felix testet die App
Start: App-Menü „Projekt-FEM“ oder `target/release/projekt-fem-app`. Rückmeldung zu Bedienung und Fehlern.

## 3. Bekannte Baustellen
- Speicher: Netze ab ca. 1 Mio. Gleichungen sprengen den RAM (Sitzung ist bei 0,6 mm am Hebel abgestürzt) → iterativer Löser (PCG) nötig
- Lagerlast (Bolzen drückt nur auf eine Bohrungshälfte)
- Reibungsfreie Lagerung auf schrägen Flächen
- Mac-Build testen
- Endgültiger Programmname

## 4. Phase 3 (erst nach Felix' Go)
Werkstoffdatenbank, automatischer Festigkeitsnachweis, PDF-Bericht, Parameterstudien, MathPad-Anbindung.

Danach: Phase 4 Balken/Schalen · Phase 5 Eigenfrequenzen/Knicken · Phase 6 Strömung (OpenFOAM).
