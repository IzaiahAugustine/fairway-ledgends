"""Head and face from the MakeHuman base mesh (CC0, see mh/LICENSE.ASSETS.md).

The hm08 base mesh is morphed with the male/young macro targets, cut at the neck and
mapped into the golfer frame (MakeHuman: decimetres, Y up, facing +Z  ->  metres, Z up,
facing -Y). The neck is extended with blended rings down into the torso (the junction
sits under the shirt collar). Eyeballs are placed in the eye-helper spheres.
Connection map (rest pose, metres):
  MakeHuman neck cut (z 1.548)  ->  extension rings  ->  ring at z 1.36 deep inside the chest
  (the lower neck is pinned to the Chest bone so the twist at the top of the backswing never
  lifts the open bottom ring out of the shirt)
  torso neck stub (r 0.050, top z 1.53)  stays inside the extended neck
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

import golfer_common as C

HERE = os.path.dirname(os.path.abspath(__file__))
MH_DIR = os.path.join(HERE, 'mh')
TARGETS = (('caucasian-male-young', 0.55), ('african-male-young', 0.25), ('asian-male-young', 0.20),
           ('universal-male-young-maxmuscle-averageweight', 0.55),
           ('universal-male-young-averagemuscle-minweight', 0.20),
           # athletic adult male face: square jaw, defined cheekbones, heavier brow ridge, strong neck
           ('head-square', 0.50), ('head-scale-horiz-incr', 0.10), ('chin-width-incr', 0.42),
           ('chin-bones-incr', 0.85), ('chin-prominent-incr', 0.35), ('l-cheek-bones-incr', 0.45),
           ('r-cheek-bones-incr', 0.45), ('l-cheek-volume-decr', 0.25), ('r-cheek-volume-decr', 0.25),
           ('eyebrows-trans-forward', 0.50), ('eyebrows-trans-down', 0.30), ('nose-hump-incr', 0.15),
           ('neck-scale-horiz-incr', 0.80), ('neck-scale-depth-incr', 0.50), ('mouth-scale-horiz-incr', 0.15),
           ('mouth-lowerlip-volume-incr', 0.20), ('nose-scale-horiz-incr', 0.15), ('nose-width2-incr', 0.20))
CUT_Y = 6.80            # neck cut height (MakeHuman units)
HEAD_H = 0.243          # chin (menton) to crown, metres
CROWN_Z = 1.800
FRONT_Z0 = 0.55         # MakeHuman z that maps to golfer y = 0
NECK_CUT_Z = 1.548      # planar cut through the MakeHuman neck
NECK_BASE_Z = 1.360     # bottom ring of the neck extension (deep inside the chest)
NECK_AXIS_Y = 0.022     # torso neck stub axis
NECK_RX, NECK_RY = 0.066, 0.060

_cache = {}


def _parse():
    if 'obj' in _cache:
        return _cache['obj']
    V, VT, groups = [], [], {}
    g = None
    with open(os.path.join(MH_DIR, 'base.obj')) as f:
        for line in f:
            if line.startswith('v '):
                V.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                VT.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('g '):
                g = line.split()[1]
            elif line.startswith('f '):
                vi, ti = [], []
                for p in line.split()[1:]:
                    a = p.split('/')
                    vi.append(int(a[0]) - 1)
                    ti.append(int(a[1]) - 1 if len(a) > 1 and a[1] else -1)
                groups.setdefault(g, []).append((vi, ti))
    V = np.array(V, dtype=np.float64)
    for name, w in TARGETS:
        with open(os.path.join(MH_DIR, 'targets', name + '.target')) as f:
            for line in f:
                if not line.strip() or line[0] == '#':
                    continue
                a = line.split()
                V[int(a[0])] += w * np.array([float(a[1]), float(a[2]), float(a[3])])
    _cache['obj'] = (V, np.array(VT), groups)
    return _cache['obj']


def mh_frame():
    """Scale and landmarks of the morphed MakeHuman head."""
    V, VT, G = _parse()
    body = {i for vi, ti in G['body'] for i in vi}
    bi = np.array(sorted(body))
    crown = V[bi, 1].max()
    mid = bi[(np.abs(V[bi, 0]) < 0.05) & (V[bi, 2] > 1.05) & (V[bi, 1] > 6.4)]
    chin = V[mid, 1].min()
    s = HEAD_H / (crown - chin)
    return s, crown


def to_golfer(P):
    s, crown = mh_frame()
    P = np.asarray(P, dtype=np.float64)
    out = np.empty_like(P)
    out[..., 0] = P[..., 0] * s
    out[..., 1] = -(P[..., 2] - FRONT_Z0) * s
    out[..., 2] = (P[..., 1] - crown) * s + CROWN_Z
    return out


def _sphere_fit(pts):
    c = pts.mean(axis=0)
    r = np.linalg.norm(pts - c, axis=1).mean()
    return c, r


def eye_spheres():
    V, VT, G = _parse()
    out = {}
    for side, grp in (('L', 'helper-l-eye'), ('R', 'helper-r-eye')):
        idx = sorted({i for vi, ti in G[grp] for i in vi})
        c, r = _sphere_fit(to_golfer(V[idx]))
        out[side] = (Vector(c), r)
    return out


# ------------------------------------------------------------------ head mesh
def _boundary_loop(bm):
    edges = [e for e in bm.edges if e.is_boundary]
    loops = []
    used = set()
    for e0 in edges:
        if e0.index in used:
            continue
        loop = [e0.verts[0]]
        v = e0.verts[1]
        used.add(e0.index)
        while v is not loop[0]:
            loop.append(v)
            nxt = None
            for e in v.link_edges:
                if e.is_boundary and e.index not in used:
                    nxt = e
                    break
            if nxt is None:
                break
            used.add(nxt.index)
            v = nxt.other_vert(v)
        loops.append(loop)
    return loops


def build_head():
    """Head + neck mesh (Skin), MakeHuman UVs in layer 'UVMap'. Returns the object and
    the list of neck-extension face indices (they need their own UVs)."""
    V, VT, G = _parse()
    faces = [(vi, ti) for vi, ti in G['body'] if max(V[i, 1] for i in vi) > CUT_Y - 0.35]
    used = sorted({i for vi, ti in faces for i in vi})
    remap = {o: n for n, o in enumerate(used)}
    P = to_golfer(V[used])
    me = bpy.data.meshes.new('Head')
    me.from_pydata([tuple(p) for p in P], [], [[remap[i] for i in vi] for vi, ti in faces])
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    li = 0
    for (vi, ti), poly in zip(faces, me.polygons):
        for k, li in enumerate(poly.loop_indices):
            uv.data[li].uv = VT[ti[k]]
    ob = C.link(bpy.data.objects.new('Head', me))
    sculpt_neck(ob)
    # clean planar cut through the neck
    bm = C.bm_from(ob)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, NECK_CUT_Z), plane_no=(0, 0, 1), clear_inner=True)
    C.bm_to(bm, ob)
    me = ob.data
    n_head_faces = len(me.polygons)
    # ---- neck extension
    bm = C.bm_from(ob)
    bm.verts.ensure_lookup_table()
    loops = _boundary_loop(bm)
    loops.sort(key=lambda L: sum(v.co.z for v in L) / len(L))
    print('head boundary loops:', [(len(L), round(sum(v.co.z for v in L) / len(L), 3)) for L in loops])
    neck = loops[0]                                   # lowest open loop = the neck cut
    # extension rings follow the cut loop's own angles (one quad column per cut vertex)
    angs = [math.atan2(v.co.y - NECK_AXIS_Y, v.co.x) % (2 * math.pi) for v in neck]
    order = sorted(range(len(neck)), key=lambda i: angs[i])
    neck = [neck[i] for i in order]
    n = len(neck)
    rings_n = 8
    rows = [neck]
    for k in range(1, rings_n + 1):
        t = k / rings_n
        s = t * t * (3 - 2 * t)
        row = []
        for v in neck:
            d = v.co - Vector((0.0, NECK_AXIS_Y, v.co.z))
            d.z = 0.0
            ang = math.atan2(d.y, d.x)
            r0 = d.length
            r1 = 1.0 / math.sqrt((math.cos(ang) / NECK_RX) ** 2 + (math.sin(ang) / NECK_RY) ** 2)
            r = r0 + (r1 - r0) * s
            z = v.co.z + (NECK_BASE_Z - v.co.z) * t
            row.append(bm.verts.new(Vector((r * math.cos(ang), NECK_AXIS_Y + r * math.sin(ang), z))))
        rows.append(row)
    for k in range(rings_n):
        for j in range(n):
            a, b = rows[k][j], rows[k][(j + 1) % n]
            c, d = rows[k + 1][(j + 1) % n], rows[k + 1][j]
            try:
                bm.faces.new((a, d, c, b))
            except ValueError:
                pass
    # relax the junction between the MakeHuman neck and the extension rings
    band = [v for v in bm.verts if abs(v.co.z - NECK_CUT_Z) < 0.016 and v.co.z < 1.57 and v.co.y > -0.045]
    for _ in range(4):
        new = {}
        for v in band:
            nb = [e.other_vert(v).co for e in v.link_edges]
            if len(nb) < 3:
                continue
            avg = sum(nb, Vector()) / len(nb)
            w = 0.5 * (1.0 - abs(v.co.z - NECK_CUT_Z) / 0.016)
            new[v] = v.co + (avg - v.co) * w
        for v, co in new.items():
            v.co = co
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    C.bm_to(bm, ob)
    # outward normals: check against the head centre
    me = ob.data
    hc = Vector((0.0, 0.0, 1.68))
    out = sum(p.normal.dot(p.center - hc) * p.area for p in me.polygons if p.center.z > 1.62)
    if out < 0:
        me.flip_normals()
    ext = list(range(n_head_faces, len(me.polygons)))
    C.assign_all(ob, 'Skin')
    C.shade_smooth(ob)
    return ob, ext


def sculpt_neck(ob):
    """Sternocleidomastoid ridges (mastoid behind the ear -> sternal notch) and a hint of the
    trapezius edge, displaced along the normals of the MakeHuman neck."""
    me = ob.data
    me.update()
    for v in me.vertices:
        p = v.co
        if p.z > 1.66 or p.z < 1.40:
            continue
        off = 0.0
        for s in (1.0, -1.0):
            a = Vector((s * 0.058, 0.012, 1.650))           # mastoid
            b = Vector((s * 0.014, -0.050, 1.470))          # sternal head
            ab = b - a
            t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
            d = (p - (a + ab * t)).length
            # the muscle belly is thickest in the middle, a groove runs just behind it
            prof = math.sin(math.pi * t) ** 0.6
            off += 0.0032 * prof * math.exp(-(d / 0.011) ** 2) - 0.0012 * prof * math.exp(-((d - 0.017) / 0.006) ** 2)
        v.co = p + v.normal * off
    me.update()


# ------------------------------------------------------------------ eyes
def build_eyes():
    """Eyeballs with a corneal bulge; UVs: front planar projection (iris centred at 0.5,0.5)."""
    objs = []
    for side, (c, r) in eye_spheres().items():
        r = r * 0.97
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=1.0)
        # pole axis along -Y (gaze)
        R = Matrix.Rotation(math.radians(90), 3, 'X')
        for v in bm.verts:
            d = R @ v.co              # z-pole -> -y
            d = Vector((d.x, d.y, d.z))
            front = max(0.0, -d.y)
            # cornea: verts within ~25 deg of the gaze axis bulge out
            ang = math.degrees(math.acos(min(1.0, front)))
            bulge = 1.0 + 0.10 * max(0.0, 1.0 - ang / 30.0) ** 1.6
            v.co = c + d * r * bulge
        me = bpy.data.meshes.new('Eye_' + side)
        bm.to_mesh(me)
        bm.free()
        ob = C.link(bpy.data.objects.new('Eye_' + side, me))
        uv = me.uv_layers.new(name='UVMap')
        for poly in me.polygons:
            for li in poly.loop_indices:
                p = me.vertices[me.loops[li].vertex_index].co - c
                d = p.normalized()
                # azimuthal projection around the gaze axis, front magnified: rr = 0.5 (ang/pi)^0.6
                ang = math.acos(max(-1.0, min(1.0, -d.y)))
                phi = math.atan2(d.z, d.x)
                rr = 0.5 * (ang / math.pi) ** 0.6
                uv.data[li].uv = (0.5 + rr * math.cos(phi), 0.5 + rr * math.sin(phi))
        C.assign_all(ob, 'Eyes')
        C.shade_smooth(ob)
        import golfer_tex as TX
        TX.set_part(ob, C.PART['eye'])
        objs.append(ob)
    return objs


# ------------------------------------------------------------------ skull proxy for hair/hats
def skull_proxy(head_ob):
    """Copy of the head with the ears pressed flat against the skull and the nose removed;
    used to cast hair and hat shells."""
    me = head_ob.data.copy()
    ob = C.link(bpy.data.objects.new('SkullProxy', me))
    s, crown = mh_frame()
    for v in me.vertices:
        p = v.co
        # ears: lateral bulge beyond the parietal plane in the ear band
        if 1.60 < p.z < 1.76 and -0.03 < p.y < 0.07:
            lim = 0.0705 + 0.004 * max(0.0, (p.z - 1.70) / 0.06)
            if abs(p.x) > lim:
                p.x = math.copysign(lim, p.x)
    return ob


# ------------------------------------------------------------------ eyelashes
LASH_GROUPS = (('helper-l-eyelashes-2', 'L', 'upper'), ('helper-l-eyelashes-1', 'L', 'lower'),
               ('helper-r-eyelashes-2', 'R', 'upper'), ('helper-r-eyelashes-1', 'R', 'lower'))


def build_lashes():
    """Lash cards from the MakeHuman eyelash helpers (Lashes material, alpha-masked).
    UV: one horizontal band per strip in the Lashes atlas, u = inner -> outer corner,
    v = root (0) -> tip (1) within the band."""
    V, VT, G = _parse()
    eyes = eye_spheres()
    objs = []
    for b, (grp, side, which) in enumerate(LASH_GROUPS):
        faces = [vi for vi, ti in G[grp]]
        used = sorted({i for f in faces for i in f})
        remap = {o: n for n, o in enumerate(used)}
        P = to_golfer(V[used])
        me = bpy.data.meshes.new('Lash')
        me.from_pydata([tuple(p) for p in P], [], [[remap[i] for i in f] for f in faces])
        me.update()
        ob = C.link(bpy.data.objects.new('Lash', me))
        c, r = eyes[side]
        xs = P[:, 0] * (1 if side == 'L' else -1)
        along = (xs - xs.min()) / max(xs.max() - xs.min(), 1e-6)
        dist = np.linalg.norm(P - np.array(c), axis=1)
        out = (dist - dist.min()) / max(dist.max() - dist.min(), 1e-6)
        uv = me.uv_layers.new(name='UVMap')
        v0 = b * 0.25 + 0.01
        for poly in me.polygons:
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                uv.data[li].uv = (0.02 + 0.96 * along[vi], v0 + 0.23 * out[vi])
        C.assign_all(ob, 'Lashes')
        objs.append(ob)
    lash = C.join(objs, 'Lashes')
    C.shade_smooth(lash)
    import golfer_tex as TX
    TX.set_part(lash, C.PART['lash'])
    return lash
