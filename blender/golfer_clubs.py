"""Six golf clubs, each a separate mesh parented to the Club bone.

Clubs are built in an "address frame" A (metres, Z up, sole on z=0, square face
normal +X, toe toward -Y, shaft rising toward +Y at the lie angle and hitting
the ground at the origin), then mapped into the Club bone frame:
  origin = grip point between the hands (GRIP_FROM_BUTT below the butt end),
  Y = down the shaft toward the head, Z = square face normal.
Connection map:
  hosel top            <-> shaft tip     overlap 0.02 along shaft
  shaft butt           <-> grip          grip sleeve covers top 0.27 m of shaft
  grip centre (radius 0.0115) sits inside both hands (hand channel radius 0.0125)
"""
import math
import bpy
import bmesh
from mathutils import Vector, Matrix

import golfer_common as C
import golfer_ai_clubs as AIC
from golfer_skeleton import club_rest_matrix

# detailed Artlist-generated heads (public/models/ai/*.glb) registered onto the procedural ones
USE_AI_HEADS = True

INCH = 0.0254
GRIP_FROM_BUTT = 0.110
GRIP_LEN = 0.27

CLUBS = {
    #            length,     lie,  loft
    'Driver': (45.5 * INCH, 58.0, 10.5),
    'Wood':   (42.0 * INCH, 57.0, 15.0),
    'Hybrid': (42.0 * INCH, 57.0, 21.0),
    'Iron':   (38.0 * INCH, 62.5, 33.0),
    'Wedge':  (35.5 * INCH, 64.0, 56.0),
    'Putter': (34.0 * INCH, 70.0, 3.0),
}


def shaft_dir(lie_deg):
    a = math.radians(lie_deg)
    return Vector((0.0, math.cos(a), math.sin(a)))      # head -> grip


def A_to_bone(name):
    """Matrix mapping address-frame coordinates to Club-bone-local coordinates."""
    L, lie, loft = CLUBS[name]
    u = shaft_dir(lie)
    G = u * (L - GRIP_FROM_BUTT)
    yb = -u
    zb = Vector((1, 0, 0))
    xb = yb.cross(zb)
    M = C.frame_matrix(G, xb, yb, zb)          # bone-local -> A
    return M.inverted()


def face_center_A(name):
    return FACE_CENTERS[name]


def face_center_local(name):
    return A_to_bone(name) @ FACE_CENTERS[name]


def face_normal_local(name):
    """Actual (lofted) face normal in bone-local coordinates."""
    loft = math.radians(CLUBS[name][2])
    nA = Vector((math.cos(loft), 0.0, math.sin(loft)))
    return (A_to_bone(name).to_3x3() @ nA).normalized()


def sole_point_local(name):
    """Point on the sole directly under the face centre (ground contact)."""
    fc = FACE_CENTERS[name]
    return A_to_bone(name) @ Vector((fc.x - 0.01, fc.y, 0.0))


FACE_CENTERS = {}
HEAD_POINTS = {}      # club head vertices in the address frame (for ground contact)
HEEL_Y = {'Iron': -0.012, 'Wedge': -0.012, 'Putter': -0.004}


# ---------------------------------------------------------------- wood-type heads
def _wood_head(name, back, face_x, toe, heel, top, loft, segs=28, rings=14):
    cx = (back + face_x) * 0.5 - 0.004
    ax_f, ax_b = face_x + 0.026 - cx, cx - back
    cy, ay = (toe + heel) * 0.5, (heel - toe) * 0.5
    cz = top * 0.48
    az_u, az_d = top - cz, cz
    tl = math.tan(math.radians(loft))
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    face_verts = set()
    for v in bm.verts:
        sx, sy, sz = v.co
        x = cx + sx * (ax_f if sx > 0 else ax_b)
        # pear shape: heel side narrower toward the back
        y = cy + sy * ay * (1.0 - 0.18 * max(0.0, -sx) * (1 if sy > 0 else 0.4))
        crown = az_u * (1.0 - 0.28 * max(0.0, -sx))
        z = cz + sz * (crown if sz > 0 else az_d)
        z = max(z, 0.0015)
        fx = face_x - (z - cz) * tl
        if x > fx:
            x = fx
            face_verts.add(v.index)
        v.co = Vector((x, y, z))
    flat = [v.co.copy() for v in bm.verts if v.index in face_verts]
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = C.link(bpy.data.objects.new(name, me))
    C.assign_all(ob, 'ClubHead')
    # face insert: an ellipse inscribed in the flat clipped region, 0.4 mm proud of it
    ys = [v.y for v in flat]
    zs = [v.z for v in flat]
    fy, fz = (min(ys) + max(ys)) * 0.5, (min(zs) + max(zs)) * 0.5
    hy, hz = (max(ys) - min(ys)) * 0.5 * 0.86, (max(zs) - min(zs)) * 0.5 * 0.80
    nrm = Vector((math.cos(math.radians(loft)), 0.0, math.sin(math.radians(loft))))
    ring = []
    for i in range(24):
        a_ = 2 * math.pi * i / 24
        y = fy + hy * math.cos(a_)
        z = fz + hz * math.sin(a_) * (1.0 + 0.12 * math.cos(a_))   # taller toward the toe
        ring.append(Vector((face_x - (z - cz) * tl, y, z)) + nrm * 0.0004)
    verts = ring + [Vector((face_x - (fz - cz) * tl, fy, fz)) + nrm * 0.0004]
    faces = [(i, (i + 1) % 24, 24) for i in range(24)]
    ins = C.new_mesh_obj(name + '_face', verts, faces, 'ClubFace')
    C.recalc_normals(ins)
    if ins.data.polygons[0].normal.dot(nrm) < 0:
        ins.data.flip_normals()
    ob = C.join([ob, ins], name)
    FACE_CENTERS[name.split('_')[1]] = Vector((face_x - (fz - cz) * tl, fy, fz)) + nrm * 0.0004
    return ob, Vector((0.0, heel - 0.016, top * 0.62))


