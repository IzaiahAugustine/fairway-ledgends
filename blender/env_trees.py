"""Procedural trees and bushes for the golf environment (Blender space, Z up).

Each builder returns (bark: MeshAccum, foliage: MeshAccum, foliage_material_name).
Foliage = alpha-tested cards anchored on real branches (the painted twig at the
bottom-centre of every atlas tile starts on a branch), with custom normals that
point outward from the crown (blend of a global crown ellipsoid and local pads)
and a baked AO term in the vertex colour (darker inside / under the crown).
"""
import math
import numpy as np
from mathutils import Vector, noise

from env_mesh import MeshAccum, unit, any_perp, rotate, random_unit, smoothstep, UP

GOLDEN = 2.399963


def tile_rect(t):
    col, row = t % 2, t // 2
    m = 3.0 / 1024.0
    return (col * 0.5 + m, row * 0.5 + m, col * 0.5 + 0.5 - m, row * 0.5 + 0.5 - m)


class Envelope:
    """Lumpy ellipsoid used for crown shape (branch lengths), normals and AO."""

    def __init__(self, center, radii, lumps=0.0, seed=0):
        self.c = np.array(center, float)
        self.r = np.array(radii, float)
        self.lumps = lumps
        self.off = Vector((seed * 7.31, seed * 3.17, seed * 5.53))

    def lump(self, d):
        if not self.lumps:
            return 1.0
        return 1.0 + self.lumps * noise.noise(Vector((d[0] * 1.7, d[1] * 1.7, d[2] * 1.7)) + self.off)

    def rho(self, p):
        q = (np.asarray(p, float) - self.c) / self.r
        n = float(np.linalg.norm(q))
        if n < 1e-9:
            return 0.0
        return n / self.lump(q / n)

    def room(self, p, d, step=0.15, max_t=40.0):
        """Distance along ray p + t d until it leaves the envelope."""
        t = step
        entered = self.rho(p) <= 1.0
        while t < max_t:
            if self.rho(p + d * t) <= 1.0:
                entered = True
            elif entered:
                break
            t += step
        return t

    def normal(self, p):
        return unit((np.asarray(p, float) - self.c) / (self.r ** 2))


class Branch:
    def __init__(self, pts, radii, level, sides):
        self.pts = [np.asarray(p, float) for p in pts]
        self.radii = list(radii)
        self.level = level
        self.sides = sides
        seg = [float(np.linalg.norm(b - a)) for a, b in zip(self.pts[:-1], self.pts[1:])]
        self.s = np.concatenate([[0.0], np.cumsum(seg)])
        self.length = float(self.s[-1])

    def at(self, t):
        s = min(max(t, 0.0), 1.0) * self.length
        i = int(np.clip(np.searchsorted(self.s, s) - 1, 0, len(self.pts) - 2))
        f = (s - self.s[i]) / max(self.s[i + 1] - self.s[i], 1e-9)
        p = self.pts[i] + (self.pts[i + 1] - self.pts[i]) * f
        d = unit(self.pts[i + 1] - self.pts[i])
        r = self.radii[i] + (self.radii[i + 1] - self.radii[i]) * f
        return p, d, r


def grow_path(rng, start, d0, length, nseg, wander=0.1, pull=None):
    pts = [np.asarray(start, float)]
    d = unit(np.asarray(d0, float))
    seg = length / nseg
    for i in range(nseg):
        d = unit(d + rng.normal(0, wander, 3))
        if pull is not None:
            d = unit(d + pull((i + 1) / nseg, d))
        pts.append(pts[-1] + d * seg)
    return pts


def taper(r0, r1, n, power=1.0):
    return [r0 + (r1 - r0) * (i / (n - 1)) ** power for i in range(n)]


def child_dir(dq, ang, roll):
    p = rotate(any_perp(dq), dq, roll)
    return unit(rotate(dq, np.cross(dq, p), ang))


