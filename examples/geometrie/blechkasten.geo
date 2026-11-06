// Blechkasten 100 x 60 x 40, Blech 2 mm, geschlossene Ecken mit 0,2 mm Spalt (wie gekantet, später geschweißt)
SetFactory("OpenCASCADE");
Box(1) = {0, 0, 0, 100, 60, 2};      // Boden
Box(2) = {0, 0, 0, 100, 2, 40};      // Seitenwand vorn
Box(3) = {0, 58, 0, 100, 2, 40};     // Seitenwand hinten
Box(4) = {0, 2.2, 0, 2, 55.6, 40};   // Stirnwand links (Spalt 0,2 zu den Seitenwänden)
Box(5) = {98, 2.2, 0, 2, 55.6, 40};  // Stirnwand rechts
BooleanUnion{ Volume{1}; Delete; }{ Volume{2,3,4,5}; Delete; }
Save "blechkasten.step";