# ---------------------------------------------------------------- iron-type heads
def _iron_head(name, loft, heel_y, toe_y, h_heel, h_toe, sole_w, top_w, lead_x=0.0, putter=False):
    """Face outline in the lofted face plane, extruded back with a cavity."""
    tl = math.radians(loft)
    n_face = Vector((math.cos(tl), 0.0, math.sin(tl)))
    up_face = Vector((-math.sin(tl), 0.0, math.cos(tl)))       # up along the face
    outline = []
    N = 22
    for i in range(N):
        t = i / (N - 1)
        y = heel_y + (toe_y - heel_y) * t
        h = h_heel + (h_toe - h_heel) * t ** 1.4
        if t > 0.8 and not putter:
            k = (t - 0.8) / 0.2
            h *= 1.0 - 0.12 * k * k
        outline.append((y, h))
    # build ring of face outline points: bottom edge heel->toe then top edge toe->heel
    pts2 = [(y, 0.0) for (y, h) in outline]
    toe_round = 6
    yT, hT = outline[-1]
    for j in range(1, toe_round):
        a = math.pi * j / toe_round
        pts2.append((yT - 0.006 * math.sin(a), hT * 0.5 * (1 - math.cos(a))))
    pts2 += [(y, h) for (y, h) in reversed(outline)]
    for j in range(1, 3):
        pts2.append((heel_y + 0.002 * j, (outline[0][1]) * (1 - j / 3)))

    def face_pt(y, w, back=0.0):
        p = Vector((lead_x, y, 0.0)) + up_face * w - n_face * back
        return p

    def depth(w, hmax):
        f = min(1.0, max(0.0, w / max(hmax, 1e-6)))
        return sole_w * (1 - f) ** 1.5 + top_w * f

    front = [face_pt(y, w) for (y, w) in pts2]
    hmax_y = {}
    rim = []
    cav = []
    for (y, w) in pts2:
        t = (y - heel_y) / (toe_y - heel_y)
        hm = h_heel + (h_toe - h_heel) * max(0, min(1, t)) ** 1.4
        rim.append(face_pt(y, w, depth(w, hm)))
    cy = (heel_y + toe_y) * 0.5
    cw = (h_heel + h_toe) * 0.25
    for (y, w), r in zip(pts2, rim):
        yy = cy + (y - cy) * 0.80
        ww = cw + (w - cw) * 0.70
        cav.append(face_pt(yy, ww, (0.004 if not putter else depth(ww, 1.0) * 0.8)))
    floor_c = face_pt(cy, cw, 0.0035 if not putter else 0.01)
    verts = front + rim + cav + [floor_c]
    n = len(pts2)
    faces = [tuple(range(n))[::-1]]  # face plate (normal +n_face after recalc)
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
        faces.append((n + i, n + j, 2 * n + j, 2 * n + i))
        faces.append((2 * n + i, 2 * n + j, 3 * n))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = C.link(bpy.data.objects.new(name, me))
    C.recalc_normals(ob)
    C.assign_all(ob, 'ClubHead')
    fi = C.add_material(ob, 'ClubFace')
    ob.data.polygons[0].material_index = fi
    # triangulate the n-gon face plate for clean export
    bm = C.bm_from(ob)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    C.bm_to(bm, ob)
    key = name.split('_')[1]
    fc_y = heel_y + (toe_y - heel_y) * 0.52
    FACE_CENTERS[key] = face_pt(fc_y, (h_heel + h_toe) * 0.5 * 0.45) + n_face * 0.0005
    hosel_base = face_pt(heel_y + 0.004, h_heel * 0.8, sole_w * 0.4)
    return ob, hosel_base


