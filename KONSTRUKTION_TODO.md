# Konstruktion: nächste Ausbaustufe – Arbeitsplan

Stand: 12.11.2026, Branch `claude/stoic-maxwell-rtmn09`, letzter Commit dazu `1c663eb`.
Dieser Plan ist so geschrieben, dass eine neue Sitzung ihn ohne Vorwissen abarbeiten kann.
Felix' Wünsche (wörtlich zusammengefasst):

1. Eine **richtige Verbindung zu Draftpad** – nicht nur Datei hochladen.
2. Die **Skizze bleibt im Hintergrund sichtbar** (wie in Onshape). Eine komplette 2D-Grundskizze zeichnen bzw. aus
   Draftpad holen, dann **nur Teile davon extrudieren**, für die nächste Extrusion **andere Flächen derselben
   Skizze** wählen. Löcher wahlweise mitnehmen oder frei lassen.
3. Die Skizze soll überhaupt **angezeigt** werden (nach „Skizze fertig“ ist sie im Moment weg).
4. Wieder ein **Koordinatensystem** im CAD (Achsenkreuz, Ansichtswürfel).

Reihenfolge der Pakete: **A → B → C → F → D → E**. A und B sind klein und machen C erst gut bedienbar; F ist der
Ablauf, um den es Felix eigentlich geht (siehe „Entscheidungen“ am Ende); D macht ihn bequem.
Jedes Paket einzeln bauen, im Browser testen, committen, pushen.

---

## 0. Was es schon gibt (nicht neu bauen)

| Datei | Inhalt |
|---|---|
| `crates/fem-core/src/cad.py` | Geometriekern (Python + Gmsh/OpenCASCADE). Führt die Feature-Liste aus. Wichtige Funktionen: `sketch_regions` (alle geschlossenen Bereiche einer Skizze per `occ.fragment`), `sketch_faces` (Auswahl per Punkt `regions`, per Schraffur `fills` oder gerade/ungerade), `half_plane` (Drehen: nur eine Seite der Achse), `combine` (dazu/weg/neu), `tessellate` (Darstellung: Dreiecke, Flächen, Kanten, Punkte). |
| `crates/fem-core/src/cad.rs` | Startet `cad.py` (`build(&CadJob)`), 3 Tests (`cargo test -p fem-core cad::`). |
| `app/src-tauri/src/lib.rs` | `CadArgs`, `cad_build_impl`, Tauri-Befehl `cad_build`. |
| `app/src-tauri/src/server.rs` | Route `/cad_build` (`api_cad_build`). |
| `app/src/api.js` | `cadBuild(args)`. |
| `app/src/cad/solver.js` | Skizzen-Löser (Maße, Bedingungen, Freiheitsgrade, Ziehen). |
| `app/src/cad/sketch.js` | Skizzen-Datenmodell, Fangen, Maße, `kernelSketch` (Skizze → Zahlen für den Kern). |
| `app/src/cad/features.js` | Feature-Vorgaben (`defaults`), `problemOf`, `kernelFeature(s)`, `cadParams` (Parameterstudie), `planeFromFace`. |
| `app/src/cad/draftpad.js` | `readDraftpad`, `defaultLayers`, `importDraftpad` (Datei → Skizzenelemente; Lücken schließen, T-Stöße, Bedingungen erkennen, Schraffuren als `sketch.fills`). |
| `app/src/cad/CadView.jsx` | 3D-Ansicht (three.js) mit Skizzierer, Auswahl von Flächen/Kanten/Ebenen, Bereichsflächen (`regions`). |
| `app/src/cad/CadStudio.jsx` | Arbeitsbereich: Werkzeugleiste, Verlauf, `FeatureDialog`, `DraftpadPanel`, Neuaufbau (`run`), Vorschau. |
| `app/src/App.jsx` | Zustand `cad = { base, features }`, `cadApplied`, `onCadApply`, `swapGeometry`, Speichern/Laden, Studie (`cad:`-Parameter). |

Datenmodell (Auszug):

```js
cad = { base: '/pfad/teil.step' | null, features: [feature, …] }
feature = { id, type, name, suppressed?, … }
// type 'sketch':  { sketch: { plane:{origin,normal,u}, planeRef, pts:{id:{x,y,fix}}, ents:[{id,t:'line'|'circle'|'arc'|'point',a,b,c,r,cons,axis,fix}], cons:[…], fills?:[[[x,y]…]…], next } }
// type 'extrude': { sketch: <id>, regions: null | [[u,v],…], useFills, mode:'add'|'cut'|'new', depth, flip, symmetric, through }
// type 'revolve': { sketch, regions, useFills, axis: <ent-id der Skizze>, angle, mode, symmetric }
```

`regions: null` heißt „automatisch“: schraffierte Bereiche (`sketch.fills`), sonst gerade/ungerade (Löcher frei).
`regions: [[u,v],…]` sind Punkte in Skizzenkoordinaten; gewählt ist jeder Bereich, der einen dieser Punkte enthält.
Der Kern liefert mit `regions_of: <skizzen-id>` die Bereiche zurück:
`result.regions = [{ pt:[u,v], area, loops:[[[u,v],…],…], evenodd, fill }]`.

---

## A. Koordinatensystem und Ansichtswürfel in der Konstruktion ✅ (erledigt)

**Ist:** `CadView.jsx` hat weder Achsenkreuz noch Ansichtswürfel. Im Modell-Reiter gibt es beides
(`app/src/components/Viewport.jsx`: `ViewCube`, `Triad`, `VIEWS`, Zustand `cam`, `fitView`, Stile `.view-nav`,
`.view-cube`, `.triad` in `styles.css`).

**To-do:**

1. In `Viewport.jsx` `ViewCube`, `Triad` und `VIEWS` exportieren (nur `export` davor, sonst nichts ändern).
2. In `CadView.jsx`:
   - Zustand `cam` (Kamera-Achsen rechts/oben/zum Betrachter) wie in `Viewport.jsx` in der Zeichenschleife setzen
     (dort Zeile mit `setCam((old) => …)` als Vorlage; nur setzen, wenn sich etwas ändert).
   - `fitView(name)` über das vorhandene `fitAll(dir, up)` mit `VIEWS[name]`.
   - Im JSX unten ergänzen: `<div className="view-nav">` mit `<ViewCube cam={cam} onView={fitView} />` und den
     Knöpfen „Isometrisch“ (`IcHome`) und „Alles zeigen“ (`IcFit`, ruft `fitAll(cam[2], cam[1])`), dazu
     `<Triad cam={cam} onView={fitView} />`. Immer zeigen (auch ohne Körper).
   - Beim Skizzieren zusätzlich einen Knopf **„Senkrecht auf die Skizze“** (ruft `lookAtPlane(sketch.plane, sketch.data)`).
