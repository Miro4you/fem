# Nächste Schritte (Stand 06.11.26)

**Aktuell: Felix testet nach `TESTPROTOKOLL.md`.**


## 0. To-dos von Felix (07.11.2026) – erledigt

1. ✅ **Onshape-API-Verbrauch:** Zähler (Einstellungen › CAD-Verbindungen, Bibliothek), Dokumentliste 10 min und
   Teilenamen gemerkt, Vorschaubilder auf der Festplatte, keine Teilestudio-Vorschaubilder, STEP-Export seltener
   nachfragen (2 s warten, dann 1,5–4 s), Suche erst ab 2 Zeichen, Variablen je Teilestudio nur einmal holen.
   Offen: bei Variablen-Studien die Feature-Liste zwischen den Werten weiterverwenden (spart 1 Aufruf je Wert).
2. ✅ **Ergebnisgrößen wieder als Liste** (nur verfügbare Größen).
3. ✅ **Server wie MathPad:** Dockerfile, docker-compose, `server/deploy.sh`, öffentlicher Modus (nur eigene Dateien),
   Anleitung mit https/Caddy in `server/README.md`. Image hier nicht baubar (Paketquellen gesperrt) → auf dem Server testen.
4. ✅ **Neue Symbole:** App-Icon (Hebel mit Spannungsfarben, Netz, Einspannung, Kraft) und Lager-/Lastsymbole mit
   angedeutetem Bauteil.
5. ✅ **Wind-Last entfernt** (alte Projekte: Wind-Lasten werden beim Öffnen mit Hinweis entfernt).

## Weitere Dateiformate einlesen (Wunsch von Felix, 08.11.) – offen

Heute: STEP (Datei, Hochladen, aus Onshape, SolidCraft live, Add-ins für SolidWorks/Fusion/NX/Solid Edge).

1. **Schnell machbar – IGES (.igs/.iges) und OpenCASCADE-BREP (.brep):** Gmsh liest beide direkt, nur Dateiauswahl,
   Hochladen und Prüfung der Endung erweitern. Aufwand klein.
2. **SolidCraft nativ (.sc):** Die Datei ist ein ZIP mit `document.json` (Features) und `cache/bodies.bin` (eigenes
   B-Rep-Format „SCBREP04“). Weg A: läuft SolidCraft, die Datei über den Steuerkanal öffnen und als STEP exportieren
   lassen (die Live-Anbindung kann das schon für das offene Design) – Aufwand klein bis mittel. Weg B: SCBREP selbst
   lesen (SolidCraft ist quelloffen, Format aus dem Quelltext übernehmen) – geht dann ohne SolidCraft, Aufwand groß,
   bricht bei Formatänderungen. Vorschlag: erst A, B nur bei Bedarf.
3. **SolidWorks nativ (.sldprt/.sldasm):** Kein freier Leser (Parasolid im SolidWorks-Container). Möglich: auf einem
   Rechner mit SolidWorks die Datei über das Makro bzw. die SolidWorks-API im Hintergrund öffnen und als STEP speichern
   (Add-in ist da, Stapelbetrieb fehlt); ohne SolidWorks nur mit kostenpflichtigen Bibliotheken (z. B. CAD Exchanger,
   HOOPS Exchange). Vorschlag: Stapelumwandlung über die vorhandene SolidWorks-Anbindung.
4. **Andere CAD-Formate** (Parasolid .x_t, Inventor .ipt, Fusion .f3d, CATIA, NX .prt, Creo, JT): ebenfalls nur über
   das jeweilige Programm (Export) oder kostenpflichtige Bibliotheken – im Einzelfall entscheiden, welche wirklich
   gebraucht werden.
5. **Netzformate aus dem 3D-Druck (STL, 3MF, OBJ):** Volumennetz aus der Oberfläche (Gmsh: Flächen klassifizieren,
   dann vernetzen). Ohne CAD-Flächen gibt es keine sauberen Flächen zum Anklicken – Flächen nach Knickwinkel
   zusammenfassen. Aufwand mittel; nützlich für Druckteile, deren Original nicht als STEP vorliegt.

## Baugruppen

- ✅ **Stufe 1:** Körper mit Namen aus STEP (Gmsh-XAO), Werkstoff je Körper (Statik, Eigenfrequenzen mit Dichte je
  Körper, Knicken), ein-/ausblenden, Fläche anklicken wählt Körper, flächige Verbindung über Spalt, Ergebnis je Körper
  und Kräfte zwischen den Körpern, Onshape-Baugruppen holen, SolidWorks-Makro und Fusion lassen Baugruppen zu.
  Prüffall „Zugstab Stahl + Alu“ (exakt).
- ✅ **Schrauben Schritt 1 (07.11.):** Erkennung modellierter Normteile (Name + Form, mit Scheiben/Muttern) und
  Vorschläge aus fluchtenden Bohrungen, Festigkeitsklasse je Schraube (aus dem Namen vorbelegt), Schraubenelement
  (Balken mit Ankopplung an Kopfauflage und Gewinde/Mutter), Fuge offen/verklebt, Kräfte (Zug, Quer, Biegung) und
  Nachweis gegen Rp0,2, PDF-Bericht. Prüffall 4 × M8 und Test mit `examples/geometrie/verschraubung.step`.
