"""Re-import the exported GLB into an empty scene, play each swing to its impact
frame and measure the club face centre against the Ball_* marker. Renders the
impact frames from the re-imported file for a visual check.

  blender --background --factory-startup --python verify_import.py
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(os.path.dirname(HERE), 'public', 'models', 'golfer.glb')
sys.path.insert(0, HERE)


def main():
    data = json.load(open(os.path.join(HERE, 'golfer_data.json')))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 30
    bpy.ops.import_scene.gltf(filepath=GLB)
    arm = next(o for o in sc.objects if o.type == 'ARMATURE')
    acts = {a.name: a for a in bpy.data.actions}
    print("imported actions:", sorted(acts))
    markers = {'Swing_Driver': 'Ball_Driver', 'Swing_Wood': 'Ball_Wood', 'Swing_Iron': 'Ball_Iron',
               'Swing_Wedge': 'Ball_Wedge', 'Swing_Chip': 'Ball_Chip', 'Swing_Putt': 'Ball_Putt'}
    import golfer_render as R
    R.setup(res=(420, 480))
    results = {}
    for anim, marker in markers.items():
        info = data['animations'][anim]
        act = next(a for n, a in acts.items() if n.startswith(anim))
        arm.animation_data.action = act
        if hasattr(arm.animation_data, 'action_slot') and act.slots:
            arm.animation_data.action_slot = act.slots[0]
        f = info['impact']
        sc.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        club = 'Club_' + info['club']
        for o in sc.objects:
            if o.name.startswith('Club_'):
                o.hide_render = o.name != club
            if o.name in ('Hat_Visor', 'Hat_Bucket', 'Hair_Long', 'Sunglasses'):
                o.hide_render = True
        ob = sc.objects[club].evaluated_get(dg)
        fc_local = Vector(data['face_center_local'][info['club']])
        fc = ob.matrix_world @ fc_local
        m = sc.objects[marker].matrix_world.translation
        err = (fc - m).length
        results[anim] = err
        print("  GLB %-13s frame %d: face centre (%.4f %.4f %.4f) marker (%.4f %.4f %.4f) dist %.4f m" % (
            anim, f, fc.x, fc.y, fc.z, m.x, m.y, m.z, err))
        loc, tgt = R.VIEWS['dtl']
        R.camera(loc, tgt, lens=40)
        R.render(os.path.join(HERE, 'renders', 'golfer_reimport_%s_impact.png' % anim))
    print("max impact error from GLB: %.4f m" % max(results.values()))


main()
