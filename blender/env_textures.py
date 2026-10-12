"""Procedural foliage atlases (numpy painting) for the golf environment.

Every atlas is 2x2 tiles. Each tile is a self-contained "branch spray" whose
twig base sits at the bottom-centre of the tile, so a card's bottom edge can be
anchored on a real branch (no floating leaves). Arrays are painted with row 0 at
the BOTTOM (Blender image convention), colours are sRGB-encoded floats.

Atlas tile layout (u, v origin bottom-left), tile index -> (col, row):
    0 -> (0, 0)  1 -> (1, 0)  2 -> (0, 1)  3 -> (1, 1)

Leaves atlas:        0 oak A, 1 oak B, 2 birch, 3 shrub
Needles atlas:       0..3 pine sprays (variants)
LeavesCypress atlas: 0..3 dense scale-leaf sprays (variants)
Gorse atlas:         0..3 spiny mass with yellow flowers (variants)
"""
import math
import numpy as np

TAU = 2.0 * math.pi
TWIG_COL = np.array([0.28, 0.22, 0.15], np.float32)


def hsv_jitter(col, rng, dh=0.0, ds=0.0, dv=0.0):
    """Cheap colour variation in sRGB: shift towards yellow/blue + saturation + value."""
    c = np.array(col, np.float32)
    v = 1.0 + rng.uniform(-dv, dv)
    h = rng.uniform(-dh, dh)
    c = c + np.array([h, 0.0, -h * 0.6], np.float32) * c[1]
    g = c.mean()
    s = 1.0 + rng.uniform(-ds, ds)
    c = g + (c - g) * s
    return np.clip(c * v, 0.0, 1.0)


