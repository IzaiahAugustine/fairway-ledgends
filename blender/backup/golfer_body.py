"""Golfer body: torso/limbs, head, hands, shoes and clothing details.

Organic parts are sculpted as metaball unions, re-meshed with voxel remesh
and QuadriFlow so the result is a smooth all-quad surface.
Connection map (rest pose, metres, Blender Z-up):
  torso neck stub (top z 1.53)   <-> head neck (bottom z 1.44)   overlap 0.09, hidden by collar
  forearm end (wrist)            <-> hand wrist capsule          overlap 0.02
  pant leg end (z 0.06)          <-> shoe upper (top z ~0.11)    overlap 0.05, inside shoe
  shoe upper bottom (z 0.022)    <-> sole top (z 0.024)          overlap 0.002
  belt inner surface             <-> waist surface               offset +0.004 (conformed by raycast)
  collar inner surface           <-> neck stub surface           offset +0.003
  sleeve hem inner surface       <-> upper arm surface           offset +0.004..0.012
"""
import math
import bpy
import bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

import golfer_common as C
from golfer_skeleton import JOINTS as J, hand_frame, grip_frame, GRIP_RADIUS


def _n(v):
    v = Vector(v)
    v.normalize()
    return v


def _ortho(axis):
    a = _n(axis)
    ref = Vector((0, 0, 1)) if abs(a.z) < 0.9 else Vector((1, 0, 0))
    u = _n(ref.cross(a))
    w = a.cross(u)
    return u, w


# ------------------------------------------------------------------ torso
def build_torso():
    m = C.Meta('TorsoMB', resolution=0.007)
    st = 3.0
    m.ellipsoid((0, 0.014, 0.940), (0.150, 0.102, 0.100), stiff=st)        # pelvis
    for s in (1, -1):
        m.ellipsoid((0.062 * s, 0.060, 0.905), (0.072, 0.064, 0.085), stiff=st)  # glutes
    m.ellipsoid((0, 0.004, 1.065), (0.146, 0.100, 0.125), stiff=st)        # waist
    m.ellipsoid((0, 0.016, 1.272), (0.163, 0.110, 0.172), stiff=st)        # ribcage
    for s in (1, -1):
        m.ellipsoid((0.064 * s, -0.058, 1.338), (0.078, 0.034, 0.050), stiff=st)  # pecs
        m.ellipsoid((0.080 * s, 0.072, 1.330), (0.076, 0.040, 0.090), stiff=st)   # lats/blades
    m.capsule((-0.145, 0.020, 1.418), (0.145, 0.020, 1.418), 0.060, stiff=st)  # shoulder girdle
    for s in (1, -1):
        m.capsule((0.0, 0.034, 1.488), (0.150 * s, 0.028, 1.448), 0.042, stiff=st)  # trapezius
    m.capsule((0, 0.024, 1.420), (0, 0.022, 1.490), 0.050, stiff=st)     # neck stub (hidden by head neck)
    for side, s in (('L', 1), ('R', -1)):
        sh, el, wr = J['shoulder_' + side], J['elbow_' + side], J['wrist_' + side]
        du = _n(el - sh)
        df = _n(wr - el)
        m.ellipsoid(sh + du * 0.025 + Vector((0, 0, 0.006)), (0.076, 0.063, 0.062), stiff=st, xdir=du)  # deltoid
        m.capsule(sh + du * 0.02, el, 0.041, stiff=st)
        m.ellipsoid(sh + du * 0.15, (0.105, 0.050, 0.048), stiff=st, xdir=du)    # biceps/triceps
        m.ball(el, 0.033, stiff=st)
        m.capsule(el, wr - df * 0.004, 0.026, stiff=st)
        m.ellipsoid(el + df * 0.075, (0.090, 0.039, 0.033), stiff=st, xdir=df,
                    ydir=Vector((s, 0, 0)))                                     # forearm mass
        hip, kn, an = J['hip_' + side], J['knee_' + side], J['ankle_' + side]
        dt = _n(kn - hip)
        ds = _n(an - kn)
        m.capsule(hip + Vector((0.006 * s, 0, 0)), kn, 0.066, stiff=st)
        m.ellipsoid(hip + dt * 0.13 + Vector((0.004 * s, 0.004, 0)), (0.165, 0.084, 0.084), stiff=st, xdir=dt)
        m.ball(kn, 0.056, stiff=st)
        m.capsule(kn, an - ds * 0.035, 0.050, stiff=st)
        m.ellipsoid(kn + ds * 0.15 + Vector((0, 0.010, 0)), (0.120, 0.054, 0.058), stiff=st, xdir=ds)
    ob = m.to_mesh('Torso')
    C.voxel_remesh(ob, 0.006)
    C.quadriflow(ob, 5200, symmetry=True)
    C.smooth_mesh(ob, 0.4, 1)
    return ob


