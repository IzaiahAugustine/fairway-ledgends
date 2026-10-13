"""Divot assets (Blender space, Z up, metres; +Y = direction of the shot, ball at the origin).

  Divot       the scar left in the turf: bare soil floor at ground level, a raised torn rim of
              soil and root mat around it, ragged grass blades hanging over the rim, and a spray
              of soil crumbs thrown forward. Starts at the ball (y=0) and runs ~0.30 m forward.
  DivotChunk  the strip of turf the club cut out: a slightly curled slab, grass on top with a short
              blade fringe, soil and roots underneath. Centred on the origin, base on z=0.

The game places one Divot per iron/wedge strike from turf and throws a DivotChunk forward, and
removes the grass blades inside the scar (see src/world/divots.ts). Keep the scar footprint in
sync with DIVOT_* in that file: centre y=0.15, half length 0.17, half width 0.055.
"""
import math

import numpy as np
from mathutils import Vector, noise

from env_mesh import MeshAccum, smoothstep

SOIL = (1.0, 1.0, 1.0)     # vertex colours multiply the material colour
CENTER_Y, HALF_L, HALF_W = 0.15, 0.15, 0.048


def _outline(rng, n):
    """Ragged scar outline: squarer at the entry (y=0), torn and frayed at the exit."""
    jit = rng.uniform(-1, 1, n)
    pts = []
    for j in range(n):
        th = 2 * math.pi * j / n
        c, s = math.cos(th), math.sin(th)
        # superellipse (squarish) so the sides run parallel like a real club strike
        e = 0.45
        x = HALF_W * math.copysign(abs(c) ** e, c)
        y = HALF_L * math.copysign(abs(s) ** e, s)
        front = smoothstep(0.0, 1.0, s)          # 0 at entry, 1 at the torn exit
        x *= 1.0 + 0.12 * front
        r = 1.0 + jit[j] * (0.03 + 0.09 * front)
        pts.append(np.array([x * r, CENTER_Y + y * r]))
    return pts


