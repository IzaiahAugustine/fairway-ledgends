"""Palm trees and desert cacti (Blender space, Z up, metres; base on z=0).

Tree_Palm_A/B/C: curved ringed trunks with a crown of arching, feathered fronds and a few coconuts.
Tree_Saguaro_A/B: ribbed columns with upturned arms.
Bush_Barrel_A: a squat ribbed barrel cactus with a crown of yellow flowers.

All solid geometry with vertex colours (no textures), so they read well up close and bake cleanly
into the game's impostor atlas for the far woodland. The game groups the _A/_B/_C variants into
one kind (Tree_Palm, Tree_Saguaro, Bush_Barrel).
"""
import math

import numpy as np

from env_mesh import MeshAccum, unit

Z = np.array([0.0, 0.0, 1.0])


def _paint(acc, start, fn):
    for i in range(start, len(acc.verts)):
        acc.cols[i] = fn(np.array(acc.verts[i]))


def _sphere(acc, c, r, col, sides=8):
    s = len(acc.verts)
    prof = [(r * math.sin(math.radians(a)), -r * math.cos(math.radians(a))) for a in range(0, 181, 30)]
    prof[0] = (0.0, prof[0][1])
    prof[-1] = (0.0, prof[-1][1])
    frame = (np.asarray(c, float), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), Z)
    acc.lathe(prof, sides, frame=frame)
    for i in range(s, len(acc.verts)):
        acc.cols[i] = col


# ---------------------------------------------------------------------------- palm

