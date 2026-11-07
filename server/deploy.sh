#!/bin/bash
# Projekt-FEM auf einen eigenen Server bringen (Docker muss dort laufen), z. B. derselbe wie MathPad.
#   server/deploy.sh root@SERVER-ADRESSE
# Optional vorher: export PROJEKT_FEM_SCHLUESSEL=…  (sonst wird beim ersten Start einer erzeugt)
set -e
REMOTE="${1:?Aufruf: server/deploy.sh root@SERVER-ADRESSE}"
REMOTE_DIR="/opt/projekt-fem"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Projekt-FEM Deploy → $REMOTE ==="
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
rsync -az --delete --exclude target --exclude node_modules --exclude .git --exclude app/dist \
  "$PROJECT_DIR/" "$REMOTE:$REMOTE_DIR/"
ssh "$REMOTE" "cd $REMOTE_DIR && PROJEKT_FEM_SCHLUESSEL='${PROJEKT_FEM_SCHLUESSEL:-}' docker compose up -d --build"
echo ""
echo "Zugangsadresse (mit Schlüssel):"
ssh "$REMOTE" "docker logs projekt-fem 2>&1 | grep -o '#k=[a-z0-9]*' | tail -1" | sed "s|^|  http://${REMOTE#*@}:8790/|"