3. **Achsen im Raum:** in der Gruppe `s.planes` (oder einer neuen Gruppe `s.axes`, immer sichtbar) drei Linien vom
   Ursprung: X rot `#dc2626`, Y grün `#16a34a`, Z blau `#2563eb`, Länge `max(20, 0.25 · s.size)`,
   `depthTest: false`, leicht durchsichtig; am Ende je ein kleiner Text (HTML-Overlay wie die Maßzahlen oder
   `THREE.Sprite`). Ursprungspunkt als kleiner Punkt.
4. Hauptebenen beschriften („XY · Oben“, „XZ · Vorne“, „YZ · Rechts“), wenn `showPlanes` an ist.
5. Knopf in der Werkzeugleiste „Ebenen zeigen/verbergen“ (Zustand in `CadStudio`, zusätzlich zur bisherigen Regel
   `showPlanes`).
6. Die Werkzeugleiste (`.cad-toolbar`, oben mittig) darf den Würfel oben rechts nicht überdecken:
   `max-width: calc(100% - 140px)`.

**Fertig, wenn:** Würfel und Achsenkreuz in der Konstruktion zu sehen sind, Klick auf Würfelfläche/Achse dreht die
Ansicht, im leeren neuen Teil die drei Achsen am Ursprung stehen.

---

## B. Skizzen bleiben sichtbar ✅ (erledigt)

**Ist:** `CadView` zeichnet nur die Skizze, die gerade bearbeitet wird (Prop `sketch`). Fertige Skizzen sind
unsichtbar. Außerdem baut der Skizzen-Effekt (der große `useEffect` mit `s.sketch.clear()`) bei jedem
Hover-Wechsel alles neu – bei importierten Skizzen mit 200 Elementen wird das zäh.

**To-do:**

1. Neue Prop `sketches` an `CadView`: `[{ id, plane, data, active, dim }]` = alle Skizzen-Features, die nicht
   unterdrückt und nicht ausgeblendet sind, außer der gerade bearbeiteten.
   In `CadStudio` aus `features` bilden; `active` = wird vom offenen Feature benutzt (`edit.draft.sketch === id`).
2. Eigene three.js-Gruppe `s.bgSketches`, **eigener** `useEffect` mit Abhängigkeit nur auf `sketches`
   (nicht auf `hover`). Je Skizze ein `LineSegments` für alle Linien/Bögen/Kreise (Polylinien aus
   `polyline(sk, e)` + `to3d`), Hilfslinien gestrichelt in zweitem Objekt. Farbe grau-blau `#64748b`,
   aktive Skizze kräftiger `#2563eb`. `depthTest: false`, `renderOrder` unter den Bereichsflächen,
   Deckkraft 0,55 (aktiv 0,9). Keine Punkte, keine Maße, keine Bedingungszeichen.
3. Den bestehenden Skizzen-Effekt aufteilen: (a) bearbeitete Skizze, (b) Bereiche + Achse, (c) Vorschau der
   Zeichenaktion. Hover-Farbe nur über Material-/Attribut-Update ändern, nicht alles neu aufbauen.
4. **Ein-/Ausblenden je Skizze:** neues Feld `feature.hidden` (nur Anzeige, nicht „unterdrückt“). Im Verlauf
   bei Skizzen ein zweites Symbol (Auge mit Stift bzw. `Eye`/`EyeOff` für `hidden`; das bisherige Auge für
   „unterdrücken“ auf ein anderes Symbol legen, z. B. `Power`/`CircleSlash`, mit Tooltip „Unterdrücken“).
   `kernelFeatures` ignoriert `hidden` (Skizze wirkt weiter).
5. Globaler Knopf in der Werkzeugleiste „Skizzen zeigen“ (an/aus für alle).
6. **Anklicken im Bild** (wenn kein Feature offen ist): Klick auf eine Hintergrund-Skizzenlinie markiert die
   Skizze im Verlauf, Doppelklick öffnet sie zum Bearbeiten (`openEdit`). Trefferprüfung wie `sketchHit`
   (Abstand zu Elementen in Pixeln), aber über alle `sketches`.
7. Bedingungszeichen (`overlay.glyphs`) bei mehr als ~40 Stück standardmäßig ausblenden; Umschalter
   „Bedingungen zeigen“ in der Skizzen-Werkzeugleiste. (Nach einem Draftpad-Import sind es 80–240 Zeichen.)

**Fertig, wenn:** nach „Skizze fertig“ die Skizze als dünne Linien im Raum bleibt, auch wenn ein Körper davor
liegt; Auge im Verlauf blendet sie aus; Drehen/Zoomen bleibt mit der Wellen-Zeichnung (179 Linien) flüssig.

---

## C. Eine Skizze – viele Extrusionen (Bereichswahl wie in Onshape) ✅ (erledigt)

**Ist:** Technisch geht es schon (`regions` je Feature), aber: die Skizze ist nicht sichtbar, die Vorauswahl ist
immer „automatisch“, es gibt kein Hervorheben unter der Maus, und beim Drehen ist die Achse nur über eine Liste
„Linie 1 … Linie 179“ wählbar.

**Zielablauf:**
Skizze (gezeichnet oder aus Draftpad) → „Extrudieren“ → im Bild die gewünschten Flächen anklicken → Tiefe → OK →
wieder „Extrudieren“ → dieselbe Skizze ist noch gewählt, andere Flächen anklicken, andere Tiefe/„Weg“ → OK.

**To-do Oberfläche (`CadStudio.jsx`, `CadView.jsx`):**

1. **Bereiche laden und merken:** Bereiche je Skizze einmal holen und zwischenspeichern
   (`Map` mit Schlüssel `JSON.stringify(kernelSketch(id, sk))`). Aufruf: `api.cadBuild({ base: null,
   features: [kernelSketch], regions_of: id, tess: false })` – unabhängig von der Körper-Vorschau, damit die
   Bereiche sofort da sind (heute kommen sie erst mit der Vorschau nach 250 ms + Bauzeit).
