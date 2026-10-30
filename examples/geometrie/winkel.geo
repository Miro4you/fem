// Winkel 80 × 60 × 40 mm, Wandstärke 8 mm, Innenradius 6 mm,
// zwei Befestigungsbohrungen Ø9 unten, eine Lastbohrung Ø11 oben
SetFactory("OpenCASCADE");
Box(1) = {0, 0, 0, 80, 40, 8};          // Fuß
Box(2) = {0, 0, 0, 8, 40, 60};          // Schenkel
BooleanUnion(3) = { Volume{1}; Delete; }{ Volume{2}; Delete; };
// Innenradius in der Ecke
Box(4) = {8, 0, 8, 6, 40, 6};
Cylinder(5) = {14, -1, 14, 0, 42, 0, 6};
BooleanDifference(6) = { Volume{4}; Delete; }{ Volume{5}; Delete; };
BooleanUnion(7) = { Volume{3}; Delete; }{ Volume{6}; Delete; };
Cylinder(10) = {45, 12, -1, 0, 0, 10, 4.5};
Cylinder(11) = {65, 28, -1, 0, 0, 10, 4.5};
Cylinder(12) = {-1, 20, 45, 10, 0, 0, 5.5};
BooleanDifference{ Volume{7}; Delete; }{ Volume{10, 11, 12}; Delete; }
Save "winkel.step";
