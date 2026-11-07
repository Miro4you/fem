# Testprotokoll Projekt-FEM

Stand: 06.11.2026 · Branch `claude/stoic-maxwell-rtmn09` · Rechenkern: 66 von 66 Lehrbuchprüfungen bestanden
(`./target/release/projekt-fem validieren`), 45 automatische Tests grün.

**So ausfüllen:** Jeden Punkt durchgehen, abhaken wenn es passt, sonst Anmerkung dazuschreiben (was du gemacht hast,
was passiert ist, gern mit Screenshot). Die Datei oder ein Foto des ausgedruckten PDFs kannst du mir einfach schicken.

**Wichtigste Punkte zuerst:** 0 (Starten), **0a (neue Oberfläche, besonders Maus/Trackpad)**, 1 + 1a (Grundablauf, Animation), 15.2–15.5a (Onshape), 16 (Schweißnähte,
besonders 16.6 mit deinem SolidWorks-Blech), 15.10 (SolidWorks). Der Rest nach Lust und Zeit.

Testteile: `Daten/Hebel.step` (Rechteckaufnahme = Flächen 1, 2, 3, 11; Bohrung Ø8 = 13) und
`examples/geometrie/` (lochplatte, winkel, welle, balken_gelenk, blechkasten). Gern auch eigene Teile.
Onshape: öffentliches Testdokument „Projekt-FEM Test 1“ (Lasche mit `#dicke`, Hebel) in deinem Konto.

---

## 0. Aktualisieren und starten

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 0.1 | Im Ordner `FEM`: `git fetch && git checkout claude/stoic-maxwell-rtmn09 && git pull` (oder nach dem Zusammenführen des nächsten Pull Requests `git checkout main && git pull`) | `git log --oneline -1` zeigt „Neue Oberfläche …“ oder neuer | [ ] |
| 0.2 | `cd app && npm install` (neu: PDF-Bibliothek jsPDF) | ohne Fehler | [ ] |
| 0.3 | `npx tauri build --no-bundle` (lädt beim ersten Mal neue Rust-Bibliotheken, Internet nötig) | baut durch, `target/release/projekt-fem-app` | [ ] |
| 0.4 | App starten | Startseite „Was möchtest du rechnen?“ mit vier Kacheln; oben rechts Datei, Export, Einstellungen (Regler-Symbol) | [ ] |
| 0.5 | Mac: dasselbe auf dem Mac | baut und startet | [ ] |