def mesh_branches(branches, bark_tile=1.0, flare=0.0, flare_h=0.6, gnarl=0.05, ao_fn=None, seed=0):
    rng = np.random.default_rng(seed + 999)
    bark = MeshAccum()
    for b in branches:
        circ = 2 * math.pi * b.radii[0]
        u_reps = max(1, int(round(circ / bark_tile)))
        v_len = circ / u_reps
        ph = rng.uniform(0, 2 * math.pi, 2)
        zs = [p[2] for p in b.pts]

        def ring_fn(i, th, b=b, ph=ph, zs=zs):
            m = 1.0 + gnarl * math.sin(3 * th + ph[0] + i * 0.9)
            if b.level == 0 and flare > 0:
                f = flare * math.exp(-max(zs[i], 0.0) / flare_h)
                m *= 1.0 + f * (0.65 + 0.35 * math.sin(5 * th + ph[1]))
            return m

        bark.tube(b.pts, b.radii, b.sides, u_reps, v_len, ring_fn, ao_fn)
    return bark


def make_cards(rng, anchors, P, normal_fn, ao_fn, outward_fn):
    """anchors: list of (pos, twig_dir, kind). kind selects facing behaviour."""
    leaves = MeshAccum()
    expanded = []
    for a, d, kind in anchors:
        for c in range(P.get('cards_per_anchor', 1)):
            expanded.append((a + d * P['card'] * 0.18 * c, d, kind))
    for a, d, kind in expanded:
        out = outward_fn(a, kind)
        n0 = unit(out * P.get('face_out', 1.0) + random_unit(rng) * P.get('face_rand', 0.8))
        if np.dot(n0, out) < 0:
            n0 = -n0
        up = d - n0 * np.dot(d, n0)
        if np.linalg.norm(up) < 0.35:
            up = unit(up) * 0.4 + (UP - n0 * np.dot(UP, n0))
            if np.linalg.norm(up) < 1e-3:
                up = any_perp(n0)
        up = unit(up)
        size = P['card'] * rng.uniform(*P.get('card_var', (0.8, 1.2)))
        w = size * P.get('card_aspect', 1.0)
        base = a - up * size * P.get('card_back', 0.05)
        facings = [n0]
        if P.get('cross'):
            # second card rotated ~90 deg about the twig: an X along the twig, so from any
            # side view at least one card is >= 45 deg from edge-on (no streaky slivers)
            n1 = rotate(n0, up, math.radians(P.get('cross_angle', 90)) + rng.normal(0, 0.15))
            facings.append(n1 if np.dot(n1, out) >= 0 else -n1)
        for nf in facings:
            tile = P['tiles'][rng.integers(len(P['tiles']))]
            leaves.card(base, up, nf, w, size, tile_rect(tile), mirror=bool(rng.uniform() < 0.5),
                        normal_fn=normal_fn, ao_fn=ao_fn, face_mix=P.get('face_mix', 0.15))
    return leaves


def crown_ao(env, inner=0.5, bottom=0.25):
    def ao(p):
        r = env.rho(p)
        zr = (p[2] - env.c[2]) / env.r[2]
        v = (inner + (1 - inner) * smoothstep(0.3, 1.05, r)) * (1 - bottom + bottom * smoothstep(-0.9, 0.3, zr))
        return v
    return ao


# ---------------------------------------------------------------------------
# broadleaf (oak / birch)

