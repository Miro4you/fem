# Konstruktion (Projekt-FEM): Feature-Liste mit OpenCASCADE ausführen.
# Aufruf: python cad.py auftrag.json   (Gmsh-Python-Modul)
# Auftrag: { base, features, upto, output, result, cache, tess, regions_of, quality }
# Ergebnis steht als JSON in `result`; letzte Ausgabezeile „ERGEBNIS ok“ oder „FEHLER text“.
#
# Features (nur Zahlen, Skizzen sind bereits gelöst):
#   sketch   { id, plane:{origin,normal,u}, ents:[{t:line,a,b}|{t:circle,c,r}|{t:arc,c,a,b}], pts:[[u,v]] }
#   extrude  { sketch, regions, mode:add|cut|new, depth, dir:±1, symmetric, through }
#   revolve  { sketch, regions, axis:{a,b}, angle, mode, symmetric }
#   hole     { sketch, diameter, through, depth, tip, flip, sink:{kind:none|cone|cyl, d, depth, angle} }
#   fillet   { edges:[{mid,dir?,kind?}], radius }        chamfer { edges, distance }
#   pattern  { kind:linear|circular, features:[ids]|"body", dir, count, spacing, dir2, count2, spacing2,
#              axis:{point,dir}, angle }
#   mirror   { features:[ids]|"body", plane:{origin,normal} }
#   removefaces { faces:[{center}] }      moveface { faces:[{center}], distance }
#   refillet / rehole: Radius bzw. Bohrung eines importierten Teils ändern (wie bisher)
import hashlib
import json
import math
import os
import sys

import gmsh

job = json.load(open(sys.argv[1], encoding="utf-8"))


class Problem(Exception):
    """Fehler mit verständlicher Meldung für ein Feature."""


def finish(text):
    print(text, flush=True)
    try:
        gmsh.finalize()
    finally:
        sys.exit(0 if text.startswith("ERGEBNIS") else 2)


gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
gmsh.option.setString("Geometry.OCCTargetUnit", "MM")
occ = gmsh.model.occ

# --- Vektoren ---------------------------------------------------------------------------------


def sub(a, b):
    return [a[i] - b[i] for i in range(len(a))]


def add(a, b):
    return [a[i] + b[i] for i in range(len(a))]


def mul(a, s):
    return [v * s for v in a]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(len(a)))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def norm(a):
    return math.sqrt(dot(a, a))


def unit(a):
    n = norm(a) or 1.0
    return [v / n for v in a]


def plane_basis(plane):
    n = unit(plane["normal"])
    u = plane.get("u") or [0.0, 0.0, 0.0]
    u = sub(u, mul(n, dot(u, n)))
    if norm(u) < 1e-9:
        k = min(range(3), key=lambda i: abs(n[i]))
        e = [0.0, 0.0, 0.0]
        e[k] = 1.0
        u = sub(e, mul(n, dot(e, n)))
    u = unit(u)
    return plane["origin"], u, cross(n, u), n


def to3d(plane, p):
    o, u, v, _ = plane_basis(plane)
    return [o[i] + u[i] * p[0] + v[i] * p[1] for i in range(3)]


# --- Zustand ----------------------------------------------------------------------------------


def volumes():
    return [(3, t) for _, t in gmsh.model.getEntities(3)]


def total_volume():
    return sum(occ.getMass(3, t) for _, t in volumes())


def diag():
    if not gmsh.model.getEntities():
        return 100.0
    b = gmsh.model.getBoundingBox(-1, -1)
    return max(math.dist(b[:3], b[3:]), 1e-6)


def cleanup():
    """Alles entfernen, was zu keinem Körper gehört (Reste von Skizzen und Werkzeugen)."""
    occ.synchronize()
    keep = {1: set(), 2: set(), 0: set()}
    vols = volumes()
    if vols:
        for d, t in gmsh.model.getBoundary(vols, combined=False, oriented=False, recursive=False):
            keep[2].add(t)
        for dim in (2, 1):
            ents = [(dim, t) for t in keep[dim]]
            if ents:
                for d, t in gmsh.model.getBoundary(ents, combined=False, oriented=False, recursive=False):
                    keep[dim - 1].add(t)
    for dim in (2, 1, 0):
        stray = [(dim, t) for _, t in gmsh.model.getEntities(dim) if t not in keep[dim]]
        if stray:
            try:
                occ.remove(stray, recursive=False)
            except Exception:
                pass
    occ.synchronize()


# Körpernamen: (Name, Punkt im Körper) – über Punkte statt Nummern, weil sich die Nummern bei jeder Operation ändern
NAMES = []


def save_state(path):
    occ.synchronize()
    with open(path + ".namen.json", "w", encoding="utf-8") as fh:
        json.dump(NAMES, fh)
    if not volumes():
        open(path, "w").write("leer")
        return
    gmsh.write(path)


def load_state(path):
    gmsh.clear()
    if os.path.getsize(path) > 10:
        occ.importShapes(path, format="brep" if path.endswith(".brep") else "")
    occ.synchronize()
    NAMES.clear()
    try:
        NAMES.extend(json.load(open(path + ".namen.json", encoding="utf-8")))
    except Exception:
        pass


def point_in_body(vol):
    """Ein Punkt sicher im Körper (Schwerpunkt reicht bei Ringen nicht)."""
    e = 1e-3 * diag()
    for _, srf in gmsh.model.getBoundary([(3, vol)], oriented=False):
        srf = abs(srf)
        lo, hi = gmsh.model.getParametrizationBounds(2, srf)
        for fu, fv in ((0.5, 0.5), (0.3, 0.4), (0.7, 0.6)):
            uv = [lo[0] + fu * (hi[0] - lo[0]), lo[1] + fv * (hi[1] - lo[1])]
            p = list(gmsh.model.getValue(2, srf, uv))
            if not gmsh.model.isInside(2, srf, p):
                continue
            n = outward_normal(srf, [vol])
            for k in (1.0, 0.1, 0.01):
                q = sub(p, mul(n, e * k))
                if gmsh.model.isInside(3, vol, q):
                    return q
    return list(occ.getCenterOfMass(3, vol))


def body_names():
    """Name je Körper (Reihenfolge wie volumes()), leer wenn keiner vergeben."""
    out = []
    for _, v in volumes():
        name = ""
        for n, pt in reversed(NAMES):
            if gmsh.model.isInside(3, v, pt):
                name = n
                break
        out.append(name)
    return out


def step_with_names(path):
    """Körpernamen in die STEP-Datei schreiben (Gmsh schreibt „Open CASCADE STEP translator … 1.<k>“)."""
    import re

    names = body_names()
    if not any(names):
        return
    text = open(path, encoding="utf-8", errors="replace").read()
    pat = re.compile(r"'Open CASCADE STEP translator [0-9.]+ 1\.(\d+)'")

    def enc(n):
        out = ""
        for ch in n:
            if ch in "'\\":
                continue
            out += ch if ord(ch) < 128 else "\\X2\\%04X\\X0\\" % ord(ch)
        return out

    def repl(m):
        k = int(m.group(1)) - 1
        return "'" + enc(names[k]) + "'" if 0 <= k < len(names) and names[k] else m.group(0)

    open(path, "w", encoding="utf-8").write(pat.sub(repl, text))


# --- Skizzen → Flächen ------------------------------------------------------------------------

TWO_PI = 2 * math.pi


def arc_angles(e):
    a0 = math.atan2(e["a"][1] - e["c"][1], e["a"][0] - e["c"][0])
    a1 = math.atan2(e["b"][1] - e["c"][1], e["b"][0] - e["c"][0])
    while a1 <= a0 + 1e-12:
        a1 += TWO_PI
    return a0, a1


def ent_radius(e):
    return e["r"] if e["t"] == "circle" else math.dist(e["a"], e["c"])


def dist_to_ent(p, e):
    """Abstand eines 2D-Punkts von einem Skizzenelement."""
    if e["t"] == "line":
        d = sub(e["b"], e["a"])
        L2 = dot(d, d)
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, dot(sub(p, e["a"]), d) / L2))
        return math.dist(p, add(e["a"], mul(d, t)))
    r = ent_radius(e)
    if e["t"] == "circle":
        return abs(math.dist(p, e["c"]) - r)
    a0, a1 = arc_angles(e)
    ang = math.atan2(p[1] - e["c"][1], p[0] - e["c"][0])
    while ang < a0:
        ang += TWO_PI
    if ang <= a1:
        return abs(math.dist(p, e["c"]) - r)
    return min(math.dist(p, e["a"]), math.dist(p, e["b"]))


