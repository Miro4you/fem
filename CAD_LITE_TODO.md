# Konstruktion „Onshape light“ – Arbeitsplan

Stand: 13.11.2026, Branch `claude/stoic-maxwell-rtmn09`. Nachfolger von `KONSTRUKTION_TODO.md` (dort A–F erledigt).
So geschrieben, dass eine neue Sitzung ihn ohne Vorwissen abarbeiten kann.

## Ziel (Felix, 13.11.2026)

Ein **solides, schnelles Konstruktionswerkzeug für Grobkonzepte** – kein Onshape-Ersatz. Typischer Ablauf:
im Gespräch in Draftpad skizzieren → nach Projekt-FEM schieben → schnell ein 3D-Modell daraus → Lasten → Nachweis
zeigen. Gelegentlich dort auch weiter ausarbeiten. Gearbeitet wird **am Rechner** (Maus); das iPad ist für Draftpad.
Modellgröße: Einzelteile (Welle, Träger, Halter) und **kleine Baugruppen, meist 20–30, höchstens ~50 Teile**.

Was Felix heute konkret fehlt (seine Worte zusammengefasst):

1. **Vorschau** bei Features – z. B. Fase/Verrundung sieht man erst nach OK.
2. **Extrudieren durch Ziehen** (Pfeil im Bild, Millimeterschritte) und **Mausrad im Zahlenfeld** (10 → 50 → 60 mm).
3. **Bedingungen in der Skizze sehen** und direkt im Bild anklicken – nicht umständlich über die Seitenleiste.
4. **Richtig bemaßen**: Linie–Linie, Punkt–Linie, Abstand, Winkel – heute geht praktisch nur „Länge einer Linie“.
5. **Trimmen** (und Verlängern, Versatz …), neue Linien zeichnen und dann positionieren.
6. **Schnittansicht** und **Messen** – Messen auch in der FEM-Ansicht für importierte STEP-Modelle
   (Anlass: STEP mit Ø 40 statt R 40 – mit einem Messwerkzeug sofort aufgefallen).

## Entscheidung: neuer Geometriekern im Browser

Heute: Python + Gmsh (OpenCASCADE-Teilmenge) auf dem Server, ein neuer Prozess je Änderung, Darstellung über STEP.
Das ist langsam (1–3 s je Änderung + Netz), kann vieles nicht (Schale, Sweep, Loft, ordentliche Vorschau) und liefert
keine Herkunft der Flächen (Bezüge werden heute über die Lage geraten).

Neu:

| Baustein | Paket (npm) | Aufgabe |
|---|---|---|
| Geometriekern | `replicad` 1.2.1 + `replicad-opencascadejs` 1.2.1 (OpenCASCADE als WebAssembly, LGPL-2.1, unverändert eingebunden) | alle Features, Vernetzen für die Anzeige, Kanten, Messen, STEP-Export/-Import |
| Skizzen-Löser | `@salusoft89/planegcs` 1.3.0 (Löser von FreeCAD als WebAssembly) | Bedingungen und Maße |
| Vernetzen/Rechnen | bleibt Gmsh auf dem Server | bekommt das fertige Teil als STEP (wie Onshape-Teile heute) |

Bleibt: Feature-Liste als JSON (Projektdatei, Studie über Parameter), `CadStudio`/`CadView` als Oberfläche, Draftpad-
Anbindung, Teilevorschlag aus Schraffuren. Der Python-Kern bleibt, bis der neue alles kann, dann fliegt er raus.

Erste Messung (Node, 13.11.2026, ein Kern): Platte 120×60×10 mit 4 Bohrungen, R5 an den senkrechten Kanten und Fase
oben – jeder Schritt im Bereich weniger Millisekunden bis einige 10 ms; Welle drehen 6 ms, Schale 31 ms, STEP-Export
56 ms. Zum Vergleich heute: 1–3 s je Neuaufbau. Ladezeit und Größe im Browser: noch offen (WebAssembly-Datei 22 MB
unkomprimiert) → G0.

---

## G0. Machbarkeitstest im Browser (zuerst, klein)

