# Geometrie anpassen (Projekt-FEM): STEP einlesen, Änderungen anwenden, STEP schreiben.
# Aufruf: python geometry.py auftrag.json   (Gmsh-Python-Modul mit OpenCASCADE)
# Ausgabe: letzte Zeile „ERGEBNIS {json}“ oder „FEHLER text“.
import json
import math
import sys

import gmsh

job = json.load(open(sys.argv[1], encoding="utf-8"))


def fail(msg):
    print("FEHLER " + msg, flush=True)
    try:
        gmsh.finalize()
    finally:
        sys.exit(2)


gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
gmsh.option.setString("Geometry.OCCTargetUnit", "MM")
occ = gmsh.model.occ
occ.importShapes(job["input"])
occ.synchronize()


def volumes():
    return [(3, t) for _, t in gmsh.model.getEntities(3)]


def total_volume():
    return sum(occ.getMass(3, t) for _, t in volumes())


def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def unit(a):
    n = math.sqrt(dot(a, a)) or 1.0
    return [v / n for v in a]


def bbox_all():
    b = gmsh.model.getBoundingBox(-1, -1)
    return math.dist(b[:3], b[3:])


def find_surface(center, what):
    """Fläche, deren Schwerpunkt `center` am nächsten liegt (Flächennummern ändern sich bei jeder Änderung)."""
    best, best_d = None, float("inf")
    for _, t in gmsh.model.getEntities(2):
        d = math.dist(occ.getCenterOfMass(2, t), center)
        if d < best_d:
            best, best_d = t, d
    if best is None or best_d > max(1.0, 0.02 * bbox_all()):
        fail(f"{what}: Fläche nicht mehr gefunden – wurde sie durch eine andere Änderung entfernt?")
    return best


def plane_basis(normal, u_hint=None):
    n = unit(normal)
    u = [0.0, 0.0, 0.0]
    if u_hint:
        u = sub(u_hint, [n[i] * dot(u_hint, n) for i in range(3)])
    if math.sqrt(dot(u, u)) < 1e-6:
        k = min(range(3), key=lambda i: abs(n[i]))
        e = [0.0, 0.0, 0.0]
        e[k] = 1.0
        u = sub(e, [n[i] * dot(e, n) for i in range(3)])
    u = unit(u)
    return n, u, cross(n, u)


def sketch(sk, offset=0.0):
    """Skizze (Kreis oder Rechteck) als Fläche in ihrer Ebene, um `offset` entlang der Normale verschoben."""
    n, u, v = plane_basis(sk["normal"], sk.get("u"))
    c = [sk["center"][i] + n[i] * offset for i in range(3)]
    if sk["shape"] == "circle":
        s = occ.addDisk(0, 0, 0, sk["radius"], sk["radius"])
    elif sk["shape"] == "rect":
        w, h = sk["width"], sk["height"]
        s = occ.addRectangle(-w / 2, -h / 2, 0, w, h)
    else:
        fail("Skizze: nur Kreis oder Rechteck")
    occ.affineTransform([(2, s)], [u[0], v[0], n[0], c[0], u[1], v[1], n[1], c[1], u[2], v[2], n[2], c[2]])
    return s, n


def single_volume(what):
    occ.synchronize()
    if len(volumes()) > 1:
        fail(what)


def op_fillet(o):
    """Radius ändern: Verrundung entfernen, die entstandene scharfe Kante neu verrunden (Radius 0 = scharf)."""
    axis = unit(o["axis"])
    tags = sorted({find_surface(c, "Radius") for c in o["surfaces"]})
    boxes = [gmsh.model.getBoundingBox(2, t) for t in tags]
    try:
        occ.defeature([t for _, t in volumes()], tags)
    except Exception as ex:
        fail(f"Radius lässt sich nicht entfernen ({ex})")
    occ.synchronize()
    if o["radius"] <= 0:
        return
    e = 1e-3 * max(1.0, bbox_all())
    edges = set()
    for b in boxes:
        for _, t in gmsh.model.getEntitiesInBoundingBox(b[0] - e, b[1] - e, b[2] - e, b[3] + e, b[4] + e, b[5] + e, 1):
            if gmsh.model.getType(1, t) != "Line":
                continue
            p = [gmsh.model.getValue(0, abs(q), []) for _, q in gmsh.model.getBoundary([(1, t)])]
            if len(p) == 2 and abs(dot(unit(sub(p[1], p[0])), axis)) > 0.999:
                edges.add(t)
    if not edges:
        fail("Radius: Kante für die neue Verrundung nicht gefunden")
    try:
        occ.fillet([t for _, t in volumes()], sorted(edges), [o["radius"]], removeVolume=True)
    except Exception as ex:
        fail(f"Radius {o['radius']} mm lässt sich hier nicht erzeugen – zu groß für die angrenzenden Flächen? ({ex})")
    single_volume("Radius: Ergebnis ist kein zusammenhängender Körper")


def op_hole(o):
    """Bohrung ändern: Bohrung schließen, mit neuem Durchmesser neu bohren (Durchmesser 0 = zu)."""
    tags = sorted({find_surface(c, "Bohrung") for c in o["surfaces"]})
    try:
        occ.defeature([t for _, t in volumes()], tags)
    except Exception as ex:
        fail(f"Bohrung lässt sich nicht schließen ({ex})")
    occ.synchronize()
    if o["diameter"] <= 0:
        return
    a = unit(o["axis"])
    L = 2 * bbox_all()
    p = [o["origin"][i] - a[i] * L / 2 for i in range(3)]
    tool = occ.addCylinder(p[0], p[1], p[2], a[0] * L, a[1] * L, a[2] * L, o["diameter"] / 2)
    occ.cut(volumes(), [(3, tool)])
    single_volume("Bohrung: Der neue Durchmesser trennt das Bauteil")


def op_add(o):
    s, n = sketch(o["sketch"])
    h = o["height"]
    tool = [x for x in occ.extrude([(2, s)], n[0] * h, n[1] * h, n[2] * h) if x[0] == 3]
    occ.synchronize()
    others = [x for x in volumes() if x not in tool]
    occ.fuse(others, tool)
    single_volume("Material hinzufügen: Die Skizze berührt das Bauteil nicht")


def op_cut(o):
    depth = o.get("depth") or 2 * bbox_all()
    eps = 1e-3 * max(1.0, bbox_all())
    s, n = sketch(o["sketch"], offset=eps)
    d = depth + eps
    tool = [x for x in occ.extrude([(2, s)], -n[0] * d, -n[1] * d, -n[2] * d) if x[0] == 3]
    occ.synchronize()
    others = [x for x in volumes() if x not in tool]
    occ.cut(others, tool)
    occ.synchronize()
    if not volumes():
        fail("Material entfernen: Es bliebe nichts übrig")
    single_volume("Material entfernen: Die Aussparung trennt das Bauteil in mehrere Teile")


before = total_volume()
ops = {"fillet": op_fillet, "hole": op_hole, "add": op_add, "cut": op_cut}
# Radien und Bohrungen zuerst (sie beziehen sich auf die Originalflächen), dann Skizzen-Operationen
order = sorted(job["ops"], key=lambda o: 0 if o["op"] in ("fillet", "hole") else 1)
for o in order:
    ops[o["op"]](o)
    occ.synchronize()
after = total_volume()
gmsh.write(job["output"])
gmsh.finalize()
print("ERGEBNIS " + json.dumps({"volume_before": before, "volume_after": after}), flush=True)
