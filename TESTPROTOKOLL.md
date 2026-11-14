# Testprotokoll Projekt-FEM

Stand: 06.11.2026 · Branch `claude/stoic-maxwell-rtmn09` · Rechenkern: 76 von 76 Lehrbuchprüfungen bestanden
(`./target/release/projekt-fem validieren`), 48 automatische Tests grün.

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

## 18a. Schrauben mit Vorspannung und Kontakt (neu) – Testteil `examples/geometrie/verschraubung.step`

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 18a.1 | `verschraubung.step` öffnen | Hinweis „2 Schrauben aus dem CAD erkannt“; im Baum nur Unterteil und Deckel; Schraubenköpfe im Bild | [ ] |
| 18a.2 | Verbindungen → Schrauben | „ISO 4762 M8x25 - 10.9“ (Gewindebohrung, Klasse 10.9) und „ISO 4762 M8x35 - 8.8“ (mit Mutter, 2 Zubehör) | [ ] |
| 18a.3 | Unterteil vorne fest, Deckel oben 4000 N nach oben (+Z), rechnen (Standard: Vorspannung 90 % nach VDI 2230, Drehmomentschlüssel α_A 1,6 mit Setzen, Kontakt µ = 0,15 – es wird zweimal gerechnet) | Karte „Schrauben“: F_V von–bis ≈ 14,7…27,4 kN (10.9) bzw. 9,7…18,6 kN (8.8), F_S kaum höher, Anziehmomente ≈ 37 / 27 N·m, S ≥ 1. Zweite Tabelle: Kopf p/p_G ≈ 78 % (S235JR, p_G 490), Mutter ≈ 57 %, Gewinde 15 / 9 mm. Karte „Fugen“: Restklemmkraft mit kleinster Vorspannung ≈ 20 kN. Deckel S235 meldet S < 1,5 (Pressung unter dem 10.9-Kopf hoch – echter Befund) | [ ] |
| 18a.4 | Vorspannung „Anziehmoment je Schraube“, je 10 N·m eintragen, rechnen | F_V deutlich kleiner, Deckel jetzt S > 1,5; kein Hinweis „nicht eingependelt“ | [ ] |
| 18a.5 | „Fuge verklebt“ bzw. Vorspannung „ohne“ | verklebt: Schrauben tragen kaum; ohne Vorspannung + Kontakt: Fuge hebt ab, Schrauben tragen die ganze Last (je ≈ 2000 N) | [ ] |
| 18a.5b | Last quer (z. B. 10 kN in X auf die Deckelseite), µ = 0,15 | hält über Reibung (Reibschluss < 100 %); Last so hoch, dass µ·F_K nicht reicht → Hinweis „rutscht durch“, Querkraft in den Schrauben | [ ] |
| 18a.5c | Werkstoff des Deckels auf EN AW-6082 T6, Unterteil auch Alu | Kopf p/p_G steigt (p_G 360), Gewinde nötig länger (Alu) – ggf. rot | [ ] |
| 18a.5d | „Dauerfestigkeit prüfen“ anhaken | Spalte S_D in der Schraubentabelle (σ_ASV / σ_a, nötig 1,2) | [ ] |
| 18a.5e | Bericht als PDF | Schraubentabelle mit F_V von–bis / M_A, F_S, Querkraft, Sicherheit; Tabelle Pressung/Gewinde/σ_a; Fugentabelle; Hinweise | [ ] |
| 18a.6 | „Schrauben aus dem CAD als Körper rechnen“ | neu vernetzt, Schrauben als Körper im Baum | [ ] |
| 18a.7 | **Deine Baugruppe mit Normteil-Schrauben** (Onshape Standard Content, SolidWorks Toolbox) | Schrauben erkannt? Namen/Klasse richtig? | [ ] |
| 18a.8 | Baugruppe **ohne** modellierte Schrauben, aber mit Bohrungen | Vorschläge „Bohrung 1 (M8)“ … anhaken → wird gerechnet | [ ] |