def divot(seed=11):
    rng = np.random.default_rng(seed)
    soil, grass = MeshAccum(), MeshAccum()
    n, rings = 40, 9
    outline = _outline(rng, n)
    c = np.array([0.0, CENTER_Y])
    # ring parameter t: 0 centre .. 1 rim crest .. 1.18 feathered outer edge (on the ground)
    ts = [0.0, 0.3, 0.55, 0.72, 0.84, 0.93, 1.0, 1.08, 1.18]
    assert len(ts) == rings
    idx = []
    for i, t in enumerate(ts):
        row = []
        for j in range(n):
            p2 = c + (outline[j] - c) * t
            y_rel = (p2[1] - (CENTER_Y - HALF_L)) / (2 * HALF_L)    # 0 entry .. 1 exit
            pv = Vector((p2[0] * 40, p2[1] * 40, seed))
            # floor at ground level, scraped deeper toward the exit; rim ridge of torn soil
            if t <= 0.84:
                z = 0.0025 + 0.0015 * noise.noise(pv * 2.0)
            elif t <= 1.0:
                k = smoothstep(0.84, 1.0, t)
                z = 0.0025 + k * (0.010 + 0.004 * y_rel + 0.003 * noise.noise(pv))
            else:
                k = smoothstep(1.0, 1.18, t)
                z = (1 - k) * (0.012 + 0.004 * y_rel) + 0.0004
            # colour: damp dark soil, club scrape streaks along the shot line, darker in the
            # corner where floor meets wall, root-mat brown-green on the rim, bruised turf outside
            streak = 0.5 + 0.5 * math.sin(p2[0] * 260 + 2.0 * noise.noise(pv * 0.5))
            mot = 0.85 + 0.3 * noise.noise(pv * 3.0)
            if t <= 0.84:
                ao = 0.75 + 0.25 * (1 - smoothstep(0.5, 0.84, t))
                v = mot * ao * (0.92 + 0.12 * streak)
                col = (v, v * 0.97, v * 0.93)
            elif t <= 1.0:
                v = mot * (0.7 + 0.45 * smoothstep(0.84, 1.0, t))
                col = (v * 1.05, v, v * 0.85)
            else:
                k = smoothstep(1.0, 1.18, t)
                g = mot * (0.8 - 0.15 * k)
                col = (g * (1.0 - 0.5 * k), g * (1.0 + 0.2 * k), g * (0.85 - 0.35 * k))
            row.append(soil.add_vert((p2[0], p2[1], z), col))
        idx.append(row)
    ci = soil.add_vert((c[0], c[1], 0.003), (0.8, 0.78, 0.74))
    for j in range(n):
        jn = (j + 1) % n
        soil.add_face((ci, idx[1][j], idx[1][jn]), [(0.5, 0.5), (0, 0), (1, 0)])
    for i in range(1, rings - 1):
        for j in range(n):
            jn = (j + 1) % n
            a, b, cc, d = idx[i][j], idx[i][jn], idx[i + 1][jn], idx[i + 1][j]
            # wound so the face normal points up (+Z)
            soil.add_face((a, d, cc, b), [(j / n, i / rings), (j / n, (i + 1) / rings),
                                          ((j + 1) / n, (i + 1) / rings), ((j + 1) / n, i / rings)])

    # soil crumbs: flattened lumps thrown forward and a few to the sides
    for k in range(26):
        fwd = rng.uniform(0.0, 1.0) ** 0.7
        y = CENTER_Y + HALF_L * 0.9 + fwd * 0.42
        x = rng.normal(0, 0.035 + 0.06 * fwd)
        if k < 5:  # a few kicked out of the sides of the scar
            y = rng.uniform(CENTER_Y - HALF_L * 0.6, CENTER_Y + HALF_L)
            x = math.copysign(HALF_W * rng.uniform(1.25, 1.8), rng.uniform(-1, 1))
        r = rng.uniform(0.004, 0.011) * (1.2 - 0.5 * fwd)
        h = r * rng.uniform(0.45, 0.8)
        v = rng.uniform(0.75, 1.05)
        prof = [(0.0, 0.0), (r, 0.0), (r * 0.85, h * 0.6), (r * 0.45, h * 0.95), (0.0, h)]
        ang = rng.uniform(0, math.pi)
        X = np.array([math.cos(ang), math.sin(ang), 0.0])
        Y = np.array([-math.sin(ang), math.cos(ang), 0.0]) * rng.uniform(0.6, 1.0)
        soil.lathe(prof, 6, frame=(np.array([x, y, 0.0]), X, Y, np.array([0, 0, 1.0])),
                   col_fn=lambda rr, zz, v=v: (v, v * 0.96, v * 0.9))

    # torn grass blades along the rim, leaning out over it (thicker on the long sides)
    for j in range(n):
        p = outline[j]
        out = p - c
        out = out / (np.linalg.norm(out) or 1.0)
        for _ in range(rng.integers(2, 5)):
            base_t = rng.uniform(1.0, 1.14)
            b = c + (p - c) * base_t + rng.normal(0, 0.003, 2)
            L = rng.uniform(0.010, 0.026)
            w = rng.uniform(0.0018, 0.003)
            lean = rng.uniform(0.3, 0.9)
            tip = np.array([b[0] + out[0] * L * lean, b[1] + out[1] * L * lean, 0.010 + L * (1 - lean * 0.6)])
            side = np.array([-out[1], out[0], 0.0]) * w
            bz = 0.009
            g = rng.uniform(0.8, 1.15)
            dry = rng.uniform(0, 1) < 0.2
            ccol = (g * 1.4, g * 1.1, g * 0.5) if dry else (g, g, g)
            v0 = grass.add_vert((b[0] - side[0], b[1] - side[1], bz), tuple(x * 0.6 for x in ccol), (0, 0, 1))
            v1 = grass.add_vert((b[0] + side[0], b[1] + side[1], bz), tuple(x * 0.6 for x in ccol), (0, 0, 1))
            v2 = grass.add_vert(tuple(tip), ccol, (0, 0, 1))
            grass.add_face((v0, v1, v2), [(0, 0), (1, 0), (0.5, 1)])
    return soil, grass


