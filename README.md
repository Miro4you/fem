# FEM

Privates FEM-Programm (Machbarkeitsstudie) für Festigkeitsanalysen – läuft auf Linux und macOS.

## Roadmap
1. **Rechenkern (Rust):** lineare Statik 3D-Volumen (Tetraeder), Von-Mises/Hauptspannungen, Validierung an Lehrbuchfällen
2. **Desktop-App (Tauri):** STEP-Import + Vernetzung (Gmsh), 3D-Ansicht, Lager/Lasten per Klick, geführter Ablauf
3. **Nachweis & Bericht:** Werkstoffdatenbank, automatische Sicherheiten, PDF-Bericht, Parameterstudien, MathPad-Anbindung
4. **Weitere Elemente:** Balken/Rahmen/Fachwerk, Schalen (Bleche)
5. **Dynamik & Stabilität:** Eigenfrequenzen, Knicken/Beulen
6. **Strömung (überschlägig):** OpenFOAM-Anbindung, Strömungslasten → Festigkeit
