# Testprotokoll Projekt-FEM

Stand: 06.11.2026 · Branch `claude/stoic-maxwell-rtmn09` · Rechenkern: 56 von 56 Lehrbuchprüfungen bestanden
(`./target/release/projekt-fem validieren`), 43 automatische Tests grün.

**So ausfüllen:** Jeden Punkt durchgehen, `[ ]` → `[x]` wenn es passt, sonst Anmerkung dahinter schreiben
(was du gemacht hast, was passiert ist, gern mit Screenshot). Die Datei kannst du mir einfach zurückschicken.

Testteile: `Daten/Hebel.step` (Rechteckaufnahme = Flächen 1, 2, 3, 11; Bohrung Ø8 = 13) und
`examples/geometrie/` (lochplatte, winkel, welle, balken_gelenk). Gern auch eigene Teile.

---

## 0. Aktualisieren und starten

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 0.1 | Im Ordner `FEM`: `git pull` | neuester Stand (`git log --oneline -1` → „Schweißnähte und SolidCraft …“) | [ ] |
| 0.2 | `cd app && npm install` (**neu nötig**: PDF-Bibliothek jsPDF) | ohne Fehler | [ ] |
| 0.3 | `npx tauri build --no-bundle` | baut durch, `target/release/projekt-fem-app` | [ ] |
| 0.4 | App starten | Fenster öffnet, oben 5 Reiter: Modell · Geometrie · Studie · Stabwerk · Ergebnis; rechts „CAD“, „Heimnetz“ | [ ] |
| 0.5 | Mac: dasselbe auf dem Mac | baut und startet | [ ] |

## 1. Grundablauf (Kurzcheck, dass nichts kaputt ist)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 1.1 | Hebel öffnen, S235JR, Lager Rechteckaufnahme fest, Last 1000 N in −y auf Bohrung, Rechnen | max. σv ≈ 209 MPa (2-mm-Netz), u ≈ 0,175 mm, S ≈ 1,12 | [ ] |
| 1.2 | Drehen/Verschieben/Zoomen im Bild | wie zuletzt (CAD-artig) | [ ] |
| 1.3 | Projekt speichern und wieder öffnen | alles wieder da (auch Infill, Nachweis, Geometrieänderungen) | [ ] |

## 2. Fortschrittsanzeige

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 2.1 | Netz auf 1 mm, Neu vernetzen, Rechnen | im grauen Hinweis: „Vernetzen …“, dann „Steifigkeitsmatrix aufbauen“, „Mehrgitter …“, „Iteration n, Restfehler …“ mit Balken, „Spannungen berechnen“ | [ ] |

## 3. Netz in Wirkbereichen verfeinern

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 3.1 | Last mit Wirkbereich (z. B. Kreis Ø10 auf der Oberseite) anlegen | unter Netz Hinweis „Wirkbereiche geändert – Neu vernetzen“, Knopf blau | [ ] |
| 3.2 | Neu vernetzen, „Netz anzeigen“ | im Kreis deutlich feineres Netz | [ ] |
| 3.3 | Häkchen „Netz in Wirkbereichen automatisch verfeinern“ aus, neu vernetzen | wieder gleichmäßiges Netz | [ ] |

## 4. 3D-Druck: Wände + Infill, Schnittansicht

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 4.1 | Werkstoff „PLA (FDM)“, Last auf 100 N | Tabelle XY / Z, Abschnitt Aufbaurichtung | [ ] |
| 4.2 | „Wände und Infill berücksichtigen“ an | Felder Muster, Füllgrad (+ Regler), Wände, Linienbreite, Schichthöhe, Deck-/Bodenschichten; Hinweis mit Wandstärke und Ersatzwerten des Infills | [ ] |
| 4.3 | Neu vernetzen (Netz wird an der Oberfläche auf Wandstärke verfeinert) | dauert länger, deutlich mehr Elemente | [ ] |
| 4.4 | Rechnen | Ergebnis; Ansichten „Sicherheit Infill“ und „Wand / Infill“ wählbar | [ ] |
| 4.5 | Ergebnis → „Schnitt (ins Bauteil schauen)“, Achse Y, Regler verschieben | Bauteil aufgeschnitten, Schnittfläche eingefärbt; bei „Wand / Infill“ rot = Wand außen, blau = Infill innen | [ ] |
| 4.6 | „⇄ Seite“ | andere Hälfte sichtbar | [ ] |
| 4.7 | Füllgrad 20 % → 60 %, rechnen | Sicherheit Infill steigt deutlich, Masse steigt | [ ] |
| 4.8 | Muster durchprobieren (Gitter, Gyroid, Waben …) | plausible Unterschiede (Waben in der Ebene weicher) | [ ] |