def deciduous(P, seed):
    rng = np.random.default_rng(seed)
    env = Envelope(P['env_c'], P['env_r'], P['lumps'], seed)
    branches = []
    anchors = []
    # trunk: explicit low rings for the root flare, then a wandering bole
    lean = np.array([rng.normal(0, P['lean']), rng.normal(0, P['lean']), 1.0])
    base_pts = [np.array([0, 0, -P['sink']]), np.array([0, 0, 0.0]), np.array([0, 0, 0.35]), np.array([0, 0, 0.9])]
    rest = grow_path(rng, base_pts[-1], lean, P['trunk_len'] - 0.9, P['trunk_seg'], P['trunk_wander'])
    tpts = base_pts + rest[1:]
    n = len(tpts)
    trad = [P['r0'] * (1.0 - (1.0 - P['r_top'] / P['r0']) * (max(p[2], 0) / P['trunk_len']) ** 0.85) for p in tpts]
    trunk = Branch(tpts, trad, 0, P['trunk_sides'])
    branches.append(trunk)

    n1 = P['n1']
    az0 = rng.uniform(0, 2 * math.pi)
    t_lo, t_hi = P['t1']
    for i in range(n1):
        f = i / max(n1 - 1, 1)
        t = t_lo + (t_hi - t_lo) * f + rng.normal(0, 0.02)
        p, dtr, rtr = trunk.at(t)
        elev = math.radians(P['elev1'][0] + (P['elev1'][1] - P['elev1'][0]) * f + rng.normal(0, 6))
        az = az0 + i * GOLDEN + rng.normal(0, 0.3)
        d = np.array([math.sin(elev) * math.cos(az), math.sin(elev) * math.sin(az), math.cos(elev)])
        L = min(env.room(p, d) * rng.uniform(*P['l1_room']), P['l1_max'])
        if L < 1.0:
            continue
        up1, dr1 = P['l1_up'], P['l1_droop']
        pts = grow_path(rng, p - d * rtr * 0.6, d, L, P['l1_seg'], P['l1_wander'],
                        lambda tt, dd: UP * (up1 * tt - dr1 * tt * tt))
        r0 = rtr * rng.uniform(*P['r1'])
        b1 = Branch(pts, taper(r0, r0 * 0.2, len(pts)), 1, P['l1_sides'])
        branches.append(b1)
        n2 = max(2, int(round(P['n2'] * min(1.0, L / P['l1_max']) + rng.uniform(-1, 1))))
        roll0 = rng.uniform(0, 2 * math.pi)
        for j in range(n2):
            tt = P['t2'][0] + (P['t2'][1] - P['t2'][0]) * (j + rng.uniform(0, 1)) / n2
            q, dq, rq = b1.at(tt)
            d2 = child_dir(dq, math.radians(rng.uniform(*P['ang2'])), roll0 + j * GOLDEN)
            d2 = unit(d2 + UP * P['l2_up'])
            L2 = min(b1.length * P['l2_len'] * rng.uniform(0.7, 1.15), env.room(q, d2) * 0.95)
            if L2 < 0.5:
                continue
            up2, dr2 = P['l2_up_pull'], P['l2_droop']
            pts2 = grow_path(rng, q - d2 * rq * 0.5, d2, L2, P['l2_seg'], P['l2_wander'],
                             lambda s, dd: UP * (up2 * s - dr2 * s * s))
            r2 = max(rq * rng.uniform(0.55, 0.75), P['r2_min'])
            b2 = Branch(pts2, taper(r2, r2 * 0.3, len(pts2)), 2, P['l2_sides'])
            branches.append(b2)
            for k in range(P['n3']):
                t3 = rng.uniform(P.get('t3', 0.2), 1.0)
                a, da, _ = b2.at(t3)
                d3 = child_dir(da, math.radians(rng.uniform(20, 70)), rng.uniform(0, 2 * math.pi))
                d3 = unit(d3 - UP * P['twig_droop'])
                anchors.append((a, d3, 0))
            a, da, _ = b2.at(1.0)
            anchors.append((a - da * 0.25, unit(da - UP * P['twig_droop']), 0))
        # a few cards on the outer part of the main limb itself
        for k in range(P['n1_cards']):
            a, da, _ = b1.at(rng.uniform(0.55, 1.0))
            anchors.append((a, child_dir(da, math.radians(rng.uniform(25, 70)), rng.uniform(0, 6.3)), 0))

    # leader: foliage around the top of the bole so the crown has no hole on the axis
    for k in range(P.get('leader_cards', 0)):
        a, da, _ = trunk.at(rng.uniform(0.78, 1.0))
        anchors.append((a, unit(UP * 0.8 + random_unit(rng)), 0))

    # keep the card count on budget
    order = rng.permutation(len(anchors))
    anchors = [anchors[i] for i in order[:P['max_cards']]]

    ao = crown_ao(env, P.get('ao_inner', 0.5), P.get('ao_bottom', 0.25))
    bark_ao = lambda p: 0.55 + 0.45 * smoothstep(0.2, 1.0, env.rho(p))
    bark = mesh_branches(branches, P['bark_tile'], P['flare'], 0.6, P['gnarl'], bark_ao, seed)
    nfn = lambda p: unit(env.normal(p) + UP * P.get('n_up', 0.12))
    leaves = make_cards(rng, anchors, P, nfn, ao, lambda a, kind: env.normal(a))
    return bark, leaves