# ------------------------------------------------------------------ head
def build_head():
    m = C.Meta('HeadMB', resolution=0.0042)
    st = 3.0
    m.ellipsoid((0, 0.016, 1.703), (0.0790, 0.098, 0.089), stiff=st)       # cranium
    m.ellipsoid((0, -0.026, 1.636), (0.062, 0.064, 0.064), stiff=st)      # face / jaw mass
    for s in (1, -1):
        m.ball((0.047 * s, 0.000, 1.618), 0.024, stiff=st)                # jaw angle
        m.ellipsoid((0.048 * s, -0.050, 1.664), (0.028, 0.013, 0.016), stiff=2.2)  # cheekbone
        m.ellipsoid((0.0765 * s, 0.010, 1.668), (0.0095, 0.020, 0.030), stiff=6.0)  # ear
        m.capsule((0.022 * s, -0.0858, 1.6930), (0.0460 * s, -0.0800, 1.6925), 0.0060, stiff=4.0)  # upper lid
        m.capsule((0.023 * s, -0.0852, 1.6738), (0.0450 * s, -0.0798, 1.6742), 0.0045, stiff=4.0)  # lower lid
    m.ellipsoid((0, -0.068, 1.581), (0.024, 0.019, 0.018), stiff=st)      # chin
    m.capsule((-0.042, -0.078, 1.702), (0.042, -0.078, 1.702), 0.0120, stiff=st)  # brow ridge
    m.capsule((0, -0.088, 1.690), (0, -0.106, 1.650), 0.0082, stiff=st)   # nose bridge
    m.ball((0, -0.1085, 1.6455), 0.0118, stiff=st)                        # nose tip
    for s in (1, -1):
        m.ball((0.0118 * s, -0.0995, 1.6400), 0.0088, stiff=st)           # alae
        m.ball((0.0335 * s, -0.0885, 1.6830), 0.0095, stiff=4.0, neg=True)  # eye socket
        m.ball((0.0800 * s, 0.006, 1.668), 0.0070, stiff=6.0, neg=True)    # concha
    m.capsule((-0.018, -0.0880, 1.6140), (0.018, -0.0880, 1.6140), 0.0052, stiff=st)  # upper lip
    m.capsule((-0.015, -0.0868, 1.6015), (0.015, -0.0868, 1.6015), 0.0056, stiff=st)  # lower lip
    m.capsule((0, 0.024, 1.440), (0, 0.008, 1.625), 0.0605, stiff=st)      # neck
    m.ellipsoid((0, 0.040, 1.640), (0.056, 0.046, 0.050), stiff=st)        # occiput/nape blend
    ob = m.to_mesh('Head')
    C.voxel_remesh(ob, 0.0035)
    C.quadriflow(ob, 2800, symmetry=True)
    C.smooth_mesh(ob, 0.3, 1)
    C.assign_all(ob, 'Skin')
    return ob