def palm(seed, height, lean):
    rng = np.random.default_rng(seed)
    trunk, fronds = MeshAccum(), MeshAccum()
    lean_dir = np.array([1.0, 0.0, 0.0])
    # trunk: a gentle curve (the classic leaning coconut palm), with leaf-scar rings
    n = 30
    pts, radii = [], []
    for i in range(n + 1):
        t = i / n
        sway = lean * height * (0.18 * t * t + 0.05 * math.sin(t * 2.4))
        pts.append(lean_dir * sway + Z * (t * height))
        flare = 0.12 * max(0.0, 1 - t * 9)
        radii.append(0.2 - 0.06 * t + flare)
    s = len(trunk.verts)
    trunk.tube(pts, radii, 10, ring_fn=lambda i, th: 1.0 + (0.045 if i % 2 == 0 else -0.02))

    def trunk_col(p):
        k = 0.85 + 0.15 * math.sin(p[2] * 9.0)
        base = 1 - min(1.0, p[2] / 2.5)
        return (0.16 * k + 0.04 * base, 0.12 * k + 0.02 * base, 0.08 * k)
    _paint(trunk, s, trunk_col)
    top = pts[-1]
    up_dir = unit(pts[-1] - pts[-3])
    # crown shaft and coconuts
    s = len(trunk.verts)
    frame = (top - up_dir * 0.35, np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), Z)
    trunk.lathe([(0.15, 0.0), (0.2, 0.25), (0.17, 0.5), (0.0, 0.62)], 10, frame=frame)
    _paint(trunk, s, lambda p: (0.1, 0.11, 0.04))
    for k in range(int(rng.integers(3, 6))):
        a = rng.uniform(0, 2 * math.pi)
        c = top + np.array([math.cos(a) * 0.24, math.sin(a) * 0.24, -0.15 - rng.uniform(0, 0.15)])
        _sphere(trunk, c, 0.1, (0.13, 0.09, 0.03) if k % 2 else (0.1, 0.13, 0.03))

    # fronds: an arching rib with rows of narrow leaflets hanging off both sides in a shallow V
    nf = 17
    for f in range(nf):
        yaw = 2 * math.pi * f / nf + rng.uniform(-0.15, 0.15)
        dead = f in (3, 11)
        pitch = math.radians(rng.uniform(-40, -15) if dead else rng.uniform(0, 48))
        L = rng.uniform(3.4, 4.4)
        droop = (0.3 if not dead else 0.12) * (1.15 - pitch)
        dirH = np.array([math.cos(yaw), math.sin(yaw), 0.0])
        side = np.cross(Z, dirH)
        K = 26
        rib = []
        for k in range(K + 1):
            sl = k / K * L
            rib.append(top + Z * 0.15 + dirH * (sl * math.cos(pitch)) + Z * (sl * math.sin(pitch) - droop * sl * sl * 0.5))
        green = (0.045, 0.11, 0.022) if not dead else (0.2, 0.15, 0.05)
        tipc = (0.085, 0.17, 0.03) if not dead else (0.26, 0.2, 0.07)
        ribc = (0.09, 0.11, 0.035) if not dead else (0.22, 0.17, 0.06)
        # the rib itself: a thin flat strip
        ids = []
        for k in range(K + 1):
            w = 0.035 * (1 - k / K) + 0.008
            ids.append((fronds.add_vert(rib[k] + side * w, ribc, Z), fronds.add_vert(rib[k] - side * w, ribc, Z)))
        for k in range(K):
            fronds.add_face((ids[k][0], ids[k + 1][0], ids[k + 1][1], ids[k][1]), [(0, 0), (1, 0), (1, 1), (0, 1)])
        fold = math.radians(28 if not dead else 60)
        for k in range(1, K):
            t = k / K
            ribdir = unit(rib[k + 1] - rib[k - 1])
            length = 0.75 * math.sin(math.pi * min(1.0, t * 1.04)) ** 0.55 + 0.08
            col = tuple(green[c] * (1 - t) + tipc[c] * t for c in range(3))
            for sgn in (1, -1):
                jitter = rng.uniform(-0.12, 0.12)
                out = unit(side * sgn * math.cos(fold) + ribdir * (0.45 + jitter) - Z * math.sin(fold))
                hang = -Z * (0.18 * length * length)
                b0, b1 = rib[k] - ribdir * 0.06, rib[k] + ribdir * 0.06
                tip = rib[k] + out * length + hang
                t0, t1 = tip - ribdir * 0.02, tip + ribdir * 0.02
                n = unit(np.cross(out, ribdir) * sgn + Z * 0.6)
                q = [fronds.add_vert(b0, col, n), fronds.add_vert(b1, col, n), fronds.add_vert(t1, col, n), fronds.add_vert(t0, col, n)]
                fronds.add_face(tuple(q) if sgn > 0 else tuple(q[::-1]), [(0, 0), (1, 0), (1, 1), (0, 1)])
    return trunk, fronds


# ---------------------------------------------------------------------------- cacti

def _ribbed(acc, start, axis_pts, ribs, ridge=(0.075, 0.14, 0.05), groove=(0.025, 0.055, 0.02)):
    """Colour a ribbed tube by angle around its (piecewise) axis: light ridges, dark grooves."""
    axis = np.array(axis_pts)
    for i in range(start, len(acc.verts)):
        p = np.array(acc.verts[i])
        j = int(np.argmin(np.linalg.norm(axis - p, axis=1)))
        d = p - axis[j]
        ang = math.atan2(d[1], d[0])
        k = 0.5 + 0.5 * math.cos(ribs * ang)
        acc.cols[i] = tuple(groove[c] + (ridge[c] - groove[c]) * k for c in range(3))