OAK = dict(
    env_c=(0.5, -0.3, 8.1), env_r=(8.0, 7.6, 4.7), lumps=0.16,
    lean=0.05, sink=0.3, trunk_len=8.6, trunk_seg=8, trunk_wander=0.05, r0=0.42, r_top=0.13,
    trunk_sides=10, flare=0.45, gnarl=0.06, bark_tile=0.95,
    n1=7, t1=(0.40, 0.93), elev1=(64, 30), l1_room=(0.82, 0.95), l1_max=8.5, l1_seg=6, l1_wander=0.10,
    l1_up=0.22, l1_droop=0.10, r1=(0.55, 0.72), l1_sides=7,
    n2=9, t2=(0.22, 0.97), ang2=(35, 65), l2_up=0.15, l2_len=0.45, l2_seg=3, l2_wander=0.15,
    l2_up_pull=0.10, l2_droop=0.10, r2_min=0.025, l2_sides=4,
    n3=24, twig_droop=0.05, n1_cards=8, leader_cards=20, cross=True,
    max_cards=900, card=1.6, tiles=(0, 1), face_out=1.0, face_rand=0.5, card_back=0.35, t3=0.4, ao_inner=0.6,
)

BIRCH = dict(
    env_c=(0.2, 0.1, 6.9), env_r=(2.9, 2.7, 3.6), lumps=0.14,
    lean=0.04, sink=0.3, trunk_len=10.2, trunk_seg=9, trunk_wander=0.035, r0=0.17, r_top=0.03,
    trunk_sides=8, flare=0.25, gnarl=0.03, bark_tile=0.6,
    n1=13, t1=(0.33, 0.95), elev1=(55, 22), l1_room=(0.8, 0.95), l1_max=3.6, l1_seg=5, l1_wander=0.08,
    l1_up=0.10, l1_droop=0.35, r1=(0.35, 0.5), l1_sides=5,
    n2=4, t2=(0.25, 0.95), ang2=(30, 55), l2_up=-0.05, l2_len=0.5, l2_seg=2, l2_wander=0.12,
    l2_up_pull=0.0, l2_droop=0.45, r2_min=0.012, l2_sides=3,
    n3=20, twig_droop=0.55, n1_cards=5, leader_cards=40, cross=True,
    max_cards=620, card=1.35, tiles=(2,), face_out=1.0, face_rand=0.7, n_up=0.15, card_back=0.3, ao_inner=0.6,
)


# ---------------------------------------------------------------------------
# pine (eastern white / Scots): bare bole, layered whorls of flat sprays

