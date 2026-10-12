"""Head accessories (all parented rigidly to the Head bone by the rig builder):
Hair_Short, Hair_Long (pulled back + ponytail), Hat_Cap, Hat_Visor, Hat_Bucket, Sunglasses.

Shells are built per meridian around the skull centre: each column runs from the
crown down to a boundary line (hairline / hat line) so edges are clean curves.
Clearances above the scalp: Hair_Short 0.008, Hair_Long 0.010, Visor band 0.013,
Cap crown 0.015, Bucket crown 0.017 -> every hat clears every hair style.
"""
import math
import bpy
import bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

import golfer_common as C
import golfer_body as B

K = B.HEAD_SCALE


def _scaled(p):
    return B.HEAD_PIVOT + (Vector(p) - B.HEAD_PIVOT) * K


SKULL_C = _scaled((0.0, 0.016, 1.703))


def _interp_periodic(table, a):
    """Catmull-Rom over a periodic table [(deg, value)] symmetric in |a|."""
    a = abs(math.degrees(a))
    xs = [t[0] for t in table]
    ys = [t[1] for t in table]
    for i in range(len(xs) - 1):
        if xs[i] <= a <= xs[i + 1]:
            t = (a - xs[i]) / (xs[i + 1] - xs[i])
            p0 = ys[max(0, i - 1)]
            p1, p2 = ys[i], ys[i + 1]
            p3 = ys[min(len(ys) - 1, i + 2)]
            return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                          + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
    return ys[-1]


class Skull:
    """Ray caster against a smooth skull proxy (no ears / nose)."""

    def __init__(self):
        m = C.Meta('SkullProxy', resolution=0.006)
        m.ellipsoid((0, 0.016, 1.703), (0.0790, 0.098, 0.089))
        m.ellipsoid((0, -0.026, 1.636), (0.062, 0.064, 0.064))
        m.ellipsoid((0, 0.040, 1.640), (0.056, 0.046, 0.050))
        m.capsule((0, 0.024, 1.440), (0, 0.008, 1.625), 0.0605)
        ob = m.to_mesh('SkullProxy')
        for v in ob.data.vertices:
            v.co = _scaled(v.co)
        self.bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
        self.ob = ob

    def free(self):
        bpy.data.objects.remove(self.ob)

    def surf(self, d):
        d = d.normalized()
        hit = self.bvh.ray_cast(SKULL_C, d, 0.5)
        return hit[0] if hit[0] is not None else SKULL_C + d * 0.09


def _dir(theta, alpha):
    """theta from +Z (crown), alpha azimuth from the face (-Y) toward +X."""
    return Vector((math.sin(theta) * math.sin(alpha), -math.sin(theta) * math.cos(alpha), math.cos(theta)))


def _theta_at(skull, alpha, z_rel):
    lo, hi = 0.05, math.radians(165)
    for _ in range(30):
        mid = (lo + hi) * 0.5
        p = skull.surf(_dir(mid, alpha))
        if p.z - SKULL_C.z > z_rel:
            lo = mid
        else:
            hi = mid
    return (lo + hi) * 0.5


