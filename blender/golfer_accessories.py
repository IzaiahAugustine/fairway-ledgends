"""Head accessories (all parented rigidly to the Head bone by the rig builder):
Hair_Short, Hair_Long (pulled back + ponytail), Hat_Cap, Hat_Visor, Hat_Bucket, Sunglasses.

Shells are built per meridian around the skull centre: each column runs from the crown
down to a boundary line (hairline / hat line) so edges are clean curves. The skull proxy
is the MakeHuman head with the ears pressed flat; afterwards every shell vertex is pushed
out to a minimum clearance from the real head (ears included).
Clearances above the scalp: Hair_Short 0.005..0.011, Hair_Long 0.008..0.0098, Visor band 0.0122,
Cap crown >= 0.0128, Bucket crown 0.017 -> every hat clears every hair style (clearance() is
printed by the build: smallest radial gap per hair/hat pair, all >= 1.4 mm).
UVs: shells map (around, crown->edge) into their own rectangles of the Hair / Hat atlases.
"""
import math

import bmesh
import bpy
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

import golfer_common as C
import golfer_mh as MH
import golfer_tex as TX

PART = C.PART
SKULL_C = Vector((0.0, 0.004, 1.712))

UV = {
    'Hair': {'short': (0.0, 0.0, 1.0, 0.300), 'layer': (0.0, 0.305, 1.0, 0.340), 'cards': (0.0, 0.345, 1.0, 0.405),
             'long': (0.0, 0.42, 0.78, 0.86),
             'tail': (0.80, 0.42, 1.0, 0.86)},
    'Hat': {'cap': (0.0, 0.0, 1.0, 0.36), 'cap_bill': (0.0, 0.37, 0.50, 0.62), 'visor_bill': (0.50, 0.37, 1.0, 0.62),
            'visor_band': (0.0, 0.63, 1.0, 0.70), 'bucket': (0.0, 0.71, 0.62, 1.0), 'bucket_brim': (0.63, 0.71, 1.0, 1.0)},
}


def _interp_periodic(table, a):
    """Catmull-Rom over a table [(deg, value)] symmetric in |a|."""
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
    """Ray caster against the head with the ears pressed flat (skull proxy), plus the
    real head for clearance checks."""

    def __init__(self, head_ob):
        dg = bpy.context.evaluated_depsgraph_get()
        self.ob = MH.skull_proxy(head_ob)
        self.bvh = C.bvh(self.ob)
        self.real = C.bvh(head_ob)

    def free(self):
        me = self.ob.data
        bpy.data.objects.remove(self.ob)
        bpy.data.meshes.remove(me)

    def surf(self, d):
        d = d.normalized()
        hit = self.bvh.ray_cast(SKULL_C, d, 0.5)
        return hit[0] if hit[0] is not None else SKULL_C + d * 0.09

    def clear(self, obj, min_clear):
        """Push vertices of obj out to at least min_clear from the real head."""
        moved = 0
        for v in obj.data.vertices:
            loc, nrm, idx, dist = self.real.find_nearest(v.co)
            if loc is None:
                continue
            out = (v.co - loc).dot(nrm) >= 0
            if out and dist >= min_clear:
                continue
            d = (v.co - SKULL_C).normalized()
            for _ in range(60):
                v.co += d * 0.0005
                loc, nrm, idx, dist = self.real.find_nearest(v.co)
                if (v.co - loc).dot(nrm) >= 0 and dist >= min_clear:
                    break
            moved += 1
        return moved


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