class Canvas:
    """Premultiplied RGBA canvas, row 0 = bottom."""

    def __init__(self, size):
        self.S = size
        self.P = np.zeros((size, size, 3), np.float32)
        self.A = np.zeros((size, size), np.float32)

    def _grid(self, xmin, xmax, ymin, ymax):
        S = self.S
        x0 = max(0, int(math.floor(xmin)))
        x1 = min(S, int(math.ceil(xmax)) + 1)
        y0 = max(0, int(math.floor(ymin)))
        y1 = min(S, int(math.ceil(ymax)) + 1)
        if x1 <= x0 or y1 <= y0:
            return None
        X, Y = np.meshgrid(np.arange(x0, x1, dtype=np.float32) + 0.5,
                           np.arange(y0, y1, dtype=np.float32) + 0.5)
        return x0, y0, X, Y

    def over(self, x0, y0, cov, col):
        h, w = cov.shape
        sl = (slice(y0, y0 + h), slice(x0, x0 + w))
        c3 = cov[..., None]
        self.P[sl] = col * c3 + self.P[sl] * (1.0 - c3)
        self.A[sl] = cov + self.A[sl] * (1.0 - cov)

    def line(self, p0, p1, w0, w1, col0, col1=None):
        """Anti-aliased tapered capsule from p0 to p1 with a colour ramp."""
        col0 = np.asarray(col0, np.float32)
        col1 = col0 if col1 is None else np.asarray(col1, np.float32)
        hw = max(w0, w1) * 0.5 + 1.5
        g = self._grid(min(p0[0], p1[0]) - hw, max(p0[0], p1[0]) + hw,
                       min(p0[1], p1[1]) - hw, max(p0[1], p1[1]) + hw)
        if g is None:
            return
        x0, y0, X, Y = g
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        L2 = dx * dx + dy * dy + 1e-9
        t = np.clip(((X - p0[0]) * dx + (Y - p0[1]) * dy) / L2, 0.0, 1.0)
        dist = np.hypot(X - (p0[0] + t * dx), Y - (p0[1] + t * dy))
        half = 0.5 * (w0 + (w1 - w0) * t)
        cov = np.clip(half - dist + 0.5, 0.0, 1.0)
        if not cov.any():
            return
        self.over(x0, y0, cov, col0 + (col1 - col0) * t[..., None])

    def blob(self, c, r_along, r_across, angle, col, shade_dir=None, shade_amt=0.0):
        """Anti-aliased ellipse; optional directional shading (lit side lighter)."""
        R = max(r_along, r_across) + 1.5
        g = self._grid(c[0] - R, c[0] + R, c[1] - R, c[1] + R)
        if g is None:
            return
        x0, y0, X, Y = g
        ca, sa = math.cos(angle), math.sin(angle)
        dx, dy = X - c[0], Y - c[1]
        u = (dx * ca + dy * sa) / r_along
        v = (-dx * sa + dy * ca) / r_across
        rr = np.sqrt(u * u + v * v)
        cov = np.clip((1.0 - rr) * min(r_along, r_across) + 0.5, 0.0, 1.0)
        if not cov.any():
            return
        col = np.asarray(col, np.float32)
        if shade_dir is not None:
            s = (dx * shade_dir[0] + dy * shade_dir[1]) / R
            col = col * (1.0 + shade_amt * s)[..., None]
        else:
            col = np.broadcast_to(col, cov.shape + (3,))
        self.over(x0, y0, cov, col)

    def leaf(self, base, angle, L, W, shape, col, fold=0.12, rib=0.18, veins=0.05):
        """Leaf blade from `base` along `angle`, length L px, max half-width W px."""
        ca, sa = math.cos(angle), math.sin(angle)
        corners = [(0, -W), (0, W), (L, -W), (L, W)]
        xs = [base[0] + a * ca - b * sa for a, b in corners]
        ys = [base[1] + a * sa + b * ca for a, b in corners]
        g = self._grid(min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1)
        if g is None:
            return
        x0, y0, X, Y = g
        dx, dy = X - base[0], Y - base[1]
        u = (dx * ca + dy * sa) / L
        v = (-dx * sa + dy * ca)
        uc = np.clip(u, 0.0, 1.0)
        hw = shape(uc) * W
        inside = hw - np.abs(v)
        cov = np.clip(inside + 0.5, 0.0, 1.0) * ((u >= 0.0) & (u <= 1.0))
        if not cov.any():
            return
        col = np.asarray(col, np.float32)
        side = np.sign(v) * fold
        vn = np.abs(v) / np.maximum(hw, 0.5)
        midrib = np.exp(-(v / 1.1) ** 2) * (u < 0.92) * rib
        vein = veins * np.cos((u * 7.0 - vn * 1.6) * TAU) * (vn > 0.15)
        edge = -0.18 * np.exp(-np.maximum(inside, 0.0) / 1.6)
        grad = -0.10 + 0.16 * uc
        k = 1.0 + side + midrib + vein + edge + grad
        self.over(x0, y0, cov, col * k[..., None])

    def inside(self, p, pad=6.0):
        """Keep painted elements off the tile border (no straight clipped edges on cards)."""
        S = self.S
        return (pad <= p[0] <= S - pad and pad <= p[1] <= S - pad and
                math.hypot(p[0] - S * 0.5, p[1] - S * 0.5) <= S * 0.5 - pad)

    def finish(self, margin=3):
        """Fade alpha to zero at the tile border so mips never bleed into neighbours."""
        S = self.S
        idx = np.arange(S, dtype=np.float32)
        ramp = np.clip(np.minimum(idx - margin, S - 1 - margin - idx) / 3.0, 0.0, 1.0)
        m = np.minimum(ramp[None, :], ramp[:, None])
        self.A *= m
        self.P *= m[..., None]


# ---------------------------------------------------------------------------
# leaf shapes: half-width (0..1) as a function of u in [0,1] (petiole -> tip)

def _sinpos(x):
    return np.maximum(np.sin(x), 0.0)


def shape_oak(u):
    base = _sinpos(np.pi * u ** 0.85) ** 0.7 * (1.0 - 0.25 * u)
    lobes = 0.55 + 0.45 * np.abs(np.sin(np.pi * (u * 4.0 + 0.25)))
    return base * lobes * (u > 0.04)


def shape_broad(u):
    return (_sinpos(np.pi * u ** 0.75) ** 0.85) * (1.0 - 0.35 * u ** 2) * (u > 0.03)


def shape_birch(u):
    b = (u ** 0.45) * np.maximum(1.0 - u, 0.0) ** 1.05 / 0.42
    return np.clip(b, 0, 1.2) * (1.0 + 0.07 * np.sin(u * 70.0)) * (u > 0.02)


def shape_small(u):
    return np.sqrt(np.clip(1.0 - (2.0 * u - 1.0) ** 2, 0.0, 1.0)) * (1.0 - 0.2 * u)


# ---------------------------------------------------------------------------
# twig skeletons