# ---------------------------------------------------------------- shaft, hosel, grip
def _tube(name, a, b, r0, r1, sides, mat, cap_end=False):
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    ref = Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 0, 1))
    u = ref.cross(d).normalized()
    w = d.cross(u)
    rings = []
    for c, r in ((a, r0), (b, r1)):
        rings.append([c + (u * math.cos(2 * math.pi * i / sides) + w * math.sin(2 * math.pi * i / sides)) * r
                      for i in range(sides)])
    return C.loft(name, rings, closed_start=True, closed_end=cap_end, mat=mat)


def build_club(name):
    L, lie, loft = CLUBS[name]
    u = shaft_dir(lie)
    full = 'Club_' + name
    if name == 'Driver':
        head, hosel_top = _wood_head(full, back=-0.098, face_x=0.024, toe=-0.124, heel=-0.004, top=0.062, loft=loft)
    elif name == 'Wood':
        head, hosel_top = _wood_head(full, back=-0.078, face_x=0.016, toe=-0.104, heel=-0.004, top=0.040, loft=loft,
                                     segs=24, rings=12)
    elif name == 'Hybrid':
        head, hosel_top = _wood_head(full, back=-0.058, face_x=0.014, toe=-0.098, heel=-0.006, top=0.037, loft=loft,
                                     segs=24, rings=12)
    elif name == 'Iron':
        head, hosel_top = _iron_head(full, loft, heel_y=-0.012, toe_y=-0.078, h_heel=0.036, h_toe=0.050,
                                     sole_w=0.020, top_w=0.007)
    elif name == 'Wedge':
        head, hosel_top = _iron_head(full, loft, heel_y=-0.012, toe_y=-0.076, h_heel=0.044, h_toe=0.060,
                                     sole_w=0.026, top_w=0.007)
    else:
        head, hosel_top = _iron_head(full, loft, heel_y=-0.004, toe_y=-0.110, h_heel=0.026, h_toe=0.026,
                                     sole_w=0.022, top_w=0.016, lead_x=0.004, putter=True)
    wood = name in ('Driver', 'Wood', 'Hybrid')
    # slide the head along Y so it meets the shaft axis (which hits the ground at the origin)
    if wood:
        dy = hosel_top.z * u.y / u.z - hosel_top.y
    else:
        dy = -0.004 - HEEL_Y[name]
    head.data.transform(Matrix.Translation((0.0, dy, 0.0)))
    FACE_CENTERS[name] = FACE_CENTERS[name] + Vector((0.0, dy, 0.0))
    base = hosel_top + Vector((0.0, dy, 0.0))
    if not wood:
        base = Vector((0.0 if name != 'Putter' else -0.004, -0.001, 0.004 if name != 'Putter' else 0.018))
    hosel_len = 0.075 if name in ('Iron', 'Wedge') else (0.040 if wood else 0.055)
    top = u * (base.dot(u) + hosel_len)
    hosel = _tube(full + '_hosel', base, top, 0.0098 if name != 'Putter' else 0.0075, 0.0068, 12, 'ClubHead',
                  cap_end=True)
    # shaft (tapered) from hosel to butt
    shaft = _tube(full + '_shaft', top - u * 0.02, u * (L - 0.004), 0.0045, 0.0076, 10, 'Shaft', cap_end=True)
    # grip: tapered sleeve with rounded butt
    g_r_top, g_r_bot = (0.0122, 0.0100) if name != 'Putter' else (0.0135, 0.0118)
    rings = []
    sides = 16
    ref = Vector((1, 0, 0))
    uu = ref.cross(u).normalized()
    ww = u.cross(uu)
    prof = [(L - GRIP_LEN, g_r_bot * 0.92), (L - GRIP_LEN + 0.01, g_r_bot), (L - 0.12, g_r_bot + (g_r_top - g_r_bot) * 0.55),
            (L - 0.01, g_r_top), (L - 0.002, g_r_top * 0.85), (L, g_r_top * 0.45)]
    for s_, r in prof:
        c = u * s_
        rings.append([c + (uu * math.cos(2 * math.pi * i / sides) + ww * math.sin(2 * math.pi * i / sides)) * r
                      for i in range(sides)])
    grip = C.loft(full + '_grip', rings, closed_end=True, mat='Grip')
    C.recalc_normals(grip)
    for o in (hosel, shaft, grip):
        C.shade_smooth(o)
    face_idx = [i for i, m in enumerate(head.data.materials) if m.name == 'ClubFace']
    for p in head.data.polygons:
        p.use_smooth = wood and p.material_index not in face_idx
    HEAD_POINTS[name] = [v.co.copy() for v in head.data.vertices]
    if USE_AI_HEADS:
        head = AIC.replace_head(name, head, base, top,
                                Vector((math.cos(math.radians(loft)), 0.0, math.sin(math.radians(loft)))))
    club = C.join([head, hosel, shaft, grip], full)
    # map A -> bone local -> world rest
    M = club_rest_matrix() @ A_to_bone(name)
    club.data.transform(M)
    return club


def build_clubs():
    return [build_club(n) for n in CLUBS]
