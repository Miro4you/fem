# Projekt-FEM auf einem Server (wie MathPad)

Projekt-FEM läuft dann im Browser von überall – gerechnet wird auf dem Server. Anders als MathPad (reine Webseite)
braucht Projekt-FEM dort den Rechenkern und Gmsh, deshalb ein eigener Docker-Container.

## Voraussetzungen

- Linux-Server mit Docker (z. B. der Hetzner-Server von MathPad), SSH-Zugang als root
- **Arbeitsspeicher:** ~2,5 GB je Million Unbekannte. Typische Teile (2-mm-Netz, ≈ 50 000 Unbekannte) brauchen
  unter 1 GB, sehr feine Netze mehrere GB. Grenze im Container: `PROJEKT_FEM_SPEICHER` (Standard 6g).
- Ein Prozessorkern reicht zum Ausprobieren; mehr Kerne = schneller

## Starten

Vom eigenen Rechner aus (Ordner `FEM`):

```bash
export PROJEKT_FEM_SCHLUESSEL=$(openssl rand -hex 12)   # fester Zugangsschlüssel, gut aufheben
server/deploy.sh root@SERVER-ADRESSE                    # z. B. dieselbe Adresse wie bei MathPad
```

Das Skript kopiert das Projekt nach `/opt/projekt-fem`, baut den Container (beim ersten Mal ~10–15 min: Rust,
Oberfläche, Gmsh) und startet ihn. Danach: `http://SERVER-ADRESSE:8790/#k=SCHLÜSSEL` im Browser öffnen.

Direkt auf dem Server geht auch: `cd /opt/projekt-fem && docker compose up -d --build`.

## Fertiges Image von GitHub (ohne selbst zu kompilieren)

Bei jedem Push baut GitHub das Image (`.github/workflows/docker.yml`) und legt es in die Container Registry:

| Tag | Inhalt |
|---|---|
| `ghcr.io/miro4you/fem:entwicklung` | neuester Stand des Entwicklungszweigs – zum Testen |
| `ghcr.io/miro4you/fem:latest` | Stand von `main` |
| `ghcr.io/miro4you/fem:sha-xxxxxxx` | genau ein Commit (zum Zurückgehen) |

Das Repository ist privat, also auch das Image. Einmalig auf dem Server/NAS anmelden – mit einem GitHub-Token
(Settings › Developer settings › Personal access tokens, Recht **read:packages**, sonst nichts):

```bash
echo DEIN_TOKEN | docker login ghcr.io -u DEIN_GITHUB_NAME --password-stdin
docker compose pull && docker compose up -d        # im Ordner mit docker-compose.yml
```

Update: wieder `docker compose pull && docker compose up -d` – oder automatisch mit Watchtower bzw. unter Unraid
„Check for Updates“ (Unraid-Vorlage: Repository `ghcr.io/miro4you/fem:entwicklung`, Port 8790, Pfad `/daten` →
`/mnt/user/appdata/projekt-fem`, Variablen `PROJEKT_FEM_SCHLUESSEL` und ggf. Speichergrenze).

## Was im Server-Modus anders ist (`PROJEKT_FEM_OEFFENTLICH=1`)

- Projekt-FEM öffnet nur Dateien, die es selbst angelegt hat (hochgeladene STEP-Dateien, CAD-Eingang, geänderte
  Geometrie) – keine beliebigen Pfade auf dem Server.
- Einstellungen, eigene Werkstoffe, Onshape-Schlüssel und der CAD-Eingang liegen im Docker-Volume `fem-daten`
  (bleiben bei Updates erhalten).
- SolidCraft-Live geht nicht (SolidCraft läuft auf deinem Rechner, nicht auf dem Server). Onshape, STEP-Upload,
  Projekte und alle Rechnungen gehen.
- CAD-Add-ins (SolidWorks, Fusion …) können direkt an den Server schicken: Einstellungen › CAD-Verbindungen zeigt
  Adresse und Schlüssel für die Datei `projekt-fem-cad.txt`.

## Sicherheit – bitte lesen

- **Zugang nur mit Schlüssel** in der Adresse (`#k=…`). Wer den Schlüssel hat, kann rechnen und deine
  Onshape-Verbindung nutzen. Neuer Schlüssel: `PROJEKT_FEM_SCHLUESSEL` ändern und neu starten.
- **Verschlüsselung (https):** Wie MathPad läuft der Container ohne https. Über das Internet sollte der Schlüssel
  nicht unverschlüsselt laufen. Empfehlung: eine Domain auf den Server zeigen lassen und davor **Caddy** setzen
  (holt das Zertifikat automatisch):

  ```
  # /etc/caddy/Caddyfile
  fem.deine-domain.de {
      reverse_proxy 127.0.0.1:8790
  }
  ```

  Dann in `docker-compose.yml` den Port nur lokal freigeben: `"127.0.0.1:8790:8790"`.
- Onshape-API-Schlüssel nur über die Oberfläche eintragen (Einstellungen › CAD-Verbindungen), nie in Dateien im Repo.

## Aktualisieren, Logs, Stoppen

```bash
server/deploy.sh root@SERVER-ADRESSE          # neuer Stand
ssh root@SERVER-ADRESSE docker logs -f projekt-fem
ssh root@SERVER-ADRESSE "cd /opt/projekt-fem && docker compose down"
```

Hinweis: Das Docker-Image wurde in der Entwicklungsumgebung nicht vollständig gebaut (dort sind die
Debian-Paketquellen gesperrt); der Server-Modus selbst (`projekt-fem-app --server`) ist getestet.