def polyline(rng, start, angle, length, steps, wander):
    pts = [np.array(start, np.float32)]
    a = angle
    seg = length / steps
    for _ in range(steps):
        a += rng.normal(0.0, wander)
        pts.append(pts[-1] + seg * np.array([math.cos(a), math.sin(a)], np.float32))
    return pts


def point_at(pts, t):
    """Point and direction angle at parameter t in [0,1] along a polyline."""
    f = t * (len(pts) - 1)
    k = min(int(f), len(pts) - 2)
    a, b = pts[k], pts[k + 1]
    d = b - a
    return a + d * (f - k), math.atan2(d[1], d[0])


def spray(rng, S, center=(0.5, 0.56), radii=(0.45, 0.42), depth_max=2, kids=(5, 8),
          kid_ang=(0.35, 0.95), kid_len=0.62, wander=0.08, main_len=0.9, roots=2, lumps=0.14):
    """Branching twig skeleton that fills a lumpy ellipse envelope.
    The main twig starts at the bottom-centre of the tile. Returns [(pts, level)]."""
    ph = rng.uniform(0, TAU, 3)
    cx, cy = center[0] * S, center[1] * S
    rx, ry = radii[0] * S, radii[1] * S

    def inside(p):
        dx, dy = (p[0] - cx) / rx, (p[1] - cy) / ry
        th = math.atan2(dy, dx)
        lim = 1.0 + lumps * (0.5 * math.sin(3 * th + ph[0]) + 0.3 * math.sin(5 * th + ph[1])
                             + 0.2 * math.sin(7 * th + ph[2]))
        return dx * dx + dy * dy <= lim * lim

    def room(p, a):
        d = np.array([math.cos(a), math.sin(a)], np.float32)
        step = S * 0.01
        t = step
        entered = inside(p)
        while t < S * 1.2:
            q = p + d * t
            if not (0 <= q[0] < S and 0 <= q[1] < S):
                break
            if inside(q):
                entered = True
            elif entered or t > S * 0.3:
                break
            t += step
        return t

    twigs = []

    def grow(p, a, L, lvl):
        L = min(L, room(p, a) * rng.uniform(0.85, 1.0))
        if L < S * 0.025:
            return
        steps = max(2, int(L / (S * 0.035)))
        pts = polyline(rng, p, a, L, steps, wander)
        twigs.append((pts, lvl))
        if lvl >= depth_max:
            return
        n = int(round(rng.integers(kids[0], kids[1] + 1) * min(1.0, L / (0.45 * S)) + 0.3))
        sgn = rng.choice([-1, 1])
        for _ in range(max(1, n)):
            t = rng.uniform(0.08, 0.92)
            q, ang = point_at(pts, t)
            sgn = -sgn
            grow(q, ang + sgn * rng.uniform(*kid_ang),
                 L * kid_len * rng.uniform(0.7, 1.1) * (1.15 - 0.45 * t), lvl + 1)

    base = np.array([S * 0.5 + rng.uniform(-0.02, 0.02) * S, S * 0.02], np.float32)
    grow(base, math.pi / 2 + rng.uniform(-0.1, 0.1), S * main_len, 0)
    for k in range(roots):
        sgn = 1 if k % 2 == 0 else -1
        grow(base, math.pi / 2 + sgn * rng.uniform(0.35, 0.75), S * main_len * 0.7, 1)
    return twigs


def walk(pts, spacing):
    """Sample (point, direction angle, t) along a polyline every `spacing` px."""
    out = []
    acc = 0.0
    n = len(pts) - 1
    for i in range(n):
        a, b = pts[i], pts[i + 1]
        d = b - a
        L = float(np.hypot(d[0], d[1]))
        if L < 1e-6:
            continue
        ang = math.atan2(d[1], d[0])
        s = spacing - acc
        while s <= L:
            out.append((a + d * (s / L), ang, (i + s / L) / n))
            s += spacing
        acc = L - (s - spacing)
    return out


def draw_twigs(cv, rng, twigs, widths, col=TWIG_COL):
    k = cv.S / 512
    for pts, lvl in twigs:
        w = widths[min(lvl, len(widths) - 1)] * k
        c = col * rng.uniform(0.8, 1.1)
        n = len(pts) - 1
        for i, (a, b) in enumerate(zip(pts[:-1], pts[1:])):
            cv.line(a, b, w * (1 - 0.5 * i / n), w * (1 - 0.5 * (i + 1) / n), c)