## 0a. Neue Oberfläche (nach deinem Entwurf)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 0a.1 | Startseite: STEP-Datei per Kachel öffnen, danach Logo oben links | zurück zur Startseite, „Zurück zu …“, unter „Zuletzt geöffnet“ steht das Teil | [ ] |
| 0a.2 | STEP-Datei aus dem Dateimanager auf das Fenster ziehen | wird geöffnet | [ ] |
| 0a.3 | Studienbaum: Teil, Werkstoff, Netz, Lager, Lasten, Verbindungen nacheinander anklicken | darunter jeweils die passenden Eigenschaften; grüner Punkt = festgelegt, Kreis = offen | [ ] |
| 0a.4 | Bei **Lager** auf „neu“ | Lager-Arten als Symbole (fest, gleitend, Bolzen, Richtungen), Flächenauswahl aktiv; Fläche anklicken, „Fertig“ | [ ] |
| 0a.5 | Bei **Lasten** auf „neu“, ebene Fläche anklicken | Kraft 1000 N **senkrecht auf die Fläche** (Pfeil drückt auf die Fläche); Betrag ändern, X/Y/Z (nochmal klicken = Gegenrichtung), umkehren, Pfeil im Bild ziehen | [ ] |
| 0a.6 | Rechnen-Knopf, solange etwas fehlt | grau; Klick zeigt „Noch offen“, Klick auf einen Punkt springt zum Eintrag | [ ] |
| 0a.7 | Im Bild auf eine blaue bzw. orange Fläche klicken | zugehöriges Lager bzw. Last wird im Baum gewählt | [ ] |
| 0a.8 | **Analyse:** Eigenfrequenzen wählen, rechnen; zurück auf Statik | Formen-Anzahl im Baumkopf, Ergebnis mit Frequenzen | [ ] |
| 0a.9 | Ansichtswürfel: OBEN, VORNE … anklicken; Haus (Startansicht), Rahmen (alles zeigen); Achse X/Y/Z unten links | Blick senkrecht auf die Seite bzw. Ebene | [ ] |
| 0a.10 | Doppelklick auf eine Fläche | Blick senkrecht auf diese Fläche | [ ] |
| 0a.11 | **Mac-Trackpad:** Einstellungen › Maus & Trackpad › „Trackpad (Mac)“: zwei Finger wischen, spreizen, ⇧ + zwei Finger, Klick | drehen um den Punkt unter dem Zeiger, zoomen zum Zeiger, verschieben, Klick wählt nur (dreht nicht) | [ ] |
| 0a.12 | **Maus wie Onshape** bzw. **wie SolidWorks** (am PC) | rechte bzw. mittlere Taste dreht, Rad zoomt zum Zeiger; fühlt es sich an wie im CAD? | [ ] |
| 0a.13 | Ergebnis: Urteil oben, σv / u / S / mehr, Details auf- und zuklappen | rot bei „Nachweis nicht erfüllt“, grün bei erfüllt; Details bleiben so, wie zuletzt eingestellt | [ ] |
| 0a.14 | Leiste im Bild: **Iso-Clip**, Regler auf ~100 MPa, über/unter | nur die Bereiche über (unter) dem Wert farbig, Rest grau | [ ] |
| 0a.15 | **Messen** an, Klick aufs Bauteil | Kästchen mit σv, u und S an der Stelle; Messen aus = Klick ohne Wirkung | [ ] |
| 0a.16 | Einstellungen › Darstellung: hell / dunkel, Farbstufen aus | Erscheinungsbild wechselt; fließender Farbverlauf | [ ] |
| 0a.17 | Was ist noch unklar, zu voll oder fehlt? „Fläche teilen“ ist als „bald“ markiert (kommt als Nächstes) | deine Anmerkungen | [ ] |

## 1. Grundablauf (Kurzcheck, dass nichts kaputt ist)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 1.1 | Hebel öffnen, S235JR, Lager Rechteckaufnahme fest, Last 1000 N auf Bohrung, Richtung Y und nochmal Y (= −Y), Rechnen | max. σv ≈ 209 MPa (2-mm-Netz), u ≈ 0,175 mm, S ≈ 1,12 | [ ] |
| 1.2 | Drehen/Verschieben/Zoomen im Bild | wie in Einstellungen › Maus & Trackpad gewählt (unten im Bild steht die Kurzhilfe) | [ ] |
| 1.3 | Projekt speichern und wieder öffnen | alles wieder da (auch Infill, Nachweis, Geometrieänderungen) | [ ] |

## 1a. Verformungsanimation und Video

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 1a.1 | Hebel rechnen, in der Leiste unten im Bild **Animation** | Bauteil verformt sich langsam hin und zurück, Farben wachsen mit der Last | [ ] |
| 1a.2 | Geschwindigkeit ½× / 2×, Darstellung auf Verschiebung bzw. Sicherheit umstellen | läuft weiter; bei Sicherheit bleiben die Farben fest | [ ] |
| 1a.3 | **Video** (Kamera-Symbol rechts in der Leiste oder Export › Video der Verformung) | nach ~6 s Datei `Hebel-verformung.webm` (Mac: `.mp4`), mit Titel, Kennwerten, Farbskala, „Last … %“ | [ ] |
| 1a.4 | Video in der Linux-Desktop-App | geht oder klare Meldung (dann im Browser über die Heimnetz-Ansicht) | [ ] |

## 2. Fortschrittsanzeige

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 2.1 | Netz auf 1 mm, Neu vernetzen, Rechnen | im grauen Hinweis: „Vernetzen …“, dann „Steifigkeitsmatrix aufbauen“, „Mehrgitter …“, „Iteration n, Restfehler …“ mit Balken, „Spannungen berechnen“ | [ ] |