def pine(P, seed):
    rng = np.random.default_rng(seed)
    H = P['height']
    tpts = [np.array([0, 0, -P['sink']]), np.array([0, 0, 0.0]), np.array([0, 0, 0.4])]
    tpts += grow_path(rng, tpts[-1], np.array([rng.normal(0, 0.03), rng.normal(0, 0.03), 1.0]),
                      H - 0.4, 13, 0.025)[1:]
    trad = [P['r0'] * (1.0 - 0.92 * (max(p[2], 0) / H) ** 0.8) for p in tpts]
    trunk = Branch(tpts, trad, 0, P['trunk_sides'])
    branches = [trunk]
    anchors = []
    pads = []  # (center, radii)
    crown = Envelope((0, 0, (P['crown_base'] + H) / 2), (P['Lmax'] * 0.7, P['Lmax'] * 0.7, (H - P['crown_base']) / 2))

    # dead branch stubs on the bare bole
    for k in range(P['stubs']):
        t = rng.uniform(0.15, P['crown_base'] / H * 0.95)
        p, dtr, rtr = trunk.at(t)
        az = rng.uniform(0, 2 * math.pi)
        d = unit(np.array([math.cos(az), math.sin(az), rng.uniform(-0.3, 0.1)]))
        L = rng.uniform(0.25, 0.7)
        branches.append(Branch([p - d * rtr * 0.5, p + d * L], [0.035, 0.012], 3, 3))

    z = P['crown_base']
    whorl = 0
    while z < H - 0.7:
        h = (z - P['crown_base']) / (H - P['crown_base'])
        prof = (1.0 - h) ** 0.55 * (0.78 + 0.22 * math.sin(h * 8.0 + 1.3))
        if whorl > 1 and rng.uniform() < P['skip_whorl']:
            z += rng.uniform(*P['whorl_gap'])
            whorl += 1
            continue  # missing tier -> open, layered crown
        nb = int(rng.integers(3, 6))
        az0 = rng.uniform(0, 2 * math.pi)
        p, dtr, rtr = trunk.at(min((z + P['sink']) / trunk.length, 1.0))
        for k in range(nb):
            az = az0 + k * 2 * math.pi / nb + rng.normal(0, 0.45)
            e = math.radians(-5 + 30 * h + rng.normal(0, 6))
            d = np.array([math.cos(e) * math.cos(az), math.cos(e) * math.sin(az), math.sin(e)])
            L = max(0.7, P['Lmax'] * prof * rng.uniform(0.45, 1.15))
            sag = P['sag']
            pts = grow_path(rng, p - d * rtr * 0.5, d, L, 3, 0.06,
                            lambda tt, dd: UP * (-sag * math.sin(math.pi * tt) + 0.25 * tt ** 3))
            r1 = float(np.clip(rtr * 0.42, 0.025, 0.10))
            b1 = Branch(pts, taper(r1, r1 * 0.25, len(pts)), 1, P['l1_sides'])
            branches.append(b1)
            pc, _, _ = b1.at(0.75)
            pads.append((pc + UP * 0.1, np.array([max(L * 0.38, 0.6), max(L * 0.38, 0.6), P['pad_h']])))
            pid = len(pads) - 1
            n2 = int(rng.integers(2, 4)) if L > 1.8 else 0
            for j in range(n2):
                tt = rng.uniform(0.4, 0.9)
                q, dq, rq = b1.at(tt)
                side = 1 if j % 2 == 0 else -1
                d2 = rotate(dq, UP, side * math.radians(rng.uniform(35, 70)))
                d2 = unit(d2 + UP * rng.normal(0.1, 0.08))
                L2 = L * rng.uniform(0.25, 0.4)
                pts2 = grow_path(rng, q, d2, L2, 1, 0.08, lambda s, dd: UP * 0.1 * s)
                branches.append(Branch(pts2, [r1 * 0.45, r1 * 0.1], 2, 3))
                b2 = branches[-1]
                for m in range(3):
                    a, da, _ = b2.at(rng.uniform(0.25, 1.0))
                    anchors.append((a, unit(da + rng.normal(0, 0.3, 3)), pid))
            for m in range(int(P['cards_per_m'] * L)):
                a, da, _ = b1.at(rng.uniform(0.3, 1.0))
                anchors.append((a, unit(da + rng.normal(0, 0.35, 3)), pid))
            a, da, _ = b1.at(1.0)
            anchors.append((a - da * 0.2, unit(da + UP * 0.6), pid))
        z += rng.uniform(*P['whorl_gap'])
        whorl += 1
    # leader tuft
    top_pad = (np.array(trunk.pts[-1]) - UP * 0.6, np.array([0.8, 0.8, 0.9]))
    pads.append(top_pad)
    for m in range(P['top_cards']):
        a, da, _ = trunk.at(rng.uniform(0.9, 0.99))
        anchors.append((a, unit(UP * 1.2 + random_unit(rng) * 0.6), len(pads) - 1))

    order = rng.permutation(len(anchors))
    anchors = [anchors[i] for i in order[:P['max_cards']]]

    def pad_normal(p, pid):
        c, r = pads[pid]
        return unit((p - c) / (r ** 2) * r.max())

    def outward(a, pid):
        c, r = pads[pid]
        horiz = a - c
        horiz[2] = 0
        hz = unit(horiz) if np.linalg.norm(horiz) > 1e-3 else unit(np.array([a[0], a[1], 0.0]) + 1e-3)
        if rng.uniform() < P['side_frac']:
            return unit(hz + UP * 0.2)
        return unit(UP + hz * 0.45)

    leaves = MeshAccum()
    # pad-aware normals/AO need the pad id: build per anchor
    for a, d, pid in anchors:
        c, r = pads[pid]
        nfn = lambda p, pid=pid: unit(0.45 * crown.normal(p) + 0.55 * pad_normal(p, pid) + 0.1 * UP)

        def ao(p, c=c, r=r):
            zr = (p[2] - c[2]) / r[2]
            g = 0.62 + 0.38 * smoothstep(0.2, 1.0, crown.rho(p))
            return g * (0.72 + 0.28 * smoothstep(-1.2, 0.6, zr))

        sub = make_cards(rng, [(a, d, pid)], P, nfn, ao, outward)
        base = len(leaves.verts)
        leaves.verts += sub.verts
        leaves.cols += sub.cols
        leaves.normals += sub.normals
        leaves.uvs += sub.uvs
        leaves.faces += [tuple(i + base for i in f) for f in sub.faces]
    bark_ao = lambda p: 0.6 + 0.4 * smoothstep(0.3, 1.0, crown.rho(p))
    bark = mesh_branches(branches, P['bark_tile'], P['flare'], 0.5, 0.04, bark_ao, seed)
    return bark, leaves