2. **Vorauswahl:**
   - Skizze wird zum ersten Mal benutzt **und** hat höchstens ~6 Bereiche → wie bisher automatisch
     (Schraffur, sonst gerade/ungerade).
   - sonst (Skizze schon von einem anderen Feature benutzt **oder** viele Bereiche) → **nichts gewählt**,
     Hinweis „Flächen im Bild anklicken“. OK ist gesperrt, bis etwas gewählt ist
     (`problemOf`: bei `regions` leerem Array → „Flächen wählen“).
   - Dafür `regions` dreiwertig behandeln: `null` = automatisch, `[]` = bewusst nichts, `[[u,v],…]` = Auswahl.
     In `kernelFeature` bleibt `fills: f.regions === null && f.useFills !== false`.
3. **Schnellwahl-Knöpfe** im Dialog: „Alle“, „Keine“, „Schraffierte“ (nur wenn `sketch.fills`),
   „Automatisch (Löcher frei)“.
4. **Hervorheben unter der Maus:** Bereich unter dem Zeiger heller färben; gewählte Bereiche blau (wie jetzt),
   Bereiche, die **ein anderes Feature** derselben Skizze schon benutzt, grau gestreift/gepunktet mit Tooltip
   „schon in Extrudieren 1“ (aus `features` berechnen: deren `regions`-Punkte bzw. automatische Auswahl).
5. **Löcher:** jeder innere Bereich (Bohrung, Tasche) ist ein eigener Bereich und wird durch Anklicken
   dazugenommen. Zusätzlich **Alt + Klick = Bereich samt allem, was darin liegt** (alle Bereiche, deren `pt`
   innerhalb der äußeren Schleife des angeklickten Bereichs liegt; äußere Schleife = die mit der größten Fläche).
6. **Skizze im Bild wählen:** ist im Dialog noch keine bzw. eine andere Skizze gewählt, wählt ein Klick auf eine
   Linie einer Hintergrund-Skizze diese Skizze (setzt `draft.sketch`, `regions: []`).
7. **„OK und weiter“**-Knopf bei Extrudieren: übernimmt das Feature und öffnet sofort ein neues Extrudieren mit
   derselben Skizze und leerer Auswahl.
8. **Drehachse im Bild wählen:** `PickButton` „Achse“ mit `pickFor = 'skaxis'`: Klick auf eine Linie der
   gewählten Skizze setzt `draft.axis`. Die Liste bleibt als Ausweichweg, zeigt aber zuerst Achsen
   (`e.axis`, Beschriftung „Achse (Draftpad)“), dann Hilfslinien, dann übrige Linien mit Länge
   („Linie · 98 mm“).
9. Bereichsflächen nicht bei jedem Rendern neu erzeugen (heute `new THREE.ShapeGeometry` im Effekt): Geometrien
   je Bereich einmal bauen, bei Auswahl/Hover nur Farbe/Deckkraft ändern.
10. `RegionClicks` (in `CadView.jsx`) und die normale Flächenauswahl dürfen sich nicht in die Quere kommen:
    Bereichsklick hat Vorrang, solange ein Extrudieren/Drehen-Dialog offen ist.

**To-do Kern (`cad.py`):**

11. `sketch_faces`: bei `picks == []` (leere Liste, nicht `None`) Fehler „keine Fläche gewählt“ statt
    automatischer Auswahl. (Heute ist `if picks:` für `[]` falsch → fällt auf automatisch zurück.)
12. Bereichspunkte robuster machen: zusätzlich zu `pt` die Fläche speichern
    (`regions: [{ pt:[u,v], area }]`; alte Form `[u,v]` weiter annehmen). Trifft ein Punkt nach einer
    Skizzenänderung keinen Bereich mehr, Meldung mit Feature-Namen (gibt es schon) – nicht still etwas anderes
    bauen.
13. Test in `cad.rs` ergänzen: eine Skizze (Rechteck mit zwei Kreisen), Extrusion 1 = Rechteckfläche ohne
    Kreise Tiefe 10, Extrusion 2 = ein Kreis Tiefe 25, Extrusion 3 = anderer Kreis „Weg“ durch alles nach einer
    Deckschicht. Volumen von Hand ausrechnen und prüfen.

**Fertig, wenn:** mit einer einzigen Skizze drei Extrusionen mit unterschiedlichen Flächen und Tiefen entstehen,
ohne die Skizze zu verlassen; unter der Maus wird der Bereich hell; schon benutzte Bereiche sind erkennbar.

---

## F. Baugruppe aus einer Skizze (der eigentliche Zweck)

**Wozu:** Felix skizziert in Draftpad eine Baugruppe (meist eine Schnittzeichnung). Wenn er etwas nachweisen
will, schiebt er die Skizze nach Projekt-FEM, macht daraus „quick and dirty“ Körper, gibt Lasten an und rechnet.
Es entstehen **mehrere Körper** (Baugruppe); **jedes Teil ist ein zusammenhängender Körper**. Hat die Zeichnung
eine Rotationsachse, sind die Teile oft rotationssymmetrisch (→ Drehen), aber nicht immer (→ Extrudieren).

**Ist:** Mit „Schraffierte Flächen als Material“ werden alle Schraffuren auf einmal extrudiert/gedreht – die
Teile hängen dann zusammen oder zerfallen zufällig (Ventil-Beispiel: 4 lose Körper, Wellen-Beispiel: 3).

**Beobachtung an Felix' Zeichnungen:** Ein Teil besteht aus mehreren Schraffur-Elementen mit **gleichem Muster
und gleichem Abstand** (z. B. `diag`/Abstand 5 = ein Teil, `diag2`/Abstand 2 = ein anderes) – genau wie in der
Norm: gleiches Teil gleiche Schraffur, Nachbarteil andere Richtung/Abstand. Daraus lassen sich Teile vorschlagen.

**To-do:**

1. **Schraffur-Gruppen merken** (`draftpad.js`, `fillsOf`/`importDraftpad`): statt `sketch.fills = [loops…]`
   speichern `sketch.fills = [{ loops, group }]` mit `group = "<ebene>|<pattern>|<angle>|<spacing>|<farbe>"`.
   Alte Form (nur `loops`-Listen) beim Laden weiter annehmen. Kern (`in_fills`) und `kernelSketch` anpassen:
   an den Kern gehen nur die `loops` der gewünschten Gruppe (neues Feld im Feature, siehe 3).