## 3. Netz in Wirkbereichen verfeinern

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 3.1 | Last mit Wirkbereich (bei der Last unter „Mehr“, z. B. Kreis Ø10 auf der Oberseite) anlegen | im Studienbaum bei Netz offener Kreis, unter Netz Hinweis „Neu vernetzen“, Knopf blau | [ ] |
| 3.2 | Neu vernetzen, „Netz anzeigen“ | im Kreis deutlich feineres Netz | [ ] |
| 3.3 | Häkchen „Netz in Wirkbereichen automatisch verfeinern“ aus, neu vernetzen | wieder gleichmäßiges Netz | [ ] |

## 4. 3D-Druck: Wände + Infill, Schnittansicht

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 4.1 | Werkstoff „PLA (FDM)“, Last auf 100 N | Tabelle XY / Z, Abschnitt Aufbaurichtung | [ ] |
| 4.2 | „Wände und Infill berücksichtigen“ an | Felder Muster, Füllgrad (+ Regler), Wände, Linienbreite, Schichthöhe, Deck-/Bodenschichten; Hinweis mit Wandstärke und Ersatzwerten des Infills | [ ] |
| 4.3 | Neu vernetzen (Netz wird an der Oberfläche auf Wandstärke verfeinert) | dauert länger, deutlich mehr Elemente | [ ] |
| 4.4 | Rechnen | Ergebnis; Ansichten „Sicherheit Infill“ und „Wand / Infill“ wählbar | [ ] |
| 4.5 | Ergebnis, Leiste im Bild → **Schnitt**, Achse Y, Regler verschieben | Bauteil aufgeschnitten, Schnittfläche eingefärbt; bei „Wand / Infill“ rot = Wand außen, blau = Infill innen | [ ] |
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
| 6.1 | Ergebnis → „mehr …“ → „Materialausnutzung“ | blau = kaum genutztes Material (auch im Schnitt) | [ ] |
| 6.2 | Werkzeugleiste links **Leichtbau**: 40 %, 20 Durchläufe, „Form berechnen“ | Fortschritt je Durchlauf; danach grüne Form im durchsichtigen Bauteil entlang des Kraftflusses | [ ] |
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
| 8.1 | **Export › Bericht als PDF** | App schaltet kurz durch die Ansichten, dann Speichern-Dialog | [ ] |
| 8.2 | PDF öffnen | 4–6 Seiten: Kopf mit Urteil, Bauteil/Netz, Werkstoff, Lager, Lasten, Ergebnisse, Nachweis, Hinweise, Bilder mit Farbskala, Annahmen | [ ] |
| 8.3 | Mit 3D-Druck-Werkstoff + Infill | Werkstoffteil enthält Aufbaurichtung, Füllung, Wände | [ ] |

## 9. Parameterstudie (Werkzeugleiste links „Studie“)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 9.1 | Netzgröße „4; 3; 2; 1,5“, Studie starten | Tabelle + Diagramm; Hebel: σv steigt leicht (200 → 210 MPa), u fast gleich | [ ] |
| 9.2 | Im Diagramm über die Punkte fahren | Wert erscheint | [ ] |
| 9.3 | Werkzeugleiste **Geometrie**: Radius-Änderung anlegen; Studie → Parameter „Radius“, Werte „4; 6; 8; 10“ | je Wert Geometrie geändert und gerechnet; danach Ausgangszustand wieder da | [ ] |
| 9.4 | Mit Infill: Parameter Füllgrad | Werte je Füllgrad | [ ] |
| 9.5 | „Tabelle als CSV (Excel)“ | öffnet sich in Excel/LibreOffice korrekt (Semikolon, Komma) | [ ] |

## 10. MathPad

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 10.1 | **Export › MathPad-Rechenblatt** | Datei „… FEM.mathpad“ | [ ] |
| 10.2 | In MathPad öffnen | Notizen + Werte mit Einheiten (E, R_e, σ_v, u_max, m, F_A1x …), S_F = R_e/σ_v rechnet live, a_F = Ausnutzung | [ ] |