def shell(skull, name, boundary, offset_fn, n_alpha=48, n_rings=12, tuck=True, mat='Hair'):
    """Grid shell: columns over alpha, rings from crown to boundary(alpha).
    offset_fn(t, alpha) = clearance above the skull for ring parameter t in [0,1]."""
    cols = []
    for j in range(n_alpha):
        al = -math.pi + 2 * math.pi * j / n_alpha
        th_max = _theta_at(skull, al, boundary(al) * K)
        col = []
        for i in range(1, n_rings + 1):
            t = i / n_rings
            th = th_max * (t ** 0.85)
            d = _dir(th, al)
            p = skull.surf(d)
            col.append(p + d * offset_fn(t, al))
        if tuck:
            d = _dir(th_max * 1.01, al)
            col.append(skull.surf(d) + d * 0.0006)
        cols.append(col)
    nr = len(cols[0])
    top = SKULL_C + Vector((0, 0, 1)) * ((skull.surf(Vector((0, 0, 1))) - SKULL_C).length + offset_fn(0.0, 0.0))
    verts = [top]
    for col in cols:
        verts.extend(col)
    faces = []
    na = len(cols)
    for j in range(na):
        jn = (j + 1) % na
        faces.append((0, 1 + jn * nr, 1 + j * nr))
        for i in range(nr - 1):
            a = 1 + j * nr + i
            b = 1 + jn * nr + i
            faces.append((a, b, b + 1, a + 1))
    ob = C.new_mesh_obj(name, verts, faces, mat)
    C.recalc_normals(ob)
    # make normals point outward
    me = ob.data
    out = sum((p.normal.dot(p.center - SKULL_C) for p in me.polygons))
    if out < 0:
        me.flip_normals()
    C.shade_smooth(ob)
    return ob


# ---------------------------------------------------------------- hair
HAIRLINE_SHORT = [(0, 0.050), (30, 0.046), (52, 0.034), (64, 0.010), (72, -0.030), (80, -0.032),
                  (87, 0.002), (100, 0.000), (118, -0.030), (140, -0.062), (180, -0.076)]
HAIRLINE_LONG = [(0, 0.050), (30, 0.046), (52, 0.034), (64, 0.012), (72, -0.024), (80, -0.026),
                 (87, 0.004), (100, 0.000), (118, -0.034), (140, -0.070), (180, -0.086)]


def _hair_offset(T):
    def f(t, al):
        strand = 0.0005 * math.sin(al * 26.0 + t * 4.0)
        if t > 0.80:
            return 0.0008 + (T - 0.0008) * ((1.0 - t) / 0.20) ** 0.7 + strand * 0.3
        return T * (1.0 + 0.10 * (1 - t)) + strand
    return f


def build_hair_short(skull):
    return shell(skull, 'Hair_Short', lambda a: _interp_periodic(HAIRLINE_SHORT, a), _hair_offset(0.0080),
                 n_alpha=56, n_rings=12)


def build_hair_long(skull):
    hair = shell(skull, 'Hair_Long', lambda a: _interp_periodic(HAIRLINE_LONG, a), _hair_offset(0.0105),
                 n_alpha=56, n_rings=12)
    # hair tie + ponytail hanging from the back of the head
    d = _dir(math.radians(112), math.pi)
    root = skull.surf(d) + d * 0.010
    path = [root, root + Vector((0, 0.030, -0.030)), root + Vector((0, 0.040, -0.080)),
            root + Vector((0, 0.036, -0.140)), root + Vector((0, 0.028, -0.200))]
    radii = [0.017, 0.021, 0.019, 0.013, 0.004]
    rings = []
    sides = 12
    for i, (p, r) in enumerate(zip(path, radii)):
        tan = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        u = Vector((1, 0, 0))
        w = tan.cross(u).normalized()
        u = w.cross(tan).normalized()
        rings.append([p + (u * math.cos(2 * math.pi * k / sides) + w * math.sin(2 * math.pi * k / sides))
                      * r * (1.0 + 0.08 * math.sin(3 * 2 * math.pi * k / sides)) for k in range(sides)])
    tail = C.loft('Ponytail', rings, closed_start=True, closed_end=True, mat='Hair')
    C.recalc_normals(tail)
    C.shade_smooth(tail)
    tie_c = root + Vector((0, 0.006, -0.006))
    tie_rings = []
    for off in (-0.006, 0.006):
        tan = Vector((0, 0.7, -0.7)).normalized()
        c = tie_c + tan * off
        u = Vector((1, 0, 0))
        w = tan.cross(u).normalized()
        tie_rings.append([c + (u * math.cos(2 * math.pi * k / sides) + w * math.sin(2 * math.pi * k / sides)) * 0.0185
                          for k in range(sides)])
    tie = C.loft('HairTie', tie_rings, closed_start=True, closed_end=True, mat='Frame')
    C.recalc_normals(tie)
    return C.join([hair, tail, tie], 'Hair_Long')