1. `replicad` im **Web Worker** (`app/src/cad/kernel/worker.js`), eingebunden über Vite (`?url` für die .wasm).
   Schnittstelle als Nachrichten: `build(features) → { bodies: [{ name, mesh, edges, faces:[{id, kind, normal,
   center, radius}] }], status }`, `step(features) → Blob`.
2. Mit der bestehenden Feature-Liste für **Skizze → Extrudieren, Drehen, Fase, Verrunden, Bohrung** (Bereiche aus der
   Skizze wie heute: Flächen aus den Schleifen bilden, Löcher frei).
3. `planegcs` mit einer Skizze aus `examples/draftpad/wellenschnitt` (über 300 Linien): Lösezeit messen.
4. Messen: Ladezeit beim ersten und zweiten Öffnen (Zwischenspeicher), Speicher, Neuaufbau nach Maßänderung,
   jeweils mit Platte, Welle und einer Baugruppe aus 30 Teilen.
5. Server: `.wasm` mit `Content-Type: application/wasm` und komprimiert ausliefern (Rust-Server und Tauri prüfen).

**Fertig, wenn:** Neuaufbau einer Platte < 100 ms im Browser, Laden < 3 s beim zweiten Öffnen, 30 Teile flüssig drehbar.
Sonst: zurück zur Alternative (volles OpenCASCADE über CadQuery in einem dauerhaft laufenden Prozess auf dem Server).

### Stand G0 (13.11.2026) ✅

Gebaut: `app/src/cad/kernel/` – `build.js` (Feature-Liste → Körper, gleiche Antwort wie `cad.py`), `geom2d.js`,
`worker.js` (Web Worker), `client.js` (`cadBuildView`: neuer Kern, wenn eingeschaltet und alle Features bekannt,
sonst Server). Standard seit 13.11.; `#kern=alt` an der Adresse schaltet auf den alten Kern (bleibt gemerkt, `#kern=neu` zurück).
Kann: Skizzenbereiche (Teiler von OpenCASCADE), Extrudieren (Dazu/Weg/Neuer Körper, symmetrisch, durch alles,
Flächenwahl, Schraffuren), Drehen (Halbebene bei Schnittzeichnungen), Bohrung (Senkung, Spitze), Verrunden,
Fase, Körpernamen, Überschneidung abziehen, STEP mit Teilenamen. Noch nicht: Muster, Spiegeln, Fläche
verschieben/entfernen, Radius/Bohrung ändern → gehen automatisch an den alten Kern.
Tests: `cd app && npm test` (die Kern-Tests aus `cad.rs` mit denselben Sollvolumen + planegcs-Vergleich).

Gemessen (Chromium ohne Grafikkarte in der Cloud-Sitzung; auf einem normalen Rechner eher schneller):

| | Zeit |
|---|---|
| WebAssembly übertragen | 7,2 MB (gzip, danach im Zwischenspeicher) |
| Kern bereit | 1,6–4,5 s beim ersten Mal, ~1,7 s danach |
| Platte 120×60 mit 4 Bohrungen, R5, Fase – Dicke ändern | 80–100 ms (Aufbau 50–65 ms + Netz) |
| dasselbe ohne Änderung / nur Fase geändert | 1 ms / 46 ms |
| Baugruppe 30 Teile komplett | 280 ms |
| … ein Teil geändert | 14 ms |
| Durchlauf aus Paket E (Platte → … → Rechnung → Studie) | gleiche Ergebnisse wie mit dem alten Kern |

Löser (Wellenschnitt, 250 Punkte, 240 Bedingungen): unser Löser 2 ms (mit Freiheitsgraden ~50–80 ms), Maß ändern
9–30 ms; planegcs 70–85 ms, Maß ändern 130–150 ms, liefert dafür benannte Widersprüche/Überbestimmungen.
**Folgerung für G2:** unser Löser bleibt fürs Ziehen und Bemaßen (schnell genug, Ergebnisse gleich), planegcs
(`app/src/cad/gcs.js`, Übersetzung fertig) nur zum Erklären von Widersprüchen – wenn nötig. Was Felix am
Skizzieren stört, ist Bedienung (Bedingungen im Bild, Bemaßen zwischen Elementen, Trimmen), nicht der Löser.

## G1. Kern ablösen (Gleichstand mit heute) ✅ (bis auf Defeaturing, siehe Stand G1)