- ✅ **Schrauben Schritt 2 (07.11.): Kontakt + Vorspannung.** Kontakt Knoten-zu-Knoten in der aufgetrennten Fuge
  (aktive Menge, erweitertes Lagrange gegen Durchdringung, Coulomb-Reibung mit Rückprojektion auf den Reibkegel,
  Schwellen/Dämpfung gegen Pendeln, Konvergenz über die Kraftänderung). Vorspannung in zwei Schritten (anziehen mit
  vorgegebener Kraft → Schraubenlänge fest → Betriebslast). F_V nach VDI 2230 aus Ausnutzung, Anziehmoment oder
  direkt; Anziehmoment, Gewindetorsion im Nachweis, Flächenpressung unter dem Kopf. Ergebnis je Fuge: aufliegend
  (angezogen/unter Last), Restklemmkraft, Pressung, Reibkraft und Reibschluss µ·F_K; Hinweise bei Klaffen/Durchrutschen.
  Krafteinleitung flächenrichtig, Spitzen dort nicht im σv-Nachweis. Löser: Warmstart, Vorkonditionierer behalten
  (Beispiel-Baugruppe 15 Durchgänge à ≈ 1 s). Prüffälle: Kontakt unter Druck, vorgespannt mit/ohne Last, Klaffen,
  Querkraft haftend/durchrutschend/reibungsfrei (115/115).
- ✅ **Schrauben Schritt 3 (07.11.):** Flächenpressung unter Kopf/Mutter gegen p_G (eigene Angabe, Richtwert nach Name,
  sonst Rm), Einschraubtiefe gegen die nötige, Anziehstreuung α_A und Setzen (zwei Rechnungen: F_V,max für Festigkeit,
  F_V,min nach dem Setzen für die Fuge; F_Z aus den Nachgiebigkeiten der FEM, Φ_K), Dauerfestigkeit σ_a/σ_ASV (wahlweise),
  Schraube von Hand an einer Bohrung (Größe, umdrehen, löschen, im Projekt gespeichert). Prüffall Streuung/Setzen,
  App-Test `flansch.step`.
- ✅ **Kontakt an beliebigen Berührflächen (07.11.):** je Körperpaar „verklebt“ oder „Kontakt“, Stabilisierung gegen lose
  Teile mit Hinweis, weichere Tangentialfeder für stabile Reibung. Prüffall „Klotz angedrückt und geschoben“ (124/124).
- ✅ **08.11. Schraubentest aus SolidCraft:** Vernetzen hing > 10 min an den Bohrspitzen (118°-Kegel, Verfeinerung nach
  Krümmung lief an der Spitze davon) → kleinste Elementgröße begrenzt (jetzt 3 s). Schrauben ohne sprechenden Namen
  werden an der Form erkannt. Anzeige „σv max“ wieder ohne die Spitzen an der Schrauben-Krafteinleitung.
- ✅ **08.11. Vernetzen bedienbar:** Fortschrittsbalken aus der Gmsh-Ausgabe (Phase, Prozent, Zeit), „Abbrechen“ beendet
  Gmsh bzw. den Löser (Kontakt-Durchgänge, PCG), „Erst grob laden“ lädt die Datei mit grobem Vorschau-Netz (bei Fehlern
  automatisch), richtig vernetzen danach unter „Netz“; Rechnen erst mit richtigem Netz.
- **Schrauben/Kontakt danach:** Kontakt über einen Spalt, der sich erst schließt (Teile berühren sich im CAD nicht),
  Passschrauben/Bolzen im Loch (Lochleibung), Schraubenbild mit Querkraft-Verteilung als eigene Auswertung, Anziehen
  nacheinander (Reihenfolge), Temperatur (Wärmedehnung Alu/Stahl verändert die Vorspannung).
- **Stufe 2 (Rest):** Bolzenverbindung (Bolzen im Loch, drehbar), 3D-Druck-Füllung zusammen mit Werkstoff je Körper.
- **Stufe 3:** Bewegungssimulation mit FEM entlang der Bewegung (siehe unten).

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
- ✅ Konstruktion (kleines CAD) statt „Geometrie anpassen“: Skizzen mit Maßen/Bedingungen, Extrudieren, Drehen,
  Bohrung mit Senkung, Verrunden, Fase, Muster, Spiegeln, Fläche verschieben/entfernen, Feature-Verlauf
  → Felix: bitte ausprobieren (Testprotokoll 18d). Ideen für danach: Variablen/Formeln für Maße (#dicke),
  Rippe, Wandung (Shell), Langloch/Polygon/Spline in der Skizze, Trimmen, Skizzen-Muster, Fasen mit zwei Maßen,
  Gewindebohrung, Baugruppen aus mehreren konstruierten Teilen, Skizze aus DXF
- **Als Nächstes: [KONSTRUKTION_TODO.md](KONSTRUKTION_TODO.md)** – ausführlicher Arbeitsplan: Koordinatensystem und
  Ansichtswürfel im CAD, Skizzen bleiben sichtbar, eine Skizze für mehrere Extrusionen (Bereichswahl wie Onshape),
  Verbindung zum Draftpad-Server (Bibliothek, verknüpfte Skizze, Aktualisieren)
- ✅ Draftpad-Zeichnung als Skizze übernehmen (Ebenen wählen, Lücken schließen, Bedingungen erkennen, Schraffur =
  Material, Achse = Drehachse). Ideen: direkt aus der Draftpad-Cloud holen statt Datei, Draftpad-Maße als Skizzenmaße
  übernehmen, mehrere Ansichten einer Zeichnung als Vorder-/Seitenansicht kombinieren
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