## 18b. Kontakt an Berührflächen und Schrauben von Hand (neu)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 18b.1 | `examples/geometrie/baugruppe.step` öffnen → Verbindungen | Abschnitt „Berührflächen“: „Grundplatte ↔ Block · 1.600 mm²“ mit „verklebt / Kontakt“ | [ ] |
| 18b.2 | Zapfen-Spalt als „flächig verbunden“, Grundplatte ↔ Block auf „Kontakt“, Lager Seite, Last oben auf den Block, rechnen | Karte „Fugen“: Block liegt teilweise auf, Druckkraft = Last, Querkraft über Reibung klein; kein Hinweis „nicht eingependelt“ | [ ] |
| 18b.3 | Last nach oben (zieht den Block weg) | Hinweis „… liegen nicht mehr aufeinander“ bzw. „Ein Teil … hat sich gelöst“ | [ ] |
| 18b.4 | `examples/geometrie/flansch.step` öffnen (zwei Platten, Bohrungen Ø9,6 – keine Normbohrung) | keine Schrauben-Vorschläge | [ ] |
| 18b.5 | „Schraube an Bohrung anlegen“ → Bohrung anklicken, für die zweite wiederholen | „Schraube 1“, „Schraube 2“: M8 mit Mutter, Kopf oben; Größe änderbar, ⇅ dreht um, Papierkorb löscht | [ ] |
| 18b.6 | Unterseite fest, oben 5 kN nach oben, rechnen | F_V ≈ 18,6 kN je Schraube (8.8), Fuge mit Restklemmkraft; Projekt speichern und wieder laden → Schrauben von Hand sind wieder da | [ ] |
| 18b.6b | `examples/geometrie/schraubentest.step` öffnen (Nachbau deines SolidCraft-Schraubentests: Sacklöcher mit Bohrspitze, Schrauben heißen nur „Body4“) | öffnet in wenigen Sekunden; 6 Schrauben „Body4 … – M5“ an der Form erkannt; im Baum nur Body1 und Body2 | [ ] |
| 18b.6c | dein `Schraubentest_1` direkt aus SolidCraft holen | vernetzt in Sekunden statt Minuten; Schrauben erkannt | [ ] |
| 18b.7 | **Deine Baugruppe**: Teile, die nur aufliegen (z. B. Platte auf Rahmen), auf „Kontakt“ | Ergebnis plausibel? Rechenzeit? | [ ] |

## 18c. Vernetzen: Fortschritt, Abbrechen, erst grob laden (neu)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 18c.1 | Große STEP-Datei öffnen | Fortschrittsbalken mit Phase (Flächen/Volumen …, Prozent) und laufender Zeit | [ ] |
| 18c.2 | Während des Vernetzens „Erst grob laden“ | Datei mit grobem Netz geladen, Hinweis; Baum „Netz: grobe Vorschau – noch vernetzen“; Rechnen zeigt den offenen Punkt „Netz“ | [ ] |
| 18c.3 | Lager/Lasten setzen, dann Netz › „Jetzt vernetzen“ | richtiges Netz, Lager und Lasten bleiben | [ ] |
| 18c.4 | Beim Vernetzen „Abbrechen“ | sofort zurück; beim Neuvernetzen bleibt das alte Netz, beim Öffnen passiert nichts | [ ] |
| 18c.5 | Beim Rechnen „Abbrechen“ (z. B. Verschraubung mit Kontakt) | hört nach dem laufenden Durchgang auf, Meldung „Abgebrochen“ | [ ] |
| 18c.6 | Vernetzen schlägt fehl | Fehlermeldung, Datei wird trotzdem grob geladen | [ ] |