def build_eyes():
    objs = []
    for s in (1, -1):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=0.0122,
                                             location=(0.0335 * s, -0.0770, 1.6830))
        eye = bpy.context.active_object
        eye.name = 'Eye_' + ('L' if s > 0 else 'R')
        C.assign_all(eye, 'Eyes')
        ii = C.add_material(eye, 'Iris')
        for p in eye.data.polygons:
            if p.center.y < -0.0104:
                p.material_index = ii
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        objs.append(eye)
    return objs


def build_brows(head):
    """Thin strips conformed to the brow ridge (Hair material)."""
    bvh = BVHTree.FromObject(head, bpy.context.evaluated_depsgraph_get())
    objs = []
    for s in (1, -1):
        rows = []
        for t in [i / 7 for i in range(8)]:
            x = s * (0.016 + 0.036 * t)
            z = 1.6985 + 0.0055 * math.sin(math.pi * min(1.0, t * 1.25)) - 0.004 * t
            col = []
            for dz, w in ((-0.0035 + 0.001 * t, 1.0), (0.0035 - 0.0015 * t, 1.0)):
                o = Vector((x, -0.2, z + dz))
                hit = bvh.ray_cast(o, Vector((0, 1, 0)))
                p = hit[0] if hit[0] is not None else Vector((x, -0.09, z + dz))
                col.append(p + Vector((0, -0.0012, 0)))
            rows.append(col)
        verts = []
        for r in rows:
            verts.extend(r)
        faces = []
        for i in range(len(rows) - 1):
            a, b = i * 2, (i + 1) * 2
            f = (a, b, b + 1, a + 1)
            faces.append(f if s > 0 else f[::-1])
        ob = C.new_mesh_obj('Brow_' + ('L' if s > 0 else 'R'), verts, faces, 'Hair')
        sol = ob.modifiers.new('Sol', 'SOLIDIFY')
        sol.thickness = 0.0018
        sol.offset = 1.0
        C.apply_modifier(ob, sol)
        objs.append(ob)
    return objs


# ------------------------------------------------------------------ hands
def _finger_path(K, S, a, p, r_wrap, length, step=0.012):
    """2D wrap path in plane (a, p) through knuckle K around shaft point S."""
    rel = K - S
    u0, v0 = rel.dot(a), rel.dot(p)
    d = math.hypot(u0, v0)
    r_wrap = min(r_wrap, d * 0.98)
    phiK = math.atan2(v0, u0)
    beta = math.acos(r_wrap / d)
    best = None
    for sgn in (1, -1):
        phT = phiK + sgn * beta
        T = (r_wrap * math.cos(phT), r_wrap * math.sin(phT))
        tang = (-math.sin(phT), math.cos(phT))          # ccw tangent
        if (T[0] - u0) * tang[0] + (T[1] - v0) * tang[1] > 0:
            best = phT
    phT = best
    pts2 = [(u0, v0)]
    Tx, Ty = r_wrap * math.cos(phT), r_wrap * math.sin(phT)
    seg = math.hypot(Tx - u0, Ty - v0)
    remaining = length
    nseg = max(1, int(seg / step))
    for i in range(1, nseg + 1):
        f = i / nseg
        pts2.append((u0 + (Tx - u0) * f, v0 + (Ty - v0) * f))
    remaining -= seg
    ph = phT
    while remaining > 0:
        dph = min(step, remaining) / r_wrap
        ph += dph
        remaining -= dph * r_wrap
        pts2.append((r_wrap * math.cos(ph), r_wrap * math.sin(ph)))
    return [S + a * u + p * v for (u, v) in pts2]