# ---------------------------------------------------------------- hats
CAP_LINE = [(0, 0.040), (40, 0.036), (75, 0.020), (90, 0.016), (120, 0.010), (160, 0.004), (180, 0.002)]
VISOR_TOP = [(0, 0.062), (40, 0.058), (90, 0.046), (140, 0.036), (180, 0.034)]
BUCKET_LINE = [(0, 0.038), (40, 0.034), (90, 0.018), (140, 0.008), (180, 0.006)]


def _bill(skull, name, line, clearance, reach=0.074, half_angle=68, tilt=12, curve=0.018):
    """Curved cap bill attached along the front of the hat line."""
    nu, nv = 17, 6
    top, bot = [], []
    for i in range(nu):
        al = math.radians(-half_angle + 2 * half_angle * i / (nu - 1))
        z_rel = _interp_periodic(line, al) * K
        th = _theta_at(skull, al, z_rel)
        d = _dir(th, al)
        base = skull.surf(d) + d * (clearance + 0.001)
        out = Vector((math.sin(al), -math.cos(al), 0.0))
        across = abs(math.degrees(al)) / half_angle
        length = reach * math.sqrt(max(0.0, 1.0 - across ** 2.2)) + 0.004
        rowt, rowb = [], []
        for k in range(nv):
            v = k / (nv - 1)
            drop = math.tan(math.radians(tilt)) * length * v + curve * across ** 2 * v
            p = base + out * (length * v) - Vector((0, 0, drop))
            rowt.append(p + Vector((0, 0, 0.0025)))
            rowb.append(p - Vector((0, 0, 0.0025)))
        top.append(rowt)
        bot.append(rowb)
    verts, faces = [], []
    idx = {}
    for s, grid in enumerate((top, bot)):
        for i in range(nu):
            for k in range(nv):
                idx[(s, i, k)] = len(verts)
                verts.append(grid[i][k])
    for s in (0, 1):
        for i in range(nu - 1):
            for k in range(nv - 1):
                f = (idx[(s, i, k)], idx[(s, i + 1, k)], idx[(s, i + 1, k + 1)], idx[(s, i, k + 1)])
                faces.append(f if s == 1 else f[::-1])
    # rim around the outer edge and the sides
    edge = [(i, nv - 1) for i in range(nu)] + [(nu - 1, k) for k in range(nv - 2, -1, -1)]
    edge = [(0, k) for k in range(0, nv)] + [(i, nv - 1) for i in range(1, nu)] + [(nu - 1, k) for k in range(nv - 2, -1, -1)]
    for a, b in zip(edge[:-1], edge[1:]):
        faces.append((idx[(0, a[0], a[1])], idx[(0, b[0], b[1])], idx[(1, b[0], b[1])], idx[(1, a[0], a[1])]))
    ob = C.new_mesh_obj(name, verts, faces, 'Hat')
    C.recalc_normals(ob)
    return ob


def build_cap(skull):
    def off(t, al):
        return 0.0150 + 0.006 * (1 - t) ** 2 if t < 0.95 else 0.0150
    crown = shell(skull, 'Hat_Cap', lambda a: _interp_periodic(CAP_LINE, a), off, n_alpha=40, n_rings=10,
                  tuck=True, mat='Hat')
    bill = _bill(skull, 'CapBill', CAP_LINE, 0.0150, reach=0.070, half_angle=62, tilt=9, curve=0.024)
    C.shade_smooth(bill)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=4, radius=0.0065,
                                         location=SKULL_C + Vector((0, 0, (skull.surf(Vector((0, 0, 1))) - SKULL_C).length + 0.019)))
    btn = bpy.context.active_object
    btn.name = 'CapButton'
    bpy.ops.object.transform_apply(location=True, scale=True)
    C.assign_all(btn, 'Hat')
    C.shade_smooth(btn)
    return C.join([crown, bill, btn], 'Hat_Cap')