## 11. Eigenfrequenzen und Knicken

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 11.1 | Über „Rechnen“: „Eigenfrequenzen“, 6 Moden | Liste in Hz (Hebel: 1. Mode ≈ 597 Hz, Arm schwingt aus der Ebene) | [ ] |
| 11.2 | Zeilen anklicken | jeweilige Schwingform, animiert („Form animieren“) | [ ] |
| 11.3 | Ohne Dichte im Werkstoff | Hinweis „Dichte angeben“ | [ ] |
| 11.4 | „Knicken“, rechnen | Lastfaktoren λ und Knicklast (Hebel 1000 N: λ ≈ 82) | [ ] |
| 11.5 | Zurück auf „Statik“ | normales Ergebnis wieder sichtbar | [ ] |

## 13. Stabwerk (Startseite oder Werkzeugleiste „Stabwerk“)

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
| 15.1 | **Einstellungen › CAD-Verbindungen** öffnen | Abschnitte Onshape, SolidCraft, Add-ins; Häkchen „automatisch neu rechnen“ | [ ] |
| 15.1a | **SolidCraft** starten (gleicher Rechner), ein Teil konstruieren; in Projekt-FEM Einstellungen › CAD-Verbindungen → SolidCraft | „gefunden“ | [ ] |
| 15.1b | „Live mitlaufen“ anhaken | Design wird geöffnet („SolidCraft: „…“ geöffnet“) | [ ] |
| 15.1c | Lager + Last setzen, rechnen. In SolidCraft ein Maß ändern | nach ~1–2 s: „neue Version … übernommen und neu gerechnet“, Vergleich | [ ] |
| 15.1d | „Ergebnis → SolidCraft“ | in SolidCraft im Parameter-Fenster FEM_Sicherheit, FEM_SigmaV_MPa, FEM_Verformung_mm … | [ ] |
| 15.1e | Werkzeugleiste Studie → Parameter „SolidCraft: <dein Maß>“, z. B. 3 Werte → Studie starten | Kurve/Tabelle; danach hat das Maß in SolidCraft wieder den alten Wert | [ ] |
| 15.2 | **Onshape:** API-Schlüssel anlegen (dev-portal.onshape.com → API keys, lesen + schreiben), unter Einstellungen › CAD-Verbindungen eintragen (oder beim ersten Klick auf „Aus Onshape“) | „API-Schlüssel hinterlegt“, zwei Lesezeichen erscheinen | [ ] |
| 15.3 | Lesezeichen „→ Projekt-FEM“ in die Lesezeichenleiste ziehen, in Onshape ein Teilestudio öffnen, Lesezeichen klicken | kleines Fenster „… an Projekt-FEM geschickt“, Projekt-FEM öffnet „Dokument - Teilestudio“ | [ ] |
| 15.4 | Lager + Last setzen, rechnen. In Onshape etwas ändern (z. B. Radius), Lesezeichen wieder klicken | Hinweis „neue Version … übernommen und neu gerechnet“, Vergleich vorige Version ↔ aktuell | [ ] |
| 15.5 | Lesezeichen „FEM-Ergebnis → Onshape“ klicken, in Onshape Teil → Eigenschaften | Beschreibung enthält `[FEM …: S = … · σv … · u … · … g …]`, eigener Text bleibt | [ ] |
| 15.4a | Onshape-Baugruppe statt Teilestudio schicken | Meldung „Baugruppen kann Projekt-FEM noch nicht rechnen – bitte das Teilestudio öffnen“ | [ ] |
| 15.5a | **Onshape-Variable:** im Teilestudio Feature „Variable“ `#dicke = 5 mm` anlegen und in einer Extrusion verwenden, Teil holen, rechnen; Werkzeugleiste Studie → „Onshape: #dicke“ → `3; 5; 8` → Studie starten | Kurve/Tabelle; in Onshape steht danach wieder 5 mm | [ ] |
| 15.5b | Kostenloses Onshape-Konto: Dokumente sind öffentlich – der FEM-Eintrag in der Beschreibung ist also für alle sichtbar | zur Kenntnis genommen | [ ] |
| 15.6 | **Onshape-Bibliothek:** Startseite „Aus Onshape“ (oder Datei › Aus Onshape-Bibliothek): Dokument suchen, Teilestudio wählen, „Holen“ | eigene Dokumente mit Vorschaubild, Teil wird geöffnet und steht unter „Zuletzt geöffnet“ | [ ] |
| 15.6a | Onshape-Teil gerechnet: **Export › Ergebnis → Onshape** | Hinweis mit dem eingetragenen Text, in Onshape Beschreibung `[FEM …]` | [ ] |
| 15.6b | Teil „Neue Version holen“ (Studienbaum › Teil) nach einer Änderung in Onshape | neue Version, Lager und Lasten bleiben | [ ] |
| 15.7 | **Fusion:** Add-in einrichten (Umschalt+S → Add-Ins → +), Reiter VOLUMENKÖRPER | Gruppe „Projekt-FEM“ mit zwei Knöpfen | [ ] |
| 15.8 | Fusion: „In Projekt-FEM rechnen“, in Projekt-FEM rechnen, in Fusion ändern, nochmal „In Projekt-FEM rechnen“ | wie 15.3/15.4 | [ ] |
| 15.9 | Fusion: „Ergebnis holen“ | Meldung mit Werten, Ändern → Parameter: FEM_Sicherheit usw. | [ ] |
| 15.10 | **SolidWorks:** Makro importieren, zwei Makro-Knöpfe anlegen, senden + Ergebnis holen | Teil kommt an; Datei → Eigenschaften → Benutzerdefiniert: FEM_… | [ ] |
| 15.11 | *(optional, nutzt du nicht)* **NX:** Journale ausführen (Alt+F8), dann als Benutzerbefehl-Knopf | Teil kommt an; Attribute FEM_… | [ ] |
| 15.12 | *(optional, nutzt du nicht)* **Solid Edge:** Skripte per Doppelklick | Teil kommt an; Eigenschaften FEM_… | [ ] |
| 15.13 | **Anderes CAD / Datei:** „Senden an → An Projekt-FEM“ (Windows) bzw. Schnellaktion (Mac) auf eine `.step` | Teil wird geöffnet | [ ] |
| 15.14 | **Über das Heimnetz:** am Laptop `projekt-fem-cad.txt` aus Einstellungen › CAD-Verbindungen anlegen, dort aus dem CAD senden; Projekt-FEM im Browser offen | Teil erscheint im Browser-Tab; „Ergebnis holen“ geht auch | [ ] |
| 15.15 | Projekt-FEM neu starten, im CAD „Ergebnis holen“ | letzte Werte kommen noch | [ ] |

