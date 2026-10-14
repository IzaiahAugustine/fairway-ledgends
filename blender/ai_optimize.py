"""Optimise the Artlist (Tripo) generated models for the web game.

The raw downloads in blender/ai_models/ are ~1.4M triangles with 2K PBR maps each. This
decimates them to a game budget, downsizes the textures and exports public/models/ai/<name>.glb.
With --preview it also renders front/side/top views to blender/renders/ai_<name>.png.

  blender --background --factory-startup --python blender/ai_optimize.py -- [--preview] [names...]
"""
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'ai_models')
OUT = os.path.join(HERE, '..', 'public', 'models', 'ai')
RENDERS = os.path.join(HERE, 'renders')

# name: (target triangles, texture size)
BUDGET = {
    'lighthouse': (30000, 1024),
    'bridge': (30000, 1024),
    'clubhouse': (40000, 1024),
    'saguaro': (12000, 1024),
    'driver': (6000, 512),
    'wood': (5000, 512),
    'hybrid': (5000, 512),
    'iron': (5000, 512),
    'wedge': (5000, 512),
    'putter': (5000, 512),
}


# Tripo painted the saguaro's ribs blue-violet; swing those hues round to cactus green.
# (from_lo, from_hi, to) in degrees, saturation-gated so the brown base and spines stay put
HUE_FIX = {'saguaro': (200.0, 320.0, 100.0)}


def fix_hue(img, lo, hi, to):
    import numpy as np
    px = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)
    rgb = px[:, :3]
    mx, mn = rgb.max(1), rgb.min(1)
    d = mx - mn + 1e-8
    r, g, b = rgb.T
    h = np.where(mx == r, (g - b) / d % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60.0
    sel = (h >= lo) & (h <= hi) & (d / (mx + 1e-8) > 0.12)
    # rebuild the selected pixels at the new hue, keeping value and saturation
    v, sat = mx[sel], (d / (mx + 1e-8))[sel]
    hh = np.full(v.shape, to) / 60.0
    c = v * sat
    x = c * (1 - np.abs(hh % 2 - 1))
    z = np.zeros_like(c)
    i = hh.astype(int) % 6
    lut = [(c, x, z), (x, c, z), (z, c, x), (z, x, c), (x, z, c), (c, z, x)]
    out = np.stack([np.choose(i, [l[k] for l in lut]) for k in range(3)], 1) + (v - c)[:, None]
    rgb[sel] = out
    px[:, :3] = rgb
    img.pixels[:] = px.ravel()
    img.update()
    print('AIOPT hue fix %s: %d px' % (img.name, int(sel.sum())))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def tri_count(objs):
    n = 0
    for o in objs:
        for p in o.data.polygons:
            n += len(p.vertices) - 2
    return n


def optimise(name, preview):
    tris_target, tex = BUDGET[name]
    reset()
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, name + '.glb'))
    objs = mesh_objects()
    before = tri_count(objs)
    for o in objs:
        bpy.context.view_layer.objects.active = o
        mod = o.modifiers.new('dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = min(1.0, tris_target / max(1, before))
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    after = tri_count(objs)
    for img in bpy.data.images:
        if img.size[0] > tex:
            img.scale(tex, tex)
    if name in HUE_FIX:
        for mat in bpy.data.materials:
            if not mat.node_tree:
                continue
            bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            link = bsdf and bsdf.inputs['Base Color'].links
            if link and link[0].from_node.type == 'TEX_IMAGE':
                fix_hue(link[0].from_node.image, *HUE_FIX[name])
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_image_format='JPEG',
                              export_jpeg_quality=85, export_draco_mesh_compression_enable=False,
                              export_materials='EXPORT', export_yup=True)
    print('AIOPT %s tris %d -> %d  %.1f MB' % (name, before, after, os.path.getsize(path) / 1e6))
    if preview:
        render_views(name, objs)


def render_views(name, objs):
    """Three orthographic views side by side (front -Y, side +X, top +Z) in Blender's Z-up frame."""
    lo = Vector((1e9,) * 3)
    hi = Vector((-1e9,) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    ctr = (lo + hi) / 2
    size = max(hi - lo) * 1.15
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_EEVEE'
    scn.render.resolution_x = scn.render.resolution_y = 512
    scn.render.film_transparent = False
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.6, 0.62, 0.66, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 1.0
    scn.world = world
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3
    sun.rotation_euler = (0.7, 0.2, 0.6)
    scn.collection.objects.link(sun)
    # axis markers: red +X, green +Y, blue +Z
    for axis, col in ((Vector((1, 0, 0)), (1, 0, 0, 1)), (Vector((0, 1, 0)), (0, 1, 0, 1)), (Vector((0, 0, 1)), (0, 0, 1, 1))):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=size * 0.03, location=ctr + axis * size * 0.45)
        m = bpy.data.materials.new('ax')
        m.use_nodes = True
        m.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = col
        m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 5
        bpy.context.active_object.data.materials.append(m)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = size
    scn.collection.objects.link(cam)
    scn.camera = cam
    views = {'front': ((0, -1, 0), (1.5708, 0, 0)), 'side': ((1, 0, 0), (1.5708, 0, 1.5708)),
             'top': ((0, 0, 1), (0, 0, 0))}
    for v, (d, rot) in views.items():
        cam.location = ctr + Vector(d) * size * 2
        cam.rotation_euler = rot
        scn.render.filepath = os.path.join(RENDERS, 'ai_%s_%s.png' % (name, v))
        bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    preview = '--preview' in argv
    names = [a for a in argv if not a.startswith('--')] or list(BUDGET)
    for n in names:
        optimise(n, preview)


main()