PINE = dict(
    height=17.6, sink=0.3, r0=0.33, trunk_sides=9, flare=0.3, bark_tile=0.9,
    crown_base=7.4, Lmax=5.2, sag=0.12, pad_h=0.7, l1_sides=4, stubs=7,
    skip_whorl=0.15, whorl_gap=(0.85, 1.35), cards_per_m=3.4,
    top_cards=14, max_cards=1000, side_frac=0.22, cards_per_anchor=1, cross=True, cross_angle=60,
    card=1.5, tiles=(0, 1, 2, 3), face_out=1.0, face_rand=0.4, card_back=0.3,
)


# ---------------------------------------------------------------------------
# Monterey cypress: gnarled leaning trunk, sinuous limbs, flat layered pads

def cypress(P, seed):
    rng = np.random.default_rng(seed)
    lean = unit(np.array([0.32, 0.05, 1.0]))
    tpts = [np.array([0, 0, -P['sink']]), np.array([0, 0, 0.0]), np.array([0.04, 0, 0.35])]
    tpts += grow_path(rng, tpts[-1], lean, P['trunk_len'], 4, 0.12)[1:]
    trunk = Branch(tpts, taper(P['r0'], P['r0'] * 0.72, len(tpts), 0.7), 0, P['trunk_sides'])
    branches = [trunk]
    anchors = []
    pads = [(np.array(c, float), np.array(r, float)) for c, r in P['pads']]
    crown = Envelope(P['crown_c'], P['crown_r'])
    top, dtop, rtop = trunk.at(1.0)

    # limbs: from the fork, each limb snakes up to under its pad, then sub-limbs fan out inside
    for li, pad_ids in enumerate(P['limbs']):
        c0, r0p = pads[pad_ids[0]]
        start, _, rs = trunk.at(rng.uniform(0.72, 0.98))
        target = c0 - UP * r0p[2] * 0.5
        pts = [start]
        nseg = 6
        for s in range(1, nseg + 1):
            f = s / nseg
            # rise first, then travel horizontally: ease the vertical component
            fz = 1 - (1 - f) ** 1.8
            q = start + (target - start) * np.array([f, f, fz])
            q = q + rng.normal(0, 0.35, 3) * math.sin(math.pi * f)
            pts.append(q)
        r_l = rs * rng.uniform(0.55, 0.7)
        limb = Branch(pts, taper(r_l, r_l * 0.4, len(pts)), 1, P['l1_sides'])
        branches.append(limb)
        for pid in pad_ids[1:]:
            c1, r1p = pads[pid]
            q, dq, rq = limb.at(rng.uniform(0.45, 0.75))
            tgt = c1 - UP * r1p[2] * 0.5
            seg = [q]
            for s in range(1, 5):
                f = s / 4
                fz = 1 - (1 - f) ** 1.6
                seg.append(q + (tgt - q) * np.array([f, f, fz]) + rng.normal(0, 0.25, 3) * math.sin(math.pi * f))
            branches.append(Branch(seg, taper(rq * 0.7, rq * 0.3, len(seg)), 1, P['l1_sides']))

    for pid, (c, r) in enumerate(pads):
        hub = c - UP * r[2] * 0.45
        n2 = int(P['pad_branches'] * (r[0] * r[1]) / 5.0) + 3
        az0 = rng.uniform(0, 2 * math.pi)
        for j in range(n2):
            az = az0 + j * GOLDEN + rng.normal(0, 0.2)
            d = unit(np.array([math.cos(az) * r[0], math.sin(az) * r[1], 0]) + UP * rng.uniform(0.0, 0.25) * r.max())
            L = float(np.linalg.norm(np.array([math.cos(az) * r[0], math.sin(az) * r[1]]))) * rng.uniform(0.7, 0.95)
            pts = grow_path(rng, hub, d, L, 2, 0.1, lambda s, dd: UP * 0.12 * s)
            b = Branch(pts, [0.07, 0.035, 0.012], 2, 3)
            branches.append(b)
            for k in range(P['cards_per_branch']):
                a, da, _ = b.at(rng.uniform(0.15, 1.0))
                a = a + UP * rng.uniform(-0.15, 0.45) * r[2]
                anchors.append((a, unit(da + rng.normal(0, 0.35, 3)), pid))
        # top-surface fill so the pads read flat and dense
        for k in range(int(P['top_fill'] * r[0] * r[1])):
            th = rng.uniform(0, 2 * math.pi)
            rr = math.sqrt(rng.uniform(0, 0.8))
            a = c + np.array([math.cos(th) * r[0] * rr, math.sin(th) * r[1] * rr, r[2] * rng.uniform(0.0, 0.55)])
            anchors.append((a - UP * 0.25, unit(np.array([math.cos(th), math.sin(th), 0.25])), pid))

    order = rng.permutation(len(anchors))
    anchors = [anchors[i] for i in order[:P['max_cards']]]

    def pad_normal(p, pid):
        c, r = pads[pid]
        return unit((p - c) / (r ** 2) * r.max())

    def outward(a, pid):
        n = pad_normal(a, pid)
        if n[2] < 0:
            n = unit(n * np.array([1, 1, 0.3]))
        return n

    leaves = MeshAccum()
    for a, d, pid in anchors:
        c, r = pads[pid]
        nfn = lambda p, pid=pid: unit(0.35 * crown.normal(p) + 0.65 * pad_normal(p, pid) + 0.1 * UP)

        def ao(p, c=c, r=r):
            zr = (p[2] - c[2]) / r[2]
            return (0.65 + 0.35 * smoothstep(0.2, 1.0, crown.rho(p))) * (0.62 + 0.38 * smoothstep(-1.1, 0.5, zr))

        sub = make_cards(rng, [(a, d, pid)], P, nfn, ao, outward)
        base = len(leaves.verts)
        leaves.verts += sub.verts
        leaves.cols += sub.cols
        leaves.normals += sub.normals
        leaves.uvs += sub.uvs
        leaves.faces += [tuple(i + base for i in f) for f in sub.faces]
    bark_ao = lambda p: 0.55 + 0.45 * smoothstep(0.3, 1.0, crown.rho(p))
    bark = mesh_branches(branches, P['bark_tile'], P['flare'], 0.5, 0.10, bark_ao, seed)
    return bark, leaves


