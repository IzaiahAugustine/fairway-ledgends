"""Golf-course props (Blender space, Z up, metres; everything built at the origin).

Connection map (parts that must touch, target overlap >= 5 mm unless noted):
  Flagstick ferrule top (z=0.050)   <-> first band bottom (z=0.050)      shared ring (hard colour edge)
  Flag left edge (x=0)              <-> pole axis (pole radius 6 mm)     flag edge inside the pole
  Cup rim annulus (z=0)             <-> inner/outer walls (z=0..-0.102)  shared rings
  TeeMarker ball (bottom z=0.022)   <-> collar top (z=0.030)             8 mm sunk into the collar
  Tee head / shank / point          single lathe profile                 continuous
  GolfBag base (local z 0..0.085)   <-> body (local z 0.06..0.86)        25 mm overlap
  GolfBag body top (local z 0.86)   <-> cuff (local z 0.82..0.91)        40 mm overlap
  Club shafts (start local z 0.70)  <-> inside cuff (opening r 0.108)    shafts start 120+ mm inside
  Leg tops (hinge)                  <-> body back surface                start 10 mm inside the body
  Leg feet                          <-> ground z=0
  Bench seat slats (z 0.422..0.458) <-> frame seat rails (top z 0.43)    8 mm
  Bench back slats                  <-> rear uprights                    slats start inside the uprights
  Bench legs bottom                 <-> ground z=0
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

from env_mesh import MeshAccum, unit, new_empty, smoothstep, any_perp

X3 = np.array([1.0, 0, 0])
Y3 = np.array([0, 1.0, 0])
Z3 = np.array([0, 0, 1.0])


def _bounds(acc):
    v = np.array(acc.verts)
    return v.min(0), v.max(0)


# ---------------------------------------------------------------------------
# flag, flagstick, cup, tee marker, tee

def flagstick():
    acc = MeshAccum()
    R, sides = 0.006, 12
    white, grey = (0.97, 0.97, 0.97), (0.80, 0.80, 0.79)
    acc.disk((0, 0, 0), (0, 0, -1), 0.0065, sides, (0.35, 0.35, 0.36))
    acc.lathe([(0.0065, 0.0), (0.0065, 0.05)], sides, col_fn=lambda r, z: (0.35, 0.35, 0.36))
    z, k = 0.05, 0
    top = 2.12
    while z < top - 1e-6:
        z1 = min(z + 0.25, top)
        c = white if k % 2 == 0 else grey
        acc.lathe([(R, z), (R, z1)], sides, col_fn=lambda r, zz, c=c: c)
        z, k = z1, k + 1
    acc.lathe([(R, top), (0.0047, top + 0.0065), (0.0, top + 0.01)], sides, col_fn=lambda r, zz: white)
    return acc


def flag():
    acc = MeshAccum()
    nx, nz = 12, 8
    W, H, z0 = 0.50, 0.36, 1.75
    idx = {}
    for j in range(nz + 1):
        for i in range(nx + 1):
            idx[i, j] = acc.add_vert((W * i / nx, 0.0, z0 + H * j / nz), (1, 1, 1), (0, -1, 0))
    for j in range(nz):
        for i in range(nx):
            a, b, c, d = idx[i, j], idx[i + 1, j], idx[i + 1, j + 1], idx[i, j + 1]
            acc.add_face((a, b, c, d), [(i / nx, j / nz), ((i + 1) / nx, j / nz),
                                        ((i + 1) / nx, (j + 1) / nz), (i / nx, (j + 1) / nz)])
    return acc


def cup():
    acc = MeshAccum()
    Ri, Ro, D, sides = 0.054, 0.0585, 0.102, 24
    acc.disk((0, 0, 0), (0, 0, 1), Ro, sides, (0.95, 0.95, 0.95), r_inner=Ri)
    # inner wall faces inward (profile runs downward); AO darkens with depth
    acc.lathe([(Ri, 0.0), (Ri, -0.03), (Ri, -0.065), (Ri, -D)], sides,
              col_fn=lambda r, z: (lambda a: (a, a, a))(0.95 - 0.45 * (-z / D) ** 1.3))
    acc.disk((0, 0, -D), (0, 0, 1), Ri, sides, (0.06, 0.055, 0.05), r_inner=0.012)
    acc.disk((0, 0, -D), (0, 0, 1), 0.012, 12, (0.015, 0.015, 0.015))
    acc.lathe([(Ro, -D), (Ro, 0.0)], sides, col_fn=lambda r, z: (0.85, 0.85, 0.85))
    acc.disk((0, 0, -D - 0.0005), (0, 0, -1), Ro, sides, (0.5, 0.5, 0.5))
    return acc


def tee_marker():
    acc = MeshAccum()
    acc.lathe([(0.0, 0.0), (0.044, 0.0), None, (0.044, 0.0), (0.043, 0.012), (0.036, 0.030), None,
               (0.036, 0.030), (0.028, 0.030), (0.026, 0.026)], 24)
    rb, cz = 0.064, 0.086  # ball sits 8 mm into the collar; top at 0.150
    prof = [(rb * math.cos(math.radians(a)), cz + rb * math.sin(math.radians(a))) for a in range(-90, 91, 12)]
    prof[0] = (0.0, prof[0][1])
    prof[-1] = (0.0, prof[-1][1])
    acc.lathe(prof, 24)
    return acc


def tee():
    acc = MeshAccum()
    prof = [(0.0, -0.029), (0.0009, -0.0272), (0.0020, -0.0215), (0.0022, 0.004), (0.0026, 0.012),
            (0.0040, 0.0185), (0.0058, 0.0232), (0.0062, 0.0250), None,
            (0.0062, 0.0250), (0.0050, 0.0250), (0.0030, 0.0236), (0.0, 0.0230)]
    acc.lathe(prof, 12)
    return acc


# ---------------------------------------------------------------------------
# golf stand bag

def golf_bag():
    rng = np.random.default_rng(42)
    tilt = math.radians(12)
    A = np.array([0.0, math.sin(tilt), math.cos(tilt)])       # bag axis (leans back toward +Y)
    B = np.array([0.0, math.cos(tilt), -math.sin(tilt)])      # "back" (legs side)
    O = np.array([0.0, 0.0, 0.125 * math.sin(tilt)])          # back-bottom edge touches z=0
    frame = (O, X3, B, A)

    def L(x, y, z):  # bag-local -> world
        return O + X3 * x + B * y + A * z

    body, trim, grip, club = MeshAccum(), MeshAccum(), MeshAccum(), MeshAccum()
    # body + ball pocket (Bag)
    body.lathe([(0.118, 0.06), (0.119, 0.25), (0.120, 0.50), (0.121, 0.70), (0.122, 0.86)], 20, frame=frame)
    pk = (L(0, -0.095, 0), X3, B, A)
    pocket = MeshAccum()
    pocket.lathe([(0.0, 0.17), (0.05, 0.172), (0.064, 0.185), (0.068, 0.30), (0.068, 0.44), (0.064, 0.505),
                  (0.05, 0.518), (0.0, 0.52)], 16, frame=pk)
    # flatten the pocket front-to-back so it reads as a sewn pocket, not a cylinder
    c = L(0, -0.095, 0)
    pocket.verts = [tuple(c + (np.array(v) - c) - B * np.dot(np.array(v) - c, B) * 0.5) for v in pocket.verts]
    _merge(body, pocket)
    # long apparel pocket on the right side, flattened sideways
    side = MeshAccum()
    cs = L(0.097, 0.0, 0)
    side.lathe([(0.0, 0.22), (0.05, 0.222), (0.066, 0.24), (0.07, 0.36), (0.07, 0.56), (0.066, 0.64),
                (0.05, 0.655), (0.0, 0.657)], 16, frame=(cs, B, -X3, A))
    side.verts = [tuple(cs + (np.array(v) - cs) - X3 * np.dot(np.array(v) - cs, X3) * 0.55) for v in side.verts]
    _merge(body, side)
    # base, cuff, inner floor, dividers (BagTrim)
    trim.lathe([(0.0, 0.0), (0.118, 0.0), (0.125, 0.012), (0.125, 0.080), (0.119, 0.088)], 20, frame=frame)
    trim.lathe([(0.119, 0.82), (0.128, 0.832), (0.129, 0.895), (0.121, 0.91), (0.110, 0.905), (0.108, 0.86),
                (0.108, 0.80)], 20, frame=frame)
    trim.disk(L(0, 0, 0.80), A, 0.109, 20, frame_x=X3)
    for ang in (0.0, math.pi / 2):
        ax = X3 * math.cos(ang) + B * math.sin(ang)
        trim.obox(L(0, 0, 0.88), (ax, np.cross(A, ax), A), (0.108, 0.003, 0.022))
    # decorative band + zippers on both pockets
    trim.lathe([(0.1205, 0.595), (0.1245, 0.60), (0.1245, 0.625), (0.1205, 0.63)], 20, frame=frame)
    trim.obox(L(0.045, -0.1205, 0.345), (X3, B, A), (0.0035, 0.0045, 0.15))
    trim.obox(L(0.1265, -0.045, 0.44), (X3, B, A), (0.0045, 0.0035, 0.19))
    # shoulder strap loop on the back
    strap = [L(0.0, 0.118, 0.72), L(0.0, 0.17, 0.62), L(0.0, 0.19, 0.48), L(0.0, 0.17, 0.34), L(0.0, 0.118, 0.26)]
    trim.tube(strap, [0.012] * 5, 6, ring_fn=lambda i, th: 0.55 + 0.45 * abs(math.cos(th)))
    # legs from the hinge on the upper back to the ground behind
    for s in (-1, 1):
        hinge = L(s * 0.055, 0.105, 0.60)
        foot = np.array([s * 0.21, 0.52, 0.012])
        trim.tube([hinge, hinge + (foot - hinge) * 0.5, foot], [0.0085, 0.008, 0.0075], 6)
        trim.obox(L(s * 0.055, 0.118, 0.60), (X3, B, A), (0.014, 0.012, 0.02))
        grip.lathe([(0.0, 0.0), (0.012, 0.0), (0.012, 0.03), (0.0085, 0.04)], 8,
                   frame=(foot - unit(foot - hinge) * 0.012 + np.array([0, 0, -0.012]), X3, Y3, Z3))
    # carry handle on the side (Grip)
    hpts = [L(-0.118, 0.0, 0.62), L(-0.15, 0.0, 0.66), L(-0.155, 0.0, 0.72), L(-0.15, 0.0, 0.78), L(-0.118, 0.0, 0.82)]
    grip.tube(hpts, [0.014] * 5, 8)

    # clubs: heads up, shafts disappear into the bag
    def shaft_dir(x, y):
        return unit(A + X3 * x * 0.6 + B * y * 0.6 + rng.normal(0, 0.02, 3))

    woods = [(-0.05, 0.055, 0.20), (0.0, 0.07, 0.22), (0.05, 0.055, 0.19)]
    for x, y, h in woods:
        d = shaft_dir(x, y)
        s0 = L(x, y, 0.70)
        top = s0 + d * h
        club.lathe([(0.0055, 0.0), (0.0055, h)], 6, frame=(s0, any_perp(d), np.cross(d, any_perp(d)), d))
        f = (top, any_perp(d), np.cross(d, any_perp(d)), d)
        grip.lathe([(0.0, -0.01), (0.017, -0.005), (0.02, 0.03), (0.042, 0.07), (0.054, 0.11), (0.05, 0.15),
                    (0.032, 0.175), (0.0, 0.183)], 14, frame=f)
    irons = [(-0.07, -0.005), (-0.025, -0.01), (0.02, -0.005), (0.065, 0.0),
             (-0.05, -0.06), (-0.005, -0.065), (0.04, -0.06)]
    for i, (x, y) in enumerate(irons):
        h = 0.16 + 0.012 * i + rng.uniform(-0.01, 0.01)
        d = shaft_dir(x, y)
        s0 = L(x, y, 0.70)
        top = s0 + d * h
        X = any_perp(d)
        club.lathe([(0.0055, 0.0), (0.0055, h), (0.0075, h + 0.03)], 6, frame=(s0, X, np.cross(d, X), d))
        yaw = rng.uniform(0, 2 * math.pi)
        along = unit(X * math.cos(yaw) + np.cross(d, X) * math.sin(yaw))
        along = unit(along + d * 0.4)              # lie angle: toe rises away from the hosel
        hgt = unit(d - along * np.dot(d, along))
        thick = np.cross(hgt, along)
        club.obox(top + d * 0.03 + along * 0.032, (along, thick, hgt), (0.035, 0.005, 0.02))
    # putter
    x, y = 0.085, 0.04
    d = shaft_dir(x, y)
    s0 = L(x, y, 0.70)
    X = any_perp(d)
    club.lathe([(0.0055, 0.0), (0.0055, 0.24)], 6, frame=(s0, X, np.cross(d, X), d))
    club.obox(s0 + d * 0.255 + X * 0.03, (X, np.cross(d, X), d), (0.052, 0.012, 0.016))
    return dict(Bag=body, BagTrim=trim, Grip=grip, ClubHead=club)


def _merge(dst, src):
    base = len(dst.verts)
    dst.verts += src.verts
    dst.cols += src.cols
    dst.normals += src.normals
    dst.uvs += src.uvs
    dst.faces += [tuple(i + base for i in f) for f in src.faces]


# ---------------------------------------------------------------------------
# bench

def bench():
    wood, metal = MeshAccum(), MeshAccum()
    half_len = 0.75
    # seat slats (front = -Y)
    for y in (-0.135, 0.0, 0.135):
        wood.box((0, y, 0.44), (half_len, 0.058, 0.018))
    # back slats, reclined 15 degrees
    rec = math.radians(15)
    up_b = np.array([0, math.sin(rec), math.cos(rec)])
    fwd_b = np.array([0, math.cos(rec), -math.sin(rec)])
    for s in (0.20, 0.36):
        c = np.array([0, 0.205, 0.47]) + up_b * s
        wood.obox(c, (X3, fwd_b, up_b), (half_len, 0.016, 0.055))
    hw = 0.02
    for x in (-0.62, 0.62):
        metal.beam((x, -0.17, 0.0), (x, -0.17, 0.43), hw, 0.008, (0, 1, 0))           # front leg
        metal.beam((x, 0.17, 0.0), (x, 0.205, 0.43), hw, 0.008, (0, 1, 0))            # rear leg
        top = np.array([x, 0.205, 0.47]) + up_b * 0.46
        metal.beam((x, 0.205 + 0.0, 0.40), tuple(top + fwd_b * 0.02), hw, 0.008, (1, 0, 0))  # back upright
        metal.beam((x, -0.20, 0.41), (x, 0.215, 0.41), 0.008, hw, (1, 0, 0))          # seat rail
        metal.beam((x, -0.21, 0.645), (x, 0.24, 0.66), 0.03, 0.01, (0, 0, 1))         # armrest
        metal.beam((x, -0.18, 0.40), (x, -0.185, 0.645), hw * 0.8, 0.008, (0, 1, 0))  # arm post
        for y in (-0.17, 0.17):
            metal.box((x, y, 0.006), (0.03, 0.04, 0.006))                              # feet
    metal.beam((-0.62, 0.0, 0.12), (0.62, 0.0, 0.12), 0.012, 0.012, (0, 0, 1))         # stretcher
    return dict(Wood=wood, Metal=metal)


# ---------------------------------------------------------------------------
# rocks

def rock(name, radii, seed, n_planes, ratio, coll, mat):
    rng = np.random.default_rng(seed)
    R = np.array(radii, float)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=5, radius=1.0)
    planes = []
    for k in range(n_planes):
        n = rng.normal(size=3)
        n[2] = abs(n[2]) * 0.8 + 0.1 if k < n_planes // 2 else n[2] * 0.5
        planes.append((unit(n), rng.uniform(0.66, 0.88)))
    strata = unit(rng.normal(size=3) * np.array([0.3, 0.3, 1.0]))
    off = Vector((seed * 3.1, seed * 1.7, seed * 2.3))
    ks = 0.03
    for v in bm.verts:
        q = unit(np.array(v.co))
        rs = [1.0] + [d / max(np.dot(q, n), 1e-3) for n, d in planes if np.dot(q, n) > 0.05]
        r = -ks * math.log(sum(math.exp(-ri / ks) for ri in rs))
        p = q * r * R
        pv = Vector(tuple(p / R.mean() * 1.6)) + off
        disp = 0.055 * noise.noise(pv) + 0.02 * noise.noise(pv * 2.7) + 0.006 * noise.noise(pv * 7.3)
        disp += 0.007 * math.sin(55 * float(np.dot(p, strata)))
        # thin grooves where a noise field crosses zero -> joints / cracks in the stone
        crack = abs(noise.noise(pv * 1.9 + Vector((4.2, 1.1, 7.7))))
        disp -= 0.022 * max(0.0, 1.0 - crack * 10.0)
        p = p + q * disp * R.mean()
        v.co = Vector(tuple(p))
    zs = [v.co.z for v in bm.verts]
    cut = min(zs) + (max(zs) - min(zs)) * 0.16
    for v in bm.verts:
        if v.co.z < cut:
            v.co.z = cut + (v.co.z - cut) * 0.12
    zmin = min(v.co.z for v in bm.verts)
    for v in bm.verts:
        v.co.z -= zmin
    me = bpy.data.meshes.new(name + "_hi")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    dec = ob.modifiers.new("dec", 'DECIMATE')
    dec.ratio = ratio
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear()
    ob.data = me2
    bpy.data.meshes.remove(me)
    me2.name = name
    # re-ground after decimation, then UVs (box projection, metres) + AO/tint colours
    bm = bmesh.new()
    bm.from_mesh(me2)
    zmin = min(v.co.z for v in bm.verts)
    for v in bm.verts:
        v.co.z -= zmin
    bm.normal_update()
    uvl = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            co = l.vert.co
            l[uvl].uv = (co.y, co.z) if ax == 0 else ((co.x, co.z) if ax == 1 else (co.x, co.y))
    col = bm.verts.layers.float_color.new("Col")
    height = max(v.co.z for v in bm.verts)
    for v in bm.verts:
        nb = [e.other_vert(v).co for e in v.link_edges]
        if nb:
            avg = sum(nb, Vector()) / len(nb)
            el = sum((x - v.co).length for x in nb) / len(nb)
            conc = (avg - v.co).dot(v.normal) / max(el, 1e-6)
        else:
            conc = 0.0
        ao = min(1.0, max(0.45, 1.0 - 2.6 * max(conc, 0.0) + 0.3 * max(-conc, 0.0)))
        ao *= 0.72 + 0.28 * smoothstep(0.0, 0.3 * height, v.co.z)
        t = noise.noise(v.co * 1.3 + off) * 0.07
        v[col] = (ao * (1 + t), ao * (1 + t * 0.6), ao * (1 - t * 0.3), 1.0)
    bm.to_mesh(me2)
    bm.free()
    me2.color_attributes.active_color = me2.color_attributes["Col"]
    me2.color_attributes.render_color_index = me2.color_attributes.active_color_index
    me2.shade_smooth()
    me2.materials.append(mat)
    return ob


# ---------------------------------------------------------------------------

def build_props(scene, asset_collection, simple_material):
    mats = {
        "Flagstick": simple_material("Flagstick", (1.0, 1.0, 1.0), rough=0.32, vcol=True),
        "Flag": simple_material("Flag", (1.0, 0.80, 0.02), rough=0.85, double=True, spec=0.3),
        "Cup": simple_material("Cup", (1.0, 1.0, 1.0), rough=0.4, vcol=True, double=True),
        "TeeMarker": simple_material("TeeMarker", (0.92, 0.92, 0.90), rough=0.35),
        "TeePeg": simple_material("TeePeg", (0.62, 0.45, 0.26), rough=0.6),
        "Bag": simple_material("Bag", (0.06, 0.11, 0.30), rough=0.55),
        "BagTrim": simple_material("BagTrim", (0.03, 0.03, 0.035), rough=0.6),
        "Grip": simple_material("Grip", (0.02, 0.02, 0.02), rough=0.9, spec=0.3),
        "ClubHead": simple_material("ClubHead", (0.62, 0.62, 0.64), rough=0.3, metal=1.0),
        "Rock": simple_material("Rock", (0.15, 0.14, 0.125), rough=0.9, vcol=True),
        "Wood": simple_material("Wood", (0.20, 0.115, 0.055), rough=0.7),
        "Metal": simple_material("Metal", (0.04, 0.07, 0.05), rough=0.45, metal=0.6),
    }
    report = {}

    def single(name, acc, mat, colors=False):
        coll = asset_collection(scene, name)
        ob = acc.to_object(name, mats[mat], coll, colors=colors)
        lo, hi = _bounds(acc)
        report[name] = dict(tris=acc.tri_count(), lo=lo, hi=hi)
        print(f"[props] {name}: {acc.tri_count()} tris  X[{lo[0]:.4f},{hi[0]:.4f}] "
              f"Y[{lo[1]:.4f},{hi[1]:.4f}] Z[{lo[2]:.4f},{hi[2]:.4f}]")
        return ob

    def multi(name, parts, colors=False):
        coll = asset_collection(scene, name)
        root = new_empty(name, coll, 0.3)
        tris = 0
        lo, hi = np.full(3, 1e9), np.full(3, -1e9)
        for mat, acc in parts.items():
            suffix = {"Bag": "Bag", "BagTrim": "Trim", "Grip": "Grip", "ClubHead": "Clubs"}.get(mat, mat)
            acc.to_object(f"{name}_{suffix}", mats[mat], coll, parent=root, colors=colors)
            tris += acc.tri_count()
            l, h = _bounds(acc)
            lo, hi = np.minimum(lo, l), np.maximum(hi, h)
            print(f"[props]   {name}_{suffix}: {acc.tri_count()} tris Z[{l[2]:.3f},{h[2]:.3f}]")
        report[name] = dict(tris=tris, lo=lo, hi=hi)
        print(f"[props] {name}: {tris} tris  X[{lo[0]:.3f},{hi[0]:.3f}] Y[{lo[1]:.3f},{hi[1]:.3f}] "
              f"Z[{lo[2]:.3f},{hi[2]:.3f}]")

    single("Flagstick", flagstick(), "Flagstick", colors=True)
    single("Flag", flag(), "Flag")
    single("Cup", cup(), "Cup", colors=True)
    single("TeeMarker", tee_marker(), "TeeMarker")
    single("Tee", tee(), "TeePeg")
    multi("GolfBag", golf_bag())
    multi("Bench", bench())
    for name, radii, seed, planes, ratio in (("Rock_A", (0.78, 0.62, 0.58), 5, 13, 0.32),
                                             ("Rock_B", (0.42, 0.34, 0.30), 9, 11, 0.18)):
        coll = asset_collection(scene, name)
        ob = rock(name, radii, seed, planes, ratio, coll, mats["Rock"])
        vs = np.array([v.co[:] for v in ob.data.vertices])
        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        report[name] = dict(tris=tris, lo=vs.min(0), hi=vs.max(0))
        print(f"[props] {name}: {tris} tris dims {vs.max(0) - vs.min(0)}")
    return report