def shell(skull, name, boundary, offset_fn, n_alpha=48, n_rings=12, tuck=True, mat='Hair', rect=(0, 0, 1, 1),
          tpow=0.85):
    """Grid shell: columns over alpha (seam duplicated at the back), rings from crown to
    boundary(alpha). offset_fn(t, alpha) = clearance above the skull for ring parameter t."""
    cols = []
    for j in range(n_alpha + 1):
        al = -math.pi + 2 * math.pi * j / n_alpha
        th_max = _theta_at(skull, al, boundary(al))
        col = []
        for i in range(1, n_rings + 1):
            t = i / n_rings
            th = th_max * (t ** tpow)
            d = _dir(th, al)
            col.append(skull.surf(d) + d * offset_fn(t, al))
        if tuck:
            d = _dir(th_max * 1.012, al)
            col.append(skull.surf(d) + d * 0.0006)
        cols.append(col)
    nr = len(cols[0])
    top = SKULL_C + Vector((0, 0, 1)) * ((skull.surf(Vector((0, 0, 1))) - SKULL_C).length + offset_fn(0.0, 0.0))
    verts = [top]
    for col in cols:
        verts.extend(col)
    faces = []
    for j in range(n_alpha):
        jn = j + 1
        faces.append((0, 1 + jn * nr, 1 + j * nr))
        for i in range(nr - 1):
            a = 1 + j * nr + i
            b = 1 + jn * nr + i
            faces.append((a, b, b + 1, a + 1))
    ob = C.new_mesh_obj(name, verts, faces, mat)
    # weld the duplicated seam column geometrically (keep separate verts for UVs)
    for i in range(nr):
        ob.data.vertices[1 + n_alpha * nr + i].co = ob.data.vertices[1 + i].co
    C.recalc_normals(ob)
    me = ob.data
    out = sum((p.normal.dot(p.center - SKULL_C) for p in me.polygons))
    if out < 0:
        me.flip_normals()
    uv = TX.ensure_uv(ob)
    x0, y0, x1, y1 = rect
    for poly in me.polygons:
        cj = None
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            if vi != 0:
                j, i = divmod(vi - 1, nr)
                cj = j if cj is None else min(cj, j)
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            if vi == 0:
                u, v = (cj + 0.5) / n_alpha, 0.0
            else:
                j, i = divmod(vi - 1, nr)
                u, v = j / n_alpha, (i + 1) / nr
            uv.data[li].uv = (x0 + (x1 - x0) * u, y1 - (y1 - y0) * v)
    C.shade_smooth(ob)
    ob['shell'] = (n_alpha, nr)
    return ob


# ---------------------------------------------------------------- hair
#                 deg  z above skull centre (m)
# measured on the head: ear z 1.636..1.695 at azimuth ~80..110 deg (z_rel -0.076..-0.017)
HAIRLINE_SHORT = [(0, 0.054), (18, 0.053), (32, 0.047), (44, 0.038), (54, 0.027), (62, 0.016), (68, 0.002),
                  (72, -0.020), (76, -0.038), (79, -0.044), (81, -0.026), (84, -0.010), (90, -0.006),
                  (104, -0.006), (112, -0.012), (120, -0.024), (130, -0.040), (145, -0.055), (160, -0.064),
                  (180, -0.068)]
HAIRLINE_LONG = [(0, 0.054), (18, 0.053), (32, 0.047), (44, 0.039), (54, 0.028), (62, 0.017), (68, 0.004),
                 (72, -0.018), (76, -0.036), (79, -0.042), (81, -0.024), (84, -0.009), (90, -0.005),
                 (104, -0.005), (112, -0.012), (120, -0.026), (130, -0.044), (145, -0.060), (160, -0.070),
                 (180, -0.076)]


def _hair_offset(top, side):
    def f(t, al):
        fr = max(0.0, math.cos(al))                  # front
        T = side + (top - side) * (1.0 - min(1.0, t / 0.75)) ** 0.8
        T += 0.0015 * fr * math.exp(-((t - 0.25) / 0.2) ** 2)    # a little lift at the front
        strand = 0.0004 * math.sin(al * 26.0 + t * 5.0)
        if t > 0.66:
            k = (1.0 - t) / 0.34
            return 0.0007 + (T - 0.0007) * k * k * (3 - 2 * k) + strand * 0.3 * k
        return T + strand
    return f


