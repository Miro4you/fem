#!/bin/sh
# Projekt-FEM – STEP-Dateien aus jedem CAD an Projekt-FEM schicken (Mac und Linux).
#
#   ./an_projekt_fem.sh Hebel.step [weitere.step …]
#
# Mac (Rechtsklick im Finder): Automator → Neues Dokument → Schnellaktion → „Shell-Skript ausführen“,
# Eingabe „als Argumente“, Inhalt:  /Pfad/zu/an_projekt_fem.sh "$@"  → speichern als „An Projekt-FEM“.
# Adresse und Schlüssel: ~/projekt-fem-cad.txt (fehlt die Datei: Projekt-FEM auf diesem Rechner).

ADRESSE=http://127.0.0.1:8791/cad
SCHLUESSEL=
if [ -f "$HOME/projekt-fem-cad.txt" ]; then
  while IFS='=' read -r k v; do
    k=$(printf '%s' "$k" | tr -d ' \r' | tr 'A-Z' 'a-z'); v=$(printf '%s' "$v" | tr -d ' \r')
    case "$k" in
      adresse) ADRESSE=${v%/} ;;
      schluessel) SCHLUESSEL=$v ;;
    esac
  done < "$HOME/projekt-fem-cad.txt"
fi

# jedes Byte prozentkodieren (funktioniert mit Umlauten und Leerzeichen)
kodiert() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g'; }

meldung() {
  if command -v osascript >/dev/null 2>&1; then osascript -e "display notification \"$1\" with title \"Projekt-FEM\"" >/dev/null 2>&1
  elif command -v notify-send >/dev/null 2>&1; then notify-send "Projekt-FEM" "$1"
  fi
  echo "$1"
}

[ $# -eq 0 ] && { echo "Aufruf: $0 Teil.step [weitere.step …]"; exit 1; }
for f in "$@"; do
  name=$(basename "$f"); name=${name%.*}
  case "$f" in
    *.step|*.stp|*.STEP|*.STP) ;;
    *) meldung "$name: keine STEP-Datei"; continue ;;
  esac
  if antwort=$(curl -sS --fail-with-body -X POST -H "X-FEM-CAD: Datei" ${SCHLUESSEL:+-H "X-FEM-Key: $SCHLUESSEL"} \
      -H "Content-Type: application/octet-stream" --data-binary @"$f" "$ADRESSE/open?name=$(kodiert "$name")&source=Datei" 2>&1); then
    meldung "„$name“ an Projekt-FEM geschickt"
  else
    meldung "$name nicht geschickt: $antwort"
  fi
done