def prune_open(ents, tol):
    """Offene Enden weglassen: Linien/Bögen, deren Endpunkt an nichts anderes anschließt."""
    ents = [e for e in ents if not (e["t"] == "line" and math.dist(e["a"], e["b"]) < tol)]
    while True:
        drop = None
        for i, e in enumerate(ents):
            if e["t"] == "circle":
                continue
            for p in (e["a"], e["b"]):
                if not any(j != i and dist_to_ent(p, o) < tol for j, o in enumerate(ents)):
                    drop = i
                    break
            if drop is not None:
                break
        if drop is None:
            return ents
        ents.pop(drop)


def crossings(q, ents):
    """Schnittpunkte eines waagrechten Strahls ab q nach +x mit den Elementen (gerade/ungerade-Regel)."""
    n = 0
    for e in ents:
        if e["t"] == "line":
            (x0, y0), (x1, y1) = e["a"], e["b"]
            if (y0 > q[1]) != (y1 > q[1]):
                x = x0 + (q[1] - y0) * (x1 - x0) / (y1 - y0)
                if x > q[0]:
                    n += 1
            continue
        r = ent_radius(e)
        dy = q[1] - e["c"][1]
        if abs(dy) >= r:
            continue
        dx = math.sqrt(r * r - dy * dy)
        for x in (e["c"][0] - dx, e["c"][0] + dx):
            if x <= q[0]:
                continue
            if e["t"] == "arc":
                a0, a1 = arc_angles(e)
                ang = math.atan2(dy, x - e["c"][0])
                while ang < a0:
                    ang += TWO_PI
                if ang > a1:
                    continue
            n += 1
    return n


def loop_polylines(face):
    """Rand einer ebenen Fläche als Linienzüge (je Randschleife), in Modellkoordinaten."""
    loops = []
    try:
        _, curve_tags = occ.getCurveLoops(face)
    except Exception:
        curve_tags = [[abs(t) for _, t in gmsh.model.getBoundary([(2, face)], oriented=False)]]
    for tags in curve_tags:
        segs = []
        for c in tags:
            c = abs(int(c))
            lo, hi = gmsh.model.getParametrizationBounds(1, c)
            kind = gmsh.model.getType(1, c)
            n = 1 if kind == "Line" else 48
            ts = [lo[0] + (hi[0] - lo[0]) * k / n for k in range(n + 1)]
            xyz = gmsh.model.getValue(1, c, ts)
            segs.append([[xyz[3 * k], xyz[3 * k + 1], xyz[3 * k + 2]] for k in range(n + 1)])
        # Kurven aneinanderhängen (Reihenfolge stimmt, Richtung nicht unbedingt)
        chain = []
        for s in segs:
            if chain and math.dist(chain[-1], s[0]) > math.dist(chain[-1], s[-1]):
                s = s[::-1]
            elif not chain and len(segs) > 1:
                nxt = segs[1]
                if min(math.dist(s[0], nxt[0]), math.dist(s[0], nxt[-1])) < min(math.dist(s[-1], nxt[0]), math.dist(s[-1], nxt[-1])):
                    s = s[::-1]
            chain.extend(s if not chain else s[1:])
        if len(chain) >= 3:
            loops.append(chain)
    return loops


def inside_poly(q, loops):
    n = 0
    for lp in loops:
        for k in range(len(lp) - 1):
            (x0, y0), (x1, y1) = lp[k][:2], lp[k + 1][:2]
            if (y0 > q[1]) != (y1 > q[1]) and x0 + (q[1] - y0) * (x1 - x0) / (y1 - y0) > q[0]:
                n += 1
    return n % 2 == 1