def hair_cards(shell_ob, min_deg=52.0, length=(0.007, 0.013), seed=1):
    """Short alpha-masked hair cards along the hairline of a shell (sides, sideburns, nape):
    two staggered rows per column, roots tucked under the shell edge, hanging along the hair
    flow and slightly outward so the edge reads as hair instead of a painted line."""
    import random
    rnd = random.Random(seed)
    na, nr = shell_ob['shell']
    me = shell_ob.data
    co = [v.co.copy() for v in me.vertices]

    def col(j, i):
        return co[1 + (j % na) * nr + i]
    verts, faces, uvs = [], [], []
    r = UV['Hair']['cards']
    for j in range(na):
        al = -180.0 + 360.0 * j / na
        if abs(al) < min_deg:
            continue
        pb, pa = col(j, nr - 2), col(j, nr - 4)
        down = (pb - pa).normalized()
        out = (pb - SKULL_C).normalized()
        tang = (col(j + 1, nr - 2) - col(j - 1, nr - 2))
        w = tang.length * 0.75
        tang.normalize()
        for row in range(2):
            f = 0.5 * row
            root = pb.lerp(col(j + 1, nr - 2), f) - down * (0.0045 + 0.002 * row) + out * (0.0010 + 0.0004 * row)
            d = (down * 0.93 + out * 0.20).normalized()
            L = rnd.uniform(*length) * (0.8 if row else 1.0)
            k = len(verts)
            verts += [root - tang * w, root + tang * w, root + tang * w * 0.8 + d * L, root - tang * w * 0.8 + d * L]
            faces.append((k, k + 1, k + 2, k + 3))
            u0 = rnd.uniform(0.0, 0.88)
            uvs += [(u0, r[3]), (u0 + 0.1, r[3]), (u0 + 0.1, r[1]), (u0, r[1])]
    ob = C.new_mesh_obj('HairCards', verts, faces, 'Hair')
    uv = TX.ensure_uv(ob)
    for poly in ob.data.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[ob.data.loops[li].vertex_index]
    C.shade_smooth(ob)
    TX.set_part(ob, PART['hair_card'])
    return ob


def layer_shell(skull, name, boundary, offset_fn, n_alpha, n_rings, t0, t1, rect, tpow=0.85):
    """Partial outer hair layer between ring parameters t0..t1 (no crown pole, no tuck): an
    alpha-masked clump layer that breaks up the shell's silhouette and adds volume."""
    cols = []
    for j in range(n_alpha + 1):
        al = -math.pi + 2 * math.pi * j / n_alpha
        th_max = _theta_at(skull, al, boundary(al))
        col = []
        for i in range(n_rings):
            t = t0 + (t1 - t0) * i / (n_rings - 1)
            d = _dir(th_max * t ** tpow, al)
            col.append(skull.surf(d) + d * offset_fn(t, al))
        cols.append(col)
    verts = [p for col in cols for p in col]
    faces = [(j * n_rings + i, (j + 1) * n_rings + i, (j + 1) * n_rings + i + 1, j * n_rings + i + 1)
             for j in range(n_alpha) for i in range(n_rings - 1)]
    ob = C.new_mesh_obj(name, verts, faces, 'Hair')
    for i in range(n_rings):
        ob.data.vertices[n_alpha * n_rings + i].co = ob.data.vertices[i].co
    C.recalc_normals(ob)
    me = ob.data
    if sum(p.normal.dot(p.center - SKULL_C) for p in me.polygons) < 0:
        me.flip_normals()
    uv = TX.ensure_uv(ob)
    x0, y0, x1, y1 = rect
    for poly in me.polygons:
        for li in poly.loop_indices:
            j, i = divmod(me.loops[li].vertex_index, n_rings)
            uv.data[li].uv = (x0 + (x1 - x0) * j / n_alpha, y1 - (y1 - y0) * i / (n_rings - 1))
    C.shade_smooth(ob)
    return ob


