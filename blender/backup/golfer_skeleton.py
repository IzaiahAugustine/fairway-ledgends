"""Rest-pose skeleton for the golfer (Blender Z-up coordinates, metres).

The golfer faces -Y, his left side (and the target) is +X.
Rest pose is an A-pose with both hands curled into a golf grip.
Everything else (mesh building, rig, animation solver) reads joint
positions and hand grip frames from here.
"""
import math
from mathutils import Vector, Matrix

ARM_ABDUCTION = math.radians(42.0)   # arm angle from vertical in rest
ARM_FORWARD = 0.06                   # small forward component of upper arm
ELBOW_REST_FLEX = math.radians(14.0)
UPPER_ARM_LEN = 0.316
FOREARM_LEN = 0.268
HAND_LEN = 0.085
GRIP_ANGLE = math.radians(42.0)      # shaft vs hand long axis (diagonal grip)
GRIP_ALONG = 0.068                   # wrist -> grip centre along the hand
GRIP_NORMAL = 0.027                  # hand axis -> shaft centre, toward palm
GRIP_HALF_SPACING = 0.035            # club bone head is midway between hand grip centres
GRIP_RADIUS = 0.0125


def _n(v):
    v = Vector(v)
    v.normalize()
    return v


def _perp(v, axis):
    """Component of v perpendicular to axis, normalised."""
    v = Vector(v)
    a = _n(axis)
    return _n(v - a * v.dot(a))


def build_joints():
    J = {}
    J['root'] = Vector((0.0, 0.0, 0.0))
    J['pelvis'] = Vector((0.0, 0.010, 0.960))
    J['spine'] = Vector((0.0, 0.016, 1.080))
    J['chest'] = Vector((0.0, 0.022, 1.240))
    J['neck'] = Vector((0.0, 0.022, 1.462))
    J['head'] = Vector((0.0, 0.012, 1.605))
    J['head_end'] = Vector((0.0, 0.006, 1.790))
    for side, s in (('L', 1.0), ('R', -1.0)):
        J['clav_' + side] = Vector((0.028 * s, 0.002, 1.448))
        sh = Vector((0.180 * s, 0.022, 1.432))
        J['shoulder_' + side] = sh
        du = _n((math.sin(ARM_ABDUCTION) * s, -ARM_FORWARD, -math.cos(ARM_ABDUCTION)))
        elbow = sh + du * UPPER_ARM_LEN
        J['elbow_' + side] = elbow
        fwd = _perp((0, -1, 0), du)
        df = _n(du * math.cos(ELBOW_REST_FLEX) + fwd * math.sin(ELBOW_REST_FLEX))
        wrist = elbow + df * FOREARM_LEN
        J['wrist_' + side] = wrist
        J['hand_end_' + side] = wrist + df * HAND_LEN
        # legs
        J['hip_' + side] = Vector((0.090 * s, 0.000, 0.925))
        J['knee_' + side] = Vector((0.096 * s, -0.014, 0.505))
        J['ankle_' + side] = Vector((0.102 * s, 0.030, 0.090))
        J['toe_' + side] = Vector((0.118 * s, -0.105, 0.025))
    return J


JOINTS = build_joints()


def hand_frame(side, J=JOINTS):
    """Anatomical hand frame in rest: along (wrist->knuckles), palm normal,
    thumb direction. Returns dict of vectors plus the wrist position."""
    s = 1.0 if side == 'L' else -1.0
    wrist = J['wrist_' + side]
    along = _n(J['hand_end_' + side] - wrist)
    palm = _perp((-s, 0.0, 0.0), along)          # palm faces the body
    if side == 'L':
        thumb = _n(palm.cross(along))
    else:
        thumb = _n(along.cross(palm))
    return {'wrist': wrist, 'along': along, 'palm': palm, 'thumb': thumb}


def grip_frame(side, J=JOINTS):
    """4x4 matrix of the grip frame held by a hand in rest pose.
    Origin = grip (shaft) centre inside the hand, Y = shaft toward clubhead,
    Z = clubface normal (back of left hand / palm of right hand)."""
    hf = hand_frame(side, J)
    g = _n(hf['along'] * math.cos(GRIP_ANGLE) + hf['thumb'] * math.sin(GRIP_ANGLE))
    z = -hf['palm'] if side == 'L' else hf['palm'].copy()
    z = _perp(z, g)
    x = _n(g.cross(z))
    origin = hf['wrist'] + hf['along'] * GRIP_ALONG + hf['palm'] * GRIP_NORMAL
    M = Matrix.Identity(4)
    for i in range(3):
        M[i][0] = x[i]
        M[i][1] = g[i]
        M[i][2] = z[i]
        M[i][3] = origin[i]
    return M


def club_rest_matrix(J=JOINTS):
    """Rest matrix of the Club bone: head at grip point between the hands,
    in rest it hangs from the right hand. Y = shaft toward head, Z = face normal."""
    G = grip_frame('R', J)
    # right hand grip centre is GRIP_HALF_SPACING below the club bone head
    return G @ Matrix.Translation((0.0, -GRIP_HALF_SPACING, 0.0))


# Bone table: name, head key, tail key/vector, parent, connected
def bone_specs(J=JOINTS):
    specs = []
    specs.append(('Root', J['root'], J['root'] + Vector((0, 0, 0.15)), None, False))
    specs.append(('Hips', J['pelvis'], J['spine'], 'Root', False))
    specs.append(('Spine', J['spine'], J['chest'], 'Hips', True))
    specs.append(('Chest', J['chest'], J['neck'], 'Spine', True))
    specs.append(('Neck', J['neck'], J['head'], 'Chest', True))
    specs.append(('Head', J['head'], J['head_end'], 'Neck', True))
    for side in ('L', 'R'):
        specs.append(('Shoulder_' + side, J['clav_' + side], J['shoulder_' + side], 'Chest', False))
        specs.append(('UpperArm_' + side, J['shoulder_' + side], J['elbow_' + side], 'Shoulder_' + side, True))
        specs.append(('Forearm_' + side, J['elbow_' + side], J['wrist_' + side], 'UpperArm_' + side, True))
        specs.append(('Hand_' + side, J['wrist_' + side], J['hand_end_' + side], 'Forearm_' + side, True))
        specs.append(('Thigh_' + side, J['hip_' + side], J['knee_' + side], 'Hips', False))
        specs.append(('Shin_' + side, J['knee_' + side], J['ankle_' + side], 'Thigh_' + side, True))
        specs.append(('Foot_' + side, J['ankle_' + side], J['toe_' + side], 'Shin_' + side, True))
    C = club_rest_matrix(J)
    head = C.to_translation()
    y = Vector((C[0][1], C[1][1], C[2][1]))
    specs.append(('Club', head, head + y * 0.25, 'Root', False))
    return specs


BONE_NAMES = [b[0] for b in bone_specs()]
