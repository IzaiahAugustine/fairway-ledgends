"""Rig the photoreal golfer scan (Artlist, image-to-3D) to the game's golfer skeleton.

    blender --background --factory-startup --python blender/import_golfer_scan.py -- <scan.glb>

Reads public/models/golfer.glb for the skeleton and its skinned body, then:
  1. stands the scan on the ground at the golfer's height, facing -Y like the rig
  2. swings the scan's arms onto the rig's rest pose (the scan's A-pose is never exactly 42 deg):
     the golfer's arms are posed to match the scan, weights copied across, and the inverse pose
     applied to the scan
  3. copies the golfer body's skin weights onto the scan (nearest surface), smoothed, 4 per vertex
  4. splits the single scanned material into the ones the game tints (Shirt, Pants, Shoes) and
     ones it leaves alone (ScanSkin: face, hair, arms; ScanBelt; Glove)
Writes public/models/golfer_scan.glb: the skinned mesh "Golfer_Scan" on the same bones, no
animations. The game rebinds it to the golfer's own skeleton by bone name.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GOLFER = os.path.join(ROOT, "public", "models", "golfer.glb")
OUT = os.path.join(ROOT, "public", "models", "golfer_scan.glb")
SRC = sys.argv[sys.argv.index("--") + 1]
TRIS = 40000


def select_only(*objs):
    bpy.ops.object.mode_set(mode='OBJECT') if bpy.context.object and bpy.context.object.mode != 'OBJECT' else None
    for o in bpy.data.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]


def world_verts(o):
    M = o.matrix_world
    return np.array([(M @ v.co)[:] for v in o.data.vertices])


# --- the golfer: skeleton + skinned body in rest pose
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GOLFER)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
body = bpy.data.objects["Golfer_Body"]
for o in list(bpy.data.objects):
    if o not in (arm, body):
        bpy.data.objects.remove(o, do_unlink=True)
if arm.animation_data:
    arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
AW = arm.matrix_world


def joint(bone, end='head'):
    b = arm.data.bones[bone]
    return AW @ (b.head_local if end == 'head' else b.tail_local)


body_v = world_verts(body)
H = body_v[:, 2].max()

# --- the scan: one mesh, transforms applied
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=SRC)
new = [o for o in bpy.data.objects if o not in before]
meshes = [o for o in new if o.type == 'MESH']
select_only(*meshes)
if len(meshes) > 1:
    bpy.ops.object.join()
scan = bpy.context.view_layer.objects.active
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in new:
    if o != scan and o.name in bpy.data.objects:
        bpy.data.objects.remove(o, do_unlink=True)
scan.name = "Golfer_Scan"
scan.data.name = "Golfer_Scan"

# stand it up at the golfer's height, centred over the rig
sv = world_verts(scan)
s = H / (sv[:, 2].max() - sv[:, 2].min())
torso_s = sv[(sv[:, 2] - sv[:, 2].min()) * s > 1.05]
torso_s = torso_s[(torso_s[:, 2] - sv[:, 2].min()) * s < 1.40]
band = body_v[(body_v[:, 2] > 1.05) & (body_v[:, 2] < 1.40) & (np.abs(body_v[:, 0]) < 0.2)]
cx = (sv[:, 0].max() + sv[:, 0].min()) / 2
cy = np.median(torso_s[np.abs(torso_s[:, 0] - cx) < 0.2 / s][:, 1])
z0 = sv[:, 2].min()
for v in scan.data.vertices:
    x, y, z = v.co
    v.co = ((x - cx) * s, (y - cy) * s + np.median(band[:, 1]), (z - z0) * s)
print(f"[scan] scale {s:.3f}, height {H:.3f}")

# face -Y like the rig: the toes stick out in front of the shins
sv = world_verts(scan)
toes = sv[sv[:, 2] < 0.05][:, 1].mean()
shins = sv[(sv[:, 2] > 0.3) & (sv[:, 2] < 0.5)][:, 1].mean()
if toes > shins:
    for v in scan.data.vertices:
        x, y, z = v.co
        v.co = (-x, -y, z)
    print("[scan] turned round to face -Y")

# fewer triangles
tris0 = sum(len(p.vertices) - 2 for p in scan.data.polygons)
select_only(scan)
if tris0 > TRIS:
    dec = scan.modifiers.new("dec", 'DECIMATE')
    dec.ratio = TRIS / tris0
    bpy.ops.object.modifier_apply(modifier=dec.name)
print(f"[scan] {tris0} -> {sum(len(p.vertices) - 2 for p in scan.data.polygons)} tris")


# --- arms onto the rest pose
def arm_rotations():
    """Per side: the rotation (about the shoulder) taking the rig's arm onto the scan's, and the
    length ratio scan/rig."""
    sv = world_verts(scan)
    out = {}
    for side, sg in (('L', 1.0), ('R', -1.0)):
        sh = joint('UpperArm_' + side)
        wrist = joint('Hand_' + side)
        hand_end = joint('Hand_' + side, 'tail')
        rig_hand = (wrist + hand_end) * 0.5
        sel = sv[(sv[:, 0] * sg > sh.x * sg + 0.07) & (sv[:, 2] > 0.55) & (sv[:, 2] < sh.z + 0.02)]
        d = np.array((rig_hand - sh).normalized())
        proj = (sel - np.array(sh)) @ d
        hand = sel[proj > proj.max() - 0.08]
        scan_hand = Vector(hand.mean(0))
        a, b = (rig_hand - sh), (scan_hand - sh)
        out[side] = (a.rotation_difference(b).to_matrix(), b.length / a.length)
        ang = math.degrees(a.angle(b))
        print(f"[arm {side}] scan hand {tuple(round(c, 3) for c in scan_hand)}, rig hand "
              f"{tuple(round(c, 3) for c in rig_hand)}, off by {ang:.1f} deg, length x{b.length / a.length:.3f}")
    return out


def pose_arms(rot, inverse=False):
    for side, (R, k) in rot.items():
        pb = arm.pose.bones['UpperArm_' + side]
        rest = (AW.to_3x3() @ arm.data.bones['UpperArm_' + side].matrix_local.to_3x3())
        Rw = R.inverted() if inverse else R
        basis = rest.inverted() @ Rw @ rest
        kk = 1.0 / k if inverse else k
        pb.matrix_basis = Matrix.LocRotScale(None, basis.to_quaternion(), Vector((kk, kk, kk)))
    bpy.context.view_layer.update()


def baked_body():
    """The golfer body as posed right now, as a static mesh that keeps its vertex groups."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(body.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    o = bpy.data.objects.new("BodyBaked", me)
    bpy.context.scene.collection.objects.link(o)
    o.matrix_world = body.matrix_world
    for g in body.vertex_groups:
        o.vertex_groups.new(name=g.name)
    return o