def underlayer(cv, rng, twigs, width, col, min_lvl=1):
    """Dark dense core along twigs: reads as shadowed inner foliage and keeps the
    alpha mass solid at low mip levels."""
    k = cv.S / 512
    for pts, lvl in twigs:
        if lvl < min_lvl:
            continue
        n = len(pts) - 1
        for i, (a, b) in enumerate(zip(pts[:-1], pts[1:])):
            if lvl <= 1 and i < max(1, n // 4):
                continue
            w = width * k * rng.uniform(0.7, 1.1)
            cv.line(a, b, w, w * 0.7, col * rng.uniform(0.8, 1.05))


# ---------------------------------------------------------------------------
# tile painters

def paint_broadleaf_tile(S, seed, shape, cols, leaf_len, leaf_w, spacing, per_node, tip_leaves,
                         droop=0.0, dv=0.18, spray_kw=None):
    rng = np.random.default_rng(seed)
    cv = Canvas(S)
    k = S / 512
    twigs = spray(rng, S, **(spray_kw or {}))
    draw_twigs(cv, rng, twigs, (3.2, 2.0, 1.3))
    leaves = []
    for pts, lvl in twigs:
        for p, ang, t in walk(pts, spacing * k * rng.uniform(0.85, 1.15)):
            if lvl == 0 and t < 0.22:
                continue
            for _ in range(per_node):
                a = ang + rng.choice([-1, 1]) * rng.uniform(0.45, 1.35)
                if droop:
                    a = math.atan2(math.sin(a) - droop, math.cos(a))
                leaves.append((p + rng.normal(0, 2.0 * k, 2), a, t))
        q, a0 = point_at(pts, 1.0)
        for _ in range(tip_leaves):
            leaves.append((q, a0 + rng.uniform(-1.2, 1.2), 1.0))
    depth = rng.uniform(0, 1, len(leaves))
    cx = np.mean([l[0][0] for l in leaves])
    cy = np.mean([l[0][1] for l in leaves])
    for i in np.argsort(depth):
        p, a, t = leaves[i]
        col = hsv_jitter(cols[rng.integers(len(cols))], rng, dh=0.10, ds=0.15, dv=dv)
        r = math.hypot(p[0] - cx, p[1] - cy) / (0.42 * S)
        shade = (0.66 + 0.42 * depth[i]) * (0.84 + 0.18 * min(1.0, r)) * (0.92 + 0.14 * p[1] / S)
        L = leaf_len * k * rng.uniform(0.75, 1.2) * (0.85 + 0.2 * t)
        W = leaf_w * k * rng.uniform(0.85, 1.15) * L / (leaf_len * k)
        ax = np.array([math.cos(a), math.sin(a)], np.float32)
        px = np.array([-ax[1], ax[0]], np.float32)
        b = p + ax * L * 0.08
        if not (cv.inside(b + ax * L) and cv.inside(b + ax * L * 0.5 + px * W) and cv.inside(b + ax * L * 0.5 - px * W)):
            continue
        cv.leaf(b, a, L, W, shape, col * shade)
    cv.finish()
    return cv


def paint_needle_tile(S, seed, cols, needle_len, spacing, per_node, fwd=(0.2, 1.1),
                      needle_w=2.0, spray_kw=None, core=None):
    rng = np.random.default_rng(seed)
    cv = Canvas(S)
    k = S / 512
    twigs = spray(rng, S, **(spray_kw or {}))
    draw_twigs(cv, rng, twigs, (3.0, 2.0, 1.4))
    if core is not None:
        underlayer(cv, rng, twigs, needle_len * 0.9, np.asarray(core, np.float32))
    needles = []
    for pts, lvl in twigs:
        for p, ang, t in walk(pts, spacing * k):
            if lvl == 0 and t < 0.18:
                continue
            for _ in range(per_node):
                a = ang + rng.choice([-1, 1]) * rng.uniform(*fwd)
                L = needle_len * k * rng.uniform(0.65, 1.15) * (1.0 - 0.3 * t ** 2)
                needles.append((p, a, L))
        q, a0 = point_at(pts, 1.0)
        for _ in range(per_node * 4):
            needles.append((q, a0 + rng.uniform(-0.8, 0.8), needle_len * k * rng.uniform(0.5, 0.95)))
    depth = rng.uniform(0, 1, len(needles))
    for i in np.argsort(depth):
        p, a, L = needles[i]
        c = hsv_jitter(cols[rng.integers(len(cols))], rng, dh=0.06, ds=0.12, dv=0.12)
        shade = 0.66 + 0.44 * depth[i]
        e = p + L * np.array([math.cos(a), math.sin(a)], np.float32)
        if not cv.inside(e, 4.0):
            continue
        w = needle_w * k * rng.uniform(0.85, 1.2)
        cv.line(p, e, w, w * 0.55, c * shade * 0.8, c * shade * 1.12)
    cv.finish()
    return cv


def paint_pine_tile(S, seed, cols, needle_len, core, spray_kw=None, brush=0.5, per_node=3, tip_n=16):
    """Pine: bare twigs ending in radiating needle brushes (fascicles crowd the last
    part of each shoot), unlike the fern-like fronds of fir/hemlock."""
    rng = np.random.default_rng(seed)
    cv = Canvas(S)
    k = S / 512
    twigs = spray(rng, S, **(spray_kw or {}))
    draw_twigs(cv, rng, twigs, (3.2, 2.2, 1.6), col=TWIG_COL * 1.1)
    core = np.asarray(core, np.float32)
    needles = []
    for pts, lvl in twigs:
        if lvl == 0 and len(twigs) > 3:
            t0 = 0.75
        else:
            t0 = 1.0 - brush
        for p, ang, t in walk(pts, 2.2 * k):
            if t < t0:
                continue
            f = (t - t0) / max(1e-6, 1 - t0)
            fwd = np.array([math.cos(ang), math.sin(ang)], np.float32)
            cv.blob(p + fwd * needle_len * k * 0.35, needle_len * k * 0.3, needle_len * k * 0.2, ang,
                    core * rng.uniform(0.9, 1.25))
            for _ in range(per_node):
                a = ang + rng.choice([-1, 1]) * rng.uniform(0.15, 1.25)
                L = needle_len * k * rng.uniform(0.6, 1.1) * (0.8 + 0.3 * f)
                needles.append((p, a, L))
        q, a0 = point_at(pts, 1.0)
        for _ in range(tip_n):
            needles.append((q, a0 + rng.uniform(-1.1, 1.1), needle_len * k * rng.uniform(0.55, 1.0)))
    depth = rng.uniform(0, 1, len(needles))
    for i in np.argsort(depth):
        p, a, L = needles[i]
        c = hsv_jitter(cols[rng.integers(len(cols))], rng, dh=0.06, ds=0.12, dv=0.12)
        shade = 0.62 + 0.5 * depth[i]
        e = p + L * np.array([math.cos(a), math.sin(a)], np.float32)
        if not cv.inside(e, 4.0):
            continue
        w = 1.9 * k * rng.uniform(0.85, 1.2)
        cv.line(p, e, w, w * 0.5, c * shade * 0.78, c * shade * 1.15)
    cv.finish()
    return cv


def paint_cypress_tile(S, seed, cols, tip_col, core):
    """Monterey cypress: dense rope-like sprays of scale leaves forming a lumpy clump."""
    rng = np.random.default_rng(seed)
    cv = Canvas(S)
    k = S / 512
    twigs = spray(rng, S, depth_max=3, kids=(4, 6), kid_ang=(0.3, 0.85), kid_len=0.62, roots=3,
                  center=(0.5, 0.54), radii=(0.40, 0.38), lumps=0.22)
    draw_twigs(cv, rng, twigs, (3.4, 2.2, 1.5))
    underlayer(cv, rng, twigs, 17.0, np.asarray(core, np.float32))
    blobs = []
    for pts, lvl in twigs:
        for p, ang, t in walk(pts, 2.4 * k):
            if lvl == 0 and t < 0.3:
                continue
            tipness = t if lvl >= 2 else 0.35 * t
            r = (3.4 + 2.0 * rng.uniform()) * k * (1.0 + 0.25 * (lvl >= 2))
            for _ in range(3):
                blobs.append((p + rng.normal(0, 2.2 * k, 2), ang, r, tipness))
    depth = rng.uniform(0, 1, len(blobs))
    cx = np.mean([b[0][0] for b in blobs])
    cy = np.mean([b[0][1] for b in blobs])
    for i in np.argsort(depth):
        p, ang, r, t = blobs[i]
        c = hsv_jitter(cols[rng.integers(len(cols))], rng, dh=0.06, ds=0.10, dv=0.12)
        m = 0.6 * t ** 3
        c = c * (1 - m) + np.asarray(tip_col, np.float32) * m
        rr = math.hypot(p[0] - cx, p[1] - cy) / (0.42 * S)
        shade = (0.6 + 0.46 * depth[i]) * (0.82 + 0.2 * min(1.0, rr)) * (0.92 + 0.14 * p[1] / S)
        if not cv.inside(p, r * 1.5 + 3):
            continue
        cv.blob(p, r * 1.5, r, ang + rng.normal(0, 0.35), c * shade, shade_dir=(0.5, 0.85), shade_amt=0.25)
    cv.finish()
    return cv


def paint_gorse_tile(S, seed, spine_cols, flower_cols, core):
    rng = np.random.default_rng(seed)
    cv = Canvas(S)
    k = S / 512
    twigs = spray(rng, S, depth_max=2, kids=(6, 9), kid_ang=(0.35, 1.0), kid_len=0.55, roots=4,
                  center=(0.5, 0.52), radii=(0.42, 0.40), lumps=0.22, wander=0.12)
    draw_twigs(cv, rng, twigs, (2.6, 1.9, 1.4))
    underlayer(cv, rng, twigs, 13.0, np.asarray(core, np.float32), min_lvl=0)
    spines = []
    flowers = []
    for pts, lvl in twigs:
        for p, ang, t in walk(pts, 2.4 * k):
            for _ in range(6):
                a = ang + rng.uniform(-1.4, 1.4)
                L = k * rng.uniform(9, 19) * (1.0 - 0.3 * t)
                spines.append((p, a, L))
            if lvl >= 1 and t > 0.4 and rng.uniform() < 0.035:
                for _ in range(rng.integers(2, 5)):
                    flowers.append((p + rng.normal(0, 5 * k, 2), rng.uniform(0, TAU)))
    depth = rng.uniform(0, 1, len(spines))
    for i in np.argsort(depth):
        p, a, L = spines[i]
        c = hsv_jitter(spine_cols[rng.integers(len(spine_cols))], rng, dh=0.05, ds=0.1, dv=0.12)
        sh = 0.62 + 0.45 * depth[i]
        e = p + L * np.array([math.cos(a), math.sin(a)], np.float32)
        if not cv.inside(e, 3.0):
            continue
        cv.line(p, e, 2.0 * k, 0.8 * k, c * sh * 0.85, c * sh * 1.1)
    for p, a in flowers:
        c = hsv_jitter(flower_cols[rng.integers(len(flower_cols))], rng, dh=0.04, ds=0.08, dv=0.08)
        r = k * rng.uniform(3.4, 5.0)
        if not cv.inside(p, r * 2 + 3):
            continue
        cv.blob(p, r * 1.15, r * 0.9, a, c * 0.84, shade_dir=(0.6, 0.8), shade_amt=0.25)
        q = p + r * 0.7 * np.array([math.cos(a), math.sin(a)], np.float32)
        cv.blob(q, r * 0.75, r * 0.55, a, c * 1.02, shade_dir=(0.6, 0.8), shade_amt=0.2)
    cv.finish()
    return cv


# ---------------------------------------------------------------------------
# atlas assembly

def box_blur(img, r):
    """Separable box blur via cumulative sums (img: HxW or HxWxC)."""
    out = img.astype(np.float32)
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(out, pad, mode='edge'), axis=axis)
        n = out.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        out = (hi - lo) / (2 * r + 1)
    return out


