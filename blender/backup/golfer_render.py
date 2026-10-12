"""Preview rendering helpers (Workbench / Eevee) used for verification."""
import math
import bpy
from mathutils import Vector


def setup(engine='WORKBENCH', res=(720, 900)):
    sc = bpy.context.scene
    if engine == 'WORKBENCH':
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh = sc.display.shading
        sh.light = 'STUDIO'
        sh.color_type = 'MATERIAL'
        sh.show_shadows = True
        sh.show_cavity = False
        sh.show_specular_highlight = True
        sc.display.shadow_shift = 0.2
    else:
        sc.render.engine = 'BLENDER_EEVEE'
        world = bpy.data.worlds.get('World') or bpy.data.worlds.new('World')
        sc.world = world
        world.use_nodes = True
        bg = world.node_tree.nodes.get('Background')
        bg.inputs['Color'].default_value = (0.55, 0.62, 0.72, 1)
        bg.inputs['Strength'].default_value = 0.9
        if not bpy.data.objects.get('PreviewSun'):
            ld = bpy.data.lights.new('PreviewSun', 'SUN')
            ld.energy = 3.5
            lo = bpy.data.objects.new('PreviewSun', ld)
            sc.collection.objects.link(lo)
            lo.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'


def ground(size=6.0):
    if bpy.data.objects.get('PreviewGround'):
        return
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    g = bpy.context.active_object
    g.name = 'PreviewGround'
    m = bpy.data.materials.get('PreviewGrass') or bpy.data.materials.new('PreviewGrass')
    m.diffuse_color = (0.22, 0.42, 0.18, 1)
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.22, 0.42, 0.18, 1)
    g.data.materials.append(m)


def camera(loc, target, lens=50, ortho=None):
    cam = bpy.data.objects.get('PreviewCam')
    if cam is None:
        cd = bpy.data.cameras.new('PreviewCam')
        cam = bpy.data.objects.new('PreviewCam', cd)
        bpy.context.scene.collection.objects.link(cam)
    cam.location = Vector(loc)
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    if ortho:
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = 'PERSP'
        cam.data.lens = lens
    cam.data.clip_start = 0.01
    bpy.context.scene.camera = cam
    return cam


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


VIEWS = {
    'front': ((0, -4.2, 1.0), (0, 0, 0.92)),
    'back': ((0, 4.2, 1.0), (0, 0, 0.92)),
    'left': ((4.2, 0, 1.0), (0, 0, 0.92)),
    'right': ((-4.2, 0, 1.0), (0, 0, 0.92)),
    'dtl': ((-4.0, -0.55, 1.2), (0, -0.35, 0.8)),        # down the line (behind ball, looking at target)
    'faceon': ((0.0, -4.5, 1.0), (0, -0.3, 0.85)),
    'behind': ((-2.6, 2.6, 1.6), (0.6, -0.4, 0.8)),        # game camera: behind golfer
    'top': ((0.0, -0.3, 5.0), (0.0, -0.3, 0.0)),
}


def contact_sheet(paths, out_path, cols=4, labels=None):
    """Tile rendered PNGs (same size) into one image."""
    import numpy as np
    imgs = []
    for p in paths:
        im = bpy.data.images.load(p)
        w, h = im.size
        a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
        imgs.append(a)
        bpy.data.images.remove(im)
    h, w = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    sheet = np.ones((rows * h, cols * w, 4), dtype=np.float32)
    for i, a in enumerate(imgs):
        r, c = divmod(i, cols)
        # image rows are bottom-up in Blender
        sheet[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = a
    out = bpy.data.images.new('sheet', cols * w, rows * h, alpha=True)
    out.pixels[:] = sheet.ravel()
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