## 5. 3D-Druck: Aufbaurichtung, Überhänge, Kalibrierung

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 5.1 | Aufbaurichtung X, Y, Z durchklicken | Schichtlinien und Druckbett drehen mit; rote Flächen = Überhang > 45° | [ ] |
| 5.2 | „⇅ Umdrehen“ | Druckbett auf der anderen Seite, andere Flächen rot | [ ] |
| 5.3 | Nach einer Rechnung „Aufbaurichtung optimieren (alle Richtungen)“ | Tabelle mit 6 Richtungen (S ≈, Stützfläche, Höhe) in < 1 s; Sortierung Sicherheit / wenig Stützmaterial / Kompromiss | [ ] |
| 5.4 | Bei einer Zeile „prüfen“ | Richtung wird übernommen und voll gerechnet | [ ] |
| 5.5 | „Werte aus eigenem Zugversuch übernehmen …“: b, h, L₀, Höchstkraft, F₁/ΔL eintragen, liegend/stehend | Vorschau Rm/Rp/E stimmt mit Handrechnung; „Übernehmen“ setzt die XY- bzw. Z-Werte | [ ] |

## 6. Leichtbau

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 6.1 | Ergebnis → „Materialausnutzung“ | blau = kaum genutztes Material (auch im Schnitt) | [ ] |
| 6.2 | Reiter Geometrie → Leichtbau-Vorschlag: 40 %, 20 Durchläufe, „Form berechnen“ | Fortschritt je Durchlauf; danach grüne Form im durchsichtigen Bauteil entlang des Kraftflusses | [ ] |
| 6.3 | Schwellwert-Regler bewegen | Form wird dicker/dünner, Volumenanteil im Text | [ ] |
| 6.4 | „Form als STL speichern“, in Slicer/CAD öffnen | STL lässt sich öffnen, Maße passen zum Bauteil | [ ] |

## 7. Werkstoffe, Masse, Festigkeitsnachweis

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 7.1 | Werkstoffliste | Gruppen Stahl, Aluminium, Kupfer, Kunststoff, 3D-Druck …; Feld Dichte | [ ] |
| 7.2 | Rechnen | Ergebnis zeigt „Masse“ (Hebel S235: ≈ 105 g) | [ ] |
| 7.3 | „Als eigenen Werkstoff speichern“, Namen eingeben; App neu starten | eigener Werkstoff unter „Eigene Werkstoffe“; löschen geht | [ ] |
| 7.4 | Nachweis: erforderlich 1,5 / 2 eintragen, rechnen | Karte „Festigkeitsnachweis erfüllt/nicht erfüllt“ mit Ausnutzung je Zeile (Hebel 1000 N: 134 % / 116 % → nicht erfüllt) | [ ] |
| 7.5 | „Verformung max.“ eintragen | zusätzliche Zeile Verformung | [ ] |

## 8. PDF-Bericht

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 8.1 | Ergebnis → „Bericht als PDF“ | App schaltet kurz durch die Ansichten, dann Speichern-Dialog | [ ] |
| 8.2 | PDF öffnen | 4–6 Seiten: Kopf mit Urteil, Bauteil/Netz, Werkstoff, Lager, Lasten, Ergebnisse, Nachweis, Hinweise, Bilder mit Farbskala, Annahmen | [ ] |
| 8.3 | Mit 3D-Druck-Werkstoff + Infill | Werkstoffteil enthält Aufbaurichtung, Füllung, Wände | [ ] |

## 9. Parameterstudie (Reiter „Studie“)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 9.1 | Netzgröße „4; 3; 2; 1,5“, Studie starten | Tabelle + Diagramm; Hebel: σv steigt leicht (200 → 210 MPa), u fast gleich | [ ] |
| 9.2 | Im Diagramm über die Punkte fahren | Wert erscheint | [ ] |
| 9.3 | Reiter Geometrie: Radius-Änderung anlegen; Studie → Parameter „Radius“, Werte „4; 6; 8; 10“ | je Wert Geometrie geändert und gerechnet; danach Ausgangszustand wieder da | [ ] |
| 9.4 | Mit Infill: Parameter Füllgrad | Werte je Füllgrad | [ ] |
| 9.5 | „Tabelle als CSV (Excel)“ | öffnet sich in Excel/LibreOffice korrekt (Semikolon, Komma) | [ ] |

