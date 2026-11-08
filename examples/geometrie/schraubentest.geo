// Nachbau von „Schraubentest_1“ (SolidCraft): Rohr R32/R40 × 35, Deckel 5 mm mit Zentrierbund und Fase,
// 6 Gewindebohrungen Ø4,2 mit 118°-Bohrspitze, 6 Durchgangsbohrungen Ø6, 6 Sechskantschrauben M5x16.
// Körpernamen wie im SolidCraft-Export (Body1, Body2, Body4) danach in der STEP-Datei gesetzt.
SetFactory("OpenCASCADE");
// Rohr (Body1) R32..R40, Höhe 35
Cylinder(1) = {0, 0, 0, 0, 0, 35, 40};
Cylinder(2) = {0, 0, 0, 0, 0, 35, 32};
BooleanDifference(3) = { Volume{1}; Delete; }{ Volume{2}; Delete; };
// Deckel (Body2): Scheibe R40 z 35..40 + Zentrierbund R30.875 z 30..35
Cylinder(4) = {0, 0, 35, 0, 0, 5, 40};
Cylinder(5) = {0, 0, 30, 0, 0, 5, 30.875};
BooleanUnion(6) = { Volume{4}; Delete; }{ Volume{5}; Delete; };
// Bohrungen auf Teilkreis R36: Deckel Ø6 durch, Rohr Ø4,2 Tiefe 15 mit 118°-Spitze
For i In {0:5}
  a = Pi/2 + i*Pi/3;
  x = 36*Cos(a); y = 36*Sin(a);
  Cylinder(100+i) = {x, y, 29, 0, 0, 12, 3};
  Cylinder(200+i) = {x, y, 20, 0, 0, 15.5, 2.1};
  Cone(300+i) = {x, y, 20, 0, 0, -2.1/Tan(59*Pi/180), 2.1, 0};
EndFor
BooleanDifference(7) = { Volume{6}; Delete; }{ Volume{100:105}; Delete; };
BooleanDifference(8) = { Volume{3}; Delete; }{ Volume{200:205, 300:305}; Delete; };
// Schrauben M5x16: Sechskant SW8 Höhe 3,5 auf z = 40, Schaft Ø5 bis z = 24
For i In {0:5}
  a = Pi/2 + i*Pi/3;
  x = 36*Cos(a); y = 36*Sin(a);
  r = 4.618802;
  For k In {0:5}
    p~{k} = newp; Point(p~{k}) = {x + r*Cos(k*Pi/3), y + r*Sin(k*Pi/3), 40};
  EndFor
  For k In {0:5}
    l~{k} = newl; Line(l~{k}) = {p~{k}, p~{(k+1)%6}};
  EndFor
  cl = newcl; Curve Loop(cl) = {l~{0}, l~{1}, l~{2}, l~{3}, l~{4}, l~{5}};
  s = news; Plane Surface(s) = {cl};
  ex[] = Extrude {0, 0, 3.5} { Surface{s}; };
  Cylinder(400+i) = {x, y, 24, 0, 0, 17.75, 2.5};
  BooleanUnion{ Volume{ex[1]}; Delete; }{ Volume{400+i}; Delete; }
EndFor
Save "schraubentest.step";
