SetFactory("OpenCASCADE");
// zwei Platten mit je zwei Bohrungen Ø9,6 (keine Normbohrung → kein automatischer Vorschlag)
Box(1) = {0, 0, 0, 60, 40, 10};
Box(2) = {0, 0, 10, 60, 40, 8};
Cylinder(3) = {15, 20, -1, 0, 0, 20, 4.8};
Cylinder(4) = {45, 20, -1, 0, 0, 20, 4.8};
BooleanDifference{ Volume{1, 2}; Delete; }{ Volume{3, 4}; Delete; }
Save "flansch.step";