def build_hand(side):
    hf = hand_frame(side)
    W, a, p, t = hf['wrist'], hf['along'], hf['palm'], hf['thumb']
    G = grip_frame(side)
    Cg = G.to_translation()
    g = Vector((G[0][1], G[1][1], G[2][1]))
    m = C.Meta('Hand%sMB' % side, resolution=0.0032)
    st = 3.0
    cuff = 0.0295 if side == 'L' else 0.0255
    m.capsule(W - a * (0.026 if side == 'L' else 0.030), W + a * 0.018, cuff, stiff=st, updir=t)  # wrist / glove cuff
    m.ellipsoid(W + a * 0.050 - p * 0.002, (0.050, 0.041, 0.0155), stiff=st, xdir=a, ydir=t)  # palm
    m.ellipsoid(W + a * 0.030 + t * 0.030 + p * 0.006, (0.030, 0.017, 0.016), stiff=st,
                xdir=_n(a + t * 0.6), ydir=p)                                            # thenar
    m.ellipsoid(W + a * 0.035 - t * 0.030 + p * 0.004, (0.034, 0.014, 0.014), stiff=st, xdir=a)  # hypothenar
    fingers = [(0.029, 0.0094, 0.074), (0.010, 0.0098, 0.082), (-0.009, 0.0093, 0.077), (-0.026, 0.0083, 0.062)]
    for off, fr, flen in fingers:
        K = W + a * (0.094 - 0.012 * abs(off - 0.008) / 0.03) + t * off
        s_par = t.dot(K - Cg) / t.dot(g)
        S = Cg + g * s_par
        pts = _finger_path(K, S, a, p, GRIP_RADIUS + fr * 0.95, flen)
        n = len(pts)
        for i in range(n - 1):
            r = fr * (1.0 - 0.18 * i / max(1, n - 2))
            m.capsule(pts[i], pts[i + 1], r, stiff=st)
    # thumb lies along the shaft toward the clubhead
    R0 = W + a * 0.028 + t * 0.030 + p * 0.010
    s0 = (R0 - Cg).dot(g)
    rv = (R0 - Cg) - g * s0
    rv_n = _n(rv)
    side_dir = _n(rv_n + p * 0.5)
    mid = Cg + g * (s0 + 0.040) + side_dir * (GRIP_RADIUS + 0.011)
    tip = Cg + g * (s0 + 0.068) + side_dir * (GRIP_RADIUS + 0.0085)
    m.capsule(R0, mid, 0.0115, stiff=st)
    m.capsule(mid, tip, 0.0098, stiff=st)
    ob = m.to_mesh('Hand_' + side)
    C.voxel_remesh(ob, 0.0028)
    C.quadriflow(ob, 650)
    C.smooth_mesh(ob, 0.3, 1)
    C.assign_all(ob, 'Glove' if side == 'L' else 'Skin')
    return ob


# ------------------------------------------------------------------ shoes
def foot_frame(side):
    s = 1.0 if side == 'L' else -1.0
    an, toe = J['ankle_' + side], J['toe_' + side]
    fwd = toe - an
    fwd.z = 0
    fwd = _n(fwd)
    right = _n(fwd.cross(Vector((0, 0, 1))))  # points to the foot's outside for L? computed per use
    heel = an - fwd * 0.078
    heel.z = 0.0
    return heel, fwd, right