### Stand G1 (13.11.2026)

Erledigt: Muster (linear, zwei Richtungen, kreisförmig; Features oder ganzer Körper), Spiegeln (exakt über
`gp_Trsf`, auch ganzer Körper), Fläche verschieben (nach außen/innen, Bezug über Art und Normale);
Übernehmen/Speichern/Studie bauen die STEP-Datei im Browser (`cadBuildStep`), der Server speichert sie nur
(`CadArgs.step_text`) und vernetzt; Teilenamen kommen bis ins Netz (Test `namen_aus_dem_browserkern`,
Testdatei `crates/fem-core/tests/data/neuer-kern-baugruppe.step`). Neuer Kern ist Standard.
Im Browser durchgespielt: Paket-E-Ablauf bis zur Studie und Paket-F-Baugruppe – alles im neuen Kern.
Spiegeln des ganzen Körpers ist jetzt exakt das Doppelte (alter Kern verlor 29 mm³ beim Verschmelzen).

Bleibt beim alten Kern (automatisch): Flächen entfernen, Radius/Bohrung ändern und Weiterkonstruieren an einem
importierten STEP-Teil (`base`) – dafür fehlt `BRepAlgoAPI_Defeaturing` in der WebAssembly-Fassung von
replicad. `cad.py` bleibt deshalb vorerst. Später: eigene opencascade.js-Fassung mit Defeaturing oder
Bohrungen/Taschen gezielt füllen; stabile Namen über die Historie (`Modified/Generated`) statt Lagehinweisen,
wenn die Hinweise in der Praxis nicht reichen.

1. Alle heutigen Features im Worker: Skizze (Bereiche, Schraffuren als Material), Extrudieren (neu/zufügen/abziehen,
   symmetrisch, bis Fläche), Drehen (Achse aus der Skizze, Halbebene), Fase, Verrunden, Bohrung, Muster, Spiegeln,
   Fläche verschieben, Flächen entfernen, mehrere Körper, Körpernamen.
2. **Bezüge über die Herkunft**: OpenCASCADE meldet je Operation, welche Fläche/Kante woraus entstanden ist
   (`Modified`/`Generated` der `BRepBuilderAPI_MakeShape`-Klassen). Daraus stabile Namen bilden
   (z. B. `extrude1/side/e_d_l3`, `extrude1/top`); Lagehinweise wie heute nur noch als Rückfall.
3. Anzeige: Dreiecksnetz + Kanten direkt aus dem Worker an three.js (kein STEP-Umweg), Flächen-IDs für Auswahl.
4. Übernehmen in die Rechnung: STEP aus dem Worker → bestehende Gmsh-Vernetzung (`mesh_step_with`), Teilenamen in STEP.
5. Zwischenstände je Feature im Worker behalten → bei Änderung ab dem geänderten Feature neu rechnen.
6. Tests: die sieben Kern-Tests aus `cad.rs` als JS-Tests (vitest) nachbauen, gleiche Volumen.

## G2. Skizzierer

1. Löser: unser eigener bleibt (siehe Stand G0); `planegcs` nur, um Widersprüche zu erklären.
2. **Bedingungen im Bild**: kleine Zeichen neben den Elementen (waagrecht, senkrecht, parallel, tangential,
   gleich, deckungsgleich …), anklicken = wählen, Entf = löschen, beim Überfahren zugehörige Elemente hervorheben.
3. **Bemaßen wie Onshape**: Werkzeug „Maß“ – zwei beliebige Elemente anklicken (Punkt–Punkt, Punkt–Linie,
   Linie–Linie parallel = Abstand, Linie–Linie schräg = Winkel, Kreis = Ø, Bogen = R, Kreis–Linie/Kreis–Kreis =
   Abstand Mitte bzw. Rand), Maß ablegen, Wert direkt im Bild eintippen, Doppelklick ändert.
4. **Bedingungen setzen** über Kurzwerkzeuge in der schwebenden Leiste (Auswahl → passende Bedingungen werden
   angeboten), beim Zeichnen automatisch (waagrecht/senkrecht/auf Punkt/tangential) wie heute, aber sichtbar.