2. **Teile vorschlagen:** nach dem Import (und über einen Knopf „Teile aus Schraffuren …“ an der Skizze im
   Verlauf) ein Dialog „Erkannte Teile“: je Schraffur-Gruppe eine Zeile mit
   - Häkchen (dabei / nicht),
   - Name (Vorschlag „Teil 1“, „Teil 2“ …; frei änderbar – der Name wird der Körpername),
   - Art: **Drehen** um die Achse (Vorschlag, wenn die Skizze eine Achse hat **und** die Gruppe Flächen auf
     beiden Seiten der Achse hat oder an die Achse grenzt) oder **Extrudieren** (Tiefe, symmetrisch zur
     Skizzenebene als Vorschlag),
   - Vorschau: beim Überfahren der Zeile die Flächen der Gruppe im Bild hervorheben.
   „Anlegen“ erzeugt je Zeile **ein Feature** (Extrudieren/Drehen) mit `mode: 'new'`, `fillGroup: <group>`,
   `name` = Teilname. Alles in einem Rückgängig-Schritt.
3. **Feature-Felder:** `extrude`/`revolve` bekommen `fillGroup` (Auswahl = alle Bereiche in den Schraffuren
   dieser Gruppe; hat Vorrang vor `useFills`, wird von `regions` übersteuert, sobald man im Bild klickt) und
   `bodyName`. `kernelFeature` gibt `fills: <loops der Gruppe>` und `name` mit; im Kern `sketch_faces` so
   erweitern, dass die Schraffurflächen aus dem **Feature** kommen können (nicht nur aus der Skizze).
4. **Ein Feature = ein Körper:** bei `mode: 'new'` verschmilzt `combine` die Werkzeugkörper eines Features
   schon; prüfen, dass Flächen, die sich nur an einer Kante berühren, nicht als zwei lose Körper enden – wenn
   doch, Warnung „Teil besteht aus n losen Stücken“ (kein Fehler).
5. **Überschneidungen zwischen Teilen** (quick and dirty heißt: Skizzen sind nicht exakt): nach jedem neuen
   Körper prüfen, ob er einen vorhandenen durchdringt (`occ.intersect` auf Kopien, Volumen > 1e-6 · kleineres
   Volumen). Wenn ja: Warnung am Feature und Option im Dialog „Überschneidung vom neuen Teil abziehen“
   (Standard an) – sonst vernetzt Gmsh die Baugruppe nicht sauber bzw. der Kontakt wird falsch.