def build_hair_short(skull):
    ob = shell(skull, 'Hair_Short', lambda a: _interp_periodic(HAIRLINE_SHORT, a), _hair_offset(0.0086, 0.0050),
               n_alpha=64, n_rings=14, rect=UV['Hair']['short'])
    skull.clear(ob, 0.0012)
    TX.set_part(ob, PART['hair_short'])
    cards = hair_cards(ob, min_deg=96.0, length=(0.005, 0.009), seed=1)
    base = _hair_offset(0.0086, 0.0050)

    def layer_off(t, al):
        # 1.3 mm over the shell under the cap line, a little fuller on the sides and back
        z_band = 1.0 if t > 0.55 else 0.0
        return base(t, al) + 0.0013 + 0.0012 * z_band * min(1.0, abs(math.degrees(al)) / 90.0)
    layer = layer_shell(skull, 'HairLayer', lambda a: _interp_periodic(HAIRLINE_SHORT, a), layer_off,
                        n_alpha=48, n_rings=8, t0=0.12, t1=0.86, rect=UV['Hair']['layer'])
    TX.set_part(layer, PART['hair_layer'])
    meta = ob['shell']
    ob = C.join([ob, cards, layer], 'Hair_Short')
    ob['shell'] = meta
    return ob


def build_hair_long(skull):
    hair = shell(skull, 'Hair_Long', lambda a: _interp_periodic(HAIRLINE_LONG, a), _hair_offset(0.0086, 0.0075),
                 n_alpha=56, n_rings=12, rect=UV['Hair']['long'])
    skull.clear(hair, 0.0012)
    TX.set_part(hair, PART['hair_long'])
    cards = hair_cards(hair, min_deg=96.0, length=(0.005, 0.009), seed=2)
    hair = C.join([hair, cards], 'Hair_Long')
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
                      * r * (1.0 + 0.08 * math.sin(3 * 2 * math.pi * k / sides)) for k in range(sides + 1)])
    verts = [p for ring in rings for p in ring]
    m = sides + 1
    faces = [(k * m + i, k * m + i + 1, (k + 1) * m + i + 1, (k + 1) * m + i) for k in range(len(rings) - 1)
             for i in range(sides)]
    tail = C.new_mesh_obj('Ponytail', verts, faces, 'Hair')
    C.recalc_normals(tail)
    me = tail.data
    cen = sum(path, Vector()) / len(path)
    if sum(p.normal.dot(p.center - cen) for p in me.polygons) < 0:
        me.flip_normals()
    uv = TX.ensure_uv(tail)
    r = UV['Hair']['tail']
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            k, i = divmod(vi, m)
            uv.data[li].uv = (r[0] + (r[2] - r[0]) * i / sides, r[3] - (r[3] - r[1]) * k / (len(rings) - 1))
    C.shade_smooth(tail)
    TX.set_part(tail, PART['ponytail'])
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
    TX.ensure_uv(tie)
    TX.set_part(tie, PART['hair_tie'])
    return C.join([hair, tail, tie], 'Hair_Long')


# ---------------------------------------------------------------- hats
CAP_LINE = [(0, 0.032), (30, 0.029), (55, 0.020), (75, 0.010), (90, 0.007), (110, 0.005), (135, -0.004),
            (160, -0.010), (180, -0.012)]
VISOR_TOP = [(0, 0.066), (30, 0.062), (60, 0.048), (90, 0.034), (140, 0.020), (180, 0.016)]
BUCKET_LINE = [(0, 0.034), (30, 0.030), (60, 0.017), (90, 0.006), (140, -0.004), (180, -0.008)]
CAP_SEAMS = [0.0, 60.0, 120.0, 180.0, -60.0, -120.0]