def assemble(tiles):
    """2x2 tiles (Canvas) -> straight-alpha RGBA float array, row 0 = bottom.
    Transparent pixels get bled leaf colour so mip-mapping never darkens edges."""
    S = tiles[0].S
    N = S * 2
    P = np.zeros((N, N, 3), np.float32)
    A = np.zeros((N, N), np.float32)
    for i, t in enumerate(tiles):
        cx, cy = i % 2, i // 2
        P[cy * S:(cy + 1) * S, cx * S:(cx + 1) * S] = t.P
        A[cy * S:(cy + 1) * S, cx * S:(cx + 1) * S] = t.A
    rgb = P / np.maximum(A, 1e-4)[..., None]
    mean = (P.reshape(-1, 3).sum(0) / max(float(A.sum()), 1e-4)).astype(np.float32)
    fill = np.broadcast_to(mean, rgb.shape).copy()
    for r in (48, 16, 6, 2):
        bp = box_blur(P, r)
        ba = box_blur(A, r)
        ok = ba > 0.02
        fill[ok] = bp[ok] / ba[ok][..., None]
    out_rgb = np.where((A > 0.02)[..., None], rgb, fill)
    rgba = np.concatenate([np.clip(out_rgb, 0, 1), A[..., None]], axis=2)
    return np.nan_to_num(rgba).astype(np.float32)


