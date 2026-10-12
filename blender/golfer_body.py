"""Golfer body: torso with polo shirt and trousers, MakeHuman head (golfer_mh), hands,
golf shoes and clothing details (collar, placket, buttons, sleeves, belt, buckle, loops).

Organic parts are sculpted as metaball unions, re-meshed with voxel remesh and QuadriFlow
so the result is a smooth all-quad surface. Every part gets UVs in its material's atlas
and a 'part' face attribute for the texture generator (golfer_texgen).
Connection map (rest pose, metres, Blender Z-up):
  head neck extension (bottom z 1.36)  <-> torso neck stub (top z 1.53)    inside, hidden by collar;
                                         neck skin, collar and torso near the neck share weights
  forearm end (wrist)                  <-> hand wrist capsule             overlap 0.02
  trouser hem (z 0.05 back .. 0.09 front, open with turned lip)  <-> shoe upper   hem conformed
                                         around the shoe (+3 mm), shoe top closed under the hem
  shoe upper bottom edge (z 0.024)     <-> sole top (z 0.024)             shared outline
  belt inner surface                   <-> waist surface                  offset +0.004 (raycast)
  collar inner surface                 <-> neck surface (head mesh)       offset +0.0025
  sleeve hem inner surface             <-> upper arm surface              offset +0.004..0.013
"""
import math

import bmesh
import bpy
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

import golfer_common as C
import golfer_mh as MH
import golfer_tex as TX
from golfer_skeleton import JOINTS as J, hand_frame, grip_frame, GRIP_RADIUS

PART = C.PART


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