def _bill(skull, name, line, clearance, reach=0.074, half_angle=68, tilt=12, curve=0.018, rect=(0, 0, 1, 1),
          thick=0.0034):
    """Pre-curved cap bill attached along the front of the hat line (rounded edge)."""
    nu, nv = 21, 7
    top, bot = [], []
    for i in range(nu):
        al = math.radians(-half_angle + 2 * half_angle * i / (nu - 1))
        z_rel = _interp_periodic(line, al)
        th = _theta_at(skull, al, z_rel)
        d = _dir(th, al)
        base = skull.surf(d) + d * (clearance + 0.0005)
        out = Vector((math.sin(al), -math.cos(al), 0.0))
        across = abs(math.degrees(al)) / half_angle
        length = reach * math.sqrt(max(0.0, 1.0 - across ** 2.4)) + 0.004
        rowt, rowb = [], []
        xb = base.x - SKULL_C.x
        for k in range(nv):
            v = k / (nv - 1)
            p = base + out * (length * v)
            # pre-curved bill: a section of a cylinder along the forward axis (radius 1 / (2 curve))
            xl = p.x - SKULL_C.x
            drop = math.tan(math.radians(tilt)) * length * v + curve * (xl * xl - xb * xb) * 2.0
            p = p - Vector((0, 0, drop))
            tk = thick * (1.0 - 0.25 * v)
            rowt.append(p + Vector((0, 0, tk * 0.5)))
            rowb.append(p - Vector((0, 0, tk * 0.5)))
        top.append(rowt)
        bot.append(rowb)
    verts, faces, uvs = [], [], []
    idx = {}
    x0, y0, x1, y1 = rect
    xm = (x0 + x1) * 0.5
    for s, grid in enumerate((top, bot)):
        for i in range(nu):
            for k in range(nv):
                idx[(s, i, k)] = len(verts)
                verts.append(grid[i][k])
                # top surface in the left half, underside in the right half of the rect
                xa, xb = (x0, xm) if s == 0 else (xm, x1)
                uvs.append((xa + (xb - xa) * i / (nu - 1), y0 + (y1 - y0) * k / (nv - 1)))
    for s in (0, 1):
        for i in range(nu - 1):
            for k in range(nv - 1):
                f = (idx[(s, i, k)], idx[(s, i + 1, k)], idx[(s, i + 1, k + 1)], idx[(s, i, k + 1)])
                faces.append(f if s == 1 else f[::-1])
    edge = [(0, k) for k in range(0, nv)] + [(i, nv - 1) for i in range(1, nu)] + [(nu - 1, k) for k in range(nv - 2, -1, -1)]
    n_surf = len(faces)
    for a, b in zip(edge[:-1], edge[1:]):
        faces.append((idx[(0, a[0], a[1])], idx[(0, b[0], b[1])], idx[(1, b[0], b[1])], idx[(1, a[0], a[1])]))
    ob = C.new_mesh_obj(name, verts, faces, 'Hat')
    C.recalc_normals(ob)
    uv = TX.ensure_uv(ob)
    ne = len(edge) - 1
    top_v = {idx[(0, a[0], a[1])] for a in edge}
    pos = {}
    for j, a in enumerate(edge):
        pos.setdefault(idx[(0, a[0], a[1])], j)
        pos.setdefault(idx[(1, a[0], a[1])], j)
    for poly in ob.data.polygons:
        if poly.index >= n_surf:
            # rim: its own thin strip just above the bill rectangle (keeps texel density sane)
            js = [pos[vi] for vi in poly.vertices]
            lo = min(js)
            for li in poly.loop_indices:
                vi = ob.data.loops[li].vertex_index
                j = pos[vi]
                if max(js) - lo > 1:          # the closing face wraps from the last to the first
                    j = j if j > lo + 1 else ne + 0
                uv.data[li].uv = (x0 + (x1 - x0) * j / ne, y1 + (0.006 if vi in top_v else 0.001))
            continue
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[ob.data.loops[li].vertex_index]
    return ob