def build_visor(skull):
    n = 44
    rings = []
    for z_off, clr in ((-0.0, 0.013), (1.0, 0.013), (1.0, 0.0105), (0.0, 0.0105)):
        ring = []
        for j in range(n):
            al = -math.pi + 2 * math.pi * j / n
            lo = _interp_periodic(CAP_LINE, al) * K
            hi = _interp_periodic(VISOR_TOP, al) * K
            if abs(al) > math.radians(120):        # thin strap at the back
                hi = lo + (hi - lo) * 0.45
            z = lo + (hi - lo) * z_off
            th = _theta_at(skull, al, z)
            d = _dir(th, al)
            ring.append(skull.surf(d) + d * clr)
        rings.append(ring)
    band = C.loft('VisorBand', rings + [rings[0]], mat='Hat')
    C.recalc_normals(band)
    C.shade_smooth(band)
    bill = _bill(skull, 'VisorBill', CAP_LINE, 0.013, reach=0.074, half_angle=62, tilt=9, curve=0.024)
    C.shade_smooth(bill)
    return C.join([band, bill], 'Hat_Visor')


def build_bucket(skull):
    def off(t, al):
        return 0.0170 + 0.010 * (1 - t) ** 1.5
    crown = shell(skull, 'Hat_Bucket', lambda a: _interp_periodic(BUCKET_LINE, a), off, n_alpha=40, n_rings=9,
                  tuck=False, mat='Hat')
    # flatten the dome into a bucket crown: compress the top, push the upper walls out
    zs = [v.co.z for v in crown.data.vertices]
    z_top, z_low = max(zs), min(zs)
    z_mid = z_low + (z_top - z_low) * 0.45
    for v in crown.data.vertices:
        w = min(1.0, max(0.0, (v.co.z - z_mid) / (z_top - z_mid)))
        w = w * w * (3 - 2 * w)
        rel = v.co - SKULL_C
        rho = Vector((rel.x, rel.y, 0.0))
        v.co.z = v.co.z + (z_top - v.co.z) * 0.55 * w - 0.008 * w
        v.co.x = SKULL_C.x + rho.x * (1.0 + 0.10 * w)
        v.co.y = SKULL_C.y + rho.y * (1.0 + 0.10 * w)
    # brim: annulus sloping down from the crown's lower edge
    n = 40
    inner, mid, outer, outer_b, inner_b = [], [], [], [], []
    for j in range(n):
        al = -math.pi + 2 * math.pi * j / n
        z_rel = _interp_periodic(BUCKET_LINE, al) * K
        th = _theta_at(skull, al, z_rel)
        d = _dir(th, al)
        p = skull.surf(d) + d * 0.0175
        out = Vector((math.sin(al), -math.cos(al), 0.0))
        inner.append(p)
        mid.append(p + out * 0.030 - Vector((0, 0, 0.010)))
        outer.append(p + out * 0.058 - Vector((0, 0, 0.026)))
        outer_b.append(p + out * 0.058 - Vector((0, 0, 0.030)))
        inner_b.append(p - Vector((0, 0, 0.004)))
    brim = C.loft('BucketBrim', [inner, mid, outer, outer_b, [m - Vector((0, 0, 0.004)) for m in mid], inner_b, inner],
                  mat='Hat')
    C.recalc_normals(brim)
    C.shade_smooth(brim)
    return C.join([crown, brim], 'Hat_Bucket')


