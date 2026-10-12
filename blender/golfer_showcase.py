"""Material-quality stills of an exported golfer GLB (EEVEE, HDRI sky + sun), with the
game's default appearance tints applied the way three.js does (material colour x texture).

  blender --background --factory-startup --python blender/golfer_showcase.py -- \
      --glb public/models/golfer.glb --prefix v2 [--views front,face,top] [--res 1024]

Writes blender/renders/<prefix>_<view>.png and <prefix>_sheet.png.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RENDER_DIR = os.path.join(HERE, 'renders')
HDRI = os.path.join(ROOT, 'public', 'assets', 'hdri', 'kloofendal_48d_partly_cloudy_puresky_4k.hdr')

# default Appearance from src/core/save.ts (sRGB hex, as material.color.set(hex))
TINT = {'Skin': '#c68a62', 'Hair': '#3b2a1e', 'Hat': '#1c2b4a', 'Shirt': '#f2f2f0', 'Pants': '#2d3440',
        'Shoes': '#f4f4f4', 'Belt': '#1a1a1a'}
BUILD = 0.25

# view: (animation, frame, club, camera location, target, lens)
VIEWS = {
    'front': ('Idle', 0, 'Iron', (0.0, -3.6, 1.05), (0.0, 0.0, 0.93), 50),
    'threeq': ('Idle', 0, 'Iron', (2.3, -2.7, 1.25), (0.0, 0.0, 0.93), 50),
    'back': ('Idle', 0, 'Iron', (-1.6, 3.2, 1.35), (0.0, 0.0, 0.95), 50),
    'face': ('Idle', 0, 'Iron', (0.30, -0.80, 1.70), (0.0, -0.01, 1.655), 85),
    'address': ('Swing_Iron', 0, 'Iron', (1.05, -1.55, 1.15), (0.05, -0.25, 1.05), 50),
    'top': ('Swing_Driver', 30, 'Driver', (0.15, -3.9, 1.25), (0.0, 0.0, 1.10), 50),
    'finish': ('Swing_Driver', 70, 'Driver', (2.4, -2.6, 1.25), (0.0, 0.0, 1.05), 50),
    'hands': ('Swing_Iron', 0, 'Iron', (-0.15, -1.05, 0.95), (0.0, -0.35, 0.80), 60),
    'nohat': ('Idle', 0, 'Iron', (0.55, -0.62, 1.74), (0.0, 0.0, 1.69), 85),
    'faceclose': ('Idle', 0, 'Iron', (0.12, -0.55, 1.69), (0.0, -0.03, 1.665), 100),
    'longhair': ('Idle', 0, 'Iron', (-0.55, 0.62, 1.74), (0.0, 0.0, 1.66), 75),
    'visor': ('Idle', 0, 'Iron', (0.55, -0.62, 1.72), (0.0, 0.0, 1.69), 80),
    'bucket': ('Idle', 0, 'Iron', (0.55, -0.62, 1.72), (0.0, 0.0, 1.69), 80),
    'shoes': ('Idle', 0, 'Iron', (0.55, -0.75, 0.30), (0.0, -0.05, 0.06), 70),
    'collarback': ('Idle', 0, 'Iron', (-0.35, 0.85, 1.62), (0.0, 0.03, 1.46), 70),
    'collarfront': ('Idle', 0, 'Iron', (0.25, -0.85, 1.55), (0.0, -0.02, 1.44), 70),
    'topclose': ('Swing_Driver', 30, 'Driver', (0.75, -1.35, 1.55), (0.0, -0.05, 1.35), 55),
    'topback': ('Swing_Driver', 30, 'Driver', (-0.9, 1.2, 1.6), (0.0, 0.0, 1.3), 50),
    'finishclose': ('Swing_Driver', 70, 'Driver', (1.1, -1.2, 1.5), (0.0, 0.0, 1.25), 55),
    'impact': ('Swing_Iron', 40, 'Iron', (0.1, -3.4, 1.0), (0.0, -0.2, 0.8), 50),
    'finishfeet': ('Swing_Driver', 70, 'Driver', (0.9, -1.0, 0.35), (0.0, 0.0, 0.10), 45),
    # game framings (vertical FOV 50 deg like the game camera, 16:9): editor = 3.5 m in front
    'editor': ('Idle', 0, 'Iron', (0.0, -3.5, 1.35), (1.05, 0.0, 0.98), 'fov50'),
    'menu': ('Idle', 0, 'Iron', (-2.2, -3.6, 1.50), (1.6, 0.0, 0.95), 'fov50'),
    'head34': ('Idle', 0, 'Iron', (0.42, -0.56, 1.70), (0.0, -0.01, 1.665), 70),
    'impactclose': ('Swing_Driver', 40, 'Driver', (0.55, -1.45, 1.25), (0.0, -0.15, 1.05), 45),
    'neckclose': ('Idle', 0, 'Iron', (0.30, -0.42, 1.58), (0.0, -0.01, 1.53), 70),
    'mouthclose': ('Idle', 0, 'Iron', (0.06, -0.36, 1.625), (0.0, -0.08, 1.612), 110),
    'eyeclose': ('Idle', 0, 'Iron', (0.10, -0.36, 1.70), (0.025, -0.07, 1.69), 110),
    'hairline': ('Idle', 0, 'Iron', (0.30, -0.42, 1.78), (0.02, -0.04, 1.735), 80),
    'impactdtl': ('Swing_Driver', 40, 'Driver', (-1.6, -0.55, 1.25), (0.0, -0.2, 1.0), 45),
    'addressclose': ('Swing_Driver', 0, 'Driver', (0.55, -1.45, 1.25), (0.0, -0.15, 1.05), 45),
    'headfront': ('Idle', 0, 'Iron', (0.0, -0.75, 1.68), (0.0, 0.0, 1.665), 70),
    'finisharms': ('Swing_Driver', 70, 'Driver', (-0.2, -1.4, 1.6), (0.05, 0.0, 1.35), 50),
    'addressneck': ('Swing_Iron', 0, 'Iron', (0.35, -0.9, 1.30), (0.0, -0.12, 1.38), 60),
}
ORDER = ['front', 'threeq', 'back', 'face', 'address', 'top', 'finish', 'hands', 'nohat', 'faceclose',
         'longhair', 'visor', 'bucket', 'shoes', 'collarback', 'collarfront', 'topclose', 'topback',
         'finishclose', 'impact', 'finishfeet', 'finisharms', 'addressneck']
# variant objects shown per view (default: cap + short hair)
SHOW = {'nohat': {'Hair_Short'}, 'faceclose': {'Hair_Short'}, 'hairline': {'Hair_Short'}, 'eyeclose': {'Hair_Short'}, 'longhair': {'Hair_Long'},
        'visor': {'Hat_Visor', 'Hair_Long', 'Sunglasses'}, 'bucket': {'Hat_Bucket', 'Hair_Short'}}
VARIANTS = ('Hat_Cap', 'Hat_Visor', 'Hat_Bucket', 'Hair_Short', 'Hair_Long', 'Sunglasses')


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    o = {'glb': os.path.join(ROOT, 'public', 'models', 'golfer.glb'), 'prefix': 'cur', 'views': ORDER,
         'res': 1024, 'samples': 48}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k == '--glb':
            o['glb'] = argv[i + 1]
        elif k == '--prefix':
            o['prefix'] = argv[i + 1]
        elif k == '--views':
            o['views'] = argv[i + 1].split(',')
        elif k == '--res':
            o['res'] = int(argv[i + 1])
        elif k == '--samples':
            o['samples'] = int(argv[i + 1])
        elif k == '--build':
            o['build'] = float(argv[i + 1])
        elif k == '--frame':
            o['frame'] = int(argv[i + 1])
        elif k == '--skin':
            o['skin'] = argv[i + 1]
        i += 2
    return o


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h):
    h = h.lstrip('#')
    return tuple(srgb_to_lin(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (1.0,)


def tint_material(m, rgba):
    """Emulate three.js: base colour = material.color (replaced) x baseColor texture."""
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        return
    inp = bsdf.inputs['Base Color']
    if not inp.is_linked:
        inp.default_value = rgba
        return
    src = inp.links[0].from_node
    if src.type == 'MIX' and src.blend_type == 'MULTIPLY':
        for s in src.inputs:
            if s.identifier == 'B_Color' and not s.is_linked:
                s.default_value = rgba
                return
            if s.identifier == 'A_Color' and not s.is_linked:
                s.default_value = rgba
                return
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    nt.links.new(inp.links[0].from_socket, mix.inputs['A_Color' if 'A_Color' in mix.inputs else 6])
    mix.inputs[7].default_value = rgba
    nt.links.new(mix.outputs[2], inp)


def setup_scene(res, samples):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    try:
        sc.eevee.taa_render_samples = samples
        sc.eevee.use_shadows = True
        sc.eevee.use_raytracing = True
        sc.eevee.ray_tracing_options.resolution_scale = '1'
    except Exception:
        pass
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        pass
    world = bpy.data.worlds.new('ShowWorld')
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes['Background']
    if os.path.exists(HDRI):
        env = nt.nodes.new('ShaderNodeTexEnvironment')
        env.image = bpy.data.images.load(HDRI)
        nt.links.new(env.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 0.8
    else:
        bg.inputs['Color'].default_value = (0.5, 0.6, 0.75, 1)
    sun = bpy.data.lights.new('ShowSun', 'SUN')
    sun.energy = 3.2
    sun.angle = math.radians(2.0)
    so = bpy.data.objects.new('ShowSun', sun)
    sc.collection.objects.link(so)
    so.rotation_euler = (math.radians(42), math.radians(0), math.radians(-38))
    # ground
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    g = bpy.context.active_object
    g.name = 'ShowGround'
    gm = bpy.data.materials.new('ShowGrass')
    gm.use_nodes = True
    b = gm.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.10, 0.20, 0.06, 1)
    b.inputs['Roughness'].default_value = 0.9
    g.data.materials.append(gm)
    cd = bpy.data.cameras.new('ShowCam')
    cam = bpy.data.objects.new('ShowCam', cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


def aim(cam, loc, tgt, lens, res=1024):
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    sc = bpy.context.scene
    if lens == 'fov50':
        cam.data.sensor_fit = 'VERTICAL'
        cam.data.sensor_height = 24.0
        cam.data.lens = 12.0 / math.tan(math.radians(25.0))
        sc.render.resolution_x, sc.render.resolution_y = res * 16 // 9, res
    else:
        cam.data.sensor_fit = 'AUTO'
        cam.data.lens = lens
        sc.render.resolution_x = sc.render.resolution_y = res
    cam.data.clip_start = 0.01


def main():
    o = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 30
    bpy.ops.import_scene.gltf(filepath=o['glb'])
    arm = next(ob for ob in sc.objects if ob.type == 'ARMATURE')
    acts = {a.name: a for a in bpy.data.actions}
    for m in bpy.data.materials:
        base = m.name.split('.')[0]
        if base in TINT and m.use_nodes:
            hx = o['skin'] if (base == 'Skin' and 'skin' in o) else TINT[base]
            tint_material(m, hex_lin(hx))
    # emulate the game's alpha-to-coverage on Hair / Lashes: texture alpha straight into the BSDF,
    # stochastic (dithered) transparency instead of the glTF 0.5 cutoff
    for m in bpy.data.materials:
        if m.name.split('.')[0] in ('Hair', 'Lashes') and m.use_nodes:
            nt = m.node_tree
            bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            tex = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image and n.image.name.lower().find('albedo') >= 0), None)
            if bsdf and tex:
                for l in list(bsdf.inputs['Alpha'].links):
                    nt.links.remove(l)
                nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
                try:
                    m.surface_render_method = 'DITHERED'
                except Exception:
                    pass
    for ob in sc.objects:
        if ob.type == 'MESH' and ob.data.shape_keys and 'Heavy' in ob.data.shape_keys.key_blocks:
            ob.data.shape_keys.key_blocks['Heavy'].value = o.get('build', BUILD)
    cam = setup_scene(o['res'], o['samples'])
    os.makedirs(RENDER_DIR, exist_ok=True)
    outs = []
    for v in o['views']:
        anim, frame, club, loc, tgt, lens = VIEWS[v]
        frame = o.get('frame', frame)
        act = next(a for n, a in acts.items() if n.startswith(anim))
        arm.animation_data.action = act
        if hasattr(arm.animation_data, 'action_slot') and act.slots:
            arm.animation_data.action_slot = act.slots[0]
        for ob in sc.objects:
            if ob.name.startswith('Club_'):
                ob.hide_render = ob.name != 'Club_' + club
            base = ob.name.split('.')[0]
            if base in VARIANTS:
                ob.hide_render = base not in SHOW.get(v, {'Hat_Cap', 'Hair_Short'})
        sc.frame_set(frame)
        aim(cam, loc, tgt, lens, o['res'])
        path = os.path.join(RENDER_DIR, '%s_%s%s.png' % (o['prefix'], v, '_f%d' % frame if 'frame' in o else ''))
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        outs.append(path)
        print('rendered', path)
    if len(outs) > 1 and all(VIEWS[v][5] != 'fov50' for v in o['views']):
        import golfer_render as R
        R.contact_sheet(outs, os.path.join(RENDER_DIR, '%s_sheet.png' % o['prefix']), cols=4)


sys.path.insert(0, HERE)
main()