def interior_point(loops):
    """Ein Punkt sicher im Inneren der Fläche (Schwerpunkt reicht bei Ringen und Sicheln nicht)."""
    pts = [p for lp in loops for p in lp]
    c = [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)]
    if inside_poly(c, loops):
        return c
    size = max(max(p[0] for p in pts) - min(p[0] for p in pts), max(p[1] for p in pts) - min(p[1] for p in pts))
    for eps in (1e-2, 1e-3, 1e-4):
        for lp in loops:
            for k in range(0, len(lp) - 1, max(1, (len(lp) - 1) // 16)):
                a, b = lp[k], lp[k + 1]
                m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
                t = unit([b[0] - a[0], b[1] - a[1]])
                for s in (1, -1):
                    q = [m[0] - s * t[1] * eps * size, m[1] + s * t[0] * eps * size]
                    if inside_poly(q, loops):
                        return q
    return c


def sketch_regions(sk):
    """Alle geschlossenen Bereiche einer Skizze, noch in der lokalen XY-Ebene.
    → Liste von { tag, pt, area, loops, evenodd }"""
    ents = sk.get("ents") or []
    if not ents:
        return []
    xs, ys = [], []
    for e in ents:
        if e["t"] == "line":
            xs += [e["a"][0], e["b"][0]]
            ys += [e["a"][1], e["b"][1]]
        else:
            r = ent_radius(e)
            xs += [e["c"][0] - r, e["c"][0] + r]
            ys += [e["c"][1] - r, e["c"][1] + r]
    size = max(max(xs) - min(xs), max(ys) - min(ys), 1e-6)
    ents = prune_open([dict(e) for e in ents], 1e-6 * size + 1e-9)
    if not ents:
        return []
    curves = []
    for e in ents:
        if e["t"] == "line":
            curves.append(occ.addLine(occ.addPoint(e["a"][0], e["a"][1], 0), occ.addPoint(e["b"][0], e["b"][1], 0)))
        elif e["t"] == "circle":
            curves.append(occ.addCircle(e["c"][0], e["c"][1], 0, e["r"]))
        else:
            a0, a1 = arc_angles(e)
            curves.append(occ.addCircle(e["c"][0], e["c"][1], 0, ent_radius(e), angle1=a0, angle2=a1))
    m = 0.5 * size + 1.0
    big = occ.addRectangle(min(xs) - m, min(ys) - m, 0, max(xs) - min(xs) + 2 * m, max(ys) - min(ys) + 2 * m)
    out, _ = occ.fragment([(2, big)], [(1, c) for c in curves])
    occ.synchronize()
    faces = [t for d, t in out if d == 2]
    rest = [(d, t) for d, t in out if d != 2]
    regions = []
    for t in faces:
        b = gmsh.model.getBoundingBox(2, t)
        if b[0] < min(xs) - 0.5 * m and b[3] > max(xs) + 0.5 * m:
            rest.append((2, t))  # Außenbereich
            continue
        loops = loop_polylines(t)
        pt = interior_point(loops)
        regions.append({"tag": t, "pt": pt, "area": occ.getMass(2, t), "loops": [[p[:2] for p in lp] for lp in loops], "evenodd": crossings(pt, ents) % 2 == 1})
    if rest:
        try:
            occ.remove(rest, recursive=True)
        except Exception:
            pass
    return regions


def fill_loops(x):
    """Schraffur: neue Form { loops, group } oder alte Form (Liste von Schleifen)."""
    return x["loops"] if isinstance(x, dict) else x


def in_fills(q, fills, group=None):
    """Punkt in einer der Schraffurflächen (je Schraffur gerade/ungerade über ihre Ränder)?"""
    return any(inside_poly(q, fill_loops(x)) for x in fills or [] if group is None or (isinstance(x, dict) and x.get("group") == group))


def sketch_faces(sk, picks=None, what="Skizze", fills=False):
    """Gewählte Bereiche der Skizze als Flächen im Raum (Auswahl per Punkt, Schraffur oder gerade/ungerade)."""
    regions = sketch_regions(sk)
    if not regions:
        raise Problem(f"{what}: keine geschlossene Kontur – Linien müssen an den Enden zusammenhängen")
    chosen = None
    if picks is not None and len(picks) == 0:
        # bewusst nichts gewählt (nicht dasselbe wie „automatisch“)
        occ.remove([(2, r["tag"]) for r in regions], recursive=True)
        raise Problem(f"{what}: keine Fläche gewählt – Flächen der Skizze im Bild anklicken")
    if picks:
        # Punkt je gewählter Fläche: [u, v] oder { pt: [u, v], area }
        pts = [p["pt"] if isinstance(p, dict) else p for p in picks]
        chosen = [r for r in regions if any(inside_poly(p, r["loops"]) for p in pts)]
        lost = sum(1 for p in pts if not any(inside_poly(p, r["loops"]) for r in regions))
        if not chosen:
            raise Problem(f"{what}: die gewählten Flächen gibt es nicht mehr (Skizze geändert?) – im Feature neu wählen")
        if lost:
            raise Problem(f"{what}: {lost} von {len(pts)} gewählten Flächen gibt es nicht mehr (Skizze geändert?) – im Feature neu wählen")
    elif fills and sk.get("fills"):
        group = fills.get("group") if isinstance(fills, dict) else None
        chosen = [r for r in regions if in_fills(r["pt"], sk["fills"], group)] or None
        if chosen is None and group is not None:
            occ.remove([(2, r["tag"]) for r in regions], recursive=True)
            raise Problem(f"{what}: Diese Schraffur gibt es in der Skizze nicht mehr – Flächen im Bild wählen")
    if chosen is None:
        chosen = [r for r in regions if r["evenodd"]]
    drop = [(2, r["tag"]) for r in regions if r not in chosen]
    if drop:
        occ.remove(drop, recursive=True)
    faces = [(2, r["tag"]) for r in chosen]
    return faces, place(faces, sk["plane"])


def place(ents, plane):
    """Aus der lokalen XY-Ebene in die Skizzenebene legen – nur drehen und schieben, damit Ebenen Ebenen
    und Zylinder Zylinder bleiben (eine allgemeine Abbildung macht daraus Freiformflächen)."""
    o, u, v, n = plane_basis(plane)
    # Drehmatrix R = [u v n] → Achse und Winkel
    tr = u[0] + v[1] + n[2]
    ang = math.acos(max(-1.0, min(1.0, (tr - 1) / 2)))
    if ang > 1e-12:
        if math.pi - ang > 1e-6:
            ax = unit([v[2] - n[1], n[0] - u[2], u[1] - v[0]])
        else:
            # 180°: Achse aus der Diagonale
            d = [max(0.0, (u[0] + 1) / 2), max(0.0, (v[1] + 1) / 2), max(0.0, (n[2] + 1) / 2)]
            k = max(range(3), key=lambda i: d[i])
            cols = [u, v, n]
            ax = [0.0, 0.0, 0.0]
            ax[k] = math.sqrt(d[k])
            for i in range(3):
                if i != k:
                    ax[i] = (cols[k][i] + cols[i][k]) / (4 * ax[k])
            ax = unit(ax)
        occ.rotate(ents, 0, 0, 0, ax[0], ax[1], ax[2], ang)
    if norm(o) > 0:
        occ.translate(ents, o[0], o[1], o[2])
    return n


# --- Körper verknüpfen ------------------------------------------------------------------------


def boxes_touch(a, b, tol):
    return all(a[i] <= b[i + 3] + tol and b[i] <= a[i + 3] + tol for i in range(3))


def combine(mode, tools, warn):
    """Werkzeugkörper hinzufügen, abziehen oder als neuen Körper stehen lassen."""
    occ.synchronize()
    bodies = [x for x in volumes() if x not in tools]
    if mode == "new" or (mode == "add" and not bodies):
        if len(tools) > 1:
            try:
                occ.fuse(tools[:1], tools[1:])
            except Exception:
                pass
        occ.synchronize()
        return
    if mode == "add":
        tol = 1e-6 * diag()
        tb = [gmsh.model.getBoundingBox(3, t) for _, t in tools]
        near = [x for x in bodies if any(boxes_touch(gmsh.model.getBoundingBox(3, x[1]), b, tol) for b in tb)]
        before = len(bodies)
        occ.fuse(near or bodies[:1], tools) if near else None
        occ.synchronize()
        if not near or len(volumes()) > before:
            warn.append("Das neue Material berührt das Bauteil nicht – es ist ein eigener, loser Körper")
        return
    if mode == "cut":
        if not bodies:
            occ.remove(tools, recursive=True)
            raise Problem("Entfernen: Es gibt noch keinen Körper")
        before = len(bodies)
        vol0 = sum(occ.getMass(3, t) for _, t in bodies)
        occ.cut(bodies, tools)
        occ.synchronize()
        if not volumes():
            raise Problem("Entfernen: Es bliebe nichts übrig")
        if abs(total_volume() - vol0) < 1e-7 * max(vol0, 1e-9):
            warn.append("Es wurde nichts entfernt – der Bereich trifft kein Material")
        if len(volumes()) > before:
            warn.append("Der Schnitt trennt das Bauteil in mehrere Körper")
        return
    raise Problem(f"unbekannte Art „{mode}“")


def sketch_of(f, sketches, what):
    sk = sketches.get(f.get("sketch"))
    if sk is None:
        raise Problem(f"{what}: Skizze fehlt (gelöscht oder unterdrückt?)")
    return sk


# --- Werkzeugkörper der Features (auch für Muster und Spiegeln) --------------------------------


def tools_extrude(f, sketches):
    sk = sketch_of(f, sketches, "Extrudieren")
    faces, n = sketch_faces(sk, f.get("regions"), "Extrudieren", f.get("fills"))
    d = (f.get("dir") or 1) * 1.0
    through = bool(f.get("through"))
    depth = float(f.get("depth") or 0)
    if through:
        depth = 2 * diag() + 2 * norm(sub(sk["plane"]["origin"], gmsh.model.getBoundingBox(-1, -1)[:3]))
    if depth <= 0:
        raise Problem("Extrudieren: Tiefe muss größer als 0 sein")
    start = 0.0
    if f.get("symmetric"):
        start = -depth / 2 if not through else -depth
        depth = depth if not through else 2 * depth
    elif through:
        start = -1e-4 * diag()
        depth -= start
    if start:
        occ.translate(faces, n[0] * d * start, n[1] * d * start, n[2] * d * start)
    out = occ.extrude(faces, n[0] * d * depth, n[1] * d * depth, n[2] * d * depth)
    return [x for x in out if x[0] == 3]


def half_plane(faces, sk, ax, warn):
    """Bereiche, die über die Drehachse reichen (Schnittzeichnung mit beiden Hälften), auf eine Seite
    der Achse beschneiden – die Seite mit der größeren Fläche."""
    a, b = ax["a"], ax["b"]
    d = unit([b[0] - a[0], b[1] - a[1]])
    nrm = [-d[1], d[0]]
    big = 4 * max(diag(), max(abs(v) for v in a + b) + 1.0)
    halves = []
    for side in (1.0, -1.0):
        cs = [[a[0] + d[0] * t + nrm[0] * side * h, a[1] + d[1] * t + nrm[1] * side * h] for t, h in ((-big, 0), (big, 0), (big, big), (-big, big))]
        pts = [occ.addPoint(c[0], c[1], 0) for c in cs]
        loop = occ.addCurveLoop([occ.addLine(pts[k], pts[(k + 1) % 4]) for k in range(4)])
        rect = occ.addPlaneSurface([loop])
        place([(2, rect)], sk["plane"])
        copy = occ.copy(faces)
        try:
            out, _ = occ.intersect(copy, [(2, rect)], removeObject=True, removeTool=True)
        except Exception:
            out = []
        occ.synchronize()
        out = [x for x in out if x[0] == 2]
        halves.append((sum(occ.getMass(2, t) for _, t in out), out))
    total = sum(occ.getMass(2, t) for _, t in faces)
    keep = max(halves, key=lambda h: h[0])
    if keep[0] > total * (1 - 1e-9):
        for _, out in halves:
            if out:
                occ.remove(out, recursive=True)
        return faces
    for h in halves:
        if h is not keep and h[1]:
            occ.remove(h[1], recursive=True)
    occ.remove(faces, recursive=True)
    occ.synchronize()
    warn.append("Die Kontur reicht über die Drehachse – gedreht wird nur die Hälfte auf einer Seite (bei Schnittzeichnungen richtig)")
    return keep[1]


def tools_revolve(f, sketches, warn=None):
    sk = sketch_of(f, sketches, "Drehen")
    ax = f.get("axis")
    if not ax:
        raise Problem("Drehen: Drehachse fehlt – eine Linie der Skizze als Achse wählen")
    faces, _ = sketch_faces(sk, f.get("regions"), "Drehen", f.get("fills"))
    faces = half_plane(faces, sk, ax, warn if warn is not None else [])
    if not faces:
        raise Problem("Drehen: Neben der Achse liegt keine Fläche")
    p = to3d(sk["plane"], ax["a"])
    q = to3d(sk["plane"], ax["b"])
    if norm(sub(q, p)) < 1e-9:
        raise Problem("Drehen: Die Achse hat keine Länge")
    a = unit(sub(q, p))
    if f.get("_mirrored"):
        a = mul(a, -1.0)
    ang = math.radians(float(f.get("angle") or 360))
    if ang <= 0:
        raise Problem("Drehen: Winkel muss größer als 0 sein")
    ang = min(ang, TWO_PI)
    if f.get("symmetric") and ang < TWO_PI:
        occ.rotate(faces, p[0], p[1], p[2], a[0], a[1], a[2], -ang / 2)
    try:
        out = occ.revolve(faces, p[0], p[1], p[2], a[0], a[1], a[2], ang)
    except Exception:
        raise Problem("Drehen: Die Kontur darf die Drehachse nicht kreuzen")
    return [x for x in out if x[0] == 3]


def tools_hole(f, sketches):
    sk = sketch_of(f, sketches, "Bohrung")
    pts = list(sk.get("pts") or [])
    if not pts:
        pts = [e["c"] for e in sk.get("ents") or [] if e["t"] == "circle"]
    if not pts:
        raise Problem("Bohrung: In der Skizze ist kein Punkt – Punkte setzen, wo gebohrt werden soll")
    d = float(f.get("diameter") or 0)
    if d <= 0:
        raise Problem("Bohrung: Durchmesser muss größer als 0 sein")
    r = d / 2
    _, _, _, n = plane_basis(sk["plane"])
    a = mul(n, 1.0 if f.get("flip") else -1.0)  # in das Material hinein
    size = diag()
    through = bool(f.get("through"))
    depth = 2 * size if through else float(f.get("depth") or 0)
    if depth <= 0:
        raise Problem("Bohrung: Tiefe muss größer als 0 sein")
    ext = 1e-3 * d
    sink = f.get("sink") or {}
    tools = []
    for p2 in pts:
        p = to3d(sk["plane"], p2)
        s = sub(p, mul(a, ext))
        parts = [occ.addCylinder(s[0], s[1], s[2], a[0] * (depth + ext), a[1] * (depth + ext), a[2] * (depth + ext), r)]
        if not through and f.get("tip", True):
            h = r / math.tan(math.radians(59))
            e = add(p, mul(a, depth))
            parts.append(occ.addCone(e[0], e[1], e[2], a[0] * h, a[1] * h, a[2] * h, r, 0))
        kind = sink.get("kind", "none")
        if kind == "cone":
            D = float(sink.get("d") or 0)
            half = math.radians(float(sink.get("angle") or 90) / 2)
            if D <= d:
                raise Problem("Bohrung: Senkdurchmesser muss größer als der Bohrungsdurchmesser sein")
            h = (D / 2 - r) / math.tan(half)
            parts.append(occ.addCone(p[0], p[1], p[2], a[0] * h, a[1] * h, a[2] * h, D / 2, r))
            parts.append(occ.addCylinder(s[0], s[1], s[2], a[0] * ext, a[1] * ext, a[2] * ext, D / 2))
        elif kind == "cyl":
            D = float(sink.get("d") or 0)
            t = float(sink.get("depth") or 0)
            if D <= d or t <= 0:
                raise Problem("Bohrung: Senkung braucht einen größeren Durchmesser und eine Tiefe")
            parts.append(occ.addCylinder(s[0], s[1], s[2], a[0] * (t + ext), a[1] * (t + ext), a[2] * (t + ext), D / 2))
        if len(parts) > 1:
            out, _ = occ.fuse([(3, parts[0])], [(3, x) for x in parts[1:]])
            tools += [x for x in out if x[0] == 3]
        else:
            tools.append((3, parts[0]))
    return tools


TOOLS = {"extrude": tools_extrude, "revolve": tools_revolve, "hole": tools_hole}


def mode_of(f):
    return "cut" if f["type"] == "hole" else f.get("mode", "add")


# --- Kanten und Flächen wiederfinden ----------------------------------------------------------


def curve_mid(c):
    lo, hi = gmsh.model.getParametrizationBounds(1, c)
    m = 0.5 * (lo[0] + hi[0])
    p = gmsh.model.getValue(1, c, [m])
    d = gmsh.model.getDerivative(1, c, [m])
    return list(p), unit(list(d))


def find_curve(ref, what):
    """Kante wiederfinden: nächste Mitte mit passender Richtung. Mit Art (Linie/Kreis, Radius) auch weiter weg,
    wenn sich davor etwas geändert hat (z. B. Platte dicker → obere Kante höher)."""
    size = diag()
    cand = []
    for _, c in gmsh.model.getEntities(1):
        mid, d = curve_mid(c)
        cand.append((math.dist(mid, ref["mid"]), c, d))
    cand.sort(key=lambda x: x[0])
    tol = max(1e-3, 0.05 * size)
    parallel = lambda d: not ref.get("dir") or abs(dot(d, ref["dir"])) > 0.9
    for dist, c, d in cand:
        if dist > tol:
            break
        if parallel(d):
            return c
    if ref.get("kind"):
        for dist, c, d in cand:
            if dist > 0.25 * size:
                break
            if ref.get("dir") and abs(dot(d, ref["dir"])) < 0.999:
                continue
            kind, _, ci = classify_curve(c, size)
            if kind != ref["kind"]:
                continue
            if kind == "circle" and ref.get("radius") and ci and abs(ci["radius"] - ref["radius"]) > 1e-3 * max(1.0, ref["radius"]):
                continue
            if kind == "line" and ref.get("length") and abs(occ.getMass(1, c) - ref["length"]) > 0.02 * ref["length"] + 1e-6 * size:
                continue
            return c
    raise Problem(f"{what}: eine gewählte Kante gibt es nicht mehr – im Feature neu wählen")


def surface_kind(t):
    """Art einer Fläche geometrisch: ("plane", Normale) bzw. ("cylinder", Achse, Radius) bzw. ("other",)."""
    lo, hi = gmsh.model.getParametrizationBounds(2, t)
    uv = [x for fu, fv in ((0.3, 0.3), (0.5, 0.5), (0.7, 0.6), (0.4, 0.8)) for x in (lo[0] + fu * (hi[0] - lo[0]), lo[1] + fv * (hi[1] - lo[1]))]
    ns = gmsh.model.getNormal(t, uv)
    n = [list(ns[3 * k : 3 * k + 3]) for k in range(4)]
    if all(abs(abs(dot(n[0], m)) - 1) < 1e-7 for m in n[1:]):
        return ("plane", unit(n[0]))
    pts = gmsh.model.getValue(2, t, uv)
    cy = fit_cylinder(n, [list(pts[3 * k : 3 * k + 3]) for k in range(4)], diag())
    return ("cylinder", cy["axis"], cy["radius"]) if cy else ("other",)


def find_surface(center, what, hint=None):
    """Fläche wiederfinden: nächster Schwerpunkt. Mit Hinweis (Art, Normale/Achse, Radius) auch weiter weg, wenn
    nur eine Fläche gleicher Art und Ausrichtung passt – z. B. wenn eine Extrusion davor dicker geworden ist."""
    cand = []
    for _, t in gmsh.model.getEntities(2):
        cand.append((math.dist(occ.getCenterOfMass(2, t), center), t))
    if not cand:
        raise Problem(f"{what}: eine gewählte Fläche gibt es nicht mehr – im Feature neu wählen")
    cand.sort()
    d0, t0 = cand[0]
    near = max(1.0, 0.02 * diag())
    if not hint or not hint.get("kind"):
        if d0 > near:
            raise Problem(f"{what}: eine gewählte Fläche gibt es nicht mehr – im Feature neu wählen")
        return t0

    def same(t):
        k = surface_kind(t)
        if hint["kind"] == "plane" and k[0] == "plane" and hint.get("normal"):
            return abs(dot(k[1], unit(hint["normal"]))) > 0.9995
        if hint["kind"] == "cylinder" and k[0] == "cylinder" and hint.get("radius"):
            ok_axis = not hint.get("axis") or abs(dot(k[1], unit(hint["axis"]))) > 0.9995
            return ok_axis and abs(k[2] - hint["radius"]) <= 1e-3 * max(1.0, hint["radius"])
        return hint["kind"] == "other" and k[0] == "other"

    far = 0.25 * diag()
    for d, t in cand:
        if d > far:
            break
        if same(t):
            return t
    if d0 <= near:
        return t0
    raise Problem(f"{what}: eine gewählte Fläche gibt es nicht mehr – im Feature neu wählen")


def owners(dim, tag):
    """Körper, zu denen eine Kante bzw. Fläche gehört."""
    surfs = [tag] if dim == 2 else list(gmsh.model.getAdjacencies(1, tag)[0])
    vols = set()
    for s in surfs:
        vols.update(int(v) for v in gmsh.model.getAdjacencies(2, s)[0])
    return vols


def tangent_chain(curves):
    """Kanten um die tangential anschließenden Kanten erweitern (wie im CAD üblich)."""
    done = set(curves)
    todo = list(curves)
    while todo:
        c = todo.pop()
        vols = owners(1, c)
        lo, hi = gmsh.model.getParametrizationBounds(1, c)
        for t_end in (lo[0], hi[0]):
            p = gmsh.model.getValue(1, c, [t_end])
            d = unit(list(gmsh.model.getDerivative(1, c, [t_end])))
            e = 1e-6 * diag() + 1e-9
            for _, o in gmsh.model.getEntitiesInBoundingBox(p[0] - e, p[1] - e, p[2] - e, p[0] + e, p[1] + e, p[2] + e, 1):
                if o in done or not (owners(1, o) & vols):
                    continue
                lo2, hi2 = gmsh.model.getParametrizationBounds(1, o)
                for t2 in (lo2[0], hi2[0]):
                    if math.dist(gmsh.model.getValue(1, o, [t2]), p) < 10 * e:
                        d2 = unit(list(gmsh.model.getDerivative(1, o, [t2])))
                        if abs(dot(d, d2)) > 0.9998:
                            done.add(o)
                            todo.append(o)
    return sorted(done)


def per_volume(curves):
    groups = {}
    for c in curves:
        for v in owners(1, c):
            groups.setdefault(v, []).append(c)
            break
    return groups


# --- Features ---------------------------------------------------------------------------------


def feat_tool(f, sketches, warn):
    tools = TOOLS[f["type"]](f, sketches, warn) if f["type"] == "revolve" else TOOLS[f["type"]](f, sketches)
    combine(mode_of(f), tools, warn)


def feat_fillet(f, sketches, warn):
    r = float(f.get("radius") or 0)
    if r <= 0:
        raise Problem("Verrunden: Radius muss größer als 0 sein")
    if not f.get("edges"):
        raise Problem("Verrunden: keine Kante gewählt")
    curves = tangent_chain([find_curve(e, "Verrunden") for e in f["edges"]])
    for v, cs in per_volume(curves).items():
        try:
            occ.fillet([v], cs, [r], removeVolume=True)
        except Exception:
            raise Problem(f"Verrunden: Radius {r:g} mm lässt sich hier nicht erzeugen – zu groß für die angrenzenden Flächen?")
        occ.synchronize()


def feat_chamfer(f, sketches, warn):
    d = float(f.get("distance") or 0)
    if d <= 0:
        raise Problem("Fase: Breite muss größer als 0 sein")
    if not f.get("edges"):
        raise Problem("Fase: keine Kante gewählt")
    curves = tangent_chain([find_curve(e, "Fase") for e in f["edges"]])
    for v, cs in per_volume(curves).items():
        surfs = [int(next(s for s in gmsh.model.getAdjacencies(1, c)[0] if v in gmsh.model.getAdjacencies(2, s)[0])) for c in cs]
        try:
            occ.chamfer([v], cs, surfs, [d], removeVolume=True)
        except Exception:
            raise Problem(f"Fase: {d:g} mm lässt sich hier nicht erzeugen – zu groß für die angrenzenden Flächen?")
        occ.synchronize()


def instances(f):
    """Abbildungen eines Musters (ohne das Original): Liste von Funktionen, die Körper verschieben."""
    out = []
    if f["kind"] == "linear":
        n1 = int(f.get("count") or 1)
        n2 = int(f.get("count2") or 1) if f.get("dir2") else 1
        d1 = mul(unit(f["dir"]), float(f.get("spacing") or 0))
        d2 = mul(unit(f["dir2"]), float(f.get("spacing2") or 0)) if f.get("dir2") else [0, 0, 0]
        if n1 < 1 or n2 < 1 or n1 * n2 < 2:
            raise Problem("Muster: Anzahl muss mindestens 2 sein")
        if n1 * n2 > 400:
            raise Problem("Muster: höchstens 400 Stück")
        if norm(d1) < 1e-9 and n1 > 1:
            raise Problem("Muster: Abstand muss größer als 0 sein")
        for i in range(n1):
            for j in range(n2):
                if i or j:
                    t = add(mul(d1, i), mul(d2, j))
                    out.append(lambda ents, t=t: occ.translate(ents, t[0], t[1], t[2]))
    else:
        n = int(f.get("count") or 1)
        if n < 2:
            raise Problem("Muster: Anzahl muss mindestens 2 sein")
        if n > 400:
            raise Problem("Muster: höchstens 400 Stück")
        total = math.radians(float(f.get("angle") or 360))
        step = total / n if abs(total - TWO_PI) < 1e-9 else total / (n - 1)
        p, a = f["axis"]["point"], unit(f["axis"]["dir"])
        for i in range(1, n):
            out.append(lambda ents, i=i: occ.rotate(ents, p[0], p[1], p[2], a[0], a[1], a[2], i * step))
    return out


def repeat(f, moves, sketches, by_id, warn, what):
    src = f.get("features")
    if src == "body":
        bodies = volumes()
        if not bodies:
            raise Problem(f"{what}: Es gibt noch keinen Körper")
        copies = []
        for mv in moves:
            c = occ.copy(bodies)
            mv(c)
            copies += c
        occ.fuse(bodies, copies)
        occ.synchronize()
        return
    if not src:
        raise Problem(f"{what}: kein Feature gewählt")
    for fid in src:
        g = by_id.get(fid)
        if g is None:
            raise Problem(f"{what}: Das gewählte Feature fehlt (gelöscht oder unterdrückt?)")
        if g["type"] not in TOOLS:
            raise Problem(f"{what}: geht für Extrudieren, Drehen und Bohrung – oder für den ganzen Körper")
        tools = []
        for mv in moves:
            t = TOOLS[g["type"]](g, sketches)
            mv(t)
            tools += t
        combine(mode_of(g), tools, warn)


def feat_pattern(f, sketches, warn, by_id):
    repeat(f, instances(f), sketches, by_id, warn, "Muster")


def reflect_point(p, o, n):
    return sub(p, mul(n, 2 * dot(sub(p, o), n)))


def reflect_vec(a, n):
    return sub(a, mul(n, 2 * dot(a, n)))


def mirrored_feature(g, sketches, o, n):
    """Feature samt Skizze an der Ebene (o, n) spiegeln – als Daten, damit die Geometrie exakt bleibt."""
    sk = sketches.get(g.get("sketch"))
    if sk is None:
        raise Problem("Spiegeln: Skizze des Features fehlt")
    _, u, _, nn = plane_basis(sk["plane"])
    sk2 = dict(sk)
    sk2["id"] = ("spiegel", sk["id"])
    sk2["plane"] = {"origin": reflect_point(sk["plane"]["origin"], o, n), "u": reflect_vec(u, n), "normal": mul(reflect_vec(nn, n), -1.0)}
    g2 = dict(g)
    g2["sketch"] = sk2["id"]
    if g["type"] == "extrude":
        g2["dir"] = -(g.get("dir") or 1)
    elif g["type"] == "hole":
        g2["flip"] = not g.get("flip")
    elif g["type"] == "revolve":
        g2["_mirrored"] = not g.get("_mirrored")
    return g2, {**sketches, sk2["id"]: sk2}


def feat_mirror(f, sketches, warn, by_id):
    pl = f.get("plane")
    if not pl:
        raise Problem("Spiegeln: Spiegelebene fehlt")
    n = unit(pl["normal"])
    o = pl["origin"]
    src = f.get("features")
    if src == "body":
        bodies = volumes()
        if not bodies:
            raise Problem("Spiegeln: Es gibt noch keinen Körper")
        c = occ.copy(bodies)
        occ.mirror(c, n[0], n[1], n[2], -dot(n, o))
        occ.fuse(bodies, c)
        occ.synchronize()
        return
    if not src:
        raise Problem("Spiegeln: kein Feature gewählt")
    for fid in src:
        g = by_id.get(fid)
        if g is None:
            raise Problem("Spiegeln: Das gewählte Feature fehlt (gelöscht oder unterdrückt?)")
        if g["type"] not in TOOLS:
            raise Problem("Spiegeln: geht für Extrudieren, Drehen und Bohrung – oder für den ganzen Körper")
        g2, sk2 = mirrored_feature(g, sketches, o, n)
        combine(mode_of(g), TOOLS[g["type"]](g2, sk2), warn)


def feat_removefaces(f, sketches, warn):
    if not f.get("faces"):
        raise Problem("Flächen entfernen: keine Fläche gewählt")
    tags = sorted({find_surface(x["center"], "Flächen entfernen", x) for x in f["faces"]})
    vol0, nsurf0 = total_volume(), len(gmsh.model.getEntities(2))
    groups = {}
    for t in tags:
        for v in owners(2, t):
            groups.setdefault(v, []).append(t)
    for v, ts in groups.items():
        try:
            occ.defeature([v], ts, removeVolume=True)
        except Exception:
            raise Problem("Flächen entfernen: Die Lücke lässt sich nicht schließen – zusammengehörige Flächen gemeinsam wählen (z. B. die ganze Bohrung)")
        occ.synchronize()
    if abs(total_volume() - vol0) < 1e-9 * max(vol0, 1.0) and len(gmsh.model.getEntities(2)) == nsurf0:
        warn.append("Es hat sich nichts geändert – Flächen einer Bohrung, Tasche oder Verrundung wählen (eine Außenfläche lässt sich nicht entfernen)")


def feat_moveface(f, sketches, warn):
    dist = float(f.get("distance") or 0)
    if dist == 0:
        raise Problem("Fläche verschieben: Abstand angeben (positiv = nach außen)")
    if not f.get("faces"):
        raise Problem("Fläche verschieben: keine Fläche gewählt")
    for x in f["faces"]:
        t = find_surface(x["center"], "Fläche verschieben", x)
        if not is_planar(t):
            raise Problem("Fläche verschieben: geht nur für ebene Flächen")
        n = outward_normal(t)
        c = occ.copy([(2, t)])
        if dist < 0:
            e = 1e-5 * diag()
            occ.translate(c, n[0] * e, n[1] * e, n[2] * e)
            out = occ.extrude(c, n[0] * (dist - e), n[1] * (dist - e), n[2] * (dist - e))
        else:
            out = occ.extrude(c, n[0] * dist, n[1] * dist, n[2] * dist)
        combine("add" if dist > 0 else "cut", [y for y in out if y[0] == 3], [])
        cleanup()


def feat_refillet(f, sketches, warn):
    """Radius eines importierten Teils ändern: Verrundung entfernen, scharfe Kante neu verrunden."""
    axis = unit(f["axis"])
    tags = sorted({find_surface(c, "Radius ändern") for c in f["surfaces"]})
    boxes = [gmsh.model.getBoundingBox(2, t) for t in tags]
    try:
        occ.defeature([t for _, t in volumes()], tags, removeVolume=True)
    except Exception:
        raise Problem("Radius ändern: Die Verrundung lässt sich nicht entfernen")
    occ.synchronize()
    r = float(f.get("radius") or 0)
    if r <= 0:
        return
    e = 1e-3 * max(1.0, diag())
    edges = set()
    for b in boxes:
        for _, t in gmsh.model.getEntitiesInBoundingBox(b[0] - e, b[1] - e, b[2] - e, b[3] + e, b[4] + e, b[5] + e, 1):
            if gmsh.model.getType(1, t) != "Line":
                continue
            p = [gmsh.model.getValue(0, abs(q), []) for _, q in gmsh.model.getBoundary([(1, t)])]
            if len(p) == 2 and abs(dot(unit(sub(p[1], p[0])), axis)) > 0.999:
                edges.add(t)
    if not edges:
        raise Problem("Radius ändern: Kante für die neue Verrundung nicht gefunden")
    try:
        for v, cs in per_volume(sorted(edges)).items():
            occ.fillet([v], cs, [r], removeVolume=True)
            occ.synchronize()
    except Exception:
        raise Problem(f"Radius ändern: {r:g} mm lässt sich hier nicht erzeugen – zu groß für die angrenzenden Flächen?")


def feat_rehole(f, sketches, warn):
    """Bohrung eines importierten Teils ändern: schließen, mit neuem Durchmesser bohren (0 = zu)."""
    tags = sorted({find_surface(c, "Bohrung ändern") for c in f["surfaces"]})
    try:
        occ.defeature([t for _, t in volumes()], tags, removeVolume=True)
    except Exception:
        raise Problem("Bohrung ändern: Die Bohrung lässt sich nicht schließen")
    occ.synchronize()
    d = float(f.get("diameter") or 0)
    if d <= 0:
        return
    a = unit(f["axis"])
    L = 2 * diag()
    p = sub(f["origin"], mul(a, L / 2))
    tool = occ.addCylinder(p[0], p[1], p[2], a[0] * L, a[1] * L, a[2] * L, d / 2)
    combine("cut", [(3, tool)], warn)


FEATURES = {
    "extrude": feat_tool,
    "revolve": feat_tool,
    "hole": feat_tool,
    "fillet": feat_fillet,
    "chamfer": feat_chamfer,
    "removefaces": feat_removefaces,
    "moveface": feat_moveface,
    "refillet": feat_refillet,
    "rehole": feat_rehole,
}

# --- Darstellung ------------------------------------------------------------------------------


def outward_normal(surf, vols=None):
    """Normale einer Fläche, vom Material weg."""
    lo, hi = gmsh.model.getParametrizationBounds(2, surf)
    best = None
    for fu, fv in ((0.5, 0.5), (0.31, 0.37), (0.71, 0.63), (0.2, 0.8), (0.8, 0.2)):
        uv = [lo[0] + fu * (hi[0] - lo[0]), lo[1] + fv * (hi[1] - lo[1])]
        p = list(gmsh.model.getValue(2, surf, uv))
        if gmsh.model.isInside(2, surf, p):
            best = (uv, p)
            break
    if best is None:
        uv = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1])]
        best = (uv, list(gmsh.model.getValue(2, surf, uv)))
    uv, p = best
    n = unit(list(gmsh.model.getNormal(surf, uv)))
    e = 1e-4 * diag()
    for v in vols if vols is not None else owners(2, surf):
        if gmsh.model.isInside(3, v, add(p, mul(n, e))) and not gmsh.model.isInside(3, v, sub(p, mul(n, e))):
            return mul(n, -1.0)
    return n