## 10. MathPad

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 10.1 | Ergebnis → „Nach MathPad (.mathpad)“ | Datei „… FEM.mathpad“ | [ ] |
| 10.2 | In MathPad öffnen | Notizen + Werte mit Einheiten (E, R_e, σ_v, u_max, m, F_A1x …), S_F = R_e/σ_v rechnet live, a_F = Ausnutzung | [ ] |

## 11. Eigenfrequenzen und Knicken

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 11.1 | Über „Rechnen“: „Eigenfrequenzen“, 6 Moden | Liste in Hz (Hebel: 1. Mode ≈ 597 Hz, Arm schwingt aus der Ebene) | [ ] |
| 11.2 | Zeilen anklicken | jeweilige Schwingform, animiert („Form animieren“) | [ ] |
| 11.3 | Ohne Dichte im Werkstoff | Hinweis „Dichte angeben“ | [ ] |
| 11.4 | „Knicken“, rechnen | Lastfaktoren λ und Knicklast (Hebel 1000 N: λ ≈ 82) | [ ] |
| 11.5 | Zurück auf „Statik“ | normales Ergebnis wieder sichtbar | [ ] |

## 12. Strömung / Wind

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 12.1 | Last „Strömung / Wind“, „Alle Außenflächen wählen“, Luft 30 m/s, c_w 1,2, Richtung −z | Hinweis mit Druck ≈ 662 Pa; Pfeil in Strömungsrichtung | [ ] |
| 12.2 | Rechnen | „Summe Lasten“ ≈ Druck × angeströmte Fläche (Hebel Oberseite 26,8 cm² → ≈ 1,8 N) | [ ] |

## 13. Stabwerk (Reiter „Stabwerk“)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 13.1 | Vorlage „Einfeldträger“, rechnen | IPE 200, 4 m, 20 kN: σv = 103,1 MPa, w = 6,54 mm (Handrechnung F·L/4/W und F·L³/48EI) | [ ] |
| 13.2 | Vorlagen Kragarm, Fachwerkbinder, Rahmen | plausible Bilder; beim Binder Pfosten über unbelasteten Untergurtknoten = Nullstäbe (blau) | [ ] |
| 13.3 | Anzeige Ausnutzung / Normalkraft / Biegemoment | Farben und Legende wechseln | [ ] |
| 13.4 | Eigenes Modell: Knoten, Stäbe, Lager, Lasten ändern | Bild aktualisiert sofort, Rechnen geht | [ ] |
| 13.5 | Speichern / Öffnen | `.stab.json` geht wieder auf | [ ] |
| 13.6 | Mechanismus bauen (z. B. Lager löschen) | verständliche Meldung „nicht ausreichend gelagert“ | [ ] |

## 14. Heimnetz (Laptop/Arbeits-PC)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 14.1 | Heimnetz-Freigabe an, Link am Laptop öffnen | App im Browser | [ ] |
| 14.2 | Stichproben im Browser: Infill + Schnitt, PDF, MathPad, Studie, Stabwerk, Eigenfrequenzen | geht wie am PC (Dateien als Download) | [ ] |

## 15. CAD-Schnittstelle (Knöpfe im CAD) – Anleitung: `cad-addins/README.md`