def leaves_atlas(S=512):
    oak_cols = [(0.21, 0.33, 0.10), (0.25, 0.37, 0.11), (0.29, 0.40, 0.13), (0.19, 0.30, 0.11)]
    oak2_cols = [(0.23, 0.36, 0.11), (0.28, 0.41, 0.12), (0.32, 0.43, 0.14), (0.20, 0.32, 0.10)]
    birch_cols = [(0.38, 0.50, 0.16), (0.44, 0.55, 0.18), (0.33, 0.46, 0.14), (0.47, 0.57, 0.21)]
    shrub_cols = [(0.20, 0.34, 0.12), (0.25, 0.39, 0.14), (0.17, 0.30, 0.11)]
    t0 = paint_broadleaf_tile(S, 11, shape_oak, oak_cols, 38, 13, 12, 2, 6,
                              spray_kw=dict(kids=(4, 6), center=(0.5, 0.55), radii=(0.36, 0.35), lumps=0.22))
    t1 = paint_broadleaf_tile(S, 23, shape_broad, oak2_cols, 36, 13, 12, 2, 6,
                              spray_kw=dict(kids=(4, 6), center=(0.5, 0.55), radii=(0.37, 0.34), lumps=0.25))
    t2 = paint_broadleaf_tile(S, 53, shape_birch, birch_cols, 26, 10, 9, 2, 5, droop=0.45, dv=0.14,
                              spray_kw=dict(kids=(4, 7), kid_ang=(0.5, 1.2), center=(0.5, 0.54),
                                            radii=(0.38, 0.38), wander=0.12, lumps=0.22))
    t3 = paint_broadleaf_tile(S, 41, shape_small, shrub_cols, 21, 8, 7, 2, 6,
                              spray_kw=dict(kids=(5, 8), center=(0.5, 0.54), radii=(0.40, 0.39), lumps=0.2))
    return assemble([t0, t1, t2, t3])


