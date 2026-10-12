"""Armature creation, skinning, the 'Heavy' shape key and rigid parenting."""
import math
import bpy
import bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

import golfer_common as C
from golfer_skeleton import JOINTS as J, bone_specs, club_rest_matrix, hand_frame

NON_DEFORM = {'Root', 'Club'}


def build_armature():
    arm = bpy.data.armatures.new('Golfer')
    ob = C.link(bpy.data.objects.new('Golfer', arm))
    C.set_active(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    club_z = Vector(club_rest_matrix().col[2][:3])
    for name, head, tail, parent, conn in bone_specs():
        b = arm.edit_bones.new(name)
        b.head, b.tail = head, tail
        if name == 'Club':
            b.align_roll(club_z)
        elif name.startswith('Hand'):
            b.align_roll(hand_frame(name[-1])['palm'])
        elif name.startswith('Foot') or name == 'Root':
            b.align_roll(Vector((0, 0, 1)) if name != 'Root' else Vector((0, -1, 0)))
        else:
            b.align_roll(Vector((0, -1, 0)))
        eb[name] = b
    for name, head, tail, parent, conn in bone_specs():
        if parent:
            eb[name].parent = eb[parent]
            eb[name].use_connect = conn
    bpy.ops.object.mode_set(mode='OBJECT')
    for b in arm.bones:
        b.use_deform = b.name not in NON_DEFORM
    for pb in ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return ob


def auto_weights(arm_ob, mesh_ob):
    """Bone-heat weights for one mesh part; leaves only vertex groups behind."""
    C.set_active(arm_ob)
    mesh_ob.select_set(True)
    arm_ob.select_set(True)
    bpy.context.view_layer.objects.active = arm_ob
    r = bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    for m in list(mesh_ob.modifiers):
        if m.type == 'ARMATURE':
            mesh_ob.modifiers.remove(m)
    mw = mesh_ob.matrix_world.copy()
    mesh_ob.parent = None
    mesh_ob.matrix_world = mw
    return r


def rigid_weights(mesh_ob, bone):
    vg = mesh_ob.vertex_groups.get(bone) or mesh_ob.vertex_groups.new(name=bone)
    vg.add(list(range(len(mesh_ob.data.vertices))), 1.0, 'REPLACE')


def transfer_weights(src, dst):
    """Copy weights from the nearest surface point of src (interpolated over the face)."""
    bvh = BVHTree.FromObject(src, bpy.context.evaluated_depsgraph_get())
    names = [g.name for g in src.vertex_groups]
    sw = [dict() for _ in src.data.vertices]
    for v in src.data.vertices:
        for g in v.groups:
            sw[v.index][src.vertex_groups[g.group].name] = g.weight
    polys = src.data.polygons
    for name in names:
        if not dst.vertex_groups.get(name):
            dst.vertex_groups.new(name=name)
    for v in dst.data.vertices:
        loc, nrm, fi, dist = bvh.find_nearest(v.co)
        if fi is None:
            continue
        p = polys[fi]
        vs = [src.data.vertices[i].co for i in p.vertices]
        ws = [1.0 / max(1e-5, (c - loc).length) for c in vs]
        tot = sum(ws)
        acc = {}
        for i, w in zip(p.vertices, ws):
            for name, val in sw[i].items():
                acc[name] = acc.get(name, 0.0) + val * w / tot
        for name, val in acc.items():
            if val > 1e-4:
                dst.vertex_groups[name].add([v.index], val, 'REPLACE')


def finalize_skin(body, arm_ob):
    C.set_active(body)
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    mod = body.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_ob
    body.parent = arm_ob
    body.matrix_parent_inverse = arm_ob.matrix_world.inverted()


def parent_to_bone(obj, arm_ob, bone_name, data_in_world=True):
    """Rigidly attach obj to a bone, keeping its rest placement.
    Mesh data is re-expressed in the bone's local frame (origin at bone head)."""
    bone = arm_ob.data.bones[bone_name]
    rest = bone.matrix_local.copy()
    if data_in_world:
        obj.data.transform(rest.inverted())
    obj.parent = arm_ob
    obj.parent_type = 'BONE'
    obj.parent_bone = bone_name
    tail_m = rest.copy()
    tail_m.translation = bone.tail_local
    obj.matrix_parent_inverse = tail_m.inverted()
    obj.matrix_basis = rest


# ------------------------------------------------------------------ Heavy shape key
def _seg_closest(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return a + ab * t, t


LIMB_AMOUNTS = {
    'Shoulder': (0.010, 0.010),
    'UpperArm': (0.013, 0.010),
    'Forearm': (0.008, 0.003),
    'Hand': (0.002, 0.002),
    'Thigh': (0.019, 0.010),
    'Shin': (0.008, 0.005),
    'Foot': (0.0, 0.0),
}


def heavy_offset(p, bone, arm_ob):
    b = arm_ob.data.bones[bone]
    h, t = b.head_local, b.tail_local
    base = bone.rsplit('_', 1)[0]
    if base in LIMB_AMOUNTS:
        q, s = _seg_closest(p, h, t)
        r = p - q
        if r.length < 1e-6:
            return Vector()
        a0, a1 = LIMB_AMOUNTS[base]
        return r.normalized() * (a0 + (a1 - a0) * s)
    if bone in ('Hips', 'Spine', 'Chest'):
        axis = Vector((0.0, 0.015, p.z))
        r = p - axis
        r.z = 0.0
        if r.length < 1e-6:
            return Vector()
        d = r.normalized()
        front = max(0.0, -d.y)
        back = max(0.0, d.y)
        side = abs(d.x)
        z = p.z
        # general girth by height
        girth = 0.022 * math.exp(-((z - 1.10) / 0.16) ** 2) + 0.012 * math.exp(-((z - 1.32) / 0.10) ** 2) \
            + 0.012 * math.exp(-((z - 0.93) / 0.08) ** 2)
        belly = 0.050 * front ** 1.6 * math.exp(-((z - 1.08) / 0.11) ** 2)
        handles = 0.014 * side ** 2 * math.exp(-((z - 1.04) / 0.07) ** 2)
        amt = girth * (1.0 - 0.45 * back) + belly + handles
        off = d * amt
        off.z -= 0.012 * front * math.exp(-((z - 1.03) / 0.08) ** 2)   # slight sag
        return off
    if bone == 'Neck':
        axis = Vector((0.0, 0.015, p.z))
        r = p - axis
        r.z = 0
        return r.normalized() * 0.007 if r.length > 1e-6 else Vector()
    if bone == 'Head':
        if p.z < 1.62 and p.y < 0.03:
            axis = Vector((0.0, 0.0, p.z))
            r = p - axis
            r.z = 0
            f = max(0.0, (1.62 - p.z) / 0.05)
            return r.normalized() * 0.005 * min(1.0, f) if r.length > 1e-6 else Vector()
        return Vector()
    return Vector()


def add_heavy_shape(body, arm_ob):
    body.shape_key_add(name='Basis', from_mix=False)
    sk = body.shape_key_add(name='Heavy', from_mix=False)
    gnames = {g.index: g.name for g in body.vertex_groups}
    for v in body.data.vertices:
        off = Vector()
        tot = 0.0
        for g in v.groups:
            name = gnames[g.group]
            if g.weight <= 0:
                continue
            off += heavy_offset(v.co, name, arm_ob) * g.weight
            tot += g.weight
        if tot > 0:
            off /= tot
        sk.data[v.index].co = v.co + off
    sk.value = 0.0
    return sk


def hem_foot_weights(torso):
    """Let the bottom of the trouser legs follow the shoes partly (the hem rests on them)."""
    for side, s in (('L', 1.0), ('R', -1.0)):
        g = torso.vertex_groups.get('Foot_' + side) or torso.vertex_groups.new(name='Foot_' + side)
        gi = g.index
        for v in torso.data.vertices:
            z = v.co.z
            if z > 0.14 or v.co.x * s < 0.02:
                continue
            t = min(1.0, max(0.0, (z - 0.06) / 0.08))
            w = 0.55 * (1.0 - t * t * (3 - 2 * t))
            if w <= 0.0:
                continue
            for ge in v.groups:
                if ge.group != gi:
                    ge.weight *= (1.0 - w)
            g.add([v.index], w, 'ADD')


class WeightSampler:
    """Interpolated vertex-group weights of a source mesh at its nearest surface point."""

    def __init__(self, src):
        self.src = src
        self.bvh = C.bvh(src)
        names = {g.index: g.name for g in src.vertex_groups}
        self.w = [{names[g.group]: g.weight for g in v.groups if g.weight > 0} for v in src.data.vertices]

    def at(self, p):
        loc, nrm, fi, dist = self.bvh.find_nearest(p)
        if fi is None:
            return {}, 1e9
        poly = self.src.data.polygons[fi]
        vs = [self.src.data.vertices[i].co for i in poly.vertices]
        ws = [1.0 / max(1e-5, (c - loc).length) for c in vs]
        tot = sum(ws)
        acc = {}
        for i, w in zip(poly.vertices, ws):
            for name, val in self.w[i].items():
                acc[name] = acc.get(name, 0.0) + val * w / tot
        return acc, dist


def _set_weights(obj, vi, weights):
    for g in obj.vertex_groups:
        g.remove([vi])
    for name, val in weights.items():
        if val <= 1e-4:
            continue
        g = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
        g.add([vi], val, 'REPLACE')


def neck_blend(collar, torso, head):
    """Collar weights: like the neck skin where it hugs the neck, like the torso where the
    leaf lies on the shoulders (they twist apart at the top of the backswing)."""
    sh, st = WeightSampler(head), WeightSampler(torso)
    for v in collar.data.vertices:
        wh, dh = sh.at(v.co)
        wt, dt = st.at(v.co)
        if dh < 0.010 or dt > 4 * dh:
            a = 1.0                                   # stand and upper leaf ride on the neck skin
        else:
            a = min(1.0, (dt / (dh + dt)) ** 0.5 * 1.1)
        mix = {}
        for k, val in wh.items():
            mix[k] = mix.get(k, 0.0) + a * val
        for k, val in wt.items():
            mix[k] = mix.get(k, 0.0) + (1.0 - a) * val
        _set_weights(collar, v.index, mix)


def neck_inside(torso, head, neck_axis_y):
    """Torso vertices hidden inside the neck (and just around it under the collar) take the
    neck skin's weights so they stay inside when the neck twists."""
    sh = WeightSampler(head)
    hb = sh.bvh
    st_w = WeightSampler(torso)
    for v in torso.data.vertices:
        p = v.co
        if p.z < 1.42 or p.z > 1.60:
            continue
        d = Vector((p.x, p.y - neck_axis_y, 0.0))
        r = d.length
        if r < 1e-6 or r > 0.14:
            continue
        o = Vector((0.0, neck_axis_y, p.z))
        hit = hb.ray_cast(o, d.normalized(), 0.3)
        if hit[0] is None:
            continue
        rh = (hit[0] - o).length
        k = min(1.0, max(0.0, (r - rh) / 0.045))
        a = 1.0 - k * k * (3 - 2 * k)
        if a <= 0.0:
            continue
        wh, _ = sh.at(p)
        wt = st_w.w[v.index]
        mix = {}
        for k, val in wh.items():
            mix[k] = mix.get(k, 0.0) + a * val
        for k, val in wt.items():
            mix[k] = mix.get(k, 0.0) + (1.0 - a) * val
        _set_weights(torso, v.index, mix)


def pin_neck_base(head, z_top=1.47, z_full=1.42):
    """Lower neck (inside the shirt) follows the Chest: blend its weights to Chest below z_top."""
    names = {g.index: g.name for g in head.vertex_groups}
    chest = head.vertex_groups.get('Chest') or head.vertex_groups.new(name='Chest')
    for v in head.data.vertices:
        z = v.co.z
        if z >= z_top:
            continue
        k = min(1.0, max(0.0, (z_top - z) / (z_top - z_full)))
        w = k * k * (3 - 2 * k)
        cur = {names[g.group]: g.weight for g in v.groups if g.weight > 0}
        mix = {n: val * (1.0 - w) for n, val in cur.items()}
        mix['Chest'] = mix.get('Chest', 0.0) + w
        _set_weights(head, v.index, mix)
