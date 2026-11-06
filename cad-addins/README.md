# CAD-Schnittstelle: Knöpfe im CAD

Programme: **SolidCraft** (live), **Onshape**, **Autodesk Fusion**, **SolidWorks**, **Siemens NX**, **Solid Edge** – und jedes
andere CAD über STEP.

Zwei Knöpfe direkt im CAD-Programm:

- **In Projekt-FEM rechnen** – schickt das aktive Teil als STEP an Projekt-FEM.
  - Neues Teil: Projekt-FEM öffnet es, du legst Lager und Lasten fest und rechnest.
  - **Gleiches Teil, neue Version** (du hast im CAD etwas geändert): Projekt-FEM überträgt Lager und Lasten auf die
    neue Geometrie, rechnet automatisch neu und zeigt den Vergleich zur vorigen Version (σv, Verformung, Sicherheit,
    Volumen). Lässt sich eine Lager-/Lastfläche nicht wiederfinden, rechnet es nicht und bittet ums Prüfen.
    Abschaltbar unter „Rechnen“: „Neue Version aus dem CAD automatisch neu rechnen“.
- **Ergebnis holen** – trägt die Ergebniswerte als Eigenschaften ins Teil ein:

  | Eigenschaft | Bedeutung |
  |---|---|
  | `FEM_Sicherheit` | Sicherheit gegen Fließen (Re/Rp0,2) |
  | `FEM_Sicherheit_Bruch` | Sicherheit gegen Bruch (Rm) |
  | `FEM_SigmaV_MPa` | max. Vergleichsspannung |
  | `FEM_Verformung_mm` | max. Verschiebung |
  | `FEM_Masse_g` | Masse (mit Infill, falls 3D-Druck) |
  | `FEM_Nachweis` | „erfüllt“ / „nicht erfüllt“ |
  | `FEM_Massgeblich` | 3D-Druck: maßgebliche Versagensart |
  | `FEM_Werkstoff`, `FEM_Lager`, `FEM_Datum` | Werkstoff, Anzahl Lager, Zeitpunkt der Rechnung |

Das Teil wird am **Namen** wiedererkannt (Dateiname bzw. Dokumentname; bei Fusion ohne „v7“).

## Einstellungen

**CAD und Projekt-FEM auf demselben Rechner:** nichts einstellen. Die Desktop-App nimmt Teile auf
`http://127.0.0.1:8791` an (nur von diesem Rechner).

**CAD auf einem anderen Rechner** (z. B. Arbeits-PC, Projekt-FEM rechnet auf dem starken PC):
Heimnetz-Freigabe einschalten, in Projekt-FEM **Einstellungen › CAD-Verbindungen** öffnen und den angezeigten Text in eine Datei
`projekt-fem-cad.txt` im Benutzerordner des CAD-Rechners kopieren:

```
adresse = http://192.168.178.42:8790/api/cad
schluessel = abcd…
```

(Windows: `C:\Users\<Name>\projekt-fem-cad.txt`, Mac: `/Users/<Name>/projekt-fem-cad.txt`.)
Alle Add-ins lesen dieselbe Datei.

## SolidCraft – live