## 18d. Konstruktion – kleines CAD (neu)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 18d.1 | Startseite › „Neues Teil konstruieren“ › Skizze › Ebene XY anklicken | Blick senkrecht auf die Ebene, Werkzeuge oben, roter Ursprungspunkt | [ ] |
| 18d.2 | Rechteck mit einer Ecke im Ursprung, Kreis darin | Ecke rastet ein; Linien waagrecht/senkrecht (Zeichen —/\|) | [ ] |
| 18d.3 | Maß (D): untere Linie → 60, rechte Linie → 40, Kreis → Ø12; Kreismitte mit Maßen festlegen | Skizze passt sich an, „Voll bestimmt“, alles schwarz | [ ] |
| 18d.4 | Skizze fertig › Extrudieren 10 › OK | Platte mit Loch; Volumen (60·40 − π·36)·10 = 22,87 cm³ | [ ] |
| 18d.5 | Skizze auf der Plattenfläche, zwei Punkte › Bohrung M8 mit Zylinderkopf-Senkung | Bohrungen mit Senkung in der Vorschau | [ ] |
| 18d.6 | Verrunden: Außenkante anklicken, R2 | Kante wird orange, Verrundung in der Vorschau; zu großer Radius → rote Meldung | [ ] |
| 18d.7 | Muster (Kreis, Ganzer Körper / einzelne Bohrung), Spiegeln an YZ | Vervielfältigt bzw. gespiegelt | [ ] |
| 18d.8 | Feature im Verlauf anklicken, Wert ändern, Auge (unterdrücken), Strg+Z | Neuaufbau, unterdrückt = durchgestrichen | [ ] |
| 18d.9 | „In die Rechnung übernehmen“ | Teil im Modell, Lager/Lasten setzen und rechnen | [ ] |
| 18d.10 | Konstruktion ändern (z. B. Tiefe) und erneut übernehmen | Lager/Lasten bleiben auf denselben Flächen, Vergleich vorher/nachher | [ ] |
| 18d.11 | STEP-Teil (Hebel) öffnen › Konstruktion › Radius/Bohrung › Bohrung anklicken, Ø ändern | „Bohrung ändern“ im Verlauf, Volumen ändert sich | [ ] |
| 18d.12 | Projekt speichern, neu laden | Verlauf wieder da, „Übernommen“ | [ ] |
| 18d.13 | Drehteil: Profil zeichnen, Drehen um eine Linie | Rotationskörper, Achse rot gestrichelt | [ ] |
| 18d.14 | Parameterstudie: Skizzenmaß mit Namen versehen, in der Studie wählen | Werte werden nacheinander gebaut und gerechnet | [ ] |
| 18d.15 | Konstruktion öffnen | Ansichtswürfel oben rechts, Achsenkreuz unten links, Achsen X/Y/Z (rot/grün/blau) am Ursprung, Hauptebenen beschriftet („XY · Oben“ …) | [ ] |
| 18d.16 | Würfelfläche bzw. Achse im Achsenkreuz anklicken; Knopf „Ebenen“ in der Werkzeugleiste; beim Skizzieren „⊥“ | Ansicht dreht sich dorthin; Ebenen aus/ein (zum Wählen einer Ebene erscheinen sie trotzdem); Blick senkrecht auf die Skizze | [ ] |
| 18d.17 | Skizze fertig, dann extrudieren/drehen | Skizze bleibt als dünne Linien im Raum (auch vor dem Körper); vom offenen Feature benutzte Skizze blau | [ ] |
| 18d.18 | Skizzenlinie im Bild anklicken / doppelklicken; Auge an der Skizze im Verlauf; Knopf „Skizzen“ in der Leiste | Skizze im Verlauf markiert / zum Bearbeiten geöffnet; einzeln bzw. alle aus- und einblenden; Ein/Aus-Knopf = unterdrücken | [ ] |
| 18d.19 | Große Draftpad-Skizze bearbeiten | Bedingungszeichen automatisch aus (Knopf „Bedingungen“ zeigt sie), Ziehen/Hover flüssig | [ ] |
| 18d.20 | Skizze: Rechteck mit zwei Kreisen › Extrudieren › „Keine“ › Platte anklicken › Tiefe 10 › „OK und weiter“ | OK gesperrt, solange nichts gewählt; „1 von 3 Flächen“; neues Extrudieren mit derselben Skizze, nichts gewählt | [ ] |
| 18d.21 | Maus über die Platte, dann linken Kreis anklicken, 25 › „OK und weiter“ › rechten Kreis, 4 › OK | Hinweis „benutzt schon Extrudieren 1“, Platte grau; Zapfen und Scheibe im Loch entstehen | [ ] |
| 18d.22 | Alt + Klick auf eine Fläche mit Löchern; Knöpfe Alle/Keine/Noch freie/Schraffierte/Automatisch | Fläche samt Inhalt an/aus; Schnellwahl wirkt | [ ] |
| 18d.23 | Drehen mit Draftpad-Skizze › „Drehachse“ › Linie im Bild anklicken | Achse aus Draftpad vorgewählt, Linie unter dem Zeiger orange, nach Klick gewählt; Liste: Achsen, Hilfslinien, Linien mit Länge | [ ] |
| 18d.24 | Konstruiertes Teil übernehmen, Lager/Last, rechnen; dann in der Konstruktion die Plattendicke ändern und erneut übernehmen | Lager und Lasten bleiben auf ihren Flächen; Fase/verschobene Fläche werden wiedergefunden; Ergebnis wird mit vorher verglichen | [ ] |
| 18d.25 | Studie › Parameter „Konstruktion: Extrudieren 1: Tiefe“, Werte „10; 18“ | beide Werte werden gebaut und gerechnet, Tabelle mit S und Masse | [ ] |

## 18e. Draftpad-Zeichnung als Skizze (neu)