def build_shoe(side):
    s = 1.0 if side == 'L' else -1.0
    heel, fwd, right = foot_frame(side)
    up = Vector((0, 0, 1))
    across = _n(up.cross(fwd))  # left of the foot direction

    def P(x, y, z):
        return heel + across * x + fwd * y + up * z

    # upper as metaball union
    m = C.Meta('Shoe%sMB' % side, resolution=0.005)
    st = 3.0
    lean = 0.004 * s   # big toe side bulge toward the body midline
    m.ellipsoid(P(-lean, 0.235, 0.040), (0.048, 0.062, 0.030), stiff=st, xdir=across, ydir=fwd)  # toe box
    m.ellipsoid(P(0.0, 0.160, 0.052), (0.053, 0.075, 0.042), stiff=st, xdir=across, ydir=fwd)    # vamp
    m.ellipsoid(P(0.0, 0.060, 0.060), (0.042, 0.062, 0.052), stiff=st, xdir=across, ydir=fwd)    # heel counter
    m.capsule(P(0.0, 0.070, 0.070), P(0.0, 0.085, 0.112), 0.044, stiff=st)                       # ankle collar
    m.ellipsoid(P(0.0, 0.120, 0.075), (0.040, 0.060, 0.040), stiff=st, xdir=across, ydir=fwd)    # instep
    ob = m.to_mesh('Shoe_' + side)
    C.voxel_remesh(ob, 0.004)
    # cut flat at the sole top
    bm = C.bm_from(ob)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, 0.020), plane_no=(0, 0, 1), clear_inner=True)
    C.bm_to(bm, ob)
    C.quadriflow(ob, 520)
    # flatten anything below the sole top
    for v in ob.data.vertices:
        if v.co.z < 0.022:
            v.co.z = 0.022
    C.smooth_mesh(ob, 0.3, 1)
    C.assign_all(ob, 'Shoes')
    # sole: outline traced from the upper by horizontal raycasts
    cf = Conformer(ob)
    centre = P(0.0, 0.150, 0.027)
    rings = ([], [], [])
    radii = []
    n = 32
    for i in range(n):
        th = 2 * math.pi * i / n
        d = across * math.sin(th) + fwd * math.cos(th)
        r = max(cf.radius(centre + Vector((0, 0, dz)), d, 0.05) for dz in (0.006, 0.012, 0.02))
        radii.append(r)
    radii = [(radii[i - 1] + 2 * radii[i] + radii[(i + 1) % n]) / 4 for i in range(n)]
    for i in range(n):
        th = 2 * math.pi * i / n
        d = across * math.sin(th) + fwd * math.cos(th)
        r = radii[i]
        for ring, z, off in zip(rings, (0.0, 0.010, 0.026), (0.0015, 0.004, 0.002)):
            ring.append(Vector((centre.x, centre.y, z)) + d * (r + off))
    sole = C.loft('Sole_' + side, list(rings), closed_start=True, closed_end=True, mat='Sole')
    C.recalc_normals(sole)
    return [ob, sole]


# ------------------------------------------------------------------ clothing overlays
class Conformer:
    def __init__(self, obj):
        self.bvh = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())

    def radius(self, origin, direction, default):
        """Distance from an interior origin to the first surface along direction."""
        o = Vector(origin)
        d = _n(direction)
        hit = self.bvh.ray_cast(o, d, 1.0)
        if hit[0] is None:
            return default
        return (hit[0] - o).dot(d)


def build_belt(torso):
    cf = Conformer(torso)
    n = 48
    ctr = Vector((0, 0.008, 0))
    zs = [0.987, 0.991, 1.023, 1.027]
    offs = [0.0045, 0.0075, 0.0075, 0.0045]
    rings = []
    for z, off in zip(zs, offs):
        ring = []
        for i in range(n):
            th = 2 * math.pi * i / n
            d = Vector((math.cos(th), math.sin(th), 0))
            r = cf.radius(ctr + Vector((0, 0, z)), d, 0.15)
            ring.append(ctr + Vector((0, 0, z)) + d * (r + off))
        rings.append(ring)
    belt = C.loft('Belt', rings, mat='Belt')
    # inner skin closing the band (keeps it watertight-looking from below)
    inner = [[(v - ctr * 0) for v in rings[0]], [(v) for v in rings[-1]]]
    C.recalc_normals(belt)
    # buckle at the front (-Y)
    front_r = cf.radius(ctr + Vector((0, 0, 1.007)), Vector((0, -1, 0)), 0.1)
    by = ctr.y - front_r - 0.010
    bpy.ops.mesh.primitive_cube_add(size=2, location=(0.0, by, 1.007))
    bk = bpy.context.active_object
    bk.name = 'Buckle'
    bk.scale = (0.026, 0.0035, 0.019)
    bpy.ops.object.transform_apply(scale=True, location=True)
    bev = bk.modifiers.new('Bev', 'BEVEL')
    bev.width = 0.003
    bev.segments = 2
    C.apply_modifier(bk, bev)
    C.assign_all(bk, 'Buckle')
    return [belt, bk]


