// Welle Ø20 × 100 mm entlang z (für Torsion und Lagerlast)
SetFactory("OpenCASCADE");
Cylinder(1) = {0, 0, 0, 0, 0, 100, 10};
Save "welle.step";