| | Schritt | Erwartet | OK / Anmerkung |
|---|---|---|---|
| 18e.1 | Konstruktion › „Draftpad“ › Datei wählen | Hinweis „erst die Ebene wählen“ | [ ] |
| 18e.2 | Ebene XZ anklicken | Liste der Draftpad-Ebenen mit Anzahl Linien/Bögen; „Reinzeichnung“ vorgewählt | [ ] |
| 18e.3 | Übernehmen | Zeichnung erscheint maßstäblich (mm) in der Skizze, Meldung mit Zahl der geschlossenen Lücken und erkannten Bedingungen | [ ] |
| 18e.4 | Ein Maß setzen, Punkt ziehen | Skizze bleibt zusammenhängend (Ecken, T-Stöße, Tangenten halten) | [ ] |
| 18e.5 | Skizze fertig › Extrudieren | schraffierte Flächen sind vorgewählt (blau), Körper entsteht | [ ] |
| 18e.6 | Schnittzeichnung mit Mittellinie › Drehen | Achse aus Draftpad vorgewählt; Hinweis „nur die Hälfte auf einer Seite“; Drehkörper | [ ] |
| 18e.7 | `.draftpad.json` auf das Fenster ziehen | neues Teil mit Import-Dialog | [ ] |
| 18e.8 | `examples/draftpad/wellenschnitt.draftpad.json` importieren (Ebene XZ) › Skizze fertig | Dialog „Teile aus den Schraffuren“: 4 Teile; Platte = Extrudieren, die anderen = Drehen um die Achse (98 mm); Zeile überfahren = Flächen im Bild orange | [ ] |
| 18e.9 | Namen vergeben (Grundplatte, Deckel, Flansch, Lagerringe) › Anlegen | je Teil ein Feature „Neuer Körper“ mit Namen; Hinweise zu losen Stücken/Überschneidungen am Feature | [ ] |
| 18e.10 | In die Rechnung übernehmen | Hinweis „Baugruppe übernommen: n Körper (Namen), m Berührflächen – verklebt“; im Modell die Körper mit Namen | [ ] |
| 18e.11 | Bruchlinie (Freihand) am Plattenende | wird als Kontur übernommen, die Platte ist eine geschlossene Fläche; freie Notizen bleiben weg | [ ] |
| 18e.12 | Einstellungen › CAD-Verbindungen › Draftpad: Adresse des Pi eintragen (z. B. `192.168.1.20:8080`) | „verbunden“ | [ ] |
| 18e.13 | Startseite › „Aus Draftpad“ | Zeichnungen der Online-Ablage mit Vorschaubild; Doppelklick oder „Übernehmen“ → Ebene wählen → Import „Verknüpft (aktualisierbar)“ | [ ] |
| 18e.14 | In Draftpad etwas ändern und speichern, dann zurück zu Projekt-FEM | nach ≤ 10 s Hinweis „…wurde geändert“ und Abzeichen am Verlauf; „Aktualisieren“ baut neu, Drehachse bleibt | [ ] |
| 18e.15 | Skizze öffnen › „In Draftpad bearbeiten“ / „Verknüpfung lösen“ | Draftpad öffnet die Zeichnung; danach ist die Skizze eine bemaßbare Kopie | [ ] |
| 18e.16 | In Draftpad: Menü › „In Projekt-FEM nachweisen“ (beim ersten Mal Adresse, z. B. `http://nas:8790`) | Projekt-FEM öffnet sich mit neuem Teil und der Zeichnung | [ ] |
| 18e.17 | Draftpad-Import: Vorschau im Dialog ansehen, „Lücken schließen bis“ von 0,3 auf 0,8 mm | Freihand/Texte blass, offene Enden rot mit Zähler; Zähler sinkt, wenn die Lücken kleiner als der Wert sind | [ ] |
| 18e.18 | Draftpad-Zeichnung mit Maßen als Datei/Kopie übernehmen | Maße erscheinen als Skizzenmaße (gemessener Wert), überzählige (z. B. dieselbe Länge zweimal) fehlen; Meldung „… Maße aus Draftpad“ | [ ] |
| 18e.19 | Konstruktion › Platte skizzieren, extrudieren, Kante verrunden/fasen, Tiefe ändern | Körper erscheint ohne merkliche Wartezeit; neben „Verlauf“ steht grün die Aufbauzeit („… ms“, Geometriekern im Browser) | [ ] |
| 18e.20 | Extrudieren: in das Feld „Tiefe“ klicken, Mausrad drehen (mit Umschalt / Strg); `10+5` eintippen und Feld verlassen | ±1 mm je Raste (Umschalt 0,1, Strg 10); 15 steht im Feld; Vorschau folgt sofort | [ ] |
| 18e.21 | Extrudieren: den blauen Punkt mit der Maßangabe im Bild nach oben/unten ziehen | Tiefe ändert sich in 1-mm-Schritten (Umschalt 0,1 mm), Feld und Vorschau laufen mit | [ ] |
| 18e.22 | Skizze: Maß doppelklicken, `2*30` eingeben | Maß wird 60 | [ ] |
| 18e.23 | Skizze: Maß (D) – untere Linie anklicken, dann obere Linie, Maß ablegen | Abstand der beiden Linien wird bemaßt (nicht die Länge der ersten); Klick ins Leere nach der ersten Linie = Länge | [ ] |
| 18e.24 | Skizze: Linie quer durch ein Rechteck, Werkzeug Trimmen (T), über das Mittelstück fahren, klicken | Stück bis zu den Schnittpunkten wird rot gezeigt und entfernt; Kreis wird beim Trimmen zum Bogen | [ ] |
| 18e.25 | Skizze: Linie anklicken | Leiste unten im Bild mit passenden Bedingungen (Waagrecht, Senkrecht, …, Fixieren, Löschen); Bedingungszeichen an den Linien gut sichtbar, bei großen Skizzen nur am Element unter dem Zeiger | [ ] |
| 18e.26 | Messen (Lineal-Knopf rechts oben im Bild) in der Konstruktion und im Modell (auch STEP/Onshape-Teil): Bohrung anklicken, dann zwei gegenüberliegende Flächen | Bohrung zeigt Ø und R; zwei parallele Flächen zeigen den Abstand, zwei Bohrungen den Achsabstand; „Fertig“ beendet | [ ] |
| 18e.27 | Konstruktion: Kasten extrudieren, Schale (Werkzeug „Schale“), Deckfläche anklicken, Wand 2 mm | Kasten oben offen, Wand 2 mm; zu dicke Wand wird gemeldet | [ ] |
| 18e.28 | Konstruktion: Schere-Knopf rechts oben (Schnittansicht), X/Y/Z, Schieber, Seite wechseln | Körper wird geschnitten, Schnittfläche orange | [ ] |
| 18e.29 | Skizze: Rechteck, alle vier Linien mit ⇧ wählen, in der Leiste unten Versatz −3 → „Versatz“ | inneres Rechteck 3 mm kleiner; extrudiert = Rahmen | [ ] |
| 18e.30 | Skizze: kurze Linie, Werkzeug Verlängern (E), nahe einem Ende klicken | Linie wird bis zum nächsten Element verlängert und hängt dort an | [ ] |
| 18e.31 | Sweep: Skizze 1 auf XY mit zwei Kreisen (Ø10/Ø8), Skizze 2 auf XZ mit einer Linie nach oben und einem Bogen; Sweep, Profil = Skizze 1, Pfad = Skizze 2 | gebogenes Rohr entsteht | [ ] |
| 18e.32 | Loft: Skizze 1 Rechteck auf XY, Skizze 2 auf XY mit „Abstand zur Ebene“ 30 und Kreis; Loft, beide Skizzen anhaken | Übergang Rechteck → Kreis über 30 mm | [ ] |
| 18e.33 | Fase/Verrunden: Kante wählen, blauen Griff an der Kante ziehen; Bohrung (nicht durch alles): Griff am Bohrpunkt ziehen | Wert ändert sich in 1-mm-Schritten, Vorschau folgt | [ ] |
| 18e.34 | Konstruktion und Modell: Ansicht „Oben“ bzw. Doppelklick auf eine Fläche | genau senkrechter Blick, keine Seitenflächen sichtbar (Parallelprojektion, nicht mehr perspektivisch verzerrt) | [ ] |
| 18e.35 | Werkzeugleiste der Konstruktion und des Skizzierers ansehen | eigene, einheitliche Symbole (Wirkung blau), alle Werkzeuge in einer Zeile; seltene Werkzeuge unter „Mehr“ | [ ] |
| 18e.36 | Verrunden: Kante anklicken | Vorschau des Radius sofort; alle sichtbaren Kanten lassen sich anklicken (auch nach der Vorschau) | [ ] |
| 18e.37 | Verknüpfte Draftpad-Skizze: in Draftpad ändern (ohne „Speichern“) | Projekt-FEM baut nach ≈ 3–5 s selbst neu (Draftpad überträgt live, sobald es aus Projekt-FEM geöffnet oder mit „In Projekt-FEM nachweisen“ geschickt wurde) | [ ] |
| 18e.38 | Skizze: Linie zeichnen | am Zeiger Länge und Winkel („37 mm · 0°“), waagrecht/senkrecht als Zeichen; Länge rastet auf glatte Werte (⇧ = frei); `50` oder `50@30` tippen + Enter = genaue Linie mit Maß; Ziehen statt Klicken geht auch | [ ] |
| 18e.39 | Skizze: Rechteck `60x40`, Kreis `10` (Ø) tippen | Maße werden als Skizzenmaße angelegt | [ ] |
| 18e.40 | Skizze: Element anklicken | Bedingungsleiste erscheint neben dem Zeiger (nicht mehr unten) | [ ] |
| 18e.41 | Ohne offenes Feature: Deckfläche anklicken, Taste **S** | Skizze startet direkt auf der Fläche, Blick senkrecht, Linienwerkzeug aktiv | [ ] |
| 18e.42 | Kante anklicken, Taste **F**, Enter | Verrunden mit vorgewählter Kante (bei verrundeten Konturen die ganze tangentiale Kette, Alt+Klick = nur eine), Enter = OK | [ ] |
| 18e.43 | Nach „Skizze fertig“ | Leiste unten „Skizze n fertig – weiter mit Extrudieren (E) / Drehen (R)“ | [ ] |
| 18e.44 | Rechtsklick auf ein Feature im Verlauf | Menü: Bearbeiten, Umbenennen (direkt in der Zeile), Nach oben/unten, Unterdrücken, Skizze zeigen/ausblenden, Löschen | [ ] |
| 18e.45 | Skizze auf Deckfläche, Kreis, Extrudieren „Weg“ | schneidet automatisch ins Material (vorher ins Leere); benutzte Skizzen sind danach ausgeblendet (Auge im Verlauf zeigt sie) | [ ] |
| 18e.46 | Skizze: Rechteck aus der Mitte (M) `60x40`, Ecke verrunden (F): `8` tippen, Ecken anklicken | Rundungen R8 tangential, Skizze „✓ bestimmt“; Radius direkt nach dem Klick im Feld änderbar | [ ] |
| 18e.47 | Skizze: Langloch (O): Mitte, `20` Enter, `8` Enter; Vieleck (V): Mitte, `13` Enter (+/− ändert die Eckenzahl) | Langloch 20 × 8 mit Maßen „Mittenabstand“/„Breite“; Sechskant SW 13 („Schlüsselweite“) | [ ] |
| 18e.48 | Skizze: im Leeren Rahmen aufziehen (links → rechts bzw. rechts → links), Strg+A | ganz umschlossene bzw. berührte Elemente gewählt, Leiste daneben | [ ] |
| 18e.49 | Bohrung (H): „Gewinde (Kernloch)“, M6; Skizze liegt unter dem Teil | Ø 5, bohrt automatisch ins Material; Durchgangsloch nach ISO 273 fein/mittel/grob | [ ] |
| 18e.50 | Taste **?** (oder F1, Tastatur-Knopf) | Übersicht aller Tastenkürzel und Mausbefehle | [ ] |
| 18e.51 | STEP öffnen (z. B. `Daten/Hebel.step`) › Konstruktion | Teil erscheint nach ≈ 1–2 s (eingelesen im Browser, kein Python mehr); Körpernamen aus der STEP-Datei bleiben | [ ] |
| 18e.52 | „Radius/Bohrung“: Bohrung anklicken, neuer Ø; Radius anklicken, neuer Radius (0 = scharfe Kante) | Bohrung bzw. Rundung geändert, Volumen plausibel; „In die Rechnung übernehmen“ vernetzt das geänderte Teil | [ ] |
| 18e.53 | Mehr › Flächen entfernen: Bohrung (mit Senkung/Spitze) bzw. gerade Verrundung anklicken | Bohrung ganz zu bzw. scharfe Kante; auch Fasen (außen ergänzt, innen abgezogen); Außenflächen werden mit Hinweis abgelehnt | [ ] |
| 18e.54 | Platte, dann Taste **H** ohne Auswahl (bzw. Deckfläche anklicken, dann H) | Skizze „Bohrpunkte“: Fläche anklicken, Punkte setzen (fangen an Kanten/Mitten, bemaßbar), „Skizze fertig“ → Bohrungsdialog mit diesen Punkten; Enter = Bohrungen | [ ] |
| 18e.55 | Skizze: senkrechte Hilfslinie (Mittellinie), halbe Kontur rechts davon, Rahmen von rechts nach links darüber ziehen, in der Leiste „Spiegeln …“, Mittellinie anklicken (oder Taste I) | linke Hälfte entsteht, bleibt symmetrisch (rechts ziehen → links folgt); Punkte auf der Mittellinie werden geteilt | [ ] |
| 18e.56 | Zwei Körper (zweiter mit „Neuer Körper“), Mehr › Boolesch: Vereinigen / Abziehen / Schnittmenge, Körper anklicken | Ergebnis wie gewählt; „Werkzeugkörper behalten“ lässt den zweiten Körper stehen | [ ] |
| 18e.57 | Verlauf: Rechtsklick auf ein früheres Feature › „Bis hier zurückrollen“, dann ein neues Feature anlegen | Bild zeigt den Stand bis zur Marke, spätere Features blass; das neue Feature landet an der Marke; ▲/▼ verschiebt die Marke, „Ans Ende“ baut alles; Übernehmen erst am Ende möglich | [ ] |
| 18e.58 | Skizze mit „Abstand zur Ebene“ über dem Teil, Extrudieren › „Bis Fläche“, Deckfläche anklicken | Körper reicht genau bis zur Fläche (Richtung automatisch) | [ ] |
| 18e.59 | Rechtsklick auf ein Feature › „Duplizieren“ | Kopie direkt dahinter („… (Kopie)“), z. B. zum Ändern der Kanten/Skizze | [ ] |
| 18e.60 | Skizze: „Neigung“ 30°, um Achse „waagrecht“; Kreis, Extrudieren | schräg stehender Zylinder (Skizzenebene um ihre x-Achse gedreht); mit „Abstand zur Ebene“ kombinierbar | [ ] |
| 18e.61 | Teil mit zwei Körpern (z. B. „Neuer Körper“) | Abschnitt „Körper (2)“ mit Name und Volumen; Überfahren markiert den Körper im Bild, Auge blendet ihn aus (nur Ansicht); Doppelklick auf den Namen benennt ihn um (Name erscheint in der Rechnung) | [ ] |
| 18e.62 | Skizze: Linie, dann Tangentenbogen (G) am Linienende beginnen, Ende klicken; Q schaltet Hilfslinie um | Bogen schließt tangential an (Vorschau mit „R … · …°“), nächster Bogen gleich weiter, Esc beendet | [ ] |
| 18e.63 | Im Verlauf eine (ausgeblendete) Skizze mit der Maus überfahren | Skizze erscheint solange blau im Bild | [ ] |
| 18e.64 | Skizze: Kreis Ø100 um den Ursprung, Kreis Ø9 bei (35, 0) anklicken › „Muster …“ › Kreis × 6 › OK; Extrudieren | Lochkreis mit 6 Bohrungen (um den Ursprung bzw. einen mitgewählten Punkt); Extrudieren wählt die Scheibe mit Löchern automatisch | [ ] |
| 18e.65 | Mehr › Körper verschieben: Körper anklicken, z = 25, Drehen um Z 45°, „Als Kopie“ | Kopie 25 mm höher und um 45° gedreht, Name „… (Kopie)“; ohne Kopie wird der Körper selbst bewegt | [ ] |
| 18e.66 | Mehr › Teil einfügen: STEP-Datei wählen (z. B. `examples/geometrie/flansch.step`) | Körper der Datei kommen als weitere Körper dazu (Namen aus der Datei bzw. Dateiname), Feature im Verlauf; mit „Körper verschieben“ anordnen; wird mit dem Projekt gespeichert | [ ] |
| 18e.67 | Mehr › Ausrichten: Fläche am zu bewegenden Körper, dann Zielfläche am anderen Körper; bzw. Zylinder des Bolzens und der Bohrung | eben: Körper wird gedreht und auf die Zielfläche gelegt (Abstand einstellbar); Zylinder: gleiche Achse (Versatz längs der Achse) | [ ] |
| 18e.68 | Winkel (L-Profil extrudiert), Skizze auf XZ mit „Abstand zur Ebene“ in der Mitte, Linie von Schenkel zu Schenkel; Mehr › Rippe, Dicke 4 | dreieckige Rippe füllt die Ecke bis zu den Wänden, symmetrisch zur Skizzenebene | [ ] |
| 18e.69 | Quader, Mehr › Formschräge: zwei Seitenflächen anklicken, neutrale Ebene XY, 3° | Seiten neigen sich nach innen (oben kleiner), Boden behält das Maß; „Richtung umkehren“ kehrt die Neigung um. Menü „Mehr“ in Gruppen Formen / Ändern / Körper und Baugruppe | [ ] |
| 18e.70 | Mehrere Körper; Knopf „Darstellung“ rechts oben im Bild mehrfach klicken | Körper leicht unterschiedlich getönt (Farbpunkt in der Körperliste passt); Darstellung wechselt: mit Kanten → ohne Kanten → durchsichtig → Drahtgitter (wird gemerkt) | [ ] |
| 18e.71 | Skizze: Kreis wählen, Strg+C, Maus an andere Stelle, Strg+V (auch in einer anderen Skizze) | Kopie erscheint an der Maus und ist gewählt (gleich verschiebbar/bemaßbar) | [ ] |
| 18e.72 | Platte mit Bohrung Ø9; Mehr › Normteil › Schraube M8 × 30, „In Bohrung“ › Bohrung anklicken; danach Mutter M8 mit „andere Seite“ | Schraube steht mit dem Kopf (Innensechskant) auf der oberen Öffnung, Schaft durch die Bohrung; Mutter sitzt unten; Namen „Schraube M8×30 ISO 4762“, „Mutter M8 ISO 4032“ | [ ] |
| 18e.73 | Konstruktion › „Als STL“ | binäre STL-Datei mit allen Körpern (im Slicer öffnen: Maße wie im CAD) | [ ] |
| 18e.74 | Neue Skizze › „Ebene durch 3 Punkte …“, drei Ecken (oder Kreismitten) des Bauteils anklicken | Skizzenebene durch die drei Punkte, Blick senkrecht darauf; Ursprung im ersten Punkt, x-Achse zum zweiten | [ ] |
| 18e.75 | Konstruktion › Messen: zwei Ecken anklicken | „Punkt (x; y; z)“ je Ecke und „Abstand der Punkte … mm (Δx, Δy, Δz)“ | [ ] |
| 18e.76 | Körperliste: Werkstoff oben rechts umstellen (Stahl → PLA), „Stückliste (CSV)“ | Masse je Körper passt sich an (gemerkt); CSV mit Pos, Name, Volumen, Masse, Schwerpunkt (öffnet in Excel mit Umlauten) | [ ] |

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
- **Schrauben-Vorspannung**: Standard 90 % Ausnutzung der Streckgrenze beim Anziehen (VDI 2230), µ_G = µ_K = 0,12;
  Kopfauflage d_w aus dem CAD, Bohrung d_h = 1,1·d. Nachweis im Betrieb σ_red ≤ Rp0,2 mit k_τ = 0,5 (S ≥ 1).