5. Bearbeiten: **Trimmen**, Verlängern, **Versatz**, Skizzen-Verrundung/-Fase, Linie teilen, Hilfslinie umschalten,
   Kanten des Körpers in die Skizze **projizieren**, rechteckiges/kreisförmiges Muster in der Skizze, Spiegeln.
6. Ziehen unterbestimmter Punkte (Löser hält die Bedingungen), Farben: unterbestimmt blau, bestimmt schwarz,
   Widerspruch rot (wie heute, aber über planegcs).
7. **Skizze auf einer Körperfläche** anlegen.

## G3. Bedienung der Features (1–3 erledigt 13.11.: Vorschau 60 ms nach jeder Eingabe, Ziehgriff Extrusionstiefe, `NumInput` mit Mausrad/Pfeilen/Rechnen – auch Skizzenmaße)

1. **Live-Vorschau** für jedes Feature während der Dialog offen ist (Worker rechnet bei jeder Eingabe, entprellt).
2. **Ziehpfeil** beim Extrudieren (und Bohrungstiefe, Fase, Verrundung): im Bild ziehen, rastet auf 1 mm
   (Umschalt = 0,1 mm), Wert läuft im Feld mit.
3. **Mausrad im Zahlenfeld**: ±1 Schritt (Umschalt fein, Strg ×10), auch Pfeiltasten; Ausdrücke wie `10+5`, `2*12`.
4. Kanten/Flächen wählen mit Hervorhebung beim Überfahren, Auswahlfilter (Fläche/Kante/Punkt), Kantenkette
   (tangential fortgesetzte Kanten auf einmal).
5. Verlauf: Rückrollbalken (Features unterhalb ausblenden), Ziehen zum Umsortieren, Fehler am Feature wie heute.

## G4. Neue Features

Schale, Sweep (Profil entlang Pfad), Loft (zwischen Skizzen), Boolesch (vereinigen/abziehen/schneiden zwischen
Körpern), Bohrung mit Senkung/Gewindekennzeichen, Ebene (versetzt, durch drei Punkte, senkrecht zu Kante),
Muster kreisförmig um Achse, Formschräge (wenn einfach).

## G5. Messen und Schnitt (Konstruktion **und** FEM-Ansicht)

1. Werkzeug „Messen“: Punkt/Kante/Fläche anklicken → Abstand, Länge, Ø/R einer Zylinderfläche, Winkel zwischen
   Flächen, Fläche, Volumen/Masse des Körpers. Ergebnis als Etikett im Bild, mehrere stehen lassen.
2. In der **FEM-Ansicht**: importiertes STEP zusätzlich in den Worker laden (`importSTEP`) und mit demselben
   Werkzeug messen – auch für Onshape-Teile.
3. **Schnittansicht**: Schnittebene (X/Y/Z oder Fläche), verschiebbar, Schnittfläche schraffiert gefüllt.

## G6. Baugruppen (bis ~50 Teile)

1. Mehrere Teile in einer Konstruktion (heute: mehrere Körper) – Teileliste mit Namen, Material, ein-/ausblenden.
2. Teile einfügen (aus diesem Projekt, STEP, Onshape), Normteile (Schraube, Mutter, Scheibe) aus der vorhandenen
   Schraubenbibliothek.
3. Einfache Lage-Bedingungen: fest, Fläche auf Fläche, Achse auf Achse (Schraube in Bohrung). Übergabe an die
   Rechnung mit Kontakt verklebt (wie heute, änderbar).
4. Leistung: 50 Teile drehbar ohne Ruckeln (Netze gebündelt, nur geänderte Teile neu rechnen).

## G7. Draftpad-Ablauf auf den neuen Kern

Import, verknüpfte Skizze, Teilevorschlag aus Schraffuren, „In Projekt-FEM nachweisen“ – unverändert bedienen,
intern über den neuen Kern. Prüfen mit `examples/draftpad/*`.

---

Reihenfolge: **G0 → G1 → G2 → G3 → G5 → G4 → G6**, G7 läuft bei G1 mit. Nach jedem Paket im Browser testen,
`TESTPROTOKOLL.md`/README aktualisieren, committen, pushen. G2 und G3 bringen Felix am meisten Bedienfreude,
G5 (Messen in der FEM-Ansicht) ist klein und kann vorgezogen werden, sobald G0 steht.