def _cap_offset(t, al):
    """Structured crown: extra height over the front panels, snug at the band."""
    fr = max(0.0, math.cos(al)) ** 1.5
    lift = 0.0045 * fr * math.sin(math.pi * min(1.0, t / 0.85)) ** 1.2 + 0.0025 * (1 - t) ** 2
    seam = 0.0
    a = math.degrees(al)
    for sdeg in CAP_SEAMS:
        dd = abs((a - sdeg + 180) % 360 - 180)
        seam = max(seam, math.exp(-(dd / 2.2) ** 2))
    return 0.0108 + lift - 0.0008 * seam * min(1.0, t * 6)


def build_cap(skull):
    crown = shell(skull, 'Hat_Cap', lambda a: _interp_periodic(CAP_LINE, a), _cap_offset, n_alpha=60, n_rings=12,
                  tuck=True, mat='Hat', rect=UV['Hat']['cap'], tpow=0.9)
    TX.set_part(crown, PART['cap'])
    bill = _bill(skull, 'CapBill', CAP_LINE, 0.0108, reach=0.068, half_angle=56, tilt=7, curve=2.8,
                 rect=UV['Hat']['cap_bill'])
    C.shade_smooth(bill)
    TX.set_part(bill, PART['cap_bill'])
    top = SKULL_C.z + (skull.surf(Vector((0, 0, 1))) - SKULL_C).length + _cap_offset(0.0, 0.0)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=0.0062,
                                         location=(SKULL_C.x, SKULL_C.y, top + 0.0005))
    btn = bpy.context.active_object
    btn.name = 'CapButton'
    btn.scale = (1.0, 1.0, 0.45)
    bpy.ops.object.transform_apply(location=True, scale=True)
    C.assign_all(btn, 'Hat')
    C.shade_smooth(btn)
    TX.ensure_uv(btn)
    TX.transform_uv(btn, [p.index for p in btn.data.polygons], lambda u, v: (0.97 + 0.02 * u, 0.33 + 0.02 * v))
    TX.set_part(btn, PART['cap_button'])
    cap = C.join([crown, bill, btn], 'Hat_Cap')
    skull.clear(cap, 0.0085)
    return cap


def build_visor(skull):
    n = 48
    rings = []
    for z_off, clr in ((0.0, 0.0148), (1.0, 0.0148), (1.0, 0.0122), (0.0, 0.0122)):
        ring = []
        for j in range(n + 1):
            al = -math.pi + 2 * math.pi * j / n
            lo = _interp_periodic(CAP_LINE, al)
            hi = _interp_periodic(VISOR_TOP, al)
            if abs(al) > math.radians(120):        # thin strap at the back
                hi = lo + (hi - lo) * 0.45
            z = lo + (hi - lo) * z_off
            th = _theta_at(skull, al, z)
            d = _dir(th, al)
            ring.append(skull.surf(d) + d * clr)
        rings.append(ring)
    rings.append(rings[0])
    m = n + 1
    verts = [p for ring in rings for p in ring]
    faces = [(k * m + i, k * m + i + 1, (k + 1) * m + i + 1, (k + 1) * m + i) for k in range(len(rings) - 1)
             for i in range(n)]
    band = C.new_mesh_obj('VisorBand', verts, faces, 'Hat')
    for i in range(m):                                   # weld the seam row geometrically
        band.data.vertices[4 * m + i].co = band.data.vertices[i].co
    C.recalc_normals(band)
    uv = TX.ensure_uv(band)
    r = UV['Hat']['visor_band']
    for poly in band.data.polygons:
        for li in poly.loop_indices:
            vi = band.data.loops[li].vertex_index
            k, i = divmod(vi, m)
            uv.data[li].uv = (r[0] + (r[2] - r[0]) * i / n, r[1] + (r[3] - r[1]) * k / 4)
    C.shade_smooth(band)
    TX.set_part(band, PART['visor_band'])
    bill = _bill(skull, 'VisorBill', CAP_LINE, 0.0148, reach=0.066, half_angle=60, tilt=8, curve=2.4,
                 rect=UV['Hat']['visor_bill'])
    C.shade_smooth(bill)
    TX.set_part(bill, PART['visor_bill'])
    visor = C.join([band, bill], 'Hat_Visor')
    skull.clear(visor, 0.009)
    return visor