Fehlermeldungen aus dem CAD bitte wörtlich oder als Screenshot – die CAD-Schnittstellen unterscheiden sich je nach
Version. Onshape ist mit echtem Konto getestet; Fusion, SolidWorks, NX, Solid Edge und SolidCraft konnte ich hier nicht
selbst starten.

## 16. Schweißnähte (Bleche) – Studienbaum › Verbindungen

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 16.1 | `examples/geometrie/blechkasten.step` öffnen (Blechkasten 2 mm, Ecken mit 0,2 mm Spalt). Boden unten fest, auf die Außenseite einer Längswand 2000 N nach innen, rechnen | rechnet, u max ≈ 0,9 mm (Wand nur am Boden gehalten) | [ ] |
| 16.2 | „Spalte suchen“ (bis 1 mm) | 4 Spalte à 0,2 mm, 76 mm² | [ ] |
| 16.3 | „Alle 4 als Naht übernehmen“, rechnen | u max ≈ 0,5 mm; Karte „Schweißnähte“ mit Kraft, l/a, τw, Ausnutzung | [ ] |
| 16.4 | Eine Naht auf „Kehlnaht“, a = 1 mm | τw steigt etwa auf das Doppelte | [ ] |
| 16.5 | Naht von Hand: „Naht von Hand (Fläche A und B anklicken)“ → Fläche A (schmale Stirnfläche), Fläche B (Gegenfläche) | Flächen orange eingefärbt, Zähler | [ ] |
| 16.6 | **Dein SolidWorks-Blechteil** mit geschlossenen Ecken als STEP: Spalte suchen, Nähte, rechnen | Spalte werden gefunden, Ergebnis plausibel? | [ ] |
| 16.7 | Ohne Nähte bei getrennten Teilen rechnen | Meldung „nicht ausreichend gelagert … Schweißnähte anlegen“ | [ ] |
| 16.8 | PDF-Bericht | Abschnitt „Schweißnähte“ | [ ] |
| 16.9 | Projekt speichern und öffnen | Nähte wieder da | [ ] |