def is_planar(surf):
    lo, hi = gmsh.model.getParametrizationBounds(2, surf)
    uv = [lo[0] + f * (hi[0] - lo[0]) if k % 2 == 0 else lo[1] + f * (hi[1] - lo[1]) for f2 in ((0.2, 0.3), (0.5, 0.5), (0.8, 0.6), (0.4, 0.9)) for k, f in enumerate(f2)]
    ns = gmsh.model.getNormal(surf, uv)
    return all(abs(abs(dot(ns[0:3], ns[3 * k : 3 * k + 3])) - 1) < 1e-9 for k in range(1, 4))


def circle_of(c):
    """Mittelpunkt, Achse und Radius einer Kreiskante."""
    lo, hi = gmsh.model.getParametrizationBounds(1, c)
    ts = [lo[0] + (hi[0] - lo[0]) * k for k in (0.0, 0.31, 0.67)]
    q = gmsh.model.getValue(1, c, ts)
    p0, p1, p2 = q[0:3], q[3:6], q[6:9]
    a, b = sub(p1, p0), sub(p2, p0)
    n = cross(a, b)
    n2 = dot(n, n)
    if n2 < 1e-18:
        return None
    ctr = add(p0, mul(add(mul(cross(n, a), dot(b, b)), mul(cross(b, n), dot(a, a))), 1 / (2 * n2)))
    return {"center": ctr, "axis": unit(n), "radius": math.dist(ctr, p0)}