**Reihenfolge für dich:** zuerst **Onshape** (15.2–15.6, privat am meisten genutzt), dann **SolidWorks** (15.10, Arbeit –
Makro-Rechte vorher klären), **Fusion** (15.7–15.9) bei Gelegenheit, SolidCraft (15.1a–e), wenn du es dir anschaust.
NX, Solid Edge und „Senden an“ kannst du überspringen.

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 15.1 | Oben **„CAD“** öffnen | Dialog mit Erklärung, Abschnitte SolidCraft und Onshape | [ ] |
| 15.1a | **SolidCraft** starten (gleicher Rechner), ein Teil konstruieren; in Projekt-FEM „CAD“ → SolidCraft | „gefunden“ | [ ] |
| 15.1b | „Live mitlaufen“ anhaken | Design wird geöffnet („SolidCraft: „…“ geöffnet“) | [ ] |
| 15.1c | Lager + Last setzen, rechnen. In SolidCraft ein Maß ändern | nach ~1–2 s: „neue Version … übernommen und neu gerechnet“, Vergleich | [ ] |
| 15.1d | „Ergebnis → SolidCraft“ | in SolidCraft im Parameter-Fenster FEM_Sicherheit, FEM_SigmaV_MPa, FEM_Verformung_mm … | [ ] |
| 15.1e | Reiter Studie → Parameter „SolidCraft: <dein Maß>“, z. B. 3 Werte → Studie starten | Kurve/Tabelle; danach hat das Maß in SolidCraft wieder den alten Wert | [ ] |
| 15.2 | **Onshape:** API-Schlüssel anlegen (dev-portal.onshape.com → API keys, lesen + schreiben), in „CAD“ eintragen | „API-Schlüssel hinterlegt“, zwei Lesezeichen erscheinen | [ ] |
| 15.3 | Lesezeichen „→ Projekt-FEM“ in die Lesezeichenleiste ziehen, in Onshape ein Teilestudio öffnen, Lesezeichen klicken | kleines Fenster „… an Projekt-FEM geschickt“, Projekt-FEM öffnet „Dokument - Teilestudio“ | [ ] |
| 15.4 | Lager + Last setzen, rechnen. In Onshape etwas ändern (z. B. Radius), Lesezeichen wieder klicken | Hinweis „neue Version … übernommen und neu gerechnet“, Vergleich vorige Version ↔ aktuell | [ ] |
| 15.5 | Lesezeichen „FEM-Ergebnis → Onshape“ klicken, in Onshape Teil → Eigenschaften | Beschreibung enthält `[FEM …: S = … · σv … · u … · … g …]`, eigener Text bleibt | [ ] |
| 15.5a | **Onshape-Variable:** im Teilestudio Feature „Variable“ `#dicke = 5 mm` anlegen und in einer Extrusion verwenden, Teil holen, rechnen; Reiter Studie → „Onshape: #dicke“ → `3; 5; 8` → Studie starten | Kurve/Tabelle; in Onshape steht danach wieder 5 mm | [ ] |
| 15.6 | Falls der Browser das Lesezeichen blockiert: Onshape-Adresse kopieren → „CAD“ → einfügen → „Holen“ | Teil wird geöffnet | [ ] |
| 15.7 | **Fusion:** Add-in einrichten (Umschalt+S → Add-Ins → +), Reiter VOLUMENKÖRPER | Gruppe „Projekt-FEM“ mit zwei Knöpfen | [ ] |
| 15.8 | Fusion: „In Projekt-FEM rechnen“, in Projekt-FEM rechnen, in Fusion ändern, nochmal „In Projekt-FEM rechnen“ | wie 15.3/15.4 | [ ] |
| 15.9 | Fusion: „Ergebnis holen“ | Meldung mit Werten, Ändern → Parameter: FEM_Sicherheit usw. | [ ] |
| 15.10 | **SolidWorks:** Makro importieren, zwei Makro-Knöpfe anlegen, senden + Ergebnis holen | Teil kommt an; Datei → Eigenschaften → Benutzerdefiniert: FEM_… | [ ] |
| 15.11 | **NX:** Journale ausführen (Alt+F8), dann als Benutzerbefehl-Knopf | Teil kommt an; Attribute FEM_… | [ ] |
| 15.12 | **Solid Edge** (falls du das mit „SolidCraft“ meintest): Skripte per Doppelklick | Teil kommt an; Eigenschaften FEM_… | [ ] |
| 15.13 | **Anderes CAD / Datei:** „Senden an → An Projekt-FEM“ (Windows) bzw. Schnellaktion (Mac) auf eine `.step` | Teil wird geöffnet | [ ] |
| 15.14 | **Über das Heimnetz:** am Laptop `projekt-fem-cad.txt` aus dem Dialog „CAD“ anlegen, dort aus dem CAD senden; Projekt-FEM im Browser offen | Teil erscheint im Browser-Tab; „Ergebnis holen“ geht auch | [ ] |
| 15.15 | Projekt-FEM neu starten, im CAD „Ergebnis holen“ | letzte Werte kommen noch | [ ] |

Fehlermeldungen aus dem CAD bitte wörtlich oder als Screenshot – die CAD-Schnittstellen unterscheiden sich je nach
Version, ich konnte Fusion/SolidWorks/NX/Solid Edge hier nicht selbst starten (Onshape nur gegen einen Nachbau).

