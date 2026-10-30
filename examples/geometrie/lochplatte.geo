// Lochplatte 200 × 50 × 5 mm mit Bohrung Ø10 in der Mitte (d/W = 0,2)
SetFactory("OpenCASCADE");
Box(1) = {0, 0, 0, 200, 50, 5};
Cylinder(2) = {100, 25, -1, 0, 0, 7, 5};
BooleanDifference{ Volume{1}; Delete; }{ Volume{2}; Delete; }
Save "lochplatte.step";