[SolidCraft](https://github.com/tangency-labs/solidcraft) (quelloffenes CAD in Rust) hat einen Steuerkanal, über den
Projekt-FEM direkt mit dem offenen Design arbeitet – ohne Add-in und ohne Export von Hand:

1. SolidCraft auf dem Rechner starten, auf dem Projekt-FEM rechnet. (Der Steuerkanal ist ab Werk an:
   SolidCraft-Einstellungen › Assistent › „Let AI agents connect (control channel / MCP)“.)
2. In Projekt-FEM **Einstellungen › CAD-Verbindungen** → Abschnitt **SolidCraft** → **„Live mitlaufen“** anhaken.
   Projekt-FEM übernimmt das offene Design sofort.
3. Lager und Lasten festlegen, rechnen.
4. In SolidCraft weiterkonstruieren: Nach jeder Änderung (Maß, Feature, Parameter) holt Projekt-FEM nach gut einer
   Sekunde Ruhe die neue Geometrie, überträgt Lager/Lasten/Schweißnähte, rechnet neu und zeigt den Vergleich.
5. **„Ergebnis → SolidCraft“** trägt die Werte als **Parameter** `FEM_Sicherheit`, `FEM_SigmaV_MPa`,
   `FEM_Verformung_mm` (mit Einheit mm), `FEM_Masse_g`, `FEM_Nachweis` … ins Design ein (Parameter-Fenster in SolidCraft,
   in Ausdrücken verwendbar) und zusätzlich alles als Design-Eigenschaft `io.github.miro4you.projekt-fem`.
   Mit „Ergebnis nach jeder Rechnung in SolidCraft eintragen“ geschieht das automatisch (Achtung: jeder Eintrag ist
   in SolidCraft ein Rückgängig-Schritt).
6. **Parameterstudie über SolidCraft-Parameter:** Reiter **Studie** → Parameter „SolidCraft: Wanddicke“ (alle
   Parameter des Designs stehen zur Wahl) → Werte → Studie starten. SolidCraft baut die Geometrie je Wert neu auf,
   Projekt-FEM rechnet; danach wird der alte Wert wieder eingesetzt. Ergebnis als Kurve und CSV.

„Jetzt holen“ übernimmt das Design einmalig, ohne mitzulaufen. Der Teilname ist der Name des Designs. Ältere
SolidCraft-Versionen (z. B. 0.30) geben den Namen nicht heraus – dann heißt das Teil „SolidCraft-Design“, oder es
nimmt die **Teilenummer** bzw. das **Projekt** aus den Design-Eigenschaften (Datei › Eigenschaften), wenn dort etwas steht.

Grenze: SolidCraft muss auf demselben Rechner laufen wie der rechnende Teil von Projekt-FEM (der Steuerkanal ist nur
lokal erreichbar). Einen Knopf direkt in SolidCraft gibt es noch nicht – SolidCraft plant Plugins
(`docs/plugins.md` dort); sobald die laufen, kann „In Projekt-FEM rechnen“ auch in SolidCraft selbst sitzen.

## Onshape

Onshape läuft im Browser – statt Add-in gibt es die **Bibliothek** in Projekt-FEM und zwei **Lesezeichen** in der
Lesezeichenleiste.

1. API-Schlüssel anlegen: <https://dev-portal.onshape.com> → **API keys** → *Create new API key*, Rechte
   „Application can read your documents“ und (für „Ergebnis → Onshape“) „… write to your documents“.
2. In Projekt-FEM **Einstellungen › CAD-Verbindungen** (oder beim ersten Klick auf „Aus Onshape“) → Access Key und
   Secret Key eintragen → Speichern. Die Schlüssel bleiben auf dem
   rechnenden Rechner (`~/.config/projekt-fem/onshape.json`), sie gehen nicht an den Browser zurück.
3. Im selben Dialog die Lesezeichen **„→ Projekt-FEM“** und **„FEM-Ergebnis → Onshape“** in die Lesezeichenleiste
   ziehen.

**Bibliothek:** Startseite **„Aus Onshape“** bzw. Datei › Aus Onshape-Bibliothek: eigene Dokumente (zuletzt geändert
zuerst, mit Suche und Vorschaubild), Teilestudio wählen → **Holen**. Danach steht es unter „Zuletzt geöffnet“.
Ergebnis zurück: **Export › Ergebnis → Onshape**.

**Lesezeichen:** In Onshape das Teilestudio öffnen → Lesezeichen **„→ Projekt-FEM“** klicken. Ein kleines Fenster meldet
„an Projekt-FEM geschickt“, Projekt-FEM öffnet das Teil (Name: „Dokument - Teilestudio“). Nach einer Änderung in
Onshape einfach wieder klicken → neue Version wird gerechnet.
**„FEM-Ergebnis → Onshape“** schreibt `[FEM 6.11.2026: S = 1,21 (Bruch 1,86) · σv 193,7 MPa · u 0,195 mm · 106,5 g · …]`
in die **Beschreibung** der Teile (Teil anklicken → Eigenschaften). Vorhandener Text bleibt, nur der FEM-Eintrag
wird ersetzt. Geht nur im Arbeitsbereich, nicht in gespeicherten Versionen.

**Parameterstudie über Onshape-Variablen:** Im Teilestudio eine Variable anlegen (Feature „Variable“, z. B.
`#dicke = 5 mm`) und in Maßen verwenden. Das Teil mit dem Lesezeichen an Projekt-FEM schicken, Lager/Lasten festlegen,
rechnen. Dann links in der Werkzeugleiste **Studie** → Parameter **„Onshape: #dicke“** → Werte (z. B. `4; 6; 8`) → Studie starten.
Projekt-FEM setzt die Variable in Onshape auf jeden Wert, holt die Geometrie, überträgt Lager/Lasten/Nähte und rechnet;
zum Schluss steht wieder der alte Wert drin. Ergebnis als Kurve (Spannung, Verformung, Sicherheit, Masse) und CSV.
Jede Änderung erscheint in der Onshape-Versionsgeschichte. Variablen aus Variablen-Studios werden noch nicht angeboten,
nur die im Teilestudio selbst.

Falls der Browser das Lesezeichen blockiert: die Onshape-Adresse kopieren und in der Bibliothek unten bei
„oder Adresse einfügen“ → „Holen“.

Bei kostenlosen Onshape-Konten sind alle Dokumente öffentlich – dann ist auch der eingetragene FEM-Eintrag in der
Beschreibung für alle sichtbar.

Die Lesezeichen enthalten den Zugangsschlüssel – nicht weitergeben. Nach „Neuen Zugangsschlüssel erzeugen“ die
Lesezeichen neu anlegen.

## Autodesk Fusion (Windows und Mac) – `fusion360/ProjektFEM`

1. In Fusion: **Dienstprogramme → Add-Ins → Skripte und Add-Ins** (Umschalt+S) → Reiter **Add-Ins** → **+**
   (bzw. „Vorhandenes Add-In hinzufügen“) → Ordner `cad-addins/fusion360/ProjektFEM` auswählen.
2. Add-In markieren → **Ausführen**, Haken bei **„Beim Start ausführen“**.
3. Knöpfe: Reiter **VOLUMENKÖRPER** → Gruppe **Projekt-FEM**.

Geschickt wird die **aktive Komponente** (sonst das ganze Dokument). Hat sie mehrere Körper, fragt das Add-in nach
(Baugruppen kann Projekt-FEM noch nicht). „Ergebnis holen“ legt die Zahlen als **Benutzerparameter** an
(Ändern → Parameter, ohne Einheit – die Einheit steht im Namen) und alles zusätzlich als Attribute.

## SolidWorks – `solidworks/ProjektFEM.bas`

1. **Extras → Makro → Neu…** → als `ProjektFEM.swp` speichern (z. B. in `Dokumente\SolidWorks\Makros`).
   Der VBA-Editor geht auf.
2. Im VBA-Editor: **Datei → Datei importieren…** → `ProjektFEM.bas`. Das leere Modul `Module1` kann weg
   (Rechtsklick → Entfernen → Nein). Speichern, Editor schließen.
3. Knöpfe: **Extras → Anpassen → Befehle → Makro** → „Neue Makro-Schaltfläche“ in eine Symbolleiste ziehen →
   Makro `ProjektFEM.swp`, Methode **`InProjektFEMRechnen`**. Zweiter Knopf mit **`ErgebnisHolen`**.

„Ergebnis holen“ schreibt in **Datei → Eigenschaften → Benutzerdefiniert**; in Zeichnungen z. B. mit
`$PRP:"FEM_Sicherheit"` verwendbar. Zahlen stehen mit Komma als Text drin.

## Siemens NX – `nx/ProjektFEM_senden.py`, `nx/ProjektFEM_holen.py`

Python-Journale (NX Open, ab NX 12).

1. Ausprobieren: **Datei → Ausführen → Journal…** (Alt+F8) → `ProjektFEM_senden.py` → Ausführen.
2. Als Knopf: Rechtsklick aufs Menüband → **Anpassen** → Reiter **Befehle** → Kategorie **Neues Element** →
   **Neuer Benutzerbefehl** ins Menüband ziehen → Rechtsklick darauf → **Aktion bearbeiten** → Journal auswählen,
   Namen vergeben („In Projekt-FEM rechnen“). Dasselbe mit `ProjektFEM_holen.py` („Ergebnis holen“).

Geschickt wird das **angezeigte Teil** (in seinem gespeicherten oder aktuellen Zustand). „Ergebnis holen“ schreibt
Teile-Attribute (Datei → Eigenschaften → Attribute), Zahlen als Zahl, Texte als Text.

## Solid Edge – `solidedge/ProjektFEM_senden.vbs`, `solidedge/ProjektFEM_holen.vbs`

Solid Edge muss laufen, ein Teil (`.par`/`.psm`) aktiv sein. Dann `ProjektFEM_senden.vbs` per Doppelklick starten –
oder als Knopf: Schnellzugriffsleiste anpassen → Makros → Skript auswählen. Falls dein Solid Edge `.vbs` dort nicht
annimmt: Verknüpfung auf den Desktop oder in die Taskleiste legen.
„Ergebnis holen“ schreibt in die **Datei-Eigenschaften → Benutzerdefiniert**.

## Jedes andere CAD (AutoCAD, Inventor, Creo, FreeCAD …) – `allgemein/`

Teil im CAD als **STEP** speichern, dann:

- **Windows:** `Win+R` → `shell:sendto` → Verknüpfung zu `allgemein/an_projekt_fem.vbs` dort ablegen und
  „An Projekt-FEM“ nennen. Dann im Explorer: Rechtsklick auf die `.step` → **Senden an → An Projekt-FEM**.
- **Mac:** Automator → Neues Dokument → **Schnellaktion** → „Shell-Skript ausführen“ (Eingabe „als Argumente“),
  Inhalt `/Pfad/zu/an_projekt_fem.sh "$@"` → speichern als „An Projekt-FEM“. Dann im Finder: Rechtsklick →
  Schnellaktionen → An Projekt-FEM.
- **Linux/Terminal:** `cad-addins/allgemein/an_projekt_fem.sh Teil.step`

Gleicher Dateiname = gleiches Teil → neue Version wird automatisch gerechnet.

**AutoCAD:** Ob dein AutoCAD 3D-Volumenkörper als STEP speichern kann, hängt von Version und Variante ab
(AutoCAD Mechanical und Inventor können es). AutoCAD wird meist für 2D genutzt – dafür ist ein DXF-Import fürs
Stabwerk (Rahmen/Fachwerke aus einer Linienzeichnung) vorgemerkt.

## Was ist getestet?

| | Stand |
|---|---|
| Projekt-FEM-Seite (Empfang, neue Version erkennen, Lager/Lasten übertragen, neu rechnen, Ergebnis bereitstellen) | getestet |
| SolidCraft | gegen einen Nachbau des SolidCraft-Steuerkanals getestet (nach dessen Dokumentation: Schlüsseldatei, Mitlaufen, neue Version nach Maßänderung, Ergebnis als Parameter + Eigenschaft, Parameterstudie mit Rücksetzen). **Mit echtem SolidCraft noch nicht** (Programm konnte hier nicht gestartet werden) |
| Onshape | **mit echtem Onshape getestet** (06.11.2026, kostenloses Konto, Dokument „Projekt-FEM Test 1“): Teilestudio holen (STEP in ~8 s, Maße in mm korrekt), rechnen, in Onshape Variable `#dicke` 5 → 8 mm ändern, neue Version holen → Lager/Lasten übernommen, automatisch neu gerechnet (σv 117,9 → 45,5 MPa, Handrechnung 120 → 46,9 MPa), Ergebnis in die Beschreibung geschrieben, Baugruppe wird abgelehnt, Parameterstudie über `#dicke` 4/6/8 mm (σv 177,7 / 82,5 / 45,8 MPa, Handrechnung 187,5 / 83,3 / 46,9 MPa; 15 s; danach wieder 8 mm). Offen: Klick auf das Lesezeichen im echten Onshape-Tab (Browser-Sicherheitsregeln) |
| Fusion-Add-in, NX-Journale | Ablauf mit Platzhaltern statt Fusion/NX gegen Projekt-FEM getestet (senden, holen, Heimnetz, Fehler). **Im echten Programm noch nicht** |
| SolidWorks-Makro, Solid-Edge-Skripte, „Senden an“ (Windows) | **ungetestet** (hier kein Windows) |
| `an_projekt_fem.sh` (Mac/Linux) | getestet (lokal, Heimnetz, falscher Schlüssel, Umlaute im Namen) |

Bitte beim ersten Ausprobieren Fehlermeldungen (Text oder Screenshot) an mich – die CAD-Schnittstellen der
Hersteller unterscheiden sich je nach Version.

## Technik (für später)

- Lokal (nur 127.0.0.1): `POST /cad/open?name=…&source=…` (Rumpf: STEP-Datei, Kopfzeile `X-FEM-CAD` nötig –
  so kann keine fremde Webseite im Browser Teile schicken), `GET /cad/summary?name=…`, `GET /cad/ping`.
- Heimnetz: dieselben Wege unter `/api/cad/…` mit Kopfzeile `X-FEM-Key` (oder `?k=`).
- Eingegangene Teile: `~/.config/projekt-fem/cad-eingang/<Name>.step` (gleicher Name überschreibt).
- Ergebniswerte: `~/.config/projekt-fem/cad-eingang/<Name>.ergebnis.json` (bleiben über einen Neustart erhalten).