def eigen_sym3(m):
    """Eigenwerte und -vektoren einer symmetrischen 3×3-Matrix (Jacobi), aufsteigend sortiert."""
    a = [row[:] for row in m]
    v = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    for _ in range(50):
        p, q = max(((0, 1), (0, 2), (1, 2)), key=lambda ij: abs(a[ij[0]][ij[1]]))
        if abs(a[p][q]) < 1e-15:
            break
        th = 0.5 * math.atan2(2 * a[p][q], a[q][q] - a[p][p])
        c, sn = math.cos(th), math.sin(th)
        for k in range(3):
            akp, akq = a[k][p], a[k][q]
            a[k][p], a[k][q] = c * akp - sn * akq, sn * akp + c * akq
        for k in range(3):
            apk, aqk = a[p][k], a[q][k]
            a[p][k], a[q][k] = c * apk - sn * aqk, sn * apk + c * aqk
        for k in range(3):
            vkp, vkq = v[k][p], v[k][q]
            v[k][p], v[k][q] = c * vkp - sn * vkq, sn * vkp + c * vkq
    order = sorted(range(3), key=lambda i: a[i][i])
    return [a[i][i] for i in order], [[v[k][i] for k in range(3)] for i in order]


def solve3(m, r):
    d = dot(m[0], cross(m[1], m[2]))
    if abs(d) < 1e-300:
        return None
    cols = [[m[i][j] for i in range(3)] for j in range(3)]
    out = []
    for j in range(3):
        c = [cols[k] if k != j else r for k in range(3)]
        out.append(dot(c[0], cross(c[1], c[2])) / d)
    return out