def saguaro(seed, height, arms):
    rng = np.random.default_rng(seed)
    acc = MeshAccum()
    R = 0.3
    ribs = 14
    n = 16
    pts = [np.array([0.02 * math.sin(i * 0.7 + seed), 0.0, height * i / n]) for i in range(n + 1)]
    radii = [R * (1.08 if i == 0 else 1.0) * (1 - 0.1 * (i / n) ** 3) for i in range(n + 1)]
    s = len(acc.verts)
    acc.tube(pts, radii, 28, ring_fn=lambda i, th: 1.0 + 0.07 * math.cos(ribs * th), cap_end=True)
    _ribbed(acc, s, pts, ribs)
    for a in range(arms):
        yaw = 2 * math.pi * a / arms + rng.uniform(-0.5, 0.5)
        out = np.array([math.cos(yaw), math.sin(yaw), 0.0])
        h0 = height * rng.uniform(0.35, 0.55)
        up = height * rng.uniform(0.25, 0.4)
        r = R * 0.68
        base = Z * h0
        path = [base + out * 0.1, base + out * 0.42 + Z * 0.04, base + out * 0.62 + Z * 0.22,
                base + out * 0.7 + Z * 0.5, base + out * 0.72 + Z * (0.5 + up * 0.5), base + out * 0.72 + Z * (0.5 + up)]
        s = len(acc.verts)
        acc.tube(path, [r * 0.95, r, r, r * 0.98, r * 0.95, r * 0.9], 20, ring_fn=lambda i, th: 1.0 + 0.07 * math.cos(12 * th), cap_end=True)
        _ribbed(acc, s, path, 12)
    return acc


def barrel():
    acc = MeshAccum()
    prof = [(0.0, 0.0), (0.2, 0.01), (0.29, 0.12), (0.31, 0.28), (0.27, 0.42), (0.16, 0.52), (0.0, 0.55)]
    s = len(acc.verts)
    acc.lathe(prof, 32)
    ribs = 16
    for i in range(s, len(acc.verts)):
        x, y, z = acc.verts[i]
        ang = math.atan2(y, x)
        k = 1.0 + 0.09 * math.cos(ribs * ang)
        acc.verts[i] = (x * k, y * k, z)
        ridge = 0.5 + 0.5 * math.cos(ribs * ang)
        g = (0.03 + 0.04 * ridge, 0.06 + 0.07 * ridge, 0.025 + 0.025 * ridge)
        acc.cols[i] = g
    # flowers around the crown
    for f in range(7):
        a = 2 * math.pi * f / 7
        _sphere(acc, (math.cos(a) * 0.1, math.sin(a) * 0.1, 0.53), 0.045, (0.95, 0.72, 0.1), sides=6)
    return acc


def build(scene, asset_collection, simple_material, report, new_empty):
    mats = {
        "PalmTrunk": simple_material("PalmTrunk", (1.0, 1.0, 1.0), rough=0.9, vcol=True, spec=0.3),
        "PalmFrond": simple_material("PalmFrond", (1.0, 1.0, 1.0), rough=0.65, vcol=True, double=True, spec=0.4),
        "Cactus": simple_material("Cactus", (1.0, 1.0, 1.0), rough=0.6, vcol=True, spec=0.45),
    }

    def emit(name, parts):
        coll = asset_collection(scene, name)
        root = new_empty(name, coll, 0.5)
        tris = 0
        allv = []
        for suffix, (mat, acc) in parts.items():
            acc.to_object(f"{name}_{suffix}", mats[mat], coll, parent=root, colors=True)
            tris += acc.tri_count()
            allv += acc.verts
        v = np.array(allv)
        report[name] = dict(tris=tris, lo=v.min(0), hi=v.max(0))
        print(f"[exotic] {name}: {tris} tris  height {v[:, 2].max():.2f} m")

    for name, seed, h, lean in (("Tree_Palm_A", 3, 9.0, 0.9), ("Tree_Palm_B", 17, 7.5, 0.5), ("Tree_Palm_C", 29, 10.5, 1.2)):
        trunk, fronds = palm(seed, h, lean)
        emit(name, {"Trunk": ("PalmTrunk", trunk), "Fronds": ("PalmFrond", fronds)})
    for name, seed, h, arms in (("Tree_Saguaro_A", 5, 7.0, 3), ("Tree_Saguaro_B", 11, 5.5, 2)):
        emit(name, {"Body": ("Cactus", saguaro(seed, h, arms))})
    emit("Bush_Barrel_A", {"Body": ("Cactus", barrel())})