CYPRESS = dict(
    sink=0.3, r0=0.46, trunk_len=2.4, trunk_sides=10, flare=0.5, bark_tile=0.9, l1_sides=6,
    crown_c=(2.4, 0.2, 6.6), crown_r=(5.6, 4.6, 2.6),
    pads=[
        ((3.4, 0.4, 7.7), (2.9, 2.5, 0.85)),   # 0 top, leeward
        ((0.9, -1.6, 8.0), (2.3, 2.0, 0.75)),  # 1 top, windward-side
        ((5.9, -0.9, 6.2), (2.4, 2.1, 0.8)),   # 2 far leeward, lower
        ((2.6, 2.7, 6.6), (2.5, 1.9, 0.8)),    # 3 side
        ((-1.0, 1.0, 6.6), (1.7, 1.5, 0.7)),   # 4 windward, small (wind-pruned)
        ((4.8, 2.6, 5.1), (1.9, 1.7, 0.7)),    # 5 low leeward
        ((2.2, -2.6, 5.6), (1.9, 1.6, 0.7)),   # 6 low other side
    ],
    limbs=[(0, 2), (1, 6), (3, 5), (4,)],
    pad_branches=5, cards_per_branch=14, top_fill=16.0, max_cards=2100,
    card=1.8, tiles=(0, 1, 2, 3), face_out=1.0, face_rand=0.6, card_back=0.1,
)