## 16. Schweißnähte (Bleche) – Reiter Modell, Abschnitt „Schweißnähte“

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 16.1 | `examples/geometrie/blechkasten.step` öffnen (Blechkasten 2 mm, Ecken mit 0,2 mm Spalt). Boden unten fest, auf die Außenseite einer Längswand 2000 N nach innen, rechnen | rechnet, u max ≈ 0,9 mm (Wand nur am Boden gehalten) | [ ] |
| 16.2 | „Spalte suchen“ (bis 1 mm) | 4 Spalte à 0,2 mm, 76 mm² | [ ] |
| 16.3 | „Alle 4 als Naht übernehmen“, rechnen | u max ≈ 0,5 mm; Karte „Schweißnähte“ mit Kraft, l/a, τw, Ausnutzung | [ ] |
| 16.4 | Eine Naht auf „Kehlnaht“, a = 1 mm | τw steigt etwa auf das Doppelte | [ ] |
| 16.5 | Naht von Hand: „Naht hinzufügen“ → Fläche A (schmale Stirnfläche), Fläche B (Gegenfläche) | Flächen orange eingefärbt, Zähler | [ ] |
| 16.6 | **Dein SolidWorks-Blechteil** mit geschlossenen Ecken als STEP: Spalte suchen, Nähte, rechnen | Spalte werden gefunden, Ergebnis plausibel? | [ ] |
| 16.7 | Ohne Nähte bei getrennten Teilen rechnen | Meldung „nicht ausreichend gelagert … Schweißnähte anlegen“ | [ ] |
| 16.8 | PDF-Bericht | Abschnitt „Schweißnähte“ | [ ] |
| 16.9 | Projekt speichern und öffnen | Nähte wieder da | [ ] |

---

## Annahmen und Standardwerte, die du prüfen solltest

- **Infill-Ersatzwerte** sind Näherungen (Gibson/Ashby-Skalierung je Muster), keine Messwerte – siehe Hinweistext beim
  Infill. Am besten mit eigenem Zugstab gleicher Einstellungen gegenprüfen.
- **Druckwerkstoffe** (PLA, PETG …): Richtwerte für 100 % Füllung; stark drucker- und einstellungsabhängig.
- **Slicer-Voreinstellung**: Gyroid 20 %, 2 Wände × 0,45 mm, Schicht 0,2 mm, 5 Deck- / 4 Bodenschichten.
- **Überhang** ab 45° (FDM-Faustregel).
- **Erforderliche Sicherheiten** Standard 1,5 (Fließen) / 2,0 (Bruch).
- **Strömung**: nur Staudruck × c_w auf der angeströmten Seite, keine Sogseite.
- **IPE-Profilwerte** aus der Profiltabelle (DIN 1025-5) – bei Bedarf gegenprüfen.
- **Schweißnähte**: Nachweis vereinfacht nach EN 1993-1-8 (Linienkraft / a ≤ Rm/(√3·β_w·1,25)), β_w aus dem
  Werkstoffnamen (S235 0,8, S275 0,85, S355 0,9, S420/S460 und Edelstahl 1,0, sonst 0,8). Nahtenden/Kerben und
  Ermüdung nicht bewertet. Die Naht ist ideal steif (keine Nahtnachgiebigkeit).

## Bekannte Grenzen

- Alles linear-elastisch, kleine Verformungen; kein Kontakt, keine Plastizität, kein Kriechen.
- Eigenfrequenzen/Knicken: massiver Werkstoff (Infill wird dort nicht berücksichtigt), bis ca. 600 000 Unbekannte.
- Stabwerk: kein Stabilitätsnachweis der Stäbe (Biegeknicken/Kippen), keine Schnittgrößen-Diagramme.
- Schalenelemente (Bleche) nicht umgesetzt – dünne Teile mit feinem Volumennetz rechnen.
- Strömung nur überschlägig (keine CFD).
- Topologieoptimierung: Form ist ein Vorschlag (STL), keine fertige CAD-Geometrie.

## Fragen an dich

1. **Programmname** – Vorschläge: „Kraftfluss“, „Lastpfad“, „Spannweite“, „Formfest“ – oder eigener?
2. **Geometrie bearbeiten**: Was fehlt dir genau? (Ablauf beschreiben: was willst du am Teil ändern, wie soll es sich bedienen?)
3. **Baugruppen** (neu auf der Liste): Welche Fälle hast du? (verschraubt, verklebt, Kontakt mit Spalt, Pressverband …)
4. **Ansys-Werte** für den Hebel (Spannung im R6-Radius, max. Verformung, Lagerkraft).
5. **Slicer**: Prusa, Orca oder Bambu Studio? Dann kann als Nächstes der 3MF-Import der Slicer-Einstellungen kommen.
6. **CAD**: SolidWorks-Version auf der Arbeit? (Makros/VBA erlaubt?) Onshape-Abo (Free/Standard/Professional)?
7. **Schweißnähte**: Brauchst du auch unterbrochene Nähte (nur Abschnitte) oder Punktschweißungen? Und Nähte an
   T-Stößen ohne Spalt (Kehlnaht zwischen zwei Blechen, die sich berühren)?