def divot_chunk(seed=23):
    """Torn-out turf strip: L x W x T, curled up at both ends, ragged sides."""
    rng = np.random.default_rng(seed)
    soil, turf = MeshAccum(), MeshAccum()
    L, W, T = 0.20, 0.075, 0.018
    nx, ny = 5, 10

    def curl(y):
        return 0.012 * (2 * y / L) ** 2

    def edge_x(y, s):
        return s * (W / 2) * (1 + 0.12 * noise.noise(Vector((y * 60, s * 3.0, seed))))

    def pt(i, j, top):
        y = -L / 2 + L * j / ny
        u = i / nx
        x = edge_x(y, -1) + (edge_x(y, 1) - edge_x(y, -1)) * u
        z = curl(y) + (T * (0.85 + 0.3 * noise.noise(Vector((x * 50, y * 50, seed + 4)))) if top else 0.0)
        return np.array([x, y, z])

    top = [[None] * (ny + 1) for _ in range(nx + 1)]
    bot = [[None] * (ny + 1) for _ in range(nx + 1)]
    for i in range(nx + 1):
        for j in range(ny + 1):
            g = 0.85 + 0.3 * rng.uniform()
            top[i][j] = turf.add_vert(pt(i, j, True), (g, g, g))
            v = 0.7 + 0.25 * rng.uniform()
            bot[i][j] = soil.add_vert(pt(i, j, False), (v, v * 0.95, v * 0.9))
    for i in range(nx):
        for j in range(ny):
            uv = [(i / nx, j / ny), ((i + 1) / nx, j / ny), ((i + 1) / nx, (j + 1) / ny), (i / nx, (j + 1) / ny)]
            turf.add_face((top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]), uv)
            soil.add_face((bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j], bot[i][j]), uv[::-1])

    # soil walls around the slab (separate verts so the edge stays crisp)
    ring = [(i, 0) for i in range(nx)] + [(nx, j) for j in range(ny)] + \
           [(i, ny) for i in range(nx, 0, -1)] + [(0, j) for j in range(ny, 0, -1)]
    for k in range(len(ring)):
        a, b = ring[k], ring[(k + 1) % len(ring)]
        pa_t, pb_t = pt(*a, True), pt(*b, True)
        pa_b, pb_b = pt(*a, False), pt(*b, False)
        va = 0.55 + 0.2 * rng.uniform()
        vb = 0.55 + 0.2 * rng.uniform()
        i0 = soil.add_vert(pa_b, (va, va * 0.95, va * 0.9))
        i1 = soil.add_vert(pb_b, (vb, vb * 0.95, vb * 0.9))
        # top of the wall is the root mat, a touch lighter
        i2 = soil.add_vert(pb_t - np.array([0, 0, 0.002]), (0.95, 0.9, 0.75))
        i3 = soil.add_vert(pa_t - np.array([0, 0, 0.002]), (0.95, 0.9, 0.75))
        soil.add_face((i0, i1, i2, i3), [(0, 0), (1, 0), (1, 1), (0, 1)])

    # short blade fringe on top
    for _ in range(140):
        i, j = rng.uniform(0.05, 0.95) * nx, rng.uniform(0.02, 0.98) * ny
        y = -L / 2 + L * j / ny
        x = edge_x(y, -1) + (edge_x(y, 1) - edge_x(y, -1)) * (i / nx)
        z = curl(y) + T
        h = rng.uniform(0.006, 0.016)
        ang = rng.uniform(0, 2 * math.pi)
        d = np.array([math.cos(ang), math.sin(ang), 0.0])
        s = np.array([-d[1], d[0], 0.0]) * 0.0015
        tip = np.array([x, y, z]) + d * h * 0.4 + np.array([0, 0, h])
        g = rng.uniform(0.85, 1.2)
        v0 = turf.add_vert((x - s[0], y - s[1], z - 0.002), (g * 0.65, g * 0.65, g * 0.65))
        v1 = turf.add_vert((x + s[0], y + s[1], z - 0.002), (g * 0.65, g * 0.65, g * 0.65))
        v2 = turf.add_vert(tuple(tip), (g, g, g))
        turf.add_face((v0, v1, v2), [(0, 0), (1, 0), (0.5, 1)])
    return soil, turf