def fit_cylinder(normals, pts, size):
    """Zylinder aus Dreiecksnormalen und Punkten: Achse ⟂ zu allen Normalen, Punkte auf einem Kreis."""
    m = [[sum(n[i] * n[j] for n in normals) for j in range(3)] for i in range(3)]
    vals, vecs = eigen_sym3(m)
    if vals[2] <= 0 or vals[0] > 1e-8 * vals[2] or vals[1] < 1e-4 * vals[2]:
        return None
    a = unit(vecs[0])
    k = min(range(3), key=lambda i: abs(a[i]))
    e = [0.0, 0.0, 0.0]
    e[k] = 1.0
    e1 = unit(sub(e, mul(a, dot(e, a))))
    e2 = cross(a, e1)
    xy = [(dot(p, e1), dot(p, e2)) for p in pts]
    mx = sum(x for x, _ in xy) / len(xy)
    my = sum(y for _, y in xy) / len(xy)
    xy = [(x - mx, y - my) for x, y in xy]
    # Kreis: x² + y² = 2·cx·x + 2·cy·y + c
    A = [[0.0] * 3 for _ in range(3)]
    b = [0.0] * 3
    for x, y in xy:
        row = [2 * x, 2 * y, 1.0]
        z = x * x + y * y
        for i in range(3):
            b[i] += row[i] * z
            for j in range(3):
                A[i][j] += row[i] * row[j]
    sol = solve3(A, b)
    if not sol:
        return None
    cx, cy, c = sol
    r2 = c + cx * cx + cy * cy
    if r2 <= 0:
        return None
    r = math.sqrt(r2)
    if max(abs(math.hypot(x - cx, y - cy) - r) for x, y in xy) > 1e-5 * size + 1e-7:
        return None
    center = add(mul(e1, cx + mx), mul(e2, cy + my))
    return {"axis": a, "radius": r, "center": center}