# ---------------------------------------------------------------------------
# bushes

def bush(P, seed):
    rng = np.random.default_rng(seed)
    env = Envelope(P['c'], P['r'], P['lumps'], seed)
    branches = []
    for k in range(P['stems']):
        az = k * GOLDEN + rng.normal(0, 0.3)
        d = unit(np.array([math.cos(az) * 0.6, math.sin(az) * 0.6, 1.0]))
        L = env.room(np.array([0, 0, 0.05]), d) * rng.uniform(0.55, 0.8)
        pts = grow_path(rng, np.array([0, 0, -P['sink']]), d, L + P['sink'], 3, 0.15)
        branches.append(Branch(pts, [P['stem_r'], P['stem_r'] * 0.7, P['stem_r'] * 0.45, P['stem_r'] * 0.2], 1, 4))
    anchors = []
    n = P['cards']
    for i in range(n):
        # fibonacci directions over the dome, skipping the buried bottom
        zz = 1 - 2 * (i + 0.5) / n
        if zz < -0.45:
            zz = rng.uniform(-0.45, 1.0)
        rr = math.sqrt(max(0.0, 1 - zz * zz))
        th = i * GOLDEN
        dirv = np.array([rr * math.cos(th), rr * math.sin(th), zz])
        dirv = unit(dirv + rng.normal(0, 0.12, 3))
        rho = rng.uniform(*P['shell'])
        a = env.c + dirv * env.r * rho * env.lump(dirv)
        a[2] = max(a[2], P['min_z'])
        anchors.append((a, unit(dirv + rng.normal(0, 0.5, 3) + UP * 0.3), 0))
    ao = crown_ao(env, 0.55, 0.3)
    nfn = lambda p: unit(env.normal(p) + UP * 0.1)
    Pc = dict(P)
    leaves = make_cards(rng, anchors, Pc, nfn, ao, lambda a, kind: env.normal(a))
    bark = mesh_branches(branches, 0.3, 0.0, 0.5, 0.05, lambda p: 0.55, seed)
    return bark, leaves


GORSE = dict(
    c=(0.0, 0.0, 0.55), r=(0.95, 0.85, 0.72), lumps=0.18, sink=0.12, stems=6, stem_r=0.03,
    cards=110, shell=(0.45, 0.88), min_z=0.12, cross=True,
    card=0.72, tiles=(0, 1, 2, 3), face_out=1.0, face_rand=0.7, card_back=0.4,
)

GREEN = dict(
    c=(0.0, 0.0, 0.85), r=(1.05, 0.98, 0.85), lumps=0.15, sink=0.12, stems=6, stem_r=0.035,
    cards=125, shell=(0.45, 0.88), min_z=0.2, cross=True,
    card=0.88, tiles=(3,), face_out=1.0, face_rand=0.7, card_back=0.4,
)


def scale_to_height(accums, target):
    zmax = max(v[2] for acc in accums for v in acc.verts)
    s = target / zmax
    for acc in accums:
        acc.verts = [(x * s, y * s, z * s) for x, y, z in acc.verts]
    return s


SPECS = {
    # name: (builder, params, seed, foliage material, target height m)
    "Tree_Oak": (deciduous, OAK, 7, "Leaves", 14.0),
    "Tree_Pine": (pine, PINE, 21, "Needles", 18.0),
    "Tree_Cypress": (cypress, CYPRESS, 5, "LeavesCypress", 9.0),
    "Tree_Birch": (deciduous, BIRCH, 13, "Leaves", 11.0),
    "Bush_Gorse": (bush, GORSE, 3, "Gorse", 1.4),
    "Bush_Green": (bush, GREEN, 17, "Leaves", 1.8),
}