def transfer_weights(src):
    select_only(scan)
    for g in list(scan.vertex_groups):
        scan.vertex_groups.remove(g)
    for g in src.vertex_groups:
        scan.vertex_groups.new(name=g.name)
    mod = scan.modifiers.new("dt", 'DATA_TRANSFER')
    mod.object = src
    mod.use_vert_data = True
    mod.data_types_verts = {'VGROUP_WEIGHTS'}
    mod.vert_mapping = 'POLYINTERP_NEAREST'
    mod.layers_vgroup_select_src = 'ALL'
    mod.layers_vgroup_select_dst = 'NAME'
    bpy.ops.object.modifier_apply(modifier=mod.name)


rot = arm_rotations()
pose_arms(rot)                       # the golfer's arms where the scan's are
posed = baked_body()
transfer_weights(posed)
bpy.data.objects.remove(posed, do_unlink=True)
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
pose_arms(rot, inverse=True)         # and the scan's arms back where the rig's are
select_only(scan)
am = scan.modifiers.new("arm", 'ARMATURE')
am.object = arm
bpy.ops.object.modifier_apply(modifier=am.name)
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
arm_rotations()                      # should now report ~0 deg

# --- final weights from the rest-pose body
rest_body = baked_body()
transfer_weights(rest_body)
bpy.data.objects.remove(rest_body, do_unlink=True)