def build_bucket(skull):
    def off(t, al):
        return 0.0170 + 0.010 * (1 - t) ** 1.5
    crown = shell(skull, 'Hat_Bucket', lambda a: _interp_periodic(BUCKET_LINE, a), off, n_alpha=44, n_rings=9,
                  tuck=False, mat='Hat', rect=UV['Hat']['bucket'])
    zs = [v.co.z for v in crown.data.vertices]
    z_top, z_low = max(zs), min(zs)
    z_mid = z_low + (z_top - z_low) * 0.45
    for v in crown.data.vertices:
        w = min(1.0, max(0.0, (v.co.z - z_mid) / (z_top - z_mid)))
        w = w * w * (3 - 2 * w)
        rel = v.co - SKULL_C
        v.co.z = v.co.z + (z_top - v.co.z) * 0.55 * w - 0.008 * w
        v.co.x = SKULL_C.x + rel.x * (1.0 + 0.10 * w)
        v.co.y = SKULL_C.y + rel.y * (1.0 + 0.10 * w)
    TX.set_part(crown, PART['bucket'])
    n = 44
    inner, mid, outer, outer_b, inner_b = [], [], [], [], []
    for j in range(n + 1):
        al = -math.pi + 2 * math.pi * j / n
        z_rel = _interp_periodic(BUCKET_LINE, al)
        th = _theta_at(skull, al, z_rel)
        d = _dir(th, al)
        p = skull.surf(d) + d * 0.0175
        out = Vector((math.sin(al), -math.cos(al), 0.0))
        inner.append(p)
        mid.append(p + out * 0.030 - Vector((0, 0, 0.010)))
        outer.append(p + out * 0.058 - Vector((0, 0, 0.026)))
        outer_b.append(p + out * 0.058 - Vector((0, 0, 0.030)))
        inner_b.append(p - Vector((0, 0, 0.004)))
    rings = [inner, mid, outer, outer_b, [m_ - Vector((0, 0, 0.004)) for m_ in mid], inner_b, inner]
    m = n + 1
    verts = [p for ring in rings for p in ring]
    faces = [(k * m + i, k * m + i + 1, (k + 1) * m + i + 1, (k + 1) * m + i) for k in range(len(rings) - 1)
             for i in range(n)]
    brim = C.new_mesh_obj('BucketBrim', verts, faces, 'Hat')
    C.recalc_normals(brim)
    uv = TX.ensure_uv(brim)
    r = UV['Hat']['bucket_brim']
    for poly in brim.data.polygons:
        for li in poly.loop_indices:
            vi = brim.data.loops[li].vertex_index
            k, i = divmod(vi, m)
            uv.data[li].uv = (r[0] + (r[2] - r[0]) * k / 6, r[1] + (r[3] - r[1]) * i / n)
    C.shade_smooth(brim)
    TX.set_part(brim, PART['bucket_brim'])
    bucket = C.join([crown, brim], 'Hat_Bucket')
    skull.clear(bucket, 0.012)
    return bucket