## 18. Baugruppen (neu) – Testteil `examples/geometrie/baugruppe.step` (Grundplatte, Block, Zapfen mit 0,1 mm Spalt)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 18.1 | `baugruppe.step` öffnen | im Studienbaum unter Teil: Grundplatte, Block, Zapfen (Namen aus der STEP-Datei) | [ ] |
| 18.2 | Block anklicken → Werkstoff „EN AW-6082 T6“ | Zeile zeigt den Werkstoff, Masse ändert sich | [ ] |
| 18.3 | Zapfen „sichtbar“ aus, „nur diesen zeigen“, „alle zeigen“ | Körper verschwinden/erscheinen im Bild | [ ] |
| 18.4 | Grundplatte Stirnseite fest, Kraft auf Block oben; Verbindungen → Spalte suchen → Naht übernehmen → Art „flächig verbunden“; rechnen | Ergebnis mit Tabelle je Körper, Kräfte zwischen den Körpern; Urteil nennt den schwächsten Körper | [ ] |
| 18.5 | Ohne Verbindung für den losen Zapfen rechnen | Meldung „nicht ausreichend gelagert … Verbindungen“ | [ ] |
| 18.6 | **Eigene Baugruppe** aus SolidWorks (Makro, jetzt auch für Baugruppen) bzw. Fusion | Körpernamen = Teilenamen | [ ] |
| 18.7 | **Onshape:** Bibliothek → „Assembly 1“ in „Projekt-FEM Test 1“ holen | Körper je Teil (kostet ≈ 5 API-Aufrufe) | [ ] |
| 18.8 | Projekt speichern und öffnen | Werkstoffe je Körper und ausgeblendete Körper wieder da | [ ] |

## 19. Server (wie MathPad) – Anleitung `server/README.md`

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 19.1 | `server/deploy.sh root@<MathPad-Server>` | Container baut (~10–15 min) und startet | [ ] |
| 19.2 | `http://<Server>:8790/#k=<Schlüssel>` öffnen, Hebel hochladen, rechnen | wie zu Hause | [ ] |
| 19.3 | Empfehlung: Domain + Caddy für https | Adresse mit https | [ ] |

## 20. Onshape-Verbrauch

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 20.1 | Einstellungen › CAD-Verbindungen | „API-Aufrufe 2026: N“ | [ ] |
| 20.2 | Bibliothek zweimal hintereinander öffnen | Zähler steigt beim zweiten Mal nicht (Liste und Bilder gespeichert) | [ ] |

## 21. Aufräumen und Sicherheit (nach dem Test)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 21.1 | Onshape-Passwort ändern (war kurz im Speicher der Cloud-Umgebung), Zwei-Faktor-Anmeldung einschalten | erledigt | [ ] |
| 21.2 | Test-API-Schlüssel löschen: dev-portal.onshape.com → API keys (stand im Chat, gültig bis 13.11.) | Schlüssel weg | [ ] |
| 21.3 | Neuen API-Schlüssel anlegen und **nur** in Projekt-FEM unter Einstellungen › CAD-Verbindungen eintragen | „API-Schlüssel hinterlegt“ | [ ] |
| 21.4 | In der Claude-Sitzung: Cloud-Umgebungs-Menü → Bearbeiten → Network secrets → Eintrag cad.onshape.com entfernen | Eintrag weg | [ ] |
| 21.5 | Onshape-Testdokument „Projekt-FEM Test 1“ behalten oder löschen | entschieden | [ ] |
| 21.6 | Heimnetz-Freigabe: Link mit Schlüssel nur auf eigenen Geräten; bei Bedarf „Neuen Zugangsschlüssel erzeugen“ (Lesezeichen danach neu anlegen) | ok | [ ] |

