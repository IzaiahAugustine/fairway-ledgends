"""Shared geometry helpers: a mesh accumulator (verts / quads / per-corner UVs /
per-vertex AO colour / optional per-vertex custom normals) that turns into a
Blender mesh object, plus small vector utilities. Blender space: Z up, metres."""
import math
import bpy
import numpy as np

UP = np.array([0.0, 0.0, 1.0])


def unit(v):
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else np.array(v, float)


def any_perp(v):
    a = np.array([1.0, 0.0, 0.0]) if abs(v[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    return unit(np.cross(v, a))


def rotate(v, axis, ang):
    """Rodrigues rotation of v about axis by ang (radians)."""
    k = unit(axis)
    c, s = math.cos(ang), math.sin(ang)
    return v * c + np.cross(k, v) * s + k * np.dot(k, v) * (1.0 - c)


def random_unit(rng):
    return unit(rng.normal(size=3))


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


class MeshAccum:
    def __init__(self):
        self.verts = []
        self.faces = []
        self.uvs = []        # one (u, v) per face corner, in face order
        self.cols = []       # per vertex (r, g, b) linear
        self.normals = []    # per vertex, or None entries if not custom

    # -- primitives -------------------------------------------------------
    def add_vert(self, p, col=(1.0, 1.0, 1.0), n=None):
        self.verts.append(tuple(float(x) for x in p))
        self.cols.append(tuple(col))
        self.normals.append(None if n is None else tuple(float(x) for x in unit(np.asarray(n, float))))
        return len(self.verts) - 1

    def add_face(self, idx, uvs):
        self.faces.append(tuple(idx))
        self.uvs.extend(uvs)

    def tube(self, pts, radii, sides, u_reps=1, v_len=None, ring_fn=None, ao_fn=None, cap_end=False):
        """Tube along a polyline using parallel-transport frames.
        UV: U wraps around (0..u_reps, seam duplicated), V = arc length / v_len.
        ring_fn(i, theta) -> radius multiplier (root flare / gnarl lobes).
        ao_fn(p) -> AO value for the vertex colour."""
        pts = [np.asarray(p, float) for p in pts]
        n = len(pts)
        if n < 2:
            return
        tans = []
        for i in range(n):
            if i == 0:
                t = pts[1] - pts[0]
            elif i == n - 1:
                t = pts[-1] - pts[-2]
            else:
                t = unit(pts[i + 1] - pts[i]) + unit(pts[i] - pts[i - 1])
            tans.append(unit(t))
        N = any_perp(tans[0])
        frames = []
        for i in range(n):
            if i > 0:
                a, b = tans[i - 1], tans[i]
                ax = np.cross(a, b)
                s = float(np.linalg.norm(ax))
                if s > 1e-8:
                    N = rotate(N, ax, math.atan2(s, float(np.dot(a, b))))
                N = unit(N - tans[i] * np.dot(N, tans[i]))
            B = np.cross(tans[i], N)
            frames.append((N, B))
        if v_len is None:
            v_len = max(2 * math.pi * radii[0] / u_reps, 0.05)
        s_acc = 0.0
        rings = []
        for i in range(n):
            if i > 0:
                s_acc += float(np.linalg.norm(pts[i] - pts[i - 1]))
            N, B = frames[i]
            ring = []
            for j in range(sides + 1):
                th = 2 * math.pi * j / sides
                d = N * math.cos(th) + B * math.sin(th)
                r = radii[i] * (ring_fn(i, th) if ring_fn else 1.0)
                p = pts[i] + d * r
                ao = ao_fn(p) if ao_fn else 1.0
                ring.append((self.add_vert(p, (ao, ao, ao), d), u_reps * j / sides, s_acc / v_len))
            rings.append(ring)
        for i in range(n - 1):
            r0, r1 = rings[i], rings[i + 1]
            for j in range(sides):
                a, b, c, d = r0[j], r0[j + 1], r1[j + 1], r1[j]
                self.add_face((a[0], b[0], c[0], d[0]),
                              [(a[1], a[2]), (b[1], b[2]), (c[1], c[2]), (d[1], d[2])])
        if cap_end:
            last = rings[-1]
            tip = pts[-1] + tans[-1] * radii[-1] * 0.6
            ao = ao_fn(tip) if ao_fn else 1.0
            ti = self.add_vert(tip, (ao, ao, ao), tans[-1])
            for j in range(sides):
                a, b = last[j], last[j + 1]
                self.add_face((a[0], b[0], ti), [(a[1], a[2]), (b[1], b[2]), ((a[1] + b[1]) / 2, a[2] + 0.1)])

    def card(self, base, up, normal, w, h, uv_rect, mirror=False, normal_fn=None, ao_fn=None, face_mix=0.15):
        """Foliage quad. `base` = bottom-centre (where the painted twig starts), `up` =
        texture up direction, `normal` = desired facing. Winding is chosen so the
        geometric normal agrees with `normal` (outward), which keeps three.js
        DoubleSide back-face flipping from inverting the custom normals on the
        side of the crown the camera actually sees."""
        n0 = unit(normal)
        up = unit(up - n0 * np.dot(up, n0))
        right = np.cross(up, n0)
        u0, v0, u1, v1 = uv_rect
        if mirror:
            u0, u1 = u1, u0
        hw = w * 0.5
        P = [base - right * hw, base + right * hw, base + right * hw + up * h, base - right * hw + up * h]
        UV = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        idx = []
        nsum = np.zeros(3)
        for p in P:
            nn = normal_fn(p) if normal_fn else n0
            nn = unit(unit(nn) * (1 - face_mix) + n0 * face_mix)
            nsum += nn
            ao = ao_fn(p) if ao_fn else 1.0
            idx.append(self.add_vert(p, (ao, ao, ao), nn))
        if np.dot(nsum, n0) < 0:
            # make the geometric front agree with the custom normals it will be shaded with
            idx, UV = idx[::-1], UV[::-1]
        self.add_face(idx, UV)

    def obox(self, center, axes, half, col=(1, 1, 1)):
        """Oriented box with flat per-face normals. axes = 3 orthonormal vectors,
        half = half-extents along them. UVs are in metres (texel-density friendly)."""
        c = np.asarray(center, float)
        A = [unit(np.asarray(a, float)) for a in axes]
        for k in range(3):
            for s in (-1, 1):
                n = A[k] * s
                i1, i2 = (k + 1) % 3, (k + 2) % 3
                if s < 0:
                    i1, i2 = i2, i1
                e1, e2 = A[i1] * half[i1], A[i2] * half[i2]
                fc = c + n * half[k]
                P = [fc - e1 - e2, fc + e1 - e2, fc + e1 + e2, fc - e1 + e2]
                idx = [self.add_vert(p, col, n) for p in P]
                L1, L2 = 2 * half[i1], 2 * half[i2]
                self.add_face(idx, [(0, 0), (L1, 0), (L1, L2), (0, L2)])

    def box(self, center, half, col=(1, 1, 1)):
        self.obox(center, (np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])), half, col)

    def beam(self, start, end, hw, hh, up_hint=(0, 0, 1), col=(1, 1, 1)):
        """Rectangular bar from start to end (no Euler rotations)."""
        s, e = np.asarray(start, float), np.asarray(end, float)
        f = unit(e - s)
        u = np.asarray(up_hint, float)
        if abs(np.dot(f, unit(u))) > 0.95:
            u = np.array([1.0, 0, 0]) if abs(f[0]) < 0.9 else np.array([0, 1.0, 0])
        r = unit(np.cross(f, u))
        up = np.cross(r, f)
        self.obox((s + e) / 2, (f, r, up), (float(np.linalg.norm(e - s)) / 2, hw, hh), col)

    def disk(self, center, normal, radius, sides, col=(1, 1, 1), frame_x=None, r_inner=0.0):
        """Flat disk (triangle fan) or annulus facing `normal`."""
        c = np.asarray(center, float)
        n = unit(np.asarray(normal, float))
        X = any_perp(n) if frame_x is None else unit(np.asarray(frame_x, float))
        Y = np.cross(n, X)
        ring = [c + (X * math.cos(2 * math.pi * j / sides) + Y * math.sin(2 * math.pi * j / sides)) * radius
                for j in range(sides)]
        outer = [self.add_vert(p, col, n) for p in ring]
        uvo = [(0.5 + 0.5 * math.cos(2 * math.pi * j / sides), 0.5 + 0.5 * math.sin(2 * math.pi * j / sides))
               for j in range(sides)]
        if r_inner > 0:
            k = r_inner / radius
            inner = [self.add_vert(c + (p - c) * k, col, n) for p in ring]
            uvi = [(0.5 + (u - 0.5) * k, 0.5 + (v - 0.5) * k) for u, v in uvo]
            for j in range(sides):
                jn = (j + 1) % sides
                self.add_face((inner[j], outer[j], outer[jn], inner[jn]), [uvi[j], uvo[j], uvo[jn], uvi[jn]])
        else:
            ci = self.add_vert(c, col, n)
            for j in range(sides):
                jn = (j + 1) % sides
                self.add_face((ci, outer[j], outer[jn]), [(0.5, 0.5), uvo[j], uvo[jn]])

    def lathe(self, profile, sides, frame=None, col_fn=None, u_reps=1.0):
        """Surface of revolution. profile: list of (r, z) points, with None entries
        marking hard edges (a new strip starts). Normals are analytic (smooth along
        each strip), winding gives outward = (dz, -dr) side of the profile direction.
        frame = (origin, X, Y, Z) maps local (x, y, z) to world."""
        if frame is None:
            frame = (np.zeros(3), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0]))
        O, FX, FY, FZ = [np.asarray(v, float) for v in frame]
        strips, cur = [], []
        for p in profile:
            if p is None:
                if len(cur) > 1:
                    strips.append(cur)
                cur = [cur[-1]] if cur else []
                continue
            cur.append(p)
        if len(cur) > 1:
            strips.append(cur)
        vacc = 0.0
        for st in strips:
            n = len(st)
            rings = []
            for i, (r, z) in enumerate(st):
                a = st[max(i - 1, 0)]
                b = st[min(i + 1, n - 1)]
                tr, tz = b[0] - a[0], b[1] - a[1]
                L = math.hypot(tr, tz) or 1.0
                nr, nz = tz / L, -tr / L
                if i > 0:
                    vacc += math.hypot(r - st[i - 1][0], z - st[i - 1][1])
                ring = []
                for j in range(sides):
                    th = 2 * math.pi * j / sides
                    ct, s_ = math.cos(th), math.sin(th)
                    p = O + FX * (r * ct) + FY * (r * s_) + FZ * z
                    nn = FX * (nr * ct) + FY * (nr * s_) + FZ * nz
                    if r < 1e-7:
                        nn = FZ * (1.0 if nz >= 0 else -1.0)
                    col = col_fn(r, z) if col_fn else (1.0, 1.0, 1.0)
                    ring.append(self.add_vert(p, col, nn))
                rings.append((ring, vacc))
            for i in range(n - 1):
                (r0, v0), (r1, v1) = rings[i], rings[i + 1]
                pole0, pole1 = st[i][0] < 1e-7, st[i + 1][0] < 1e-7
                for j in range(sides):
                    jn = (j + 1) % sides
                    u0, u1 = u_reps * j / sides, u_reps * (j + 1) / sides
                    if pole0 and not pole1:
                        self.add_face((r0[j], r1[jn], r1[j]), [((u0 + u1) / 2, v0), (u1, v1), (u0, v1)])
                    elif pole1 and not pole0:
                        self.add_face((r0[j], r0[jn], r1[j]), [(u0, v0), (u1, v0), ((u0 + u1) / 2, v1)])
                    elif not (pole0 and pole1):
                        self.add_face((r0[j], r0[jn], r1[jn], r1[j]), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])

    def tri_count(self):
        return sum(len(f) - 2 for f in self.faces)

    # -- output -----------------------------------------------------------
    def to_object(self, name, material, collection, parent=None, colors=True, custom_normals=True, smooth=True):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], self.faces)
        uv = me.uv_layers.new(name="UVMap")
        uv.data.foreach_set("uv", [c for t in self.uvs for c in t])
        if colors:
            ca = me.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
            ca.data.foreach_set("color", [c for col in self.cols for c in (col[0], col[1], col[2], 1.0)])
            me.color_attributes.active_color = ca
            me.color_attributes.render_color_index = me.color_attributes.active_color_index
        if smooth:
            me.shade_smooth()
        if custom_normals and all(n is not None for n in self.normals):
            me.normals_split_custom_set_from_vertices(self.normals)
        me.materials.append(material)
        me.update()
        ob = bpy.data.objects.new(name, me)
        collection.objects.link(ob)
        if parent is not None:
            ob.parent = parent
        return ob


def new_empty(name, collection, size=0.5):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = size
    collection.objects.link(e)
    return e