def classify_curve(c, size):
    """Kante abtasten und als Linie, Kreis(bogen) oder sonstige Kurve einordnen (unabhängig von der
    Darstellung im Kern – gespiegelte Körper bestehen aus Freiformkurven)."""
    lo, hi = gmsh.model.getParametrizationBounds(1, c)
    n = 32
    xyz = gmsh.model.getValue(1, c, [lo[0] + (hi[0] - lo[0]) * k / n for k in range(n + 1)])
    pts = [list(xyz[3 * k : 3 * k + 3]) for k in range(n + 1)]
    tol = 1e-6 * size + 1e-9
    chord = sub(pts[-1], pts[0])
    L = norm(chord)
    if L > tol and all(norm(cross(sub(p, pts[0]), chord)) / L < tol for p in pts):
        return "line", [pts[0], pts[-1]], None
    ci = circle_of(c)
    if ci and all(abs(math.dist(p, ci["center"]) - ci["radius"]) < 10 * tol and abs(dot(sub(p, ci["center"]), ci["axis"])) < 10 * tol for p in pts):
        return "circle", pts, ci
    return "other", pts, None


def tessellate():
    occ.synchronize()
    # über eine STEP-Datei neu laden: frisch gedrehte Flächen lassen sich sonst manchmal nicht vernetzen
    # („Impossible to mesh periodic surface“); der STEP-Leser repariert sie
    import tempfile

    tmp = os.path.join(tempfile.gettempdir(), f"projekt-fem-tess-{os.getpid()}.step")
    gmsh.write(tmp)
    gmsh.clear()
    occ.importShapes(tmp)
    occ.synchronize()
    os.remove(tmp)
    size = diag()
    q = float(job.get("quality") or 1.0)
    gmsh.option.setNumber("General.NumThreads", min(8, os.cpu_count() or 1))
    gmsh.option.setNumber("Mesh.MeshSizeMax", size / 8)
    gmsh.option.setNumber("Mesh.MeshSizeMin", size / 800)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 36 * q)
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber("Mesh.Algorithm", 5)
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.model.mesh.generate(2)
    tags, coords, _ = gmsh.model.mesh.getNodes()
    index = {int(t): i for i, t in enumerate(tags)}
    positions = [round(float(c), 6) for c in coords]

    def P(i):
        return positions[3 * i : 3 * i + 3]

    def tri_normal(tri):
        a, b, c = P(tri[0]), P(tri[1]), P(tri[2])
        return cross(sub(b, a), sub(c, a))

    triangles, tri_surface, surfaces, curves = [], [], [], []
    vols = [t for _, t in volumes()]
    body_of = {}
    for bi, v in enumerate(vols):
        for _, s in gmsh.model.getBoundary([(3, v)], oriented=False):
            body_of[abs(s)] = bi
    tris_of = {}
    signed = [0.0] * len(vols)
    for _, s in gmsh.model.getEntities(2):
        if s not in body_of:
            continue
        types, _, nodes = gmsh.model.mesh.getElements(2, s)
        mine = []
        for et, nn in zip(types, nodes):
            if et == 2:
                mine += [index[int(n)] for n in nn]
        tris_of[s] = mine
        triangles += mine
        tri_surface += [s] * (len(mine) // 3)
        for k in range(0, len(mine), 3):
            a, b, c = P(mine[k]), P(mine[k + 1]), P(mine[k + 2])
            signed[body_of[s]] += dot(a, cross(b, c)) / 6
    for _, s in gmsh.model.getEntities(2):
        if s not in body_of:
            continue
        mine = tris_of[s]
        flip = -1.0 if signed[body_of[s]] < 0 else 1.0  # Dreiecke zeigen sonst nach außen
        info = {"tag": s, "kind": "other", "body": body_of[s], "center": list(occ.getCenterOfMass(2, s)), "area": occ.getMass(2, s)}
        tn = [tri_normal(mine[k : k + 3]) for k in range(0, len(mine), 3)]
        tn = [(norm(n), n) for n in tn]
        tn = [(a2, mul(n, flip / a2)) for a2, n in tn if a2 > 0]
        if tn:
            big = max(range(len(tn)), key=lambda k: tn[k][0])
            n0 = tn[big][1]
            tri = mine[3 * big : 3 * big + 3]
            p0 = mul(add(add(P(tri[0]), P(tri[1])), P(tri[2])), 1 / 3)
            nodes = sorted(set(mine))
            if all(norm(sub(n, n0)) < 1e-5 for _, n in tn) and all(abs(dot(sub(P(i), p0), n0)) < 1e-6 * size + 1e-9 for i in nodes):
                info.update(kind="plane", normal=n0, point=p0)
            else:
                # Normalen und Punkte der zugrunde liegenden Fläche (Dreiecke liegen schräg auf dem Zylinder)
                lo, hi = gmsh.model.getParametrizationBounds(2, s)
                uv = [x for i in range(5) for j in range(5) for x in (lo[0] + (hi[0] - lo[0]) * (i + 0.5) / 5, lo[1] + (hi[1] - lo[1]) * (j + 0.5) / 5)]
                sn = gmsh.model.getNormal(s, uv)
                sp = gmsh.model.getValue(2, s, uv)
                cy = fit_cylinder([list(sn[3 * k : 3 * k + 3]) for k in range(25)], [list(sp[3 * k : 3 * k + 3]) for k in range(25)], size)
                if cy:
                    ext = [dot(sub(P(i), cy["center"]), cy["axis"]) for i in nodes]
                    length = max(ext) - min(ext)
                    foot = add(cy["center"], mul(cy["axis"], dot(sub(p0, cy["center"]), cy["axis"])))
                    info.update(kind="cylinder", axis=cy["axis"], radius=cy["radius"], origin=add(cy["center"], mul(cy["axis"], min(ext))), length=length, hole=dot(n0, sub(p0, foot)) < 0, full=abs(info["area"] - TWO_PI * cy["radius"] * length) < 0.03 * info["area"])
        surfaces.append(info)
    for _, c in gmsh.model.getEntities(1):
        adj = [int(s) for s in gmsh.model.getAdjacencies(1, c)[0] if int(s) in body_of]
        if not adj:
            continue
        kind, pts, ci = classify_curve(c, size)
        mid, d = curve_mid(c)
        info = {"tag": c, "kind": kind, "pts": [round(float(x), 6) for p in pts for x in p], "mid": mid, "dir": d, "surfaces": adj, "length": occ.getMass(1, c)}
        if ci:
            info.update(ci)
            info["closed"] = math.dist(pts[0], pts[-1]) < 1e-6 * size
        curves.append(info)
    vertices = [list(gmsh.model.getValue(0, p, [])) for _, p in gmsh.model.getEntities(0)]
    gmsh.model.mesh.clear()
    lo = [min(positions[k::3]) for k in range(3)] if positions else [0, 0, 0]
    hi = [max(positions[k::3]) for k in range(3)] if positions else [0, 0, 0]
    return {"positions": positions, "triangles": triangles, "tri_surface": tri_surface, "surfaces": surfaces, "curves": curves, "vertices": vertices, "bbox": [lo, hi], "bodies": len(vols)}


def new_bodies(f, before, warn):
    """Neuer Körper eines Features: Überschneidung mit vorhandenen Teilen abziehen, Namen merken."""
    new = [t for _, t in volumes() if t not in before]
    old = [t for _, t in volumes() if t in before]
    if new and old and f.get("subtract", True):
        tol = 1e-6 * min(occ.getMass(3, t) for t in new + old)
        a = occ.copy([(3, t) for t in new])
        b = occ.copy([(3, t) for t in old])
        try:
            out, _ = occ.intersect(a, b, removeObject=True, removeTool=True)
        except Exception:
            out = []
        occ.synchronize()
        overlap = sum(occ.getMass(3, t) for d, t in out if d == 3)
        if out:
            occ.remove(out, recursive=True)
            occ.synchronize()
        if overlap > tol:
            occ.cut([(3, t) for t in new], [(3, t) for t in old], removeObject=True, removeTool=False)
            occ.synchronize()
            cleanup()
            new = [t for _, t in volumes() if t not in set(old)]
            warn.append(f"überschneidet ein anderes Teil um {overlap:.0f} mm³ – die Überschneidung wurde vom neuen Teil abgezogen")
    if len(new) > 1:
        warn.append(f"besteht aus {len(new)} losen Stücken (Flächen der Skizze hängen nicht zusammen)")
    name = (f.get("bodyName") or "").strip()
    if name:
        for t in new:
            NAMES.append([name, point_in_body(t)])


# --- Ablauf -----------------------------------------------------------------------------------

features = [f for f in job.get("features") or []]
upto = job.get("upto")
if upto is not None:
    features = features[: int(upto)]
by_id = {f["id"]: f for f in features}
cache = job.get("cache")
if cache:
    os.makedirs(cache, exist_ok=True)

base = job.get("base")
seed = ""
if base:
    st = os.stat(base)
    seed = f"{os.path.abspath(base)}|{st.st_mtime_ns}|{st.st_size}"


# Fassung der Zwischenstände: erhöhen, wenn sich ändert, was zu einem Zwischenstand gespeichert wird
CACHE_VERSION = "2"


def key_of(k):
    h = hashlib.sha1((CACHE_VERSION + "\n" + seed + "\n" + json.dumps(features[: k + 1], sort_keys=True)).encode()).hexdigest()
    return os.path.join(cache, h + ".brep")


solid = [k for k, f in enumerate(features) if f["type"] != "sketch"]
start = 0
loaded = False
if cache:
    for k in reversed(solid):
        p = key_of(k)
        if os.path.exists(p):
            try:
                load_state(p)
                os.utime(p)
                start = k + 1
                loaded = True
                break
            except Exception:
                gmsh.clear()
if not loaded and base:
    try:
        occ.importShapes(base)
        occ.synchronize()
    except Exception as ex:
        finish(f"FEHLER Die Ausgangsgeometrie lässt sich nicht lesen ({ex})")

sketches = {f["id"]: f for f in features[:start] if f["type"] == "sketch"}
status = [{"id": f["id"], "ok": True} for f in features[:start]]
if loaded and start:
    # Meldungen (z. B. Warnungen) der zwischengespeicherten Features wieder mitgeben
    try:
        saved = json.load(open(key_of(start - 1) + ".status.json", encoding="utf-8"))
        if [x["id"] for x in saved] == [x["id"] for x in status]:
            status = saved
    except Exception:
        pass
failed = False
for k in range(start, len(features)):
    f = features[k]
    if failed:
        status.append({"id": f["id"], "ok": False, "skipped": True})
        continue
    if f["type"] == "sketch":
        sketches[f["id"]] = f
        status.append({"id": f["id"], "ok": True})
        continue
    warn = []
    good = None
    if cache:
        prev = [j for j in solid if j < k]
        good = key_of(prev[-1]) if prev else os.path.join(cache, "start-" + hashlib.sha1(seed.encode()).hexdigest() + ".brep")
        if not os.path.exists(good):
            save_state(good)
    try:
        before = set(t for _, t in volumes())
        fn = FEATURES.get(f["type"])
        if f["type"] == "pattern":
            feat_pattern(f, sketches, warn, by_id)
        elif f["type"] == "mirror":
            feat_mirror(f, sketches, warn, by_id)
        elif fn:
            fn(f, sketches, warn)
        else:
            raise Problem(f"unbekanntes Feature „{f['type']}“")
        cleanup()
        if not volumes():
            raise Problem("Es ist kein Körper entstanden")
        if f.get("mode") == "new" and f["type"] in ("extrude", "revolve"):
            new_bodies(f, before, warn)
        s = {"id": f["id"], "ok": True}
        if warn:
            s["warn"] = warn
        status.append(s)
        if cache:
            save_state(key_of(k))
            with open(key_of(k) + ".status.json", "w", encoding="utf-8") as fh:
                json.dump(status, fh)
    except Exception as ex:
        msg = str(ex) if isinstance(ex, Problem) else f"{f['type']}: Die Geometrie lässt sich so nicht erzeugen ({str(ex).strip().splitlines()[-1] if str(ex).strip() else type(ex).__name__})"
        status.append({"id": f["id"], "ok": False, "error": msg})
        failed = True
        if good and os.path.exists(good):
            load_state(good)
        else:
            cleanup()

if cache:
    files = sorted((os.path.join(cache, n) for n in os.listdir(cache)), key=os.path.getmtime)
    for p in files[: max(0, len(files) - 400)]:
        try:
            os.remove(p)
        except OSError:
            pass

result = {"status": status, "volume": total_volume(), "bodies": len(volumes())}
rid = job.get("regions_of")
if rid is not None:
    sk = next((f for f in job.get("features") or [] if f["id"] == rid and f["type"] == "sketch"), None)
    regs = []
    if sk:
        try:
            regs = sketch_regions(sk)
            occ.remove([(2, r["tag"]) for r in regs], recursive=True)
        except Exception:
            regs = []
        cleanup()
    result["regions"] = [
        {
            "pt": r["pt"],
            "area": r["area"],
            "loops": r["loops"],
            "evenodd": r["evenodd"],
            "fill": in_fills(r["pt"], sk.get("fills")),
            "groups": sorted({x["group"] for x in sk.get("fills") or [] if isinstance(x, dict) and inside_poly(r["pt"], x["loops"])}),
        }
        for r in regs
    ]

if volumes():
    names = body_names()
    result["bodies_info"] = [{"name": names[i], "volume": occ.getMass(3, t), "center": list(occ.getCenterOfMass(3, t))} for i, (_, t) in enumerate(volumes())]

if job.get("output") and volumes() and not failed:
    cleanup()
    gmsh.write(job["output"])
    step_with_names(job["output"])
    result["step"] = job["output"]

if job.get("tess", True):
    result["tess"] = tessellate() if volumes() else None

with open(job["result"], "w", encoding="utf-8") as fh:
    json.dump(result, fh, separators=(",", ":"))
finish("ERGEBNIS ok")