def _smooth01(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ atlas rectangles (u0, v0, u1, v1)
UV = {
    'Skin': {'face': (0.0, 0.0, 0.575, 1.0), 'headmisc': (0.585, 0.70, 1.0, 1.0),
             'arms': (0.585, 0.0, 1.0, 0.69)},
    'Shirt': {'torso': (0.0, 0.0, 1.0, 0.70), 'sleeve': (0.0, 0.715, 0.30, 1.0),
              'collar': (0.31, 0.715, 1.0, 0.925), 'placket': (0.31, 0.935, 1.0, 1.0)},
    'Pants': {'legs': (0.0, 0.0, 1.0, 0.90), 'misc': (0.0, 0.91, 0.62, 1.0), 'loops': (0.64, 0.91, 1.0, 1.0)},
    'Belt': {'band': (0.0, 0.0, 1.0, 0.55), 'misc': (0.0, 0.58, 1.0, 1.0)},
    'Hair': {'brow': (0.0, 0.88, 1.0, 1.0)},
}

# ------------------------------------------------------------------ torso
BELT_Z = (0.987, 1.027)
SHIRT_LINE_Z = 1.005
HEM_Y0, HEM_Z0, HEM_SLOPE = 0.035, 0.072, 0.32       # z_hem(y) = Z0 - SLOPE * (y - Y0)


def hem_z(y):
    return HEM_Z0 - HEM_SLOPE * (y - HEM_Y0)


def leg_foot_end(side):
    s = 1.0 if side == 'L' else -1.0
    an = J['ankle_' + side]
    return Vector((an.x + 0.004 * s, an.y + 0.012, -0.02))


def build_torso():
    """Athletic adult male: deep chest, V-taper lats, heavy traps and deltoids, forearms that
    taper to the wrist. Legs are the trouser surface (loose thigh, straight leg)."""
    m = C.Meta('TorsoMB', resolution=0.007)
    st = 3.0
    m.ellipsoid((0, 0.014, 0.940), (0.152, 0.104, 0.100), stiff=st)        # pelvis
    for s in (1, -1):
        m.ellipsoid((0.062 * s, 0.062, 0.905), (0.076, 0.068, 0.088), stiff=st)  # seat
    m.ellipsoid((0, 0.006, 1.065), (0.150, 0.104, 0.125), stiff=st)        # waist
    m.ellipsoid((0, 0.018, 1.272), (0.172, 0.124, 0.178), stiff=st)        # ribcage
    for s in (1, -1):
        m.ellipsoid((0.068 * s, -0.066, 1.335), (0.086, 0.040, 0.056), stiff=st)  # pecs
        m.ellipsoid((0.100 * s, 0.050, 1.290), (0.070, 0.058, 0.118), stiff=st)   # lats (V-taper)
        m.ellipsoid((0.076 * s, 0.088, 1.345), (0.076, 0.036, 0.082), stiff=st)   # shoulder blades
    m.capsule((-0.150, 0.020, 1.418), (0.150, 0.020, 1.418), 0.064, stiff=st)  # shoulder girdle
    for s in (1, -1):
        m.capsule((0.0, 0.036, 1.488), (0.152 * s, 0.028, 1.450), 0.048, stiff=st)  # trapezius
    m.capsule((0, 0.024, 1.420), (0, 0.022, 1.490), 0.050, stiff=st)     # neck stub (inside the head neck)
    for side, s in (('L', 1), ('R', -1)):
        sh, el, wr = J['shoulder_' + side], J['elbow_' + side], J['wrist_' + side]
        du = _n(el - sh)
        df = _n(wr - el)
        m.ellipsoid(sh + du * 0.028 + Vector((0, 0, 0.006)), (0.082, 0.070, 0.068), stiff=st, xdir=du)  # deltoid
        m.capsule(sh + du * 0.02, el, 0.044, stiff=st)
        m.ellipsoid(sh + du * 0.15, (0.112, 0.056, 0.052), stiff=st, xdir=du)    # biceps/triceps
        m.ball(el, 0.034, stiff=st)
        fm = el + df * 0.14
        m.capsule(el, fm, 0.031, stiff=st)                                     # forearm, thick near the elbow
        m.capsule(fm, wr - df * 0.004, 0.0255, stiff=st)                       # tapering to the wrist
        m.ellipsoid(el + df * 0.078, (0.096, 0.047, 0.039), stiff=st, xdir=df,
                    ydir=Vector((s, 0, 0)))                                     # forearm mass
        # trouser leg: loose thigh, soft knee, straight leg down past the hem line
        hip, kn = J['hip_' + side], J['knee_' + side]
        fe = leg_foot_end(side)
        dt = _n(kn - hip)
        ds = _n(fe - kn)
        m.capsule(hip + Vector((0.006 * s, 0, 0)), kn, 0.074, stiff=st)
        m.ellipsoid(hip + dt * 0.13 + Vector((0.004 * s, 0.004, 0)), (0.170, 0.092, 0.092), stiff=st, xdir=dt)
        m.ball(kn, 0.065, stiff=st)
        m.capsule(kn, fe, 0.0630, stiff=st)
        m.ellipsoid(kn + ds * 0.13 + Vector((0, 0.008, 0)), (0.12, 0.060, 0.064), stiff=st, xdir=ds)  # calf drape
    ob = m.to_mesh('Torso')
    C.voxel_remesh(ob, 0.006)
    C.quadriflow(ob, 6400, symmetry=True)
    C.smooth_mesh(ob, 0.4, 1)
    blouse(ob)
    return ob


def blouse(torso):
    """Shirt bloused over the belt: push the band above the belt outward with soft lumps."""
    for v in torso.data.vertices:
        p = v.co
        if not (BELT_Z[1] - 0.004 < p.z < 1.15) or abs(p.x) > 0.24:
            continue
        d = Vector((p.x, p.y - 0.008, 0.0))
        if d.length > 0.26:
            continue
        th = math.atan2(d.y, d.x)
        b = _smooth01(BELT_Z[1] - 0.004, BELT_Z[1] + 0.012, p.z) * (1.0 - _smooth01(1.05, 1.15, p.z))
        amt = 0.0060 * b * (1.0 + 0.30 * math.sin(5 * th + 1.3) + 0.18 * math.sin(9 * th + 0.4))
        v.co = p + d.normalized() * amt


def loosen_shirt(torso):
    """Loose-fitting polo: push the Shirt zone outward (looser at the waist and sleeves, snug on
    the shoulder tops) with low-frequency drape folds; faded to zero at the zone boundaries and
    below the belt top so nothing pokes through the belt, collar line or sleeve hems."""
    import numpy as np
    from golfer_tex import noise3, fbm3
    me = torso.data
    names = [m.name for m in me.materials]
    bm = C.bm_from(torso)
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    shirt_f = [names[f.material_index] == 'Shirt' for f in bm.faces]
    bm.faces.ensure_lookup_table()
    dist = {}
    frontier = [v for v in bm.verts if any(not shirt_f[f.index] for f in v.link_faces)]
    for v in frontier:
        dist[v.index] = 0
    for k in range(1, 4):
        nxt = []
        for v in frontier:
            for e in v.link_edges:
                w = e.other_vert(v)
                if w.index not in dist:
                    dist[w.index] = k
                    nxt.append(w)
        frontier = nxt
    sel = [v for v in bm.verts if any(shirt_f[f.index] for f in v.link_faces)]
    P = np.array([v.co[:] for v in sel])
    x, y, z = P[:, 0], P[:, 1], P[:, 2]

    def sst(e0, e1, q):
        t = np.clip((q - e0) / (e1 - e0), 0, 1)
        return t * t * (3 - 2 * t)
    body = np.abs(x) < 0.22
    base = 0.0060 + 0.0045 * (1 - sst(1.10, 1.30, z)) - 0.0035 * sst(1.40, 1.48, z)
    arm = np.zeros(len(P))
    for side in ('L', 'R'):
        sh, el = np.array(J['shoulder_' + side][:]), np.array(J['elbow_' + side][:])
        du = (el - sh) / np.linalg.norm(el - sh)
        along = (P - sh) @ du
        radial = np.linalg.norm((P - sh) - along[:, None] * du, axis=1)
        arm = np.maximum(arm, (radial < 0.10) * sst(0.04, 0.10, along))
    base = base + 0.0040 * arm
    th = np.arctan2(x, -(y - 0.012))
    fold = 0.0022 * fbm3(P, 7.0, 3, seed=301)
    # drape folds from the armpits toward the waist, front and back
    for s_ in (1, -1):
        for fy in (-1, 1):
            a = np.array([s_ * 0.150, 0.012 + fy * 0.075, 1.30])
            b = np.array([s_ * 0.065, 0.012 + fy * 0.095, 1.09])
            ab = b - a
            t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
            d = np.linalg.norm(P - (a + t[:, None] * ab), axis=1)
            fold += 0.0040 * np.exp(-(d / 0.016) ** 2) * np.sin(np.pi * t) * ((y - 0.012) * fy > 0) * body
    gate = sst(-0.25, 0.35, noise3(P, 10.0, seed=302))
    fold += 0.0032 * gate * np.sin(th * 8.0 + 3.0 * noise3(P, 8.0, seed=303)) * sst(1.035, 1.06, z) * (1 - sst(1.10, 1.18, z)) * body
    fold += 0.0018 * np.sin(z * 2 * np.pi / 0.045 + 3.0 * noise3(P, 6.0, seed=304)) * arm
    amt = (base + fold) * sst(1.024, 1.045, z + 0.2 * (~body))      # nothing under the belt
    for v, a_ in zip(sel, amt):
        w = min(1.0, dist.get(v.index, 3) / 3.0)
        v.co = v.co + v.normal * float(a_) * w
    C.bm_to(bm, torso)


def zone_torso(torso):
    """Cut clean boundaries and assign Shirt / Skin / Pants."""
    C.assign_all(torso, 'Shirt')
    i_skin = C.add_material(torso, 'Skin')
    i_pants = C.add_material(torso, 'Pants')
    bm = C.bm_from(torso)
    faces = [f for f in bm.faces if abs(f.calc_center_median().x) < 0.26]
    edges = list({e for f in faces for e in f.edges})
    verts = list({v for f in faces for v in f.verts})
    bmesh.ops.bisect_plane(bm, geom=verts + edges + faces, plane_co=(0, 0, SHIRT_LINE_Z), plane_no=(0, 0, 1))
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
    # trouser hems: planar cut, higher at the front
    for side, s in (('L', 1.0), ('R', -1.0)):
        an = J['ankle_' + side]
        sel = [f for f in bm.faces if f.calc_center_median().z < 0.22 and f.calc_center_median().x * s > 0.02]
        edges = list({e for f in sel for e in f.edges})
        verts = list({v for f in sel for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=verts + edges + sel, plane_co=(an.x, HEM_Y0, HEM_Z0),
                               plane_no=(0.0, HEM_SLOPE, 1.0), clear_inner=True)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for f in bm.faces:
        c = f.calc_center_median()
        idx = 0
        if c.z < SHIRT_LINE_Z and abs(c.x) < 0.26:
            idx = i_pants
        if c.z < 0.90:
            idx = i_pants
        for side in ('L', 'R'):
            sh, el = J['shoulder_' + side], J['elbow_' + side]
            du = _n(el - sh)
            if (c - sh).dot(du) > SLEEVE_HEM - 0.004 and (c - sh).length > 0.12 and abs(c.x) > 0.2:
                idx = i_skin
        f.material_index = idx
    # turned hem lip: fabric thickness inside the open trouser leg
    lip_faces = []
    for side, s in (('L', 1.0), ('R', -1.0)):
        an = J['ankle_' + side]
        axis = Vector((an.x + 0.002 * s, an.y + 0.010, 0.0))
        bverts = [v for v in bm.verts if v.is_boundary and v.co.z < 0.2 and v.co.x * s > 0]
        loop = _ordered_loop(bverts)
        if not loop:
            continue
        rings = [loop]
        for k, (inset, rise) in enumerate(((0.0035, 0.002), (0.0045, 0.016))):
            ring = []
            for v in loop:
                d = Vector((v.co.x - axis.x, v.co.y - axis.y, 0.0)).normalized()
                ring.append(bm.verts.new(v.co - d * inset + Vector((0, 0, rise))))
            rings.append(ring)
        n = len(loop)
        for k in range(2):
            for j in range(n):
                a, b = rings[k][j], rings[k][(j + 1) % n]
                c2, d2 = rings[k + 1][(j + 1) % n], rings[k + 1][j]
                try:
                    f = bm.faces.new((a, b, c2, d2))
                    f.material_index = i_pants
                    lip_faces.append(f)
                except ValueError:
                    pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.faces.ensure_lookup_table()
    lip_idx = [f.index for f in lip_faces]
    C.bm_to(bm, torso)
    TX.set_part(torso, PART['torso'])
    TX.set_part(torso, PART['hem'], lip_idx)
    loosen_shirt(torso)
    return lip_idx


def _ordered_loop(bverts):
    """Order boundary vertices into a closed loop."""
    if not bverts:
        return []
    vs = set(bverts)
    loop = [bverts[0]]
    prev = None
    cur = bverts[0]
    while True:
        nxt = None
        for e in cur.link_edges:
            if not e.is_boundary:
                continue
            w = e.other_vert(cur)
            if w in vs and w is not prev:
                nxt = w
                break
        if nxt is None or nxt is loop[0]:
            break
        loop.append(nxt)
        prev, cur = cur, nxt
        if len(loop) > len(vs):
            break
    return loop


# ------------------------------------------------------------------ head details
def build_brows(head):
    """Eyebrow cards conformed to the brow ridge (Hair material, alpha-masked texture)."""
    bvh = C.bvh(head)
    eyes = MH.eye_spheres()
    ec, er = eyes['L']
    objs = []
    nu, nv = 14, 5
    for s in (1, -1):
        verts, uvs = [], []
        for i in range(nu):
            t = i / (nu - 1)
            x = s * (0.010 + 0.050 * t)
            zc = ec.z + er * 0.95 + 0.0055 * math.sin(math.pi * min(1.0, t * 1.15)) - 0.0035 * t
            half = 0.0052 * (1.0 - 0.45 * t) + 0.0008
            for k in range(nv):
                w = k / (nv - 1)
                z = zc + (w - 0.45) * 2 * half
                o = Vector((x, -0.2, z))
                hit = bvh.ray_cast(o, Vector((0, 1, 0)))
                p = hit[0] if hit[0] is not None else Vector((x, -0.09, z))
                nrm = hit[1] if hit[0] is not None else Vector((0, -1, 0))
                verts.append(p + nrm * 0.0010)
                uvs.append((t, w))
        faces = []
        for i in range(nu - 1):
            for k in range(nv - 1):
                a = i * nv + k
                f = (a, a + nv, a + nv + 1, a + 1)
                faces.append(f if s < 0 else f[::-1])
        ob = C.new_mesh_obj('Brow_' + ('L' if s > 0 else 'R'), verts, faces, 'Hair')
        _orient_outward(ob, Vector((0.0, 0.0, 1.68)))
        uv = TX.ensure_uv(ob)
        r = UV['Hair']['brow']
        for poly in ob.data.polygons:
            for li in poly.loop_indices:
                vi = ob.data.loops[li].vertex_index
                t, w = uvs[vi]
                uv.data[li].uv = (r[0] + (r[2] - r[0]) * t, r[1] + (r[3] - r[1]) * w)
        TX.set_part(ob, PART['brow'])
        objs.append(ob)
    return objs


# ------------------------------------------------------------------ hands
HAND_DATA = {}      # side -> list of finger dicts (tip, dir, dorsal, r) for nails / glove seams


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
    data = []
    for off, fr, flen in fingers:
        K = W + a * (0.094 - 0.012 * abs(off - 0.008) / 0.03) + t * off
        s_par = t.dot(K - Cg) / t.dot(g)
        S = Cg + g * s_par
        pts = _finger_path(K, S, a, p, GRIP_RADIUS + fr * 0.95, flen)
        n = len(pts)
        for i in range(n - 1):
            r = fr * (1.0 - 0.18 * i / max(1, n - 2))
            m.capsule(pts[i], pts[i + 1], r, stiff=st)
        tip = pts[-1]
        d = _n(pts[-1] - pts[-2])
        axis_pt = Cg + g * (tip - Cg).dot(g)
        data.append({'tip': tip, 'dir': d, 'dorsal': _n(tip - axis_pt), 'r': fr * 0.82, 'knuckle': K})
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
    data.append({'tip': tip, 'dir': _n(tip - mid), 'dorsal': side_dir, 'r': 0.0098 * 0.85, 'knuckle': R0, 'thumb': True})
    HAND_DATA[side] = data
    ob = m.to_mesh('Hand_' + side)
    C.voxel_remesh(ob, 0.0028)
    C.quadriflow(ob, 760)
    C.smooth_mesh(ob, 0.3, 1)
    C.assign_all(ob, 'Glove' if side == 'L' else 'Skin')
    TX.set_part(ob, PART['hand_' + side])
    return ob


def build_glove_tab(hand):
    """Hook-and-loop closure tab on the back of the gloved (left) hand."""
    hf = hand_frame('L')
    W, a, p, t = hf['wrist'], hf['along'], hf['palm'], hf['thumb']
    bvh = C.bvh(hand)
    nu, nv = 7, 6
    verts = []
    for i in range(nu):
        su = i / (nu - 1)
        for k in range(nv):
            sv = k / (nv - 1)
            along = -0.008 + 0.040 * su
            # rounded end toward the knuckles
            half = 0.013 * (1.0 if su < 0.75 else math.sqrt(max(0.0, 1 - ((su - 0.75) / 0.25) ** 2)) * 0.9 + 0.1)
            across = (sv - 0.5) * 2 * half - 0.004
            o = W + a * along + t * across - p * 0.08
            hit = bvh.ray_cast(o, p, 0.2)
            q = hit[0] if hit[0] is not None else W + a * along + t * across - p * 0.02
            nrm = hit[1] if hit[0] is not None else -p
            verts.append(q + nrm * 0.0009)
    faces = [(i * nv + k, (i + 1) * nv + k, (i + 1) * nv + k + 1, i * nv + k + 1)
             for i in range(nu - 1) for k in range(nv - 1)]
    ob = C.new_mesh_obj('GloveTab', verts, faces, 'Glove')
    sol = ob.modifiers.new('Sol', 'SOLIDIFY')
    sol.thickness = 0.0012
    sol.offset = 1.0
    C.apply_modifier(ob, sol)
    C.recalc_normals(ob)
    TX.set_part(ob, PART['glove_tab'])
    return ob


# ------------------------------------------------------------------ shoes
SHOE_LEN = 0.298
SHOE_HEEL_BACK = 0.080       # heel back behind the ankle joint along the foot axis
SOLE_TOP = 0.024
# t (heel back 0 -> toe tip 1): medial half width, lateral half width, top height
SHOE_PROFILE = [
    (0.00, 0.010, 0.010, 0.046), (0.03, 0.024, 0.024, 0.066), (0.10, 0.033, 0.033, 0.074),
    (0.22, 0.034, 0.036, 0.072), (0.36, 0.035, 0.041, 0.086), (0.50, 0.043, 0.045, 0.080),
    (0.63, 0.048, 0.046, 0.064), (0.75, 0.046, 0.042, 0.053), (0.86, 0.039, 0.033, 0.044),
    (0.94, 0.027, 0.021, 0.036), (0.985, 0.012, 0.009, 0.029), (1.00, 0.002, 0.002, 0.026)]
LACE_T = (0.475, 0.520, 0.565, 0.610, 0.655, 0.700)


def lace_half(t):
    """Half-width of the lacing throat (fraction of the section parameter from the top)."""
    return 0.140 - 0.045 * (t - LACE_T[0]) / (LACE_T[-1] - LACE_T[0])


def eyestay_lift(t, a):
    """Raised eyestay bands either side of the throat, recessed tongue between them."""
    if t < LACE_T[0] - 0.04 or t > LACE_T[-1] + 0.05:
        return 0.0
    w = min(1.0, (t - (LACE_T[0] - 0.04)) / 0.04, ((LACE_T[-1] + 0.05) - t) / 0.05)
    dlt = lace_half(min(max(t, LACE_T[0]), LACE_T[-1]))
    bump = 0.0016 * math.exp(-((a - dlt - 0.018) / 0.022) ** 2)
    dip = -0.0016 * (1.0 - _smooth01(dlt - 0.035, dlt - 0.005, a))
    return w * (bump + dip)


def _interp(table, t, col):
    for i in range(len(table) - 1):
        if table[i][0] <= t <= table[i + 1][0]:
            a, b = table[i], table[i + 1]
            f = (t - a[0]) / (b[0] - a[0])
            f = f * f * (3 - 2 * f)
            return a[col] + (b[col] - a[col]) * f
    return table[-1][col]


def foot_frame(side):
    an, toe = J['ankle_' + side], J['toe_' + side]
    fwd = toe - an
    fwd.z = 0
    fwd = _n(fwd)
    across = _n(Vector((0, 0, 1)).cross(fwd))      # to the foot's left
    heel = an - fwd * SHOE_HEEL_BACK
    heel.z = 0.0
    return heel, fwd, across


def toe_spring(t):
    return 0.011 * max(0.0, (t - 0.80) / 0.20) ** 2


def shoe_point(side, t, phi, lift=0.0):
    """Upper surface point. phi 0 = medial bottom edge, pi/2 = top, pi = lateral bottom edge."""
    s = 1.0 if side == 'L' else -1.0
    heel, fwd, across = foot_frame(side)
    lateral = across * s                             # foot's outside
    wm, wl, h = (_interp(SHOE_PROFILE, t, k) for k in (1, 2, 3))
    zb = SOLE_TOP + toe_spring(t)
    h = max(h + toe_spring(t), zb + 0.007)
    c = math.cos(phi)
    sgn = 1.0 if c >= 0 else -1.0
    w = wm if c >= 0 else wl
    e = 0.62                                         # squarish section
    x = -sgn * w * abs(c) ** e                       # medial side is -lateral
    zz = zb + (h - zb + lift) * math.sin(phi) ** 0.85
    base = heel + fwd * (t * SHOE_LEN)
    return base + lateral * x + Vector((0, 0, zz))


def build_shoe(side):
    nt, nphi = 42, 31
    ts = [0.5 - 0.5 * math.cos(math.pi * i / (nt - 1)) for i in range(nt)]
    verts, uvs = [], []
    for t in ts:
        for k in range(nphi):
            phi = math.pi * k / (nphi - 1)
            verts.append(shoe_point(side, t, phi, lift=eyestay_lift(t, abs(k / (nphi - 1) - 0.5))))
            uvs.append((t, k / (nphi - 1)))
    faces = []
    for i in range(nt - 1):
        for k in range(nphi - 1):
            a = i * nphi + k
            f = (a, a + 1, a + nphi + 1, a + nphi)
            faces.append(f)
    # ankle opening: inside the collar line the upper dips down and shows the sock
    def opening(t):
        if t < 0.07 or t > 0.43:
            return 0.0
        return 0.215 * math.sin(math.pi * (t - 0.07) / 0.36) ** 0.55
    sock_v = set()
    rim_v = set()
    for i, t in enumerate(ts):
        ow = opening(t)
        for k in range(nphi):
            a = abs(k / (nphi - 1) - 0.5)
            idx = i * nphi + k
            if ow > 0 and a < ow - 0.02:
                sock_v.add(idx)
                verts[idx] = verts[idx] - Vector((0, 0, 0.010 * min(1.0, (ow - a) / 0.08)))
            elif ow > 0 and a < ow + 0.035:
                rim_v.add(idx)
                verts[idx] = verts[idx] + Vector((0, 0, 0.0028))
    # close heel back and toe tip with fans to the section centre
    for i, tcap in ((0, ts[0]), (nt - 1, ts[-1])):
        c = len(verts)
        ring = [verts[i * nphi + k] for k in range(nphi)]
        verts.append(sum(ring, Vector()) / nphi)
        uvs.append((tcap, 0.5))
        for k in range(nphi - 1):
            faces.append((i * nphi + k, i * nphi + k + 1, c))
    ob = C.new_mesh_obj('Shoe_' + side, verts, faces, 'Shoes')
    _orient_outward(ob, _shoe_centre(side))
    si = C.add_material(ob, 'Sock')
    for p in ob.data.polygons:
        if sum(1 for vi in p.vertices if vi in sock_v) >= 3:
            p.material_index = si
    uv = TX.ensure_uv(ob)
    for poly in ob.data.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[ob.data.loops[li].vertex_index]
    TX.set_part(ob, PART['shoe'])
    sole = build_sole(side)
    laces = build_laces(side)
    return [ob, sole, laces]


def _shoe_centre(side):
    heel, fwd, across = foot_frame(side)
    return heel + fwd * (SHOE_LEN * 0.5) + Vector((0, 0, 0.04))


def _orient_outward(ob, centre):
    C.recalc_normals(ob)
    me = ob.data
    out = sum(p.normal.dot(p.center - centre) * p.area for p in me.polygons)
    if out < 0:
        me.flip_normals()


def build_sole(side):
    """Midsole + outsole extruded under the upper outline, slight welt and toe spring."""
    n = 40
    outline = []
    for i in range(n):
        # medial edge heel->toe then lateral edge toe->heel
        if i < n // 2:
            t = 0.5 - 0.5 * math.cos(math.pi * i / (n // 2))
            phi = 0.0
        else:
            t = 0.5 + 0.5 * math.cos(math.pi * (i - n // 2) / (n // 2))
            phi = math.pi
        outline.append((t, shoe_point(side, t, phi)))
    ctr = sum((p for t, p in outline), Vector()) / n
    rings = []
    spec = [(-0.0025, 0.000), (0.0030, 0.0035), (0.0040, 0.0060), (0.0042, SOLE_TOP - 0.004), (0.0010, SOLE_TOP + 0.0008)]
    for off, z in spec:
        ring = []
        for t, p in outline:
            d = Vector((p.x - ctr.x, p.y - ctr.y, 0.0))
            # outward = perpendicular to the outline in the ground plane, approximated radially
            dn = d.normalized()
            q = Vector((p.x, p.y, 0.0)) + dn * off
            q.z = z + toe_spring(t)
            ring.append(q)
        rings.append(ring)
    sole = C.loft('Sole_' + side, rings, closed_start=True, closed_end=True, mat='Sole')
    _orient_outward(sole, ctr + Vector((0, 0, 0.01)))
    uv = TX.ensure_uv(sole)
    me = sole.data
    nring = len(spec)
    top_c = nring * n + 1                  # centre of the (hidden) top cap fan
    for poly in me.polygons:
        if top_c in poly.vertices:
            for k, li in enumerate(poly.loop_indices):
                uv.data[li].uv = (0.985 + 0.01 * (k == 1), 0.005 + 0.01 * (k == 2))
            continue
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            if vi >= nring * n:            # bottom centre (fan)
                uv.data[li].uv = (0.25, 0.25)
                continue
            r, j = divmod(vi, n)
            if len(poly.vertices) == 3:
                # bottom: planar footprint in the lower-left square
                co = me.vertices[vi].co
                heel, fwd, across = foot_frame(side)
                tt = (co - heel).dot(fwd) / SHOE_LEN
                ll = (co - heel).dot(across * (1.0 if side == 'L' else -1.0))
                uv.data[li].uv = (0.25 + ll / 0.11 * 0.48, 0.02 + tt * 0.46)
            else:
                uv.data[li].uv = (j / n, 0.52 + 0.46 * r / (nring - 1))
    TX.set_part(sole, PART['sole'])
    return sole


def build_laces(side):
    """Criss-cross laces between eyelet pairs, lying on the tongue/eyestays."""
    objs = []
    pairs = []
    for t in LACE_T:
        d = lace_half(t) + 0.012
        pairs.append(((t, 0.5 - d), (t, 0.5 + d)))

    def strap(p0, p1, name):
        pts = []
        for k in range(8):
            f = k / 7
            t = p0[0] + (p1[0] - p0[0]) * f
            a = p0[1] + (p1[1] - p0[1]) * f
            lift = eyestay_lift(t, abs(a - 0.5)) + 0.0011 + 0.0006 * math.sin(math.pi * f)
            pts.append(shoe_point(side, t, math.pi * a, lift=lift))
        rings = []
        for j, p in enumerate(pts):
            tan = _n(pts[min(j + 1, 7)] - pts[max(j - 1, 0)])
            up = Vector((0, 0, 1))
            sv = _n(tan.cross(up))
            w, hh = 0.0020, 0.0009
            rings.append([p + sv * w, p + up * hh, p - sv * w, p - up * hh * 0.4])
        ob = C.loft(name, rings, closed_start=True, closed_end=True, mat='Laces')
        C.recalc_normals(ob)
        return ob
    for i in range(len(pairs) - 1):
        (m0, l0), (m1, l1) = pairs[i], pairs[i + 1]
        objs.append(strap(m0, l1, 'LaceA'))
        objs.append(strap(l0, m1, 'LaceB'))
    objs.append(strap(pairs[-1][0], pairs[-1][1], 'LaceTop'))
    lace = C.join(objs, 'Laces_' + side)
    TX.ensure_uv(lace)
    TX.set_part(lace, PART['lace'])
    return lace


def conform_hems(torso, shoes, lip_idx=()):
    """Push the lower trouser vertices out so the hem drapes around the shoe."""
    dg = bpy.context.evaluated_depsgraph_get()
    lipv = {vi for f in lip_idx for vi in torso.data.polygons[f].vertices}
    for side, s in (('L', 1.0), ('R', -1.0)):
        bvh = C.bvh(shoes[side][0])
        an = J['ankle_' + side]
        axis = Vector((an.x + 0.002 * s, an.y + 0.010, 0.0))
        for v in torso.data.vertices:
            p = v.co
            if p.z > 0.14 or p.x * s < 0.02:
                continue
            d = Vector((p.x - axis.x, p.y - axis.y, 0.0))
            if d.length < 1e-6:
                continue
            d.normalize()
            q = p.copy()
            for _ in range(40):
                loc, nrm, idx, dist = bvh.find_nearest(q)
                if loc is None:
                    break
                inside = (q - loc).dot(nrm) < 0
                if not inside and dist > (0.0012 if v.index in lipv else 0.0050):
                    break
                q += d * 0.001
            fall = 1.0 - _smooth01(0.08, 0.14, p.z)
            v.co = p + (q - p) * max(fall, 1.0 if p.z < 0.10 else 0.0)


# ------------------------------------------------------------------ clothing overlays
class Conformer:
    """Ray caster against one or more objects (largest hit distance wins)."""

    def __init__(self, *objs):
        dg = bpy.context.evaluated_depsgraph_get()
        self.bvhs = [C.bvh(o) for o in objs]

    def radius(self, origin, direction, default):
        """Distance from an interior origin to the outermost first-hit surface along direction."""
        o = Vector(origin)
        d = _n(direction)
        best = None
        for bvh in self.bvhs:
            hit = bvh.ray_cast(o, d, 1.0)
            if hit[0] is not None:
                r = (hit[0] - o).dot(d)
                best = r if best is None else max(best, r)
        return default if best is None else best


def build_belt(torso):
    cf = Conformer(torso)
    n = 64
    ctr = Vector((0, 0.008, 0))
    zs = [BELT_Z[0], BELT_Z[0] + 0.004, BELT_Z[1] - 0.004, BELT_Z[1]]
    offs = [0.0045, 0.0078, 0.0078, 0.0045]
    rings = []
    for z, off in zip(zs, offs):
        ring = []
        for i in range(n + 1):
            th = -math.pi / 2 + 2 * math.pi * i / n          # start at the front (buckle)
            d = Vector((math.cos(th), math.sin(th), 0))
            r = cf.radius(ctr + Vector((0, 0, z)), d, 0.15)
            ring.append(ctr + Vector((0, 0, z)) + d * (r + off))
        rings.append(ring)
    # open loft (seam duplicated at the buckle for clean UVs)
    verts = [p for ring in rings for p in ring]
    m = n + 1
    faces = [(k * m + i, k * m + i + 1, (k + 1) * m + i + 1, (k + 1) * m + i) for k in range(3) for i in range(n)]
    belt = C.new_mesh_obj('Belt', verts, faces, 'Belt')
    _orient_outward(belt, Vector((0, 0.008, 1.007)))
    uv = TX.ensure_uv(belt)
    r = UV['Belt']['band']
    vband = [0.0, 0.12, 0.88, 1.0]
    for poly in belt.data.polygons:
        for li in poly.loop_indices:
            vi = belt.data.loops[li].vertex_index
            k, i = divmod(vi, m)
            uv.data[li].uv = (r[0] + (r[2] - r[0]) * i / n, r[1] + (r[3] - r[1]) * vband[k])
    TX.set_part(belt, PART['belt'])
    zc = (BELT_Z[0] + BELT_Z[1]) * 0.5
    front_r = cf.radius(ctr + Vector((0, 0, zc)), Vector((0, -1, 0)), 0.1)
    fy = ctr.y - front_r - 0.0078
    parts = [belt]
    # strap tail from the buckle toward the first loop (wearer's left, +x)
    tail_rings = []
    for i in range(9):
        x = 0.006 + 0.064 * i / 8
        d = _n(Vector((x, -front_r, 0.0)))
        rr = cf.radius(ctr + Vector((0, 0, zc)), d, 0.15)
        p = ctr + Vector((0, 0, zc)) + d * (rr + 0.0108)
        half = 0.0165
        tail_rings.append([p + Vector((0, 0, -half)), p + Vector((0, 0, half)), p + Vector((0, 0, half)) - d * 0.0026,
                           p + Vector((0, 0, -half)) - d * 0.0026])
    tail = C.loft('BeltTail', tail_rings, closed_start=True, closed_end=True, mat='Belt')
    _orient_outward(tail, Vector((0.03, 0.008, zc)))
    uvt = TX.ensure_uv(tail)
    rm = UV['Belt']['misc']
    for poly in tail.data.polygons:
        for li in poly.loop_indices:
            vi = tail.data.loops[li].vertex_index
            i, k = divmod(vi, 4) if vi < 36 else (8, 0)
            uvt.data[li].uv = (rm[0] + (rm[2] - rm[0]) * (0.05 + 0.6 * i / 8), rm[1] + (rm[3] - rm[1]) * (0.1 + 0.25 * (k in (1, 2))))
    TX.set_part(tail, PART['belt_tail'])
    parts.append(tail)
    parts += build_buckle(fy, zc)
    parts += build_belt_loops(cf, ctr)
    return parts


def build_buckle(fy, zc):
    """Brushed metal frame buckle with centre bar and prong."""
    W, H, bar, th = 0.042, 0.036, 0.0042, 0.0034
    y = fy - 0.0022
    objs = []

    def box(name, cx, cz, sx, sz, sy, yy):
        bpy.ops.mesh.primitive_cube_add(size=2, location=(cx, yy, cz))
        ob = bpy.context.active_object
        ob.name = name
        ob.scale = (sx, sy, sz)
        bpy.ops.object.transform_apply(scale=True, location=True)
        bev = ob.modifiers.new('Bev', 'BEVEL')
        bev.width = 0.0011
        bev.segments = 2
        C.apply_modifier(ob, bev)
        C.assign_all(ob, 'Buckle')
        return ob
    x0 = -0.004
    objs.append(box('BuckleTop', x0, zc + H / 2 - bar / 2, W / 2, bar / 2, th / 2, y))
    objs.append(box('BuckleBot', x0, zc - H / 2 + bar / 2, W / 2, bar / 2, th / 2, y))
    objs.append(box('BuckleL', x0 + W / 2 - bar / 2, zc, bar / 2, H / 2, th / 2, y))
    objs.append(box('BuckleR', x0 - W / 2 + bar / 2, zc, bar / 2, H / 2, th / 2, y))
    objs.append(box('BuckleBar', x0 - 0.006, zc, 0.0016, H / 2 - bar * 0.6, th * 0.45, y + 0.0012))
    objs.append(box('BuckleProng', x0 + 0.007, zc, 0.012, 0.0011, 0.0011, y - 0.0016))
    ob = C.join(objs, 'Buckle')
    TX.ensure_uv(ob)
    TX.set_part(ob, PART['buckle'])
    # keeper loop next to the buckle
    kx = 0.031
    keeper = _keeper(kx, fy, zc)
    return [ob, keeper]


def _keeper(kx, fy, zc):
    """Leather keeper loop wrapped around belt + tail at x = kx."""
    n = 16
    rings = []
    for w in (-0.0045, 0.0045):
        ring = []
        for j in range(n):
            a = 2 * math.pi * j / n
            # rounded rectangle around the strap stack (front face proud by the tail thickness)
            hz = 0.0205
            hy = 0.0045
            ca, sa = math.cos(a), math.sin(a)
            zz = zc + hz * (abs(sa) ** 0.3) * (1 if sa >= 0 else -1)
            yy = fy - 0.0015 + hy * (abs(ca) ** 0.3) * (-1 if ca >= 0 else 1)
            ring.append(Vector((kx + w, yy, zz)))
        rings.append(ring)
    inner = [[p + (Vector((kx + (rings[r][0].x - kx), fy - 0.0015, zc)) - p).normalized() * 0.0012 for p in rings[r]]
             for r in (1, 0)]
    keeper = C.loft('Keeper', rings + inner + [rings[0]], mat='Belt')
    _orient_outward(keeper, Vector((kx, fy - 0.0015, zc)))
    uv = TX.ensure_uv(keeper)
    rm = UV['Belt']['misc']
    for poly in keeper.data.polygons:
        for li in poly.loop_indices:
            vi = keeper.data.loops[li].vertex_index
            r, j = divmod(vi, n)
            uv.data[li].uv = (rm[0] + (rm[2] - rm[0]) * (0.70 + 0.28 * j / n), rm[1] + (rm[3] - rm[1]) * (0.05 + 0.4 * r / 4))
    TX.set_part(keeper, PART['keeper'])
    return keeper


def build_belt_loops(cf, ctr):
    loops = []
    zc = (BELT_Z[0] + BELT_Z[1]) * 0.5
    for k, deg in enumerate((-58.0, 58.0, -112.0, 112.0, 180.0)):
        th = math.radians(deg) - math.pi / 2
        d = Vector((math.cos(th), math.sin(th), 0.0))
        rows = []
        for i in range(5):
            z = zc - 0.023 + 0.041 * i / 4
            r = cf.radius(ctr + Vector((0, 0, z)), d, 0.15)
            lift = 0.0108 if -0.021 < z - zc < 0.0175 else 0.0042
            p = ctr + Vector((0, 0, z)) + d * (r + lift)
            side = Vector((-d.y, d.x, 0.0)) * 0.0058
            rows.append([p - side, p + side, p + side - d * 0.0018, p - side - d * 0.0018])
        ob = C.loft('BeltLoop', rows, closed_start=True, closed_end=True, mat='Pants')
        _orient_outward(ob, ctr + Vector((0, 0, zc)))
        loops.append(ob)
    ob = C.join(loops, 'BeltLoops')
    TX.unwrap(ob, [p.index for p in ob.data.polygons], UV['Pants']['loops'], angle=70)
    TX.set_part(ob, PART['belt_loop'])
    return [ob]


def build_collar(torso, head):
    """Polo collar: stand plus a fold-down leaf with spread points. The stand wraps the neck
    (head mesh), its base sits on the torso neckline; every vertex is kept 1.5 mm off the body."""
    tb, hb = C.bvh(torso), C.bvh(head)
    ctr = Vector((0, 0.022, 0))
    segs = 32
    th0, th1 = math.radians(-152), math.radians(152)   # 0 = back (+Y); front opening around +-180
    base = []
    for i in range(segs + 1):
        th = th0 + (th1 - th0) * i / segs
        d = Vector((math.sin(th), math.cos(th), 0))
        rn = []
        for z in (1.500, 1.520):
            o = ctr + Vector((0, 0, z))
            hit = hb.ray_cast(o, d, 0.3)
            rn.append((hit[0] - o).length if hit[0] is not None else 0.065)
        r0 = max(rn) + 0.0040
        q = ctr + d * (r0 + 0.003) + Vector((0, 0, 1.70))
        hit = tb.ray_cast(q, Vector((0, 0, -1)), 0.6)
        zs = hit[0].z if hit[0] is not None else 1.48
        base.append((th, d, r0, min(zs, 1.505) - 0.004))
    # smooth the neckline height (no dips between the trapezius bulges)
    zsm = []
    for i in range(segs + 1):
        acc = wsum = 0.0
        for k in range(-4, 5):
            j = min(segs, max(0, i + k))
            w = 1.0 - abs(k) / 5.0
            acc += base[j][3] * w
            wsum += w
        zsm.append(max(acc / wsum, base[i][3]))
    rings = []
    for i in range(segs + 1):
        th, d, r0, _ = base[i]
        zb = zsm[i]
        f = max(0.0, -math.cos(th))                    # 1 at the front
        h = 0.034 - 0.013 * f
        leaf = h + 0.004 + 0.020 * f ** 2.5           # leaf depth grows into the collar points
        spread = 0.0035 + 0.018 * f ** 2
        prof = [
            (0.0, 0.0), (0.0, h), (0.0030, h + 0.0020), (0.0060, h + 0.0004),
            (0.0060 + spread, h - leaf), (0.0042 + spread, h - leaf + 0.0006),
            (0.0040, h - 0.003), (0.0018, 0.0),
        ]
        ring = [ctr + d * (r0 + dr) + Vector((0, 0, zb + dz)) for (dr, dz) in prof + [prof[0]]]
        rings.append(ring)
    n = len(rings[0])
    verts = [p for ring in rings for p in ring]
    faces = [(i * n + j, i * n + j + 1, (i + 1) * n + j + 1, (i + 1) * n + j)
             for i in range(segs) for j in range(n - 1)]
    faces.append(tuple(range(n - 1))[::-1])
    faces.append(tuple(segs * n + j for j in range(n - 1)))
    collar = C.new_mesh_obj('Collar', verts, faces, 'Shirt')
    # keep the leaf and stand off the shoulders / neck
    for v in collar.data.vertices:
        for _ in range(40):
            bad = False
            for bvh in (tb, hb):
                loc, nrm, idx, dist = bvh.find_nearest(v.co)
                if loc is not None and ((v.co - loc).dot(nrm) < 0 or dist < 0.0015):
                    bad = True
                    v.co += nrm.normalized() * 0.0006
            if not bad:
                break
    C.recalc_normals(collar)
    _orient_outward(collar, Vector((0.0, 0.022, 1.50)))
    uv = TX.ensure_uv(collar)
    r = UV['Shirt']['collar']
    me = collar.data
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            i, j = divmod(vi, n)
            uv.data[li].uv = (r[0] + (r[2] - r[0]) * i / segs, r[1] + (r[3] - r[1]) * j / (n - 1))
    TX.set_part(collar, PART['collar'])
    return collar


PLACKET_Z = (1.448, 1.315)
BUTTON_Z = (1.428, 1.389, 1.350)


def _front_surface(bvh, x, z):
    """Outermost torso surface point in front of (x, z) (ray from outside, so hidden inner
    parts such as the neck stub are never picked)."""
    hit = bvh.ray_cast(Vector((x, -0.4, z)), Vector((0, 1, 0)), 0.6)
    return hit[0] if hit[0] is not None else Vector((x, -0.09, z))


def build_placket(torso):
    tb = C.bvh(torso)
    pts = []
    zs = [PLACKET_Z[0] + (PLACKET_Z[1] - PLACKET_Z[0]) * i / 7 for i in range(8)]
    for z in zs:
        row = []
        for x in (-0.0135, -0.006, 0.006, 0.0135):
            row.append(_front_surface(tb, x, z) + Vector((0, -0.0011, 0)))
        pts.append(row)
    verts = [v for r in pts for v in r]
    faces = [(i * 4 + k + 1, i * 4 + k, (i + 1) * 4 + k, (i + 1) * 4 + k + 1) for i in range(len(pts) - 1) for k in range(3)]
    pl = C.new_mesh_obj('Placket', verts, faces, 'Shirt')
    uv = TX.ensure_uv(pl)
    r = UV['Shirt']['placket']
    for poly in pl.data.polygons:
        for li in poly.loop_indices:
            vi = pl.data.loops[li].vertex_index
            i, k = divmod(vi, 4)
            uv.data[li].uv = (r[0] + (r[2] - r[0]) * i / 7, r[1] + (r[3] - r[1]) * k / 3)
    sol = pl.modifiers.new('Sol', 'SOLIDIFY')
    sol.thickness = 0.0016
    sol.offset = 1.0
    C.apply_modifier(pl, sol)
    C.recalc_normals(pl)
    TX.set_part(pl, PART['placket'])
    buttons = []
    for z in BUTTON_Z:
        fy = _front_surface(tb, 0.0, z).y
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.0062, depth=0.0024,
                                            location=(0, fy - 0.0037, z), rotation=(math.pi / 2, 0, 0))
        b = bpy.context.active_object
        b.name = 'Button'
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bev = b.modifiers.new('Bev', 'BEVEL')
        bev.width = 0.0007
        bev.segments = 1
        C.apply_modifier(b, bev)
        C.assign_all(b, 'Button')
        TX.ensure_uv(b)
        TX.set_part(b, PART['button'])
        buttons.append(b)
    return [pl] + buttons


SLEEVE_HEM = 0.165   # distance from shoulder joint along the upper arm


def build_sleeves(torso):
    cf = Conformer(torso)
    objs = []
    n = 28
    for side in ('L', 'R'):
        sh, el = J['shoulder_' + side], J['elbow_' + side]
        du = _n(el - sh)
        u, w = _ortho(du)
        rings = []
        spec = [(0.105, 0.0012), (0.128, 0.0060), (0.150, 0.0120), (SLEEVE_HEM, 0.0165), (SLEEVE_HEM + 0.0024, 0.0145),
                (SLEEVE_HEM - 0.006, 0.0090), (SLEEVE_HEM - 0.014, 0.0050)]
        for dist, off in spec:
            c = sh + du * dist
            ring = []
            for i in range(n + 1):
                th = 2 * math.pi * i / n
                d = u * math.cos(th) + w * math.sin(th)
                r = cf.radius(c, d, 0.045)
                # looser underneath the arm (drape)
                droop = 0.0025 * max(0.0, -d.z) * (dist - 0.105) / 0.06
                ring.append(c + d * (r + off + droop))
            rings.append(ring)
        m = n + 1
        verts = [p for ring in rings for p in ring]
        faces = [(k * m + i, k * m + i + 1, (k + 1) * m + i + 1, (k + 1) * m + i) for k in range(len(rings) - 1)
                 for i in range(n)]
        sl = C.new_mesh_obj('Sleeve_' + side, verts, faces, 'Shirt')
        _orient_outward(sl, sh + du * 0.13)
        # the inner (turned) rows face inward
        uv = TX.ensure_uv(sl)
        r = UV['Shirt']['sleeve']
        half = (r[2] - r[0]) / 2
        x0 = r[0] if side == 'L' else r[0] + half
        for poly in sl.data.polygons:
            for li in poly.loop_indices:
                vi = sl.data.loops[li].vertex_index
                k, i = divmod(vi, m)
                uv.data[li].uv = (x0 + half * k / (len(rings) - 1), r[1] + (r[3] - r[1]) * i / n)
        TX.set_part(sl, PART['sleeve'])
        objs.append(sl)
    return objs


# ------------------------------------------------------------------ UV layout of the big parts
def uv_torso(torso, lip_idx):
    me = torso.data
    TX.ensure_uv(torso)
    names = [m.name for m in me.materials]
    lip = set(lip_idx)
    zones = {'Shirt': [], 'Pants': [], 'Skin': []}
    for p in me.polygons:
        if p.index in lip:
            continue
        zones[names[p.material_index]].append(p.index)
    TX.unwrap(torso, zones['Shirt'], UV['Shirt']['torso'], angle=58)
    TX.unwrap(torso, zones['Pants'], UV['Pants']['legs'], angle=58)
    if lip_idx:
        TX.unwrap(torso, list(lip_idx), UV['Pants']['misc'], angle=80)


def uv_head(head, ext):
    """MakeHuman UVs for the face/scalp island, smart islands for neck and inner parts."""
    me = head.data
    uv = me.uv_layers['UVMap'].data
    extset = set(ext)
    main, misc, mouth, socket = [], [], [], []
    for p in me.polygons:
        if p.index in extset:
            misc.append(p.index)
            continue
        us = [uv[li].uv[0] for li in p.loop_indices]
        vs = [uv[li].uv[1] for li in p.loop_indices]
        uc, vc = sum(us) / len(us), sum(vs) / len(vs)
        if uc > 0.6 and 0.14 < vc < 0.83:
            main.append(p.index)
        else:
            misc.append(p.index)
            # MakeHuman islands: mouth cavity (inner lips, mouth) and the eye-socket lining
            if 0.74 < uc < 0.94 and vc < 0.14:
                mouth.append(p.index)
            elif uc < 0.16 and 0.53 < vc < 0.65:
                socket.append(p.index)
    TX.fit_rect(head, main, UV['Skin']['face'], keep_aspect=True)
    TX.unwrap(head, misc, UV['Skin']['headmisc'], angle=60)
    TX.set_part(head, PART['head'])
    TX.set_part(head, PART['neck'], ext)
    TX.set_part(head, PART['mouth'], mouth)
    TX.set_part(head, PART['socket'], socket)


def tuck_neck(torso, head, clearance=0.003):
    """Pull torso vertices that would poke through the (head mesh) neck back inside it."""
    hb = C.bvh(head)
    moved = 0
    for v in torso.data.vertices:
        p = v.co
        if p.z < 1.465 or p.z > 1.60:
            continue
        d = Vector((p.x, p.y - MH.NECK_AXIS_Y, 0.0))
        r = d.length
        if r > 0.10 or r < 1e-6:
            continue
        o = Vector((0.0, MH.NECK_AXIS_Y, p.z))
        hit = hb.ray_cast(o, d.normalized(), 0.3)
        if hit[0] is None:
            continue
        rh = (hit[0] - o).length
        if r > rh - clearance:
            k = max(0.02, rh - clearance) / r
            v.co = Vector((p.x * k, MH.NECK_AXIS_Y + (p.y - MH.NECK_AXIS_Y) * k, p.z))
            moved += 1
    return moved


def build_body(accessory_builder=None, arm_ob=None):
    """Build all body parts, skin them part by part (if an armature is given)
    and join them. Returns (joined body mesh, accessory objects)."""
    import golfer_rig as RIG
    torso = build_torso()
    lip_idx = zone_torso(torso)
    head, ext = MH.build_head()
    tuck_neck(torso, head)
    eyes = MH.build_eyes()
    lashes = MH.build_lashes()
    brows = build_brows(head)
    accessories = accessory_builder(head) if accessory_builder else []
    hands = [build_hand('L'), build_hand('R')]
    tab = build_glove_tab(hands[0])
    shoes = {'L': build_shoe('L'), 'R': build_shoe('R')}
    conform_hems(torso, shoes, lip_idx)
    cloth = build_belt(torso) + [build_collar(torso, head)] + build_placket(torso) + build_sleeves(torso)
    uv_torso(torso, lip_idx)
    uv_head(head, ext)
    TX.unwrap(hands[0], [p.index for p in hands[0].data.polygons], (0.0, 0.0, 1.0, 0.86), angle=60)
    TX.unwrap(tab, [p.index for p in tab.data.polygons], (0.0, 0.87, 0.30, 1.0), angle=80)
    if arm_ob is not None:
        for o in [torso, head] + hands:
            RIG.auto_weights(arm_ob, o)
        RIG.pin_neck_base(head, z_top=1.565, z_full=1.44)
        for o in eyes + brows + [lashes]:
            RIG.rigid_weights(o, 'Head')
        RIG.rigid_weights(tab, 'Hand_L')
        for side, objs in shoes.items():
            for o in objs:
                RIG.rigid_weights(o, 'Foot_' + side)
        for o in cloth:
            RIG.transfer_weights(torso, o)
        RIG.hem_foot_weights(torso)
        collar = next(o for o in cloth if o.name.startswith('Collar'))
        RIG.neck_inside(torso, head, MH.NECK_AXIS_Y)
        RIG.neck_blend(collar, torso, head)
    parts = [torso, head] + eyes + brows + [lashes] + hands + [tab] + shoes['L'] + shoes['R'] + cloth
    for p in parts:
        C.shade_smooth(p)
        TX.ensure_uv(p)
    body = C.join(parts, 'Golfer_Body')
    # right hand + arms share one packing (uniform texel density)
    skin_i = [i for i, m in enumerate(body.data.materials) if m.name == 'Skin'][0]
    pids = TX.part_ids(body)
    arm_faces = [p.index for p in body.data.polygons
                 if p.material_index == skin_i and pids[p.index] in (PART['torso'], PART['hand_R'])]
    TX.unwrap(body, arm_faces, UV['Skin']['arms'], angle=60)
    return body, accessories