# ---------------------------------------------------------------- sunglasses
def build_sunglasses(head_obj, eyes):
    bvh = BVHTree.FromObject(head_obj, bpy.context.evaluated_depsgraph_get())
    parts = []
    lens_w, lens_h = 0.054 * K * 0.95, 0.036 * K * 0.95
    for eye in eyes:
        ec = sum((v.co for v in eye.data.vertices), Vector()) / len(eye.data.vertices)
        s = 1.0 if ec.x > 0 else -1.0
        centre = Vector((ec.x + 0.003 * s, ec.y - 0.0245, ec.z - 0.002))
        nu, nv = 9, 5
        grid = []
        for i in range(nu):
            u = -1 + 2 * i / (nu - 1)
            row = []
            for k in range(nv):
                v = -1 + 2 * k / (nv - 1)
                # rounded rectangle via superellipse squeeze
                x = u * lens_w * 0.5
                z = v * lens_h * 0.5 * (1.0 - 0.18 * max(0.0, -v) * abs(u) - 0.10 * u * u * (1 if v > 0 else 0.4))
                wrap = 0.012 * (max(0.0, u * s)) ** 2      # wrap toward the temples
                row.append(centre + Vector((x, wrap + 0.004 * v * v, z)))
            grid.append(row)
        verts = [p for row in grid for p in row]
        faces = [(i * nv + k, (i + 1) * nv + k, (i + 1) * nv + k + 1, i * nv + k + 1)
                 for i in range(nu - 1) for k in range(nv - 1)]
        lens = C.new_mesh_obj('Lens', verts, faces, 'Lens')
        sol = lens.modifiers.new('Sol', 'SOLIDIFY')
        sol.thickness = 0.002
        C.apply_modifier(lens, sol)
        C.shade_smooth(lens)
        parts.append(lens)
        # frame rim along the top edge
        top_edge = [grid[i][nv - 1] + Vector((0, -0.0008, 0.0012)) for i in range(nu)]
        rim = []
        for p in top_edge:
            rim.append([p + Vector((0, 0, 0.0025)), p + Vector((0, -0.0025, 0.0)), p + Vector((0, 0, -0.0025)),
                        p + Vector((0, 0.0025, 0.0))])
        rim_ob = C.loft('Rim', rim, closed_start=True, closed_end=True, mat='Frame')
        C.recalc_normals(rim_ob)
        parts.append(rim_ob)
        # temple arm from the outer top corner back to the ear
        outer = grid[nu - 1 if s > 0 else 0][nv - 1]
        pts = [outer]
        for yy in (0.02, 0.05, 0.085, 0.105):
            z = outer.z - 0.004 - 0.018 * max(0.0, (yy - 0.06) / 0.05)
            o = Vector((0.0, outer.y + yy, z))
            hit = bvh.ray_cast(o, Vector((s, 0, 0)), 0.2)
            x = (hit[0].x + 0.0035 * s) if hit[0] is not None else outer.x
            pts.append(Vector((x, outer.y + yy, z)))
        arm = []
        for p in pts:
            arm.append([p + Vector((0, 0, 0.0028)), p + Vector((0.0012 * s, 0, 0)), p + Vector((0, 0, -0.0028)),
                        p + Vector((-0.0012 * s, 0, 0))])
        arm_ob = C.loft('Temple', arm, closed_start=True, closed_end=True, mat='Frame')
        C.recalc_normals(arm_ob)
        parts.append(arm_ob)
    # bridge between the lenses
    eL = sum((v.co for v in eyes[0].data.vertices), Vector()) / len(eyes[0].data.vertices)
    by = eL.y - 0.0245
    bridge = [[Vector((x, by - 0.001, eL.z + 0.004 + dz)) + o for o in
               (Vector((0, 0, 0.002)), Vector((0, -0.002, 0)), Vector((0, 0, -0.002)), Vector((0, 0.002, 0)))]
              for x, dz in ((-0.012, -0.001), (0.0, 0.002), (0.012, -0.001))]
    br = C.loft('Bridge', bridge, closed_start=True, closed_end=True, mat='Frame')
    C.recalc_normals(br)
    parts.append(br)
    return C.join(parts, 'Sunglasses')


def build_accessories(head_obj, eyes):
    skull = Skull()
    objs = [build_hair_short(skull), build_hair_long(skull), build_cap(skull), build_visor(skull),
            build_bucket(skull), build_sunglasses(head_obj, eyes)]
    skull.free()
    return objs