def build_collar(torso):
    cf = Conformer(torso)
    ctr = Vector((0, 0.020, 0))
    segs = 26
    th0, th1 = math.radians(-152), math.radians(152)   # 0 = back (+Y); front opening around +-180
    rings = []
    for i in range(segs + 1):
        th = th0 + (th1 - th0) * i / segs
        d = Vector((math.sin(th), math.cos(th), 0))
        frontness = max(0.0, -math.cos(th))        # 1 at the front
        zb = 1.486 - 0.034 * frontness ** 1.5
        h = 0.032 - 0.010 * frontness
        r0 = cf.radius(ctr + Vector((0, 0, zb + 0.01)), d, 0.06) + 0.0025
        leaf = 0.026 + 0.012 * frontness ** 3
        prof = [
            (0.0, 0.0), (0.0, h), (0.006, h + 0.003), (0.013, h - 0.002),
            (0.020 + 0.006 * frontness, h - leaf), (0.016 + 0.006 * frontness, h - leaf),
            (0.008, h - 0.004), (0.003, 0.0),
        ]
        ring = []
        for (dr, dz) in prof:
            ring.append(ctr + d * (r0 + dr) + Vector((0, 0, zb + dz)))
        rings.append(ring)
    collar = C.loft('Collar', rings, mat='Shirt')
    bm = C.bm_from(collar)
    # cap both ends
    n = len(rings[0])
    vs = bm.verts
    vs.ensure_lookup_table()
    bm.faces.new([vs[j] for j in range(n)][::-1])
    last = len(rings) - 1
    bm.faces.new([vs[last * n + j] for j in range(n)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    C.bm_to(bm, collar)
    return collar


def build_placket(torso):
    cf = Conformer(torso)
    pts = []
    for z in (1.445, 1.415, 1.385, 1.355, 1.325):
        row = []
        for x in (-0.013, 0.013):
            o = Vector((x, 0.0, z))
            r = cf.radius(o, Vector((0, -1, 0)), 0.11)
            row.append(o + Vector((0, -1, 0)) * (r + 0.0012))
        pts.append(row)
    verts = [v for r in pts for v in r]
    faces = [(i * 2 + 1, i * 2, i * 2 + 2, i * 2 + 3) for i in range(len(pts) - 1)]
    pl = C.new_mesh_obj('Placket', verts, faces, 'Shirt')
    sol = pl.modifiers.new('Sol', 'SOLIDIFY')
    sol.thickness = 0.002
    sol.offset = 1.0
    C.apply_modifier(pl, sol)
    buttons = []
    for z in (1.428, 1.385):
        o = Vector((0, 0.0, z))
        r = cf.radius(o, Vector((0, -1, 0)), 0.11)
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.0055, depth=0.003,
                                            location=(0, -(r + 0.0035), z),
                                            rotation=(math.pi / 2, 0, 0))
        b = bpy.context.active_object
        b.name = 'Button'
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        C.assign_all(b, 'Eyes')
        buttons.append(b)
    return [pl] + buttons


SLEEVE_HEM = 0.165   # distance from shoulder joint along the upper arm


def build_sleeves(torso):
    cf = Conformer(torso)
    objs = []
    n = 24
    for side in ('L', 'R'):
        sh, el = J['shoulder_' + side], J['elbow_' + side]
        du = _n(el - sh)
        u, w = _ortho(du)
        rings = []
        spec = [(0.110, 0.0015), (0.140, 0.006), (SLEEVE_HEM, 0.010), (SLEEVE_HEM + 0.002, 0.008),
                (SLEEVE_HEM - 0.010, 0.0035)]
        for dist, off in spec:
            c = sh + du * dist
            ring = []
            for i in range(n):
                th = 2 * math.pi * i / n
                d = u * math.cos(th) + w * math.sin(th)
                r = cf.radius(c, d, 0.045)
                ring.append(c + d * (r + off))
            rings.append(ring)
        sl = C.loft('Sleeve_' + side, rings, mat='Shirt')
        C.recalc_normals(sl)
        objs.append(sl)
    return objs


# ------------------------------------------------------------------ material zones on torso
def zone_torso(torso):
    """Cut clean boundaries and assign Shirt / Skin / Pants."""
    C.assign_all(torso, 'Shirt')
    i_skin = C.add_material(torso, 'Skin')
    i_pants = C.add_material(torso, 'Pants')
    bm = C.bm_from(torso)
    # belt line (torso only)
    faces = [f for f in bm.faces if abs(f.calc_center_median().x) < 0.26]
    edges = list({e for f in faces for e in f.edges})
    verts = list({v for f in faces for v in f.verts})
    bmesh.ops.bisect_plane(bm, geom=verts + edges + faces, plane_co=(0, 0, 1.005), plane_no=(0, 0, 1))
    # sleeve lines
    for side in ('L', 'R'):
        sh, el = J['shoulder_' + side], J['elbow_' + side]
        du = _n(el - sh)
        pc = sh + du * (SLEEVE_HEM - 0.004)
        sel = []
        for f in bm.faces:
            c = f.calc_center_median()
            rel = c - pc
            along = rel.dot(du)
            radial = (rel - du * along).length
            if abs(along) < 0.05 and radial < 0.09:
                sel.append(f)
        edges = list({e for f in sel for e in f.edges})
        verts = list({v for f in sel for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=verts + edges + sel, plane_co=pc, plane_no=du)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for f in bm.faces:
        c = f.calc_center_median()
        idx = 0
        if c.z < 1.005 and abs(c.x) < 0.26:
            idx = i_pants
        if c.z < 0.90:
            idx = i_pants
        for side in ('L', 'R'):
            sh, el = J['shoulder_' + side], J['elbow_' + side]
            du = _n(el - sh)
            if (c - sh).dot(du) > SLEEVE_HEM - 0.004 and (c - sh).length > 0.12 and abs(c.x) > 0.2:
                idx = i_skin
        f.material_index = idx
    C.bm_to(bm, torso)


HEAD_SCALE = 1.06
HEAD_PIVOT = Vector((0.0, 0.010, 1.620))


def scale_about(obj, k, pivot):
    for v in obj.data.vertices:
        v.co = pivot + (v.co - pivot) * k


def build_body(accessory_builder=None, arm_ob=None):
    """Build all body parts, skin them part by part (if an armature is given)
    and join them. Returns (joined body mesh, accessory objects)."""
    import golfer_rig as RIG
    torso = build_torso()
    zone_torso(torso)
    head = build_head()
    eyes = build_eyes()
    brows = build_brows(head)
    for o in [head] + eyes + brows:
        scale_about(o, HEAD_SCALE, HEAD_PIVOT)
    accessories = accessory_builder(head, eyes) if accessory_builder else []
    hands = [build_hand('L'), build_hand('R')]
    shoes = {'L': build_shoe('L'), 'R': build_shoe('R')}
    cloth = build_belt(torso) + [build_collar(torso)] + build_placket(torso) + build_sleeves(torso)
    if arm_ob is not None:
        for o in [torso, head] + hands:
            RIG.auto_weights(arm_ob, o)
        for o in eyes + brows:
            RIG.rigid_weights(o, 'Head')
        for side, objs in shoes.items():
            for o in objs:
                RIG.rigid_weights(o, 'Foot_' + side)
        for o in cloth:
            RIG.transfer_weights(torso, o)
    parts = [torso, head] + eyes + brows + hands + shoes['L'] + shoes['R'] + cloth
    for p in parts:
        C.shade_smooth(p)
    body = C.join(parts, 'Golfer_Body')
    return body, accessories
