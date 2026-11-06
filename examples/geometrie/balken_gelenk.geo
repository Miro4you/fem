// Balken 200 × 10 × 20 mm (Länge x, Breite y, Höhe z) mit zwei Bolzenbohrungen Ø8
// in der Schwerachse bei x = 10 und x = 190 (Stützweite 180 mm) – Gelenklager-Prüffall
SetFactory("OpenCASCADE");
Box(1) = {0, 0, 0, 200, 10, 20};
Cylinder(2) = {10, -1, 10, 0, 12, 0, 4};
Cylinder(3) = {190, -1, 10, 0, 12, 0, 4};
BooleanDifference{ Volume{1}; Delete; }{ Volume{2, 3}; Delete; }
Save "balken_gelenk.step";