def needles_atlas(S=512):
    cols = [(0.15, 0.27, 0.15), (0.19, 0.31, 0.17), (0.23, 0.35, 0.19), (0.12, 0.23, 0.12)]
    core = (0.09, 0.15, 0.08)
    t0 = paint_pine_tile(S, 101, cols, 52, core, spray_kw=dict(kids=(4, 6), center=(0.5, 0.52), radii=(0.34, 0.34)))
    t1 = paint_pine_tile(S, 113, cols, 48, core, spray_kw=dict(kids=(5, 7), center=(0.5, 0.52), radii=(0.36, 0.31)))
    t2 = paint_pine_tile(S, 127, cols, 44, core, brush=0.6, spray_kw=dict(kids=(5, 8), center=(0.5, 0.53), radii=(0.35, 0.34)))
    t3 = paint_pine_tile(S, 131, cols, 56, core, brush=0.45, spray_kw=dict(kids=(3, 5), center=(0.5, 0.53), radii=(0.31, 0.36)))
    return assemble([t0, t1, t2, t3])


def cypress_atlas(S=512):
    cols = [(0.09, 0.19, 0.08), (0.12, 0.23, 0.09), (0.15, 0.26, 0.10), (0.08, 0.16, 0.07)]
    tip = (0.30, 0.40, 0.14)
    core = (0.05, 0.10, 0.05)
    return assemble([paint_cypress_tile(S, s, cols, tip, core) for s in (201, 211, 223, 227)])


def gorse_atlas(S=512):
    spine = [(0.12, 0.21, 0.08), (0.15, 0.25, 0.09), (0.10, 0.18, 0.08), (0.18, 0.28, 0.11)]
    flower = [(0.98, 0.80, 0.08), (1.0, 0.86, 0.20), (0.95, 0.72, 0.05)]
    core = (0.06, 0.11, 0.05)
    return assemble([paint_gorse_tile(S, s, spine, flower, core) for s in (301, 307, 311, 317)])


ATLASES = {
    # material name -> (generator, tile size in px; atlas is 2x tile size)
    "Leaves": (leaves_atlas, 512),
    "Needles": (needles_atlas, 512),
    "LeavesCypress": (cypress_atlas, 512),
    "Gorse": (gorse_atlas, 256),
}