- **Reibwert der Fuge** µ = 0,15 (Stahl/Stahl trocken etwa 0,1 … 0,2). Prüfe, ob das zu deinen Teilen passt.
- **Anziehverfahren** Standard Drehmomentschlüssel α_A = 1,6 mit Setzen (Setzbetrag Rz < 10 µm: Gewinde 3, Kopf/Mutter
  je 2,5, jede innere Fuge 1,5 µm). **p_G-Richtwerte** (VDI 2230, gerundet): S235 490, S355 760, C45 700, 42CrMo4 850,
  1.4301 630, GJS-400 600, 6082 360, 7075 540 MPa, sonst Rm. **Einschraubtiefe** nötig: Rm_S·A_s / (0,6·Rm·0,75·π·d).
  **Dauerfestigkeit** σ_ASV = 0,85·(150/d + 45) (schlussvergütet), nötig S_D ≥ 1,2.
- **Kontakt mit Reibung**: Tangentialfeder 1 % der Normalfeder (kleiner elastischer Schlupf), Reibgesetz je Knoten auf ±2 %.
- **Örtliche Spitzen an Schraubenauflagen und Gewinde** zählen nicht zum σv-Nachweis (Zone ≈ 0,6·d um die
  Auflagen bzw. das tragende Gewinde); sie stehen unter Details.

## Bekannte Grenzen

- Alles linear-elastisch, kleine Verformungen; keine Plastizität, kein Kriechen. Kontakt nur in Fugen verschraubter Teile.
- Eigenfrequenzen/Knicken: massiver Werkstoff (Infill wird dort nicht berücksichtigt), bis ca. 600 000 Unbekannte.
- Stabwerk: kein Stabilitätsnachweis der Stäbe (Biegeknicken/Kippen), keine Schnittgrößen-Diagramme.
- Schalenelemente (Bleche) nicht umgesetzt – dünne Teile mit feinem Volumennetz rechnen.
- Baugruppen: Körper verklebt (gemeinsame Flächen), über Schweißnähte gekoppelt oder verschraubt (Fuge mit Kontakt).
- Schrauben: Biegung im Gewinde bei Querlast nur über den Ersatzbalken; Kontakt nur, wo sich Teile im Netz berühren
  (kein Spalt, der sich schließt).
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