# smooth over the mesh (the scan's surface is far denser and lumpier than the body it copied
# from), keep the 4 strongest bones per vertex, normalise
def tidy_weights(o, smooth=0.5, repeat=2, limit=4):
    nv, groups = len(o.data.vertices), list(o.vertex_groups)
    W = np.zeros((nv, len(groups)), dtype=np.float64)
    for v in o.data.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    e = np.array([ed.vertices[:] for ed in o.data.edges])
    deg = np.bincount(e.ravel(), minlength=nv).astype(np.float64)[:, None]
    for _ in range(repeat):
        acc = np.zeros_like(W)
        np.add.at(acc, e[:, 0], W[e[:, 1]])
        np.add.at(acc, e[:, 1], W[e[:, 0]])
        W = np.where(deg > 0, (1 - smooth) * W + smooth * acc / np.maximum(deg, 1), W)
    keep = np.argsort(-W, axis=1)[:, :limit]
    mask = np.zeros_like(W, dtype=bool)
    np.put_along_axis(mask, keep, True, axis=1)
    W = np.where(mask & (W > 1e-4), W, 0.0)
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    for gi, g in enumerate(groups):
        g.remove(list(range(nv)))
        idx = np.nonzero(W[:, gi])[0]
        for i in idx:
            g.add([int(i)], float(W[i, gi]), 'REPLACE')
    unweighted = int((W.sum(1) < 0.5).sum())
    print(f"[scan] weights tidied, {unweighted} vertices without a bone")


tidy_weights(scan)

# --- materials: the game tints Shirt, Pants and Shoes (white in the scan); the rest keep the photo
src_mat = scan.data.materials[0]
bsdf = next(n for n in src_mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
base_img = next(l.from_node.image for l in src_mat.node_tree.links if l.to_node == bsdf and l.to_socket.name == 'Base Color')
w, h = base_img.size
px = np.array(base_img.pixels[:], dtype=np.float32).reshape(h, w, 4)
names = ["ScanSkin", "Shirt", "Pants", "Shoes", "ScanBelt", "Glove"]
mats = []
for i, n in enumerate(names):
    m = src_mat if i == 0 else src_mat.copy()
    m.name = n
    mats.append(m)
scan.data.materials.clear()
for m in mats:
    scan.data.materials.append(m)
uv = scan.data.uv_layers.active.data
wl = joint('Hand_L')
counts = [0] * len(names)
for p in scan.data.polygons:
    u = sum(uv[i].uv[0] for i in p.loop_indices) / p.loop_total
    v = sum(uv[i].uv[1] for i in p.loop_indices) / p.loop_total
    c = px[min(h - 1, max(0, int(v * h))), min(w - 1, max(0, int(u * w))), :3]
    luma = float(c @ np.array([0.2126, 0.7152, 0.0722]))
    sat = float(c.max() - c.min())
    z = p.center.z
    pale = luma > 0.45 and sat < 0.14
    if pale and z < 0.13:
        k = 3
    elif pale and (p.center - wl).length < 0.13:
        k = 5
    elif pale and z > 0.99 and z < 1.6:
        k = 1
    elif pale and z >= 0.13 and z <= 0.99:
        k = 2
    elif 0.9 < z < 1.06 and luma < 0.35 and c[0] > c[2] and abs(p.center.x) < 0.25:
        k = 4
    else:
        k = 0
    p.material_index = k
    counts[k] += 1
print("[scan] faces per material", dict(zip(names, counts)))
for m in mats:
    # the scan doubles the specular level, which makes skin look wet
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Specular IOR Level'].default_value = 0.5
    b.inputs['Specular Tint'].default_value = (1, 1, 1, 1)
for m in mats[1:]:
    # cloth is not metal, whatever the scan says
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    for link in list(m.node_tree.links):
        if link.to_node == b and link.to_socket.name == 'Metallic':
            m.node_tree.links.remove(link)
    b.inputs['Metallic'].default_value = 0.0

# textures: 2K colour (faces need it), 1K for the rest
for img in bpy.data.images:
    target = 2048 if img == base_img else 1024
    if img.size[0] > target:
        img.scale(target, target)

# --- skin it to the armature and export (no animations: the game rebinds to golfer.glb's rig)
bpy.data.objects.remove(body, do_unlink=True)
select_only(scan, arm)
bpy.context.view_layer.objects.active = arm
scan.parent = arm
scan.matrix_parent_inverse = arm.matrix_world.inverted()
am = scan.modifiers.new("Armature", 'ARMATURE')
am.object = arm
select_only(scan, arm)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
    export_animations=False, export_skins=True, export_influence_nb=4, export_all_influences=False,
    export_morph=False, export_def_bones=False, export_leaf_bone=False, export_rest_position_armature=True,
    export_image_format='JPEG', export_jpeg_quality=88, export_cameras=False, export_lights=False,
)
print(f"[scan] wrote {OUT} {os.path.getsize(OUT) / 1024:.0f} KB")