6. **Körpernamen bis in die Rechnung:** `gmsh.model.setEntityName` landet **nicht** in der STEP-Datei
   (geprüft). Die von Gmsh geschriebene STEP enthält aber je Körper einen Eintrag
   `PRODUCT('Open CASCADE STEP translator 7.8 1.<k>', …)` in Körperreihenfolge. Vorgehen: der Kern merkt sich
   je Körper den Namen (über den Schwerpunkt des Werkzeugkörpers beim Anlegen → nach jedem Feature neu
   zuordnen: Körper, der den Punkt enthält), schreibt die STEP und ersetzt danach im Text die Namen der
   `PRODUCT`-Einträge `…1.<k>` durch die Körpernamen (Sonderzeichen `'` und `\` entfernen). Prüfen mit dem
   vorhandenen Weg: `fem_core::gmsh` liest Namen über die `.xao`-Datei (`solid_names`), Test
   `Grundplatte/Block/Zapfen` in `gmsh.rs` als Vorlage. Außerdem `result.bodies_info = [{ name, volume, center }]`
   zurückgeben und im Verlauf unter „Rechnen“ als Liste zeigen.
   Achtung: Körper mit Namen wie „Schraube …/Mutter …“ erkennt Projekt-FEM als Verbindungselemente
   (`fastener.rs`) – das ist erwünscht, wenn Felix ein Teil so nennt.
7. **In der Rechnung:** mehrere Körper gibt es schon (Reiter Modell: Werkstoff je Körper, Körper ausblenden,
   Berührflächen verklebt oder mit Kontakt/Reibung, Schrauben). Nach „In die Rechnung übernehmen“ einen Hinweis
   zeigen: „n Körper, m Berührflächen – unter Verbindungen festlegen, ob verklebt oder Kontakt“. Nichts Neues
   bauen, nur prüfen, dass die Baugruppe aus der Konstruktion dort sauber ankommt (Namen, `touching`).
8. **Drehteile, die nicht voll umlaufen** (Nut, Passfeder, Schlüsselfläche) und Teile, die in Wahrheit Quader
   sind: bleibt Handarbeit über Paket C (Bereiche anklicken, Extrudieren mit Tiefe, „Weg“). Im Dialog aus 2.
   deshalb je Zeile die Art umschaltbar lassen.
9. **Wälzlager, Schrauben, Normteile** in der Zeichnung sind meist nicht schraffiert → werden nicht vorgeschlagen.
   Im Dialog ein Satz dazu („nicht schraffierte Flächen: im Bild anklicken und mit Extrudieren/Drehen selbst
   anlegen“). Später: Lager als Ersatz-Verbindung (steife Kopplung zwischen Innen- und Außenring).

**Test (`cad.rs`):** Skizze mit zwei Schraffur-Gruppen neben einer Achse (zwei Rechtecke, die sich an einer
Kante berühren) → zwei Features `revolve`, `mode: new` → 2 Körper, Volumen je Ring von Hand prüfen, Namen in
der STEP wiederfinden (`mesh_step` + `body_names`).

**Fertig, wenn:** Wellen-Zeichnung importieren → Dialog schlägt die Teile vor → „Anlegen“ → benannte Drehkörper,
die sich berühren, aber nicht durchdringen → „In die Rechnung übernehmen“ → im Modell erscheinen die Körper mit
Namen und Berührflächen → Lager, Last, Rechnen läuft durch.

---

## D. Verbindung zu Draftpad (Server statt Datei)

### D.0 Wie Draftpad arbeitet (geprüft im Repo `Miro4you/Draftpad`, `server/server.mjs`, `src/storage/*.ts`)

- Kleiner Node-Server (`npm start`, Port 8080, z. B. Raspberry Pi), Zeichnungen als JSON in `data/`.
- CORS ist offen (`Access-Control-Allow-Origin: *`). Optionales Passwort `TOKEN`:
  Kopfzeile `Authorization: Bearer <TOKEN>` (beim Live-Strom als `?token=` in der Adresse).
- Schnittstelle:
  - `GET /api/health` → `{ ok, app: "skizzen-cad", auth: true|false }`
  - `GET /api/drawings` → `[{ id, name, updated (ISO-Zeit), size, thumb (data:image/…, bis 200 kB) }]`, neueste zuerst
  - `GET /api/drawings/<id>` → die Zeichnung (`format: "skizzen-cad"`, wie die `.draftpad.json`-Datei)
  - `PUT /api/drawings/<id>` `{ name, doc, thumb }`, `DELETE /api/drawings/<id>`
  - Live: `GET /api/live/<id>/events?client=<x>&token=<t>` (Server-Sent Events: `snapshot` mit ganzer Zeichnung,
    dann `ops` = `put`/`del`/`layers`/`scale`), `POST /api/live/<id>/ops`
- Zeichnung: Millimeter, y nach unten. Elemente `line {a,b,axis?}`, `circle {c,r}`, `arc {c,r,start,sweep}`,
  `stroke` (Freihand), `hatch {loops}`, `dim {type: lin|dia|rad|ang, p1,p2,p3,dir,off,text}`, `text`, außerdem
  Mechanik-Symbole. `style.lineType`: `solid|dashed|dashdot|dashdotdot|freehand`. Ebenen `layers[{id,name,visible}]`.
  `scale` ist nur der Zeichnungsmaßstab fürs Papier – die Geometrie ist immer in echten Millimetern, **nicht
  umrechnen**.
- Draftpad lässt sich auch einbetten (`src/embed.ts`, `mountDraftpad`), braucht aber eine eigene Seite derselben
  Herkunft. Das ist für später (D.6), nicht für den ersten Schritt.

### D.1 Rechenkern-Seite: `app/src-tauri/src/draftpad.rs` (neu)

Vorlage ist `onshape.rs` (ebenfalls `ureq`, Schlüssel in einer Datei im Einstellungsordner, nie an die Oberfläche
zurückgeben). Über den Rechenkern statt direkt aus dem Browser, damit (a) das Passwort nicht im Browser liegt,
(b) es auch dann geht, wenn Projekt-FEM per https und Draftpad per http läuft, (c) die Desktop-App keine
CORS-/CSP-Sonderfälle braucht.

- Einstellung `draftpad.json` im Einstellungsordner (`config_dir()` wie bei Onshape): `{ url, token }`.
  Heute läuft Draftpad auf einem Raspberry Pi **ohne Passwort** (http, Heimnetz); später soll es auf einen Server mit
  **eigener Domain** (https, dann mit Passwort). Beides muss gehen: `http://192.168.x.y:8080` und `https://…`.
  `url` ohne Schrägstrich am Ende; ohne `http://` davor → `http://` ergänzen (wie Draftpads `cloud.ts`).
- Funktionen: `status()` → `{ configured, reachable, auth_ok, error? }` (ruft `/api/health`, bei
  `auth` zusätzlich `/api/drawings` zum Prüfen des Passworts); `set_config(url, token)`;
  `list(with_thumbs: bool)` → Liste; `get(id)` → Zeichnung als `serde_json::Value` (prüfen:
  `format == "skizzen-cad"`); `meta(id)` → `{ updated, name }`.
- `id` nur nach Draftpads Muster zulassen (`^[a-z0-9][a-z0-9-]{0,63}$`, wie `ID` in `server.mjs`), sonst Fehler – die `id` geht in eine
  Adresse.
- Zeitlimit 15 s, verständliche Meldungen („Draftpad-Server nicht erreichbar“, „Passwort fehlt oder ist falsch“,
  „Kein Draftpad-Server“).
- Tauri-Befehle + Server-Routen wie bei Onshape: `draftpad_status`, `draftpad_config`, `draftpad_list`,
  `draftpad_get`, `draftpad_meta` (in `lib.rs` `invoke_handler`, in `server.rs` `.route("/draftpad/…")`).
  In `api.js` je eine Funktion (`isDesktop ? invoke : http`).
- Öffentlicher Servermodus (`PROJEKT_FEM_OEFFENTLICH=1`): Adresse nur aus der gespeicherten Einstellung nehmen,
  nie aus dem Aufruf (sonst könnte man den Server beliebige Adressen abrufen lassen).
- Test: kleiner Schein-Server im Rust-Test (wie beim Onshape-Mock, falls vorhanden) oder Test gegen einen lokal
  gestarteten Draftpad-Server (`node /home/user/Draftpad/server/server.mjs` mit `PORT=8099 DATA_DIR=<temp>`).

### D.2 Kleine Ergänzungen in Draftpad (Repo `Miro4you/Draftpad`, eigener Commit dort)

Nur nötig für Komfort; D.1/D.3 funktionieren auch ohne (dann mit den Ausweichwegen in Klammern).

1. `GET /api/drawings?thumbs=0` → Liste ohne Vorschaubilder, und `GET /api/drawings/<id>/meta` →
   `{ id, name, updated, size }`. Für die Abfrage „hat sich die Zeichnung geändert?“ (Ausweichweg: ganze Liste
   holen – mit Vorschaubildern bis 200 kB je Zeichnung, also nur selten abfragen).
2. Adresse zum direkten Öffnen: `http://<draftpad>/?open=<id>` öffnet die Zeichnung aus der Online-Ablage
   (in `src/main.ts`/`src/app.ts` beim Start auswerten; die Lade-Funktion steht in `src/ui/cloud-dialog.ts`,
   `loadCloudDrawing(e.id)`). Für den Knopf „In Draftpad bearbeiten“ (Ausweichweg: nur die Draftpad-Startseite
   öffnen).
3. README von Draftpad um beides ergänzen.

### D.3 Oberfläche in Projekt-FEM

1. **Einstellungen › CAD-Verbindungen** (`app/src/ui/Settings.jsx`, `CadSettings`): Karte „Draftpad“ mit
   Adresse (z. B. `192.168.1.20:8080`), Passwort (optional, `type="password"`), Knopf „Verbinden/Prüfen“,
   Statuszeile. Passwort wird nie zurück angezeigt (nur „gespeichert“).
2. **Draftpad-Bibliothek** `app/src/ui/DraftpadLibrary.jsx` nach dem Muster von `OnshapeLibrary.jsx`:
   Kacheln mit Vorschaubild (`thumb`), Name, „geändert vor …“, Suchfeld. Ohne Verbindung: Hinweis + Knopf zu
   den Einstellungen + „Datei wählen …“ (bisheriger Weg bleibt).
3. Der Knopf **„Draftpad“** in der Konstruktion (heute Datei-Dialog) öffnet die Bibliothek; darin unten
   „Datei vom Rechner …“. Startseite: Kachel „Aus Draftpad“ (neues Teil + Bibliothek).
4. Nach der Auswahl wie bisher: Ebene wählen → `DraftpadPanel` (Ebenen, Lücken, Optionen) → Übernehmen.
   Im `DraftpadPanel` neu: **Vorschau** der gewählten Ebenen schon vor dem Übernehmen (als Hintergrund-Skizze
   aus B zeichnen) und die Optionen aus D.4/D.5.

### D.4 Verknüpfte Skizze („Grundskizze“) und Aktualisieren

Ziel: Zeichnung in Draftpad ändern → in Projekt-FEM „Aktualisieren“ → Körper bauen sich neu.

1. Skizzen-Feature bekommt `source`:
   `{ kind: 'draftpad', id, name, updated, layers: [ebenen-ids], opts: { tol, center|origin, fills }, mode: 'linked' | 'copy' }`.
   Bei Datei-Import `id: null` (kein Aktualisieren möglich, nur „Datei neu wählen“).
2. **Zwei Arten**, im `DraftpadPanel` wählbar:
   - **Verknüpft (Standard – passt zu Felix' Ablauf „skizzieren, rüberschieben, schnell extrudieren“):** Geometrie ist fest (alle Punkte `fix`, Kreise `fix`), es werden
     **keine** Bedingungen erzeugt, in Projekt-FEM wird an der Skizze nichts gezeichnet/gezogen
     (Skizzen-Dialog zeigt statt der Werkzeuge: Quelle, Ebenen, „Aktualisieren“, „In Draftpad bearbeiten“,
     „Verknüpfung lösen“). Vorteil: kein Löser nötig, schnell, eindeutig – Draftpad ist die Wahrheit.
   - **Kopie zum Weiterbearbeiten:** wie heute (Bedingungen erkennen, bemaßbar). Kein Aktualisieren.
     „Verknüpfung lösen“ macht aus einer verknüpften Skizze genau das (einmal `importDraftpad` mit
     `fixed: false` auf die gespeicherte Zeichnung bzw. Bedingungen nachträglich erkennen).
3. **Stabile Kennungen** in `importDraftpad` (wichtig, damit Drehachse und spätere Bezüge ein Aktualisieren
   überleben): Elemente bekommen `id: 'd_' + <draftpad-id>` statt der laufenden Nummer; Punkte
   `id: 'd_' + <draftpad-id> + '_a' | '_b' | '_c'` des **ersten** Elements, das den Punkt anlegt
   (zusammengeführte Punkte behalten diese Kennung). `addEnt`/`addPoint` in `sketch.js` um einen optionalen
   Parameter `id` erweitern. Doppelte Elemente (Skizze/Reinzeichnung übereinander): die Kennung des behaltenen
   Elements.
4. **Aktualisieren** (`refreshDraftpad(feature)` in `CadStudio`): Zeichnung über `api.draftpadGet(id)` holen,
   `importDraftpad` in eine **leere** Skizze mit derselben Ebene und denselben Optionen, Ergebnis ersetzt
   `feature.sketch`, `source.updated` neu setzen. Danach prüfen und melden:
   - Drehachse (`revolve.axis`) noch vorhanden? Sonst Feature als fehlerhaft markieren („Achse neu wählen“).
   - Bereichspunkte: der Kern meldet Features, deren Punkt keinen Bereich mehr trifft.
   - Ebenen, die es nicht mehr gibt: Hinweis, Rest übernehmen.
   Das Ganze ist **ein** Schritt im Verlauf-Rückgängig (`commitFeatures`).
5. **Änderung bemerken:** solange der Reiter Konstruktion offen ist und es verknüpfte Skizzen gibt, alle 10 s
   (und beim Zurückkehren ins Fenster, `visibilitychange`/`focus`) `draftpadMeta(id)` abfragen. Ist `updated`
   neuer als `source.updated`: im Verlauf an der Skizze ein Punkt/Abzeichen „geändert“ und oben ein Hinweis mit
   Knopf „Aktualisieren“. Zusätzlich Schalter „automatisch aktualisieren“ (je Skizze, Standard aus).
   Kein Dauer-Strom (SSE) im ersten Schritt – Abfragen reicht und läuft über den Rechenkern.
6. **Lage der Zeichnung in der Skizzenebene** (ersetzt die eine Option „Mitte auf den Ursprung“):
   - „Mitte der Zeichnung auf den Ursprung“ (wie jetzt),
   - „Achse auf den Ursprung“: gibt es eine Symmetrieachse (`axis: true`), dann Ursprung = Mitte der längsten
     Achse und die Achse liegt auf der v- bzw. u-Achse der Skizze (Drehteil liegt dann auf einer Hauptachse),
   - „wie in Draftpad“ (Draftpad-Nullpunkt = Ursprung),
   - Drehen um 90°/180°/270° und Spiegeln (für „Zeichnung steht hochkant“).
   Die gewählte Lage in `source.opts` speichern, damit Aktualisieren dieselbe Lage nimmt.
   Später: „Punkt als Ursprung wählen“ (im Bild einen Punkt der Skizze anklicken).
7. **„In Draftpad bearbeiten“:** öffnet `http://<draftpad>/?open=<id>` in neuem Fenster/Tab (Browser: `window.open`; in der
   Desktop-App gibt es noch kein Plugin zum Öffnen von Adressen – entweder `tauri-plugin-opener` ergänzen oder die
   Adresse zum Kopieren anzeigen).
   Die Adresse liefert der Rechenkern (`draftpad_status` gibt die öffentliche Adresse zurück, nicht das Passwort).
8. Projektdatei: `source` wird mitgespeichert; beim Laden **nicht** automatisch nachladen (die gespeicherte
   Skizze gilt), nur das „geändert“-Abzeichen zeigen.

### D.5 Was aus der Zeichnung übernommen wird (Erweiterungen an `draftpad.js`)

1. **Schraffuren als Material** gibt es. Ergänzen: nur Schraffuren der **gewählten Ebenen** oder aller Ebenen
   wählbar (heute: alle Ebenen, `fillsOf(doc, null)`), weil Felix eine eigene Ebene „Schraffur“ hat, die
   ausgeblendet sein kann.
2. **Verdeckte Kanten** (`dashed`) werden Hilfslinien – so lassen. Mittellinien (`dashdot`), Achsen (`axis`) auch.
3. **Kreise mit Achsenkreuz** (`mark: true`) → zusätzlich ein Skizzen-**Punkt** in der Mitte (dann kann man mit
   „Bohrung“ direkt an diesen Stellen bohren). Als Option „Kreismitten als Bohrpunkte“.
4. **Maße aus Draftpad** (`kind: 'dim'`) im ersten Schritt nicht übernehmen (bei verknüpfter Skizze ist die
   Geometrie ohnehin fest). Später bei „Kopie“: `lin` → `dist`/`dx`/`dy`, `dia`/`rad` → `dia`/`rad`,
   Wert = gemessen (nicht `text`).
5. **Freihand** (`stroke`) und Texte bleiben weg; in der Vorschau des Import-Dialogs blass mitzeichnen, damit
   man die Zeichnung wiedererkennt.
6. Lücken: Standard 0,3 mm bleibt. In Felix' Beispielen gibt es Lücken bis 0,5 mm; im Dialog nach dem Import
   anzeigen, **wo** noch offene Enden sind (rote Punkte an Endpunkten, die nur ein Element haben), mit Zähler.
   Dafür in `importDraftpad` die Liste `open: [[x,y],…]` zurückgeben.

### D.7 „Rüberschieben“ aus Draftpad (ein Klick)

Felix' Ablauf beginnt in Draftpad. Deshalb zusätzlich zur Bibliothek:

1. **Projekt-FEM öffnet eine Zeichnung über die Adresse:** `http://<projekt-fem>/#draftpad=<id>` (bzw. mit
   Schlüssel `#k=…&draftpad=<id>`; in `api.js` wird `#k=` schon ausgewertet – dort erweitern und den Wert an
   `App` geben). Beim Start: neues Teil anlegen (`newCadPart`), Zeichnung über `api.draftpadGet(id)` holen und
   wie beim Datei-Import als `incoming` an `CadStudio` geben (`setCadDraftpad`), mit `source.id` (verknüpft).
2. **Knopf in Draftpad** (Menü): „In Projekt-FEM nachweisen“ – speichert die Zeichnung in der Online-Ablage
   (falls noch nicht) und öffnet die Adresse aus 1. Die Projekt-FEM-Adresse ist eine Draftpad-Einstellung
   (neben der Online-Ablage, `src/storage/cloud.ts`/`src/ui/cloud-dialog.ts`). Kompakt-/Einbettmodus: Knopf weglassen.
3. Desktop-App von Projekt-FEM: gleicher Weg über die Heimnetz-Freigabe (die Adresse zeigt auf den Rechner,
   auf dem Projekt-FEM als Server läuft – bei Felix der NAS).

### D.6 Später (nicht jetzt)

- Draftpad im Fenster einbetten (`mountDraftpad`, braucht den Draftpad-Build unter derselben Herkunft – z. B.
  vom Projekt-FEM-Server mit ausliefern) und Änderungen live in die Skizze übernehmen.
- Live-Strom (SSE) statt Abfragen.
- Mehrere Ansichten einer Zeichnung (Vorder-/Seitenansicht) auf verschiedene Ebenen legen.
- Ergebnisbild aus Projekt-FEM zurück in die Draftpad-Zeichnung legen.

**Fertig (D gesamt), wenn:** Adresse in den Einstellungen eingetragen → Bibliothek zeigt die Zeichnungen mit
Vorschaubild → Zeichnung wählen, Ebene wählen, übernehmen → extrudieren → in Draftpad eine Linie verschieben →
in Projekt-FEM erscheint „geändert“, „Aktualisieren“ baut den Körper mit der neuen Form.

---

## E. Aufräumen und Lücken aus dem letzten Test

1. **Noch nicht im Browser geprüft** (nur Kern-Tests bzw. gar nicht): Fase, Spiegeln, Fläche verschieben,
   Flächen entfernen, ein fertig gebautes Muster, Parameterstudie über Konstruktionsmaße, erneutes Übernehmen
   mit schon gesetzten Lagern/Lasten, „In die Rechnung übernehmen“ + Rechnen mit einem Draftpad-Teil.
   Für jedes einen Durchlauf im Browser und einen Eintrag im Testprotokoll (18d/18e) abhaken bzw. Fehler beheben.
2. `App.jsx`: Reste des alten Geometrie-Reiters entfernen – Zustände `geoOps`, `geoApplied`, `geoInfo`,
   `geoWarnings`, `geoPick`, Zweig `drawing.type === 'geo'`, `view === 'geometry'`, in der Studie die
   `geo:`-Parameter und `api.modifyGeometry`; danach `geoops.js` bis auf `remapSurfaces` (wird gebraucht) und
   im Rechenkern `modify_geometry`/`geometry.rs`/`geometry.py` prüfen: `find_python` aus `geometry.rs` wird von
   `cad.rs` benutzt → nach `cad.rs` umziehen, Rest löschen. Alte Projekte laufen über `featuresFromGeoOps`.
3. Mehrkörper-Ergebnis verständlich machen: nach dem Aufbau „4 Körper“ mit Hinweis, wenn sie sich nicht
   berühren („lose Körper – für die Rechnung zusammenführen oder einzeln lagern“).
4. Geschwindigkeit: jeder Neuaufbau startet Python neu (~0,1–1 s). Wenn es stört: dauerhaften Python-Prozess
   mit Aufträgen über stdin/stdout (in `cad.rs`), Zwischenstände gibt es schon (`zwischenstand/*.brep`).

---

## Stolpersteine (aus der bisherigen Arbeit – unbedingt beachten)

- **Gmsh/OpenCASCADE:** `occ.affineTransform`, `occ.mirror` und `occ.dilate` machen aus Ebenen und Zylindern
  Freiformflächen. Deshalb legt `place()` Skizzen nur mit `rotate` + `translate` in den Raum, und „Spiegeln“
  einzelner Features baut die Werkzeuge aus gespiegelten **Daten** neu (`mirrored_feature`). Nicht „vereinfachen“.
- **Darstellung:** `tessellate()` lädt den Körper über eine STEP-Datei neu, weil frisch gedrehte Flächen sonst
  „Impossible to mesh periodic surface“ werfen (hing 30 s). Flächen-/Kantenarten werden **geometrisch** erkannt
  (`fit_cylinder`, `classify_curve`), nicht über `getType` – so bleiben auch gespiegelte Körper anklickbar.
- **Leere Randschleifen:** `loop_polylines` kann leere Schleifen liefern; sie werden gefiltert
  (`len(chain) >= 3`), die Oberfläche filtert zusätzlich.
- **Bezüge sind geometrisch:** Kanten über Mittelpunkt + Richtung, Flächen über Schwerpunkt, Bereiche über einen
  Punkt. Ändert sich die Geometrie davor stark, meldet das Feature „gibt es nicht mehr“. Keine Nummern speichern.
- **React:** In Maus-Ereignissen von `CadView` nie Props direkt benutzen, sondern `cb.current` (die Ereignisse
  werden nur einmal angemeldet; ein veraltetes `tess` hat schon einmal einen Absturz verursacht).
- **Formatierung:** kein `cargo fmt` über das ganze Repo (erzeugt riesige Änderungen). Rust-Zeilen bis 140 Zeichen.
- **Sicherheit:** Passwörter/Schlüssel nie in den Chat, nie ins Repo, nie in Protokollausgaben; Draftpad-Passwort
  wie die Onshape-Schlüssel nur im Einstellungsordner des Rechenkerns.
- **Docker/NAS:** Jede Änderung außer `*.md`/`docs` baut über `.github/workflows/docker.yml` ein neues Image
  `ghcr.io/miro4you/fem:entwicklung`; der NAS holt es per Cronjob. Im Container gibt es das Gmsh-Python-Modul.

## Bauen und Testen (Befehle)

```bash
# Kern-Tests (brauchen das Gmsh-Python-Modul; in der Cloud-Sitzung liegt es hier):
export FEM_GMSH_PYTHON=/root/.local/share/uv/tools/gmsh/bin/python
cargo test --release -p fem-core cad::

# Oberfläche + Server bauen und starten (Browser: http://localhost:8790/#k=<Schlüssel aus der Ausgabe>):
cd app && npx vite build && cd .. && touch app/src-tauri/src/server.rs && cargo build --release -p projekt-fem-app
XDG_CONFIG_HOME=<leerer Ordner> ./target/release/projekt-fem-app --server

# Löser und Draftpad-Import ohne Browser prüfen (node, ES-Module):
node -e "import('/home/user/fem/app/src/cad/draftpad.js').then(m => console.log(Object.keys(m)))"

# Draftpad-Server zum Testen von D (anderes Repo, nur Node nötig):
cd /home/user/Draftpad && npm install && npm run build && PORT=8099 DATA_DIR=/tmp/dp-daten node server/server.mjs
#   Zeichnung anlegen:  curl -X PUT localhost:8099/api/drawings/test-1 -H 'Content-Type: application/json' \
#                         -d "{\"name\":\"Test\",\"doc\":$(cat zeichnung.draftpad.json)}"
```

Browser-Tests mit Playwright (ist vorinstalliert): Chromium mit
`args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']` starten, Seite öffnen, über
`.cad-tool` (Werkzeugknöpfe), `.cad-dialog` (Feature-Dialog), `.cad-side` (Verlauf), `.cad-status`
(Freiheitsgrade), `.cad-hint` (Meldung), `.cad-dim` (Maße) bedienen und Screenshots ansehen.
Flächen/Kanten trifft man, indem man die Maus rastert, bis `.cad-view .viewport-canvas` den Zeiger `pointer` hat.
Beispielzeichnungen von Felix: `examples/draftpad/*.draftpad.json` (Wellenschnitt mit Lagern, Ventil-Kreuzstück).

Nach jedem Paket: `README.md` (Abschnitt „Konstruktion“), `TESTPROTOKOLL.md` (18d/18e, neue Zeilen),
`NAECHSTE_SCHRITTE.md` aktualisieren, PDF des Testprotokolls neu erzeugen, committen, pushen.

## Entscheidungen von Felix (12.11.2026)

- **Draftpad-Server:** läuft im Moment auf dem Raspberry Pi, **ohne Passwort**. Soll später auf einen Server
  (eigener oder mit auf den MathPad-Server), auf jeden Fall mit **eigener Domain**. → Adresse einstellbar,
  http und https, Passwort optional (D.1).
- **Zweck:** erst in Draftpad skizzieren; wenn etwas nachgewiesen werden soll, die Skizze nach Projekt-FEM
  schieben, **anhand der Skizze schnell extrudieren (quick and dirty)**, Lasten angeben, rechnen. → Paket F und
  D.7; verknüpfte, feste Skizze als Standard (D.4).
- **Sichtbarkeit:** Skizzen bleiben nach der ersten Verwendung sichtbar und lassen sich **einzeln ausschalten**
  (Paket B).
- **Körper:** meistens sind es **Baugruppen** – man muss aus einer Skizze **mehrere Körper** machen können, jedes
  Teil ein zusammenhängender Körper. Mit Rotationsachse häufig Drehteile (Drehen), aber nicht zwingend – das
  entscheidet man je Teil (Paket F).

- **Netz:** Der Pi (Draftpad) ist vom NAS (Projekt-FEM) aus erreichbar, beide im selben Heimnetz.
- **Berührflächen:** Teile aus der Zeichnung standardmäßig **verklebt**; im Reiter Modell je Berührfläche auf
  Kontakt umstellbar (gibt es schon – nur die Vorgabe prüfen).
- **Beispiele:** Felix' Zeichnungen liegen in `examples/draftpad/` (`wellenschnitt.draftpad.json`: Welle mit
  Lagern, Schrauben, Achse – 179 Linien, 22 Schraffuren in 4 Gruppen; `ventil-kreuzstueck.draftpad.json`:
  Kreuzstück mit Riegel – 67 Linien, 17 Schraffuren, Freihand-Notizen auf eigener Ebene). Für Tests benutzen.
