"""Build the rigged, animated golfer and export public/models/golfer.glb.

Run headless:
  blender --background --factory-startup --python D:/golfgame/blender/build_golfer.py
Optional args after "--":
  --anims Swing_Iron,Idle   only generate these animations (dev)
  --no-export               skip GLB export
  --preview                 render key frames of generated swings to renders/
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
for _m in list(sys.modules):
    if _m.startswith('golfer_'):
        del sys.modules[_m]

import bpy
from mathutils import Vector, Matrix

import golfer_common as C
import golfer_body as B
import golfer_clubs as K
import golfer_accessories as ACC
import golfer_rig as RIG
import golfer_anim as A
import golfer_swings as SW

ROOT = os.path.dirname(HERE)
BLEND_PATH = os.path.join(HERE, 'golfer.blend')
GLB_PATH = os.path.join(ROOT, 'public', 'models', 'golfer.glb')
RENDER_DIR = os.path.join(HERE, 'renders')

ALL_ANIMS = ['Swing_Driver', 'Swing_Wood', 'Swing_Iron', 'Swing_Wedge', 'Swing_Chip', 'Swing_Putt',
             'Idle', 'Celebrate', 'Dejected']
BALL_MARKERS = {'Swing_Driver': 'Ball_Driver', 'Swing_Wood': 'Ball_Wood', 'Swing_Iron': 'Ball_Iron',
                'Swing_Wedge': 'Ball_Wedge', 'Swing_Chip': 'Ball_Chip', 'Swing_Putt': 'Ball_Putt'}


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'anims': ALL_ANIMS, 'export': True, 'preview': False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--anims':
            opts['anims'] = argv[i + 1].split(',')
            i += 1
        elif a == '--no-export':
            opts['export'] = False
        elif a == '--preview':
            opts['preview'] = True
        elif a == '--diag':
            opts['diag'] = True
        elif a == '--frames':
            opts['frames'] = [int(x) for x in argv[i + 1].split(',')]
            i += 1
        i += 1
    return opts


def build_model():
    C.reset_scene()
    C.make_materials()
    arm = RIG.build_armature()
    body, acc = B.build_body(ACC.build_accessories, arm_ob=arm)
    RIG.finalize_skin(body, arm)
    RIG.add_heavy_shape(body, arm)
    for o in acc:
        RIG.parent_to_bone(o, arm, 'Head')
    clubs = K.build_clubs()
    rest_inv = arm.data.bones['Club'].matrix_local.inverted()
    for c in clubs:
        RIG.parent_to_bone(c, arm, 'Club')
    return arm, body, acc, clubs


def generate(rig, name):
    """Returns (poses, info) for one animation."""
    kind = name.split('_', 1)[1] if name.startswith('Swing_') else name
    if kind in SW.FULL:
        sb, info = SW.build_full_swing(rig, kind)
        poses = sb.frames()
    elif kind == 'Chip':
        sb, info = SW.build_chip(rig)
        poses = sb.frames()
    elif kind == 'Putt':
        sb, info = SW.build_putt(rig)
        poses = sb.frames()
    else:
        sb, info = SW.build_gesture(rig, kind)
        poses = sb.frames()
    info['builder'] = sb
    return poses, info


def verify_impact(name, poses, info):
    club = info['club']
    imp = info['impact']
    P = poses[imp]
    fc = A.face_center_world(P['Club'], club)
    ball = info['ball']
    err = (fc - ball).length
    n = A.face_normal_world(P['Club'], club)
    sq = Vector((n.x, n.y, 0)).normalized()
    import math
    face_angle = math.degrees(math.atan2(sq.y, sq.x))
    shaft = P['Club'].to_3x3().col[1]
    lean = math.degrees(math.atan2(-shaft.x, -shaft.z))
    # sole height under the face centre
    sole = P['Club'] @ K.sole_point_local(club)
    print("  %-13s impact f%d  face-centre->ball %.4f m  (gap along normal %.4f)  face angle %.1f deg  "
          "shaft lean %.1f deg  sole z %.4f" % (name, imp, err, (ball - fc).dot(n), face_angle, lean, sole.z))
    return err


def diag_motion(name, poses, info):
    import math
    club = info['club']
    sb = info['builder']
    prev_fc, prev_y = None, None
    rows = []
    for f, P in enumerate(poses):
        fc = A.face_center_world(P['Club'], club)
        y = P['Club'].to_3x3().col[1]
        st = sb.state(f)[1]
        sp = (fc - prev_fc).length * 30 if prev_fc is not None else 0.0
        rot = math.degrees(y.angle(prev_y)) if prev_y is not None else 0.0
        rows.append("%d:%.1f/%.0f%s" % (f, sp, rot, ('!%.3f' % st.get('club_shift', 0)) if st.get('club_shift', 0) > 0.002 else ''))
        prev_fc, prev_y = fc, y
    me = bpy.data.objects['Club_' + club].data
    pts = [v.co.copy() for v in me.vertices if v.co.y > 0.5]       # head region (bone-local, y down the shaft)
    lows = []
    for f, P in enumerate(poses):
        M = P['Club']
        lows.append(min((M @ p).z for p in pts))
    print("   club lowest point z per frame: " + " ".join("%d:%.3f" % (f, z) for f, z in enumerate(lows)
                                                       if f <= 12 or info['top'] <= f <= info['impact'] + 4))
    print("   speed m/s / club rot deg per frame (! = reach shift m):")
    for i in range(0, len(rows), 12):
        print("     " + "  ".join(rows[i:i + 12]))


def add_markers(arm, infos):
    for anim, marker in BALL_MARKERS.items():
        if anim not in infos:
            continue
        e = bpy.data.objects.new(marker, None)
        e.empty_display_type = 'SPHERE'
        e.empty_display_size = A.BALL_R
        C.link(e)
        e.parent = arm
        e.location = infos[anim]['ball']


def preview(arm, name, info, act):
    import golfer_render as R
    arm.animation_data.action = act
    R.setup(res=(560, 640))
    R.ground(8)
    ball = info.get('ball')
    if ball is not None and not bpy.data.objects.get('PreviewBall'):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=A.BALL_R, location=ball)
        bpy.context.active_object.name = 'PreviewBall'
    if ball is not None:
        bpy.data.objects['PreviewBall'].location = ball
    club = info.get('club')
    for o in bpy.data.objects:
        if o.name.startswith('Club_'):
            o.hide_render = (club is None) or (o.name != 'Club_' + club)
        if o.name in ('Hat_Visor', 'Hat_Bucket', 'Hair_Long', 'Sunglasses'):
            o.hide_render = True
    frames = info.get('preview_frames') or sorted({0, info.get('top', 0), info.get('impact', 0),
                                                   info.get('finish', 0)})
    sb = info['builder']
    for f in frames:
        P, st = sb.state(f)
        rig = sb.rig
        wl, wr = P['Hand_L'].translation, P['Hand_R'].translation
        hd = P['Head'].translation
        rl = (wl - rig.shoulder(P, 'L')).length / rig.arm_len
        rr = (wr - rig.shoulder(P, 'R')).length / rig.arm_len
        twl = rig.forearm_twist(P, 'L')
        twr = rig.forearm_twist(P, 'R')
        print("   f%5.1f wristL (%.2f %.2f %.2f) wristR (%.2f %.2f %.2f) head (%.2f %.2f %.2f) reach L %.3f R %.3f"
              "  twist/bend L %.0f/%.0f R %.0f/%.0f" % (f, wl.x, wl.y, wl.z, wr.x, wr.y, wr.z, hd.x, hd.y, hd.z, rl, rr,
                                                      twl[0], twl[1], twr[0], twr[1]))
    R.setup(res=(300, 380))
    sheets = {'dtl': [], 'faceon': []}
    for f in frames:
        bpy.context.scene.frame_set(int(f))
        for view in ('dtl', 'faceon'):
            loc, tgt = R.VIEWS[view]
            R.camera(loc, tgt, lens=40)
            path = os.path.join(RENDER_DIR, 'tmp_%s_%s_f%02d.png' % (name, view, f))
            R.render(path)
            sheets[view].append(path)
    for view, paths in sheets.items():
        R.contact_sheet(paths, os.path.join(RENDER_DIR, 'golfer_%s_%s.png' % (name, view)), cols=min(6, len(paths)))
        for pth in paths:
            os.remove(pth)
    R.setup(res=(560, 640))
    if info.get('closeups'):
        for f in info['closeups']:
            bpy.context.scene.frame_set(int(f))
            P, st = sb.state(f)
            c = (P['Hand_L'].translation + P['Hand_R'].translation) * 0.5
            for tag, off in (('hands_a', Vector((-0.35, -0.55, 0.15))), ('hands_b', Vector((0.45, -0.45, 0.10)))):
                R.camera(c + off, c, lens=55)
                R.render(os.path.join(RENDER_DIR, 'golfer_%s_%s_f%02d.png' % (name, tag, f)))


def blender_side_check(arm, infos, actions):
    """Measure the face centre of the visible club mesh with Blender's own
    evaluation (bone-parented object matrices), compare with the Ball marker."""
    out = {}
    for name, info in infos.items():
        if not name.startswith('Swing_'):
            continue
        arm.animation_data.action = actions[name]
        bpy.context.scene.frame_set(info['impact'])
        dg = bpy.context.evaluated_depsgraph_get()
        club_obj = bpy.data.objects['Club_' + info['club']].evaluated_get(dg)
        fc = club_obj.matrix_world @ K.face_center_local(info['club'])
        marker = bpy.data.objects[BALL_MARKERS[name]].matrix_world.translation
        err = (fc - marker).length
        out[name] = err
        print("  blender-eval %-13s impact f%d face-centre %s  marker %s  dist %.4f m" % (
            name, info['impact'], tuple(round(x, 4) for x in fc), tuple(round(x, 4) for x in marker), err))
    return out


def write_report_data(infos, errs):
    import json
    data = {'fps': 30, 'animations': {}, 'face_center_local': {}, 'markers_gltf': {}}
    for name, info in infos.items():
        d = {'frames': info['last'] if 'last' in info else None}
        for k in ('top', 'impact', 'finish', 'last'):
            if k in info:
                d[k] = info[k]
                d[k + '_s'] = round(info[k] / 30.0, 4)
        if name in errs:
            d['impact_face_center_to_ball_m'] = round(errs[name], 4)
        if 'club' in info:
            d['club'] = info['club']
        data['animations'][name] = d
        if name in BALL_MARKERS:
            b = info['ball']
            data['markers_gltf'][BALL_MARKERS[name]] = [round(b.x, 4), round(b.z, 4), round(-b.y, 4)]
    for c in K.CLUBS:
        data['face_center_local'][c] = [round(x, 5) for x in K.face_center_local(c)]
    with open(os.path.join(HERE, 'golfer_data.json'), 'w') as f:
        json.dump(data, f, indent=1)


def export_glb(arm):
    os.makedirs(os.path.dirname(GLB_PATH), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.hide_set(False)
        o.hide_render = False
    bpy.ops.export_scene.gltf(
        filepath=GLB_PATH, export_format='GLB', export_yup=True, export_apply=False,
        export_animations=True, export_animation_mode='ACTIONS', export_anim_single_armature=True,
        export_force_sampling=True, export_frame_step=1, export_optimize_animation_size=False,
        export_reset_pose_bones=True, export_def_bones=False, export_skins=True, export_influence_nb=4,
        export_all_influences=False, export_morph=True, export_morph_normal=True, export_morph_animation=False,
        export_materials='EXPORT', export_image_format='AUTO', export_cameras=False, export_lights=False,
        export_extras=False, use_selection=False, use_visible=False, export_leaf_bone=False,
        export_rest_position_armature=True, export_anim_slide_to_zero=False, export_bake_animation=False)
    print("exported", GLB_PATH, os.path.getsize(GLB_PATH))


def main():
    t0 = time.time()
    opts = parse_args()
    arm, body, acc, clubs = build_model()
    print("model built %.1fs  body tris %d" % (time.time() - t0, C.tri_count(body)))
    rig = A.Rig(arm)
    infos = {}
    actions = {}
    for name in opts['anims']:
        poses, info = generate(rig, name)
        act = A.bake(rig, name, poses)
        actions[name] = act
        infos[name] = info
        if 'impact' in info and info.get('club') and name.startswith('Swing_'):
            info['impact_error'] = verify_impact(name, poses, info)
            if opts.get('diag'):
                diag_motion(name, poses, info)
        print("anim %-13s frames %d  (%.1fs)" % (name, len(poses), time.time() - t0))
    add_markers(arm, infos)
    errs = blender_side_check(arm, infos, actions)
    write_report_data(infos, errs)
    if opts['preview']:
        for name in opts['anims']:
            if opts.get('frames'):
                infos[name]['preview_frames'] = opts['frames']
                infos[name]['closeups'] = []
            preview(arm, name, infos[name], actions[name])
        for o in list(bpy.data.objects):
            if o.name.startswith('Preview'):
                bpy.data.objects.remove(o)
    arm.animation_data.action = actions.get('Idle') or next(iter(actions.values()))
    bpy.context.scene.frame_set(0)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
    if opts['export']:
        export_glb(arm)
    print("done %.1fs" % (time.time() - t0))


if __name__ == '__main__':
    main()