---

## Annahmen und Standardwerte, die du prüfen solltest

- **Infill-Ersatzwerte** sind Näherungen (Gibson/Ashby-Skalierung je Muster), keine Messwerte – siehe Hinweistext beim
  Infill. Am besten mit eigenem Zugstab gleicher Einstellungen gegenprüfen.
- **Druckwerkstoffe** (PLA, PETG …): Richtwerte für 100 % Füllung; stark drucker- und einstellungsabhängig.
- **Slicer-Voreinstellung**: Gyroid 20 %, 2 Wände × 0,45 mm, Schicht 0,2 mm, 5 Deck- / 4 Bodenschichten.
- **Überhang** ab 45° (FDM-Faustregel).
- **Erforderliche Sicherheiten** Standard 1,5 (Fließen) / 2,0 (Bruch).
- **IPE-Profilwerte** aus der Profiltabelle (DIN 1025-5) – bei Bedarf gegenprüfen.
- **Schweißnähte**: Nachweis vereinfacht nach EN 1993-1-8 (Linienkraft / a ≤ Rm/(√3·β_w·1,25)), β_w aus dem
  Werkstoffnamen (S235 0,8, S275 0,85, S355 0,9, S420/S460 und Edelstahl 1,0, sonst 0,8). Nahtenden/Kerben und
  Ermüdung nicht bewertet. Die Naht ist ideal steif (keine Nahtnachgiebigkeit).

## Bekannte Grenzen

- Alles linear-elastisch, kleine Verformungen; kein Kontakt, keine Plastizität, kein Kriechen.
- Eigenfrequenzen/Knicken: massiver Werkstoff (Infill wird dort nicht berücksichtigt), bis ca. 600 000 Unbekannte.
- Stabwerk: kein Stabilitätsnachweis der Stäbe (Biegeknicken/Kippen), keine Schnittgrößen-Diagramme.
- Schalenelemente (Bleche) nicht umgesetzt – dünne Teile mit feinem Volumennetz rechnen.
- Baugruppen: Körper nur verklebt (gemeinsame Flächen) oder über Schweißnähte gekoppelt; kein Kontakt, keine Schrauben,
  ein Werkstoff für alle Körper.
- Video-Aufnahme in der Linux-Desktop-App je nach WebKit-Version nicht verfügbar (dann im Browser aufnehmen).
- Topologieoptimierung: Form ist ein Vorschlag (STL), keine fertige CAD-Geometrie.

## Fragen an dich

1. **Programmname** – Vorschläge: „Kraftfluss“, „Lastpfad“, „Spannweite“, „Formfest“ – oder eigener?
2. **Geometrie bearbeiten**: Was fehlt dir genau? (Ablauf beschreiben: was willst du am Teil ändern, wie soll es sich bedienen?)
3. **Baugruppen** (neu auf der Liste): Welche Fälle hast du? (verschraubt, verklebt, Kontakt mit Spalt, Pressverband …)
4. **Ansys-Werte** für den Hebel (Spannung im R6-Radius, max. Verformung, Lagerkraft).
5. **Slicer**: Prusa, Orca oder Bambu Studio? Dann kann als Nächstes der 3MF-Import der Slicer-Einstellungen kommen.
6. **CAD**: SolidWorks-Version auf der Arbeit? Sind Makros (VBA) dort erlaubt?
7. **Schweißnähte**: Brauchst du auch unterbrochene Nähte (nur Abschnitte) oder Punktschweißungen? Und Nähte an
   T-Stößen ohne Spalt (Kehlnaht zwischen zwei Blechen, die sich berühren)?
8. **Baugruppen / Bewegung**: Hast du ein konkretes Beispiel (z. B. Koppelstange mit Bolzen) als Onshape-Baugruppe,
   an dem wir Baugruppen und später die Bewegungssimulation entwickeln können?
9. **Animation/Video**: Reicht WebM/MP4, oder brauchst du GIF (z. B. für Foren)?
