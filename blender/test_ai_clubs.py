"""Render the AI club heads over the procedural ones to check the registration.

  blender --background --factory-startup --python blender/test_ai_clubs.py
Writes renders/aiclub_<name>.png (procedural head in translucent red over the generated head).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy
from mathutils import Matrix, Vector

import golfer_clubs as K
import golfer_ai_clubs as AIC
import golfer_common as C
from golfer_skeleton import club_rest_matrix

bpy.ops.wm.read_factory_settings(use_empty=True)
C.make_materials()
scn = bpy.context.scene
scn.render.engine = 'BLENDER_EEVEE'
scn.render.resolution_x, scn.render.resolution_y = 900, 300
world = bpy.data.worlds.new('w')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.75, 0.77, 0.8, 1)
scn.world = world
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3
sun.rotation_euler = (0.6, 0.3, 0.8)
scn.collection.objects.link(sun)
red = bpy.data.materials.new('red')
red.use_nodes = True
bsdf = red.node_tree.nodes['Principled BSDF']
bsdf.inputs['Base Color'].default_value = (1, 0, 0, 1)
bsdf.inputs['Alpha'].default_value = 0.35
red.surface_render_method = 'BLENDED'

CAND = '--candidates' in sys.argv
for name, k in [(n, k) for n in K.CLUBS for k in (range(8) if CAND else [None])]:
    if k is not None:
        AIC.CHOICE[name] = k
    K.USE_AI_HEADS = False
    proc = K.build_club(name)
    proc.name = 'proc_' + name
    proc.data.materials.clear()
    proc.data.materials.append(red)
    K.USE_AI_HEADS = True
    try:
        ai = K.build_club(name)
    except IndexError:
        bpy.data.objects.remove(proc)
        for o in [o for o in bpy.data.objects if o.name.startswith('Club_')]:
            bpy.data.objects.remove(o)
        continue
    M = club_rest_matrix() @ K.A_to_bone(name)
    pts = [M @ p for p in K.HEAD_POINTS[name]]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    ctr, size = (lo + hi) / 2, max(hi - lo) * 1.6
    # three cameras rendered into one strip via three passes
    # address-frame views: face-on (+X), from above (+Z), from the toe (-Y)
    for v, dA in (('a', Vector((1, 0, 0.15))), ('b', Vector((0.05, 0, 1))), ('c', Vector((0.1, -1, 0.15)))):
        d = (M.to_3x3() @ dA).normalized()
        cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = size
        scn.collection.objects.link(cam)
        up = (M.to_3x3() @ Vector((0, 0, 1)) if v != 'b' else M.to_3x3() @ Vector((1, 0, 0))).normalized()
        z = d
        x = up.cross(z).normalized()
        y = z.cross(x)
        R = Matrix((x, y, z)).transposed().to_4x4()
        cam.matrix_world = Matrix.Translation(ctr + d * 2) @ R
        scn.camera = cam
        scn.render.resolution_x = scn.render.resolution_y = 300
        scn.render.filepath = os.path.join(HERE, 'renders', ('aiclub_%s_%s.png' % (name, v)) if k is None else ('aicand_%s_%d_%s.png' % (name, k, v)))
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam)
    for o in (proc, ai):
        bpy.data.objects.remove(o)