# ---------------------------------------------------------------- sunglasses
def build_sunglasses(head_obj):
    bvh = C.bvh(head_obj)
    eyes = MH.eye_spheres()
    parts = []
    lens_w, lens_h = 0.056, 0.037
    ecL, er = eyes['L']
    lens_y = ecL.y - er - 0.0125
    for side in ('L', 'R'):
        ec, _ = eyes[side]
        s = 1.0 if ec.x > 0 else -1.0
        centre = Vector((ec.x + 0.004 * s, lens_y, ec.z - 0.002))
        nu, nv = 11, 6
        grid = []
        for i in range(nu):
            u = -1 + 2 * i / (nu - 1)
            row = []
            for k in range(nv):
                v = -1 + 2 * k / (nv - 1)
                x = u * lens_w * 0.5
                z = v * lens_h * 0.5 * (1.0 - 0.18 * max(0.0, -v) * abs(u) - 0.10 * u * u * (1 if v > 0 else 0.4))
                wrap = 0.014 * (max(0.0, u * s)) ** 2 + 0.003 * u * u
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
        top_edge = [grid[i][nv - 1] + Vector((0, -0.0008, 0.0012)) for i in range(nu)]
        rim = []
        for p in top_edge:
            rim.append([p + Vector((0, 0, 0.0028)), p + Vector((0, -0.0025, 0.0)), p + Vector((0, 0, -0.0022)),
                        p + Vector((0, 0.0025, 0.0))])
        rim_ob = C.loft('Rim', rim, closed_start=True, closed_end=True, mat='Frame')
        C.recalc_normals(rim_ob)
        parts.append(rim_ob)
        outer = grid[nu - 1 if s > 0 else 0][nv - 1]
        pts = [outer]
        for yy in (0.02, 0.05, 0.08, 0.100, 0.112):
            z = outer.z - 0.003 - 0.016 * max(0.0, (yy - 0.07) / 0.04)
            o = Vector((0.0, outer.y + yy, z))
            hit = bvh.ray_cast(Vector((s * 0.2, o.y, o.z)), Vector((-s, 0, 0)), 0.3)
            x = (hit[0].x + 0.0035 * s) if hit[0] is not None else outer.x
            x = s * max(abs(x), abs(outer.x) * 0.98)
            pts.append(Vector((x, outer.y + yy, z)))
        arm = []
        for p in pts:
            arm.append([p + Vector((0, 0, 0.0028)), p + Vector((0.0012 * s, 0, 0)), p + Vector((0, 0, -0.0028)),
                        p + Vector((-0.0012 * s, 0, 0))])
        arm_ob = C.loft('Temple', arm, closed_start=True, closed_end=True, mat='Frame')
        C.recalc_normals(arm_ob)
        parts.append(arm_ob)
    by = lens_y
    bridge = [[Vector((x, by - 0.001, ecL.z + 0.005 + dz)) + o for o in
               (Vector((0, 0, 0.002)), Vector((0, -0.002, 0)), Vector((0, 0, -0.002)), Vector((0, 0.002, 0)))]
              for x, dz in ((-0.013, -0.001), (0.0, 0.002), (0.013, -0.001))]
    br = C.loft('Bridge', bridge, closed_start=True, closed_end=True, mat='Frame')
    C.recalc_normals(br)
    parts.append(br)
    for p in parts:
        TX.ensure_uv(p)
    g = C.join(parts, 'Sunglasses')
    return g


def clearance(inner, outer):
    """Smallest radial gap (from the skull centre) between inner's vertices and outer's surface;
    negative = the inner shell pokes through."""
    bvh = C.bvh(outer)
    worst = None
    for v in inner.data.vertices:
        d = v.co - SKULL_C
        hit = bvh.ray_cast(SKULL_C, d.normalized(), 0.5)
        if hit[0] is None:
            continue
        gap = (hit[0] - SKULL_C).length - d.length
        if gap < 0.03:                 # only where the hat actually covers the hair
            worst = gap if worst is None else min(worst, gap)
    return worst


def build_accessories(head_obj):
    skull = Skull(head_obj)
    objs = [build_hair_short(skull), build_hair_long(skull), build_cap(skull), build_visor(skull),
            build_bucket(skull), build_sunglasses(head_obj)]
    skull.free()
    by = {o.name: o for o in objs}
    for hair in ('Hair_Short', 'Hair_Long'):
        for hat in ('Hat_Cap', 'Hat_Visor', 'Hat_Bucket'):
            g = clearance(by[hair], by[hat])
            print('  clearance %-10s under %-10s %s' % (hair, hat, 'n/a' if g is None else '%.4f m' % g))
    return objs
