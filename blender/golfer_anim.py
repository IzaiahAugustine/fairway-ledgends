"""Analytic pose solver and all animations.

Every animation is generated per frame in Python: torso FK from swing
parameters, the club placed from interpolated chest-relative keys, both
hands locked to the grip, two-bone IK for arms and legs (with pole vectors
and forearm twist distribution), then written as plain per-frame bone keys.
No constraints are used, so the exported glTF animations are exactly what
is computed here.
"""
import math
import bpy
from mathutils import Vector, Matrix, Quaternion

import golfer_clubs as K
from golfer_skeleton import grip_frame, GRIP_HALF_SPACING

BALL_R = 0.0213
FPS = 30


def rx(d):
    return Matrix.Rotation(math.radians(d), 3, 'X')


def ry(d):
    return Matrix.Rotation(math.radians(d), 3, 'Y')


def rz(d):
    return Matrix.Rotation(math.radians(d), 3, 'Z')


def rot_axis(axis, d):
    return Matrix.Rotation(math.radians(d), 3, Vector(axis).normalized())


def cols(x, y, z):
    return Matrix((x, y, z)).transposed()


def frame4(R, t):
    M = R.to_4x4()
    M.translation = t
    return M


def slerp_m(A, B, t):
    qa, qb = A.to_quaternion(), B.to_quaternion()
    if qa.dot(qb) < 0:
        qb.negate()
    return qa.slerp(qb, t).to_matrix()


def look_frame(fwd, up):
    """Rotation mapping rest head axes (forward -Y, up +Z) to fwd/up."""
    f = fwd.normalized()
    u = (up - f * up.dot(f)).normalized()
    y = -f
    x = y.cross(u)
    return cols(x, y, u)


def orthoframe(y, z):
    y = y.normalized()
    z = (z - y * z.dot(y)).normalized()
    return cols(y.cross(z), y, z)


# ====================================================================== rig
class Rig:
    ORDER = ['Root', 'Hips', 'Spine', 'Chest', 'Neck', 'Head',
             'Shoulder_L', 'UpperArm_L', 'Forearm_L', 'Hand_L',
             'Shoulder_R', 'UpperArm_R', 'Forearm_R', 'Hand_R',
             'Thigh_L', 'Shin_L', 'Foot_L', 'Thigh_R', 'Shin_R', 'Foot_R', 'Club']

    def __init__(self, arm_ob):
        self.ob = arm_ob
        bones = arm_ob.data.bones
        self.rest = {b.name: b.matrix_local.copy() for b in bones}
        self.rest3 = {n: m.to_3x3() for n, m in self.rest.items()}
        self.head = {b.name: b.head_local.copy() for b in bones}
        self.tail = {b.name: b.tail_local.copy() for b in bones}
        self.length = {b.name: b.length for b in bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in bones}
        self.off = {}
        for side, sgn in (('L', -1.0), ('R', 1.0)):
            G = grip_frame(side)
            self.off[side] = Matrix.Translation((0.0, sgn * GRIP_HALF_SPACING, 0.0)) @ G.inverted() @ self.rest['Hand_' + side]
        self.wrist_local = {s: self.off[s].translation.copy() for s in 'LR'}
        # rest limb frames
        self.limb_rest = {}
        for side in 'LR':
            for up, lo in (('UpperArm_', 'Forearm_'), ('Thigh_', 'Shin_')):
                S, E, W = self.head[up + side], self.head[lo + side], self.tail[lo + side]
                u = (W - S).normalized()
                v = (E - S) - u * (E - S).dot(u)
                v.normalize()
                n = v.cross(u).normalized()
                self.limb_rest[up + side] = cols(n, (E - S).normalized(), n.cross((E - S).normalized()))
                self.limb_rest[lo + side] = cols(n, (W - E).normalized(), n.cross((W - E).normalized()))
        self.arm_len = self.length['UpperArm_L'] + self.length['Forearm_L']
        self.eye_rest = Vector((0.0, -0.082, 1.69))

    # -------------------------------------------------- helpers
    def pm(self, name, R, head):
        return frame4(R @ self.rest3[name], head)

    def child_head(self, name, P):
        par = self.parent[name]
        return P[par] @ (self.rest[par].inverted() @ self.head[name])

    def delta(self, name, P):
        return P[name].to_3x3() @ self.rest3[name].transposed()

    @staticmethod
    def two_bone(S, W, a, b, pole):
        dv = W - S
        d = dv.length
        d = min(max(d, abs(a - b) + 1e-4), (a + b) * 0.9995)
        u = dv.normalized()
        v = pole - u * pole.dot(u)
        if v.length < 1e-6:
            v = Vector((0, 0, -1)) - u * (-u.z)
        v.normalize()
        ca = (a * a + d * d - b * b) / (2 * a * d)
        sa = math.sqrt(max(0.0, 1 - ca * ca))
        E = S + (u * ca + v * sa) * a
        W2 = S + u * d
        n = v.cross(u).normalized()
        return E, W2, n

    # -------------------------------------------------- torso part
    def solve_torso(self, st):
        P = {'Root': self.rest['Root'].copy()}
        P['Hips'] = self.pm('Hips', st['R_hips'], st['pel'])
        for name in ('Spine', 'Chest', 'Neck', 'Head'):
            P[name] = self.pm(name, st['R_' + name.lower()], self.child_head(name, P))
        for side in 'LR':
            n = 'Shoulder_' + side
            P[n] = self.pm(n, st['R_clav_' + side], self.child_head(n, P))
        return P

    def shoulder(self, P, side):
        return self.child_head('UpperArm_' + side, P)

    def hand_from_club(self, club, side):
        return club @ self.off[side]

    def solve_limbs(self, P, st):
        for side in 'LR':
            Mh = st['hand_' + side]
            S = self.shoulder(P, side)
            a, b = self.length['UpperArm_' + side], self.length['Forearm_' + side]
            if Mh is not None:
                W = Mh.translation
            else:
                W = st['wrist_' + side]
            E, W2, n = self.two_bone(S, W, a, b, st['pole_' + side])
            yu = (E - S).normalized()
            Fu = cols(n, yu, n.cross(yu))
            Ru = Fu @ self.limb_rest['UpperArm_' + side].transposed()
            P['UpperArm_' + side] = self.pm('UpperArm_' + side, Ru, S)
            yf = (W2 - E).normalized()
            Ff = cols(n, yf, n.cross(yf))
            Rf = Ff @ self.limb_rest['Forearm_' + side].transposed()
            fo_full = Rf @ self.rest3['Forearm_' + side]
            if Mh is None:
                wr = st.get('wrist_rot_' + side, Matrix.Identity(3))
                h3 = fo_full @ wr @ (self.rest3['Forearm_' + side].transposed() @ self.rest3['Hand_' + side])
            else:
                h3 = Mh.to_3x3()
            rel_rest = self.rest3['Forearm_' + side].transposed() @ self.rest3['Hand_' + side]
            X = fo_full.transposed() @ h3 @ rel_rest.transposed()
            q = X.to_quaternion()
            if q.w < 0:
                q.negate()
            tau = 2 * math.atan2(q.y, q.w)
            fo_full = fo_full @ Matrix.Rotation(tau * 0.55, 3, 'Y')
            P['Forearm_' + side] = frame4(fo_full, E)
            P['Hand_' + side] = frame4(h3, W2)
            # legs
            Mf = st['foot_' + side]
            H = self.child_head('Thigh_' + side, P)
            a, b = self.length['Thigh_' + side], self.length['Shin_' + side]
            Kn, A2, n = self.two_bone(H, Mf.translation, a, b, st['knee_' + side])
            yt = (Kn - H).normalized()
            Rt = cols(n, yt, n.cross(yt)) @ self.limb_rest['Thigh_' + side].transposed()
            P['Thigh_' + side] = self.pm('Thigh_' + side, Rt, H)
            ys = (A2 - Kn).normalized()
            Rs = cols(n, ys, n.cross(ys)) @ self.limb_rest['Shin_' + side].transposed()
            P['Shin_' + side] = self.pm('Shin_' + side, Rs, Kn)
            P['Foot_' + side] = frame4(Mf.to_3x3(), A2)
        P['Club'] = st['club']
        return P

    def forearm_twist(self, P, side):
        fo = P['Forearm_' + side].to_3x3()
        h3 = P['Hand_' + side].to_3x3()
        rel_rest = self.rest3['Forearm_' + side].transposed() @ self.rest3['Hand_' + side]
        X = fo.transposed() @ h3 @ rel_rest.transposed()
        q = X.to_quaternion()
        if q.w < 0:
            q.negate()
        tw = 2 * math.degrees(math.atan2(q.y, q.w))
        sw = math.degrees(2 * math.acos(min(1.0, math.sqrt(q.w * q.w + q.y * q.y))))
        return tw, sw

    def to_basis(self, P):
        out = {}
        for name in self.ORDER:
            par = self.parent[name]
            if par is None:
                B = self.rest[name].inverted() @ P[name]
            else:
                B = (self.rest[par].inverted() @ self.rest[name]).inverted() @ P[par].inverted() @ P[name]
            out[name] = B
        return out


# ====================================================================== interpolation
class Track:
    """Non-uniform Catmull-Rom (cubic Hermite) over keys; flat tangents on demand."""

    def __init__(self, keys, flat=()):
        self.keys = sorted(keys, key=lambda k: k[0])
        self.flat = set(flat)

    def _tan(self, i):
        ks = self.keys
        f, v = ks[i]
        if f in self.flat or i == 0 or i == len(ks) - 1:
            return v * 0.0
        f0, v0 = ks[i - 1]
        f1, v1 = ks[i + 1]
        d0 = (v - v0) / (f - f0)
        d1 = (v1 - v) / (f1 - f)
        return (d0 * (f1 - f) + d1 * (f - f0)) / (f1 - f0)

    def __call__(self, f):
        ks = self.keys
        if f <= ks[0][0]:
            return ks[0][1].copy() if hasattr(ks[0][1], 'copy') else ks[0][1]
        if f >= ks[-1][0]:
            return ks[-1][1].copy() if hasattr(ks[-1][1], 'copy') else ks[-1][1]
        for i in range(len(ks) - 1):
            f0, v0 = ks[i]
            f1, v1 = ks[i + 1]
            if f0 <= f <= f1:
                h = f1 - f0
                t = (f - f0) / h
                m0, m1 = self._tan(i) * h, self._tan(i + 1) * h
                t2, t3 = t * t, t * t * t
                return v0 * (2 * t3 - 3 * t2 + 1) + m0 * (t3 - 2 * t2 + t) + v1 * (-2 * t3 + 3 * t2) + m1 * (t3 - t2)


# ====================================================================== swing description
def torso_rots(p):
    hy, ht, hb = p['hip']
    cy, ct, cs = p['chest']
    R_hips = rz(hy) @ rx(ht) @ ry(hb)
    # spine axis tilted forward (ct) and toward the target (+cs) / away (-cs); shoulders turn about it
    R_chest = ry(cs) @ rx(ct) @ rz(cy)
    R_spine = slerp_m(R_hips, R_chest, 0.5)
    return R_hips, R_spine, R_chest


def clav_rots(R_chest, c):
    eL, pL, eR, pR = c
    return R_chest @ rz(-pL) @ ry(-eL), R_chest @ rz(pR) @ ry(eR)


def foot_matrix(rig, side, ank, yaw, lift=0.0, roll=0.0):
    """Planted foot: ankle position on the stance, flare yaw (deg, + = toe out),
    heel lift (deg) pivoting about the toe, roll (deg, + = onto outside edge)."""
    s = 1.0 if side == 'L' else -1.0
    rest3 = rig.rest3['Foot_' + side]
    head = rig.head['Foot_' + side]
    toe = rig.tail['Foot_' + side]
    rest_flare = math.degrees(math.atan2(s * (toe.x - head.x), -(toe.y - head.y)))
    R0 = rz(s * (yaw - rest_flare))
    A0 = Vector(ank)
    toe_tip = head + (toe - head) * 1.42
    toe_tip.z = 0.012
    d = toe_tip - head
    fwd = R0 @ Vector((d.x, d.y, 0.0))
    piv = A0 + R0 @ (toe_tip - head)
    lat = fwd.normalized().cross(Vector((0, 0, 1)))
    Rl = rot_axis(lat, -lift) if lift else Matrix.Identity(3)
    Rr = rot_axis(fwd, roll * s) if roll else Matrix.Identity(3)
    R = Rr @ Rl @ R0
    ankle = piv + Rr @ Rl @ (A0 - piv)
    return frame4(R @ rest3, ankle)


class Pose:
    """Key-frame parameter set (deep copied between keys)."""

    def __init__(self, **kw):
        self.p = dict(kw)

    def copy(self, **kw):
        d = {}
        for k, v in self.p.items():
            d[k] = v.copy() if hasattr(v, 'copy') else (tuple(v) if isinstance(v, (list, tuple)) else v)
        d.update(kw)
        return Pose(**d)

    def __getitem__(self, k):
        return self.p[k]


SCALAR3 = ('hip', 'chest')


class Animator:
    def __init__(self, rig):
        self.rig = rig

    # ---------------------------------------------------- per-key torso state
    def torso_state(self, p):
        R_hips, R_spine, R_chest = torso_rots(p)
        st = {'pel': Vector(p['pel']), 'R_hips': R_hips, 'R_spine': R_spine, 'R_chest': R_chest}
        cL, cR = clav_rots(R_chest, p['clav'])
        st['R_clav_L'], st['R_clav_R'] = cL, cR
        # head look-at (two passes for the eye position)
        st['R_neck'] = R_chest
        st['R_head'] = R_chest
        gaze = Vector(p['gaze'])
        for _ in range(2):
            P = self.rig.solve_torso(st)
            eye = P['Head'] @ (self.rig.rest['Head'].inverted() @ self.rig.eye_rest)
            up = (R_chest @ Vector((0, 0, 1))) * 0.35 + Vector((0, 0, 1)) * 0.65
            up = rot_axis(gaze - eye, p.get('head_roll', 0.0)) @ up
            R_head = look_frame(gaze - eye, up)
            st['R_head'] = R_head
            st['R_neck'] = slerp_m(R_chest, R_head, 0.45)
        P = self.rig.solve_torso(st)
        return st, P

    @staticmethod
    def chest_frame(P, rig):
        R = P['Chest'].to_3x3() @ rig.rest3['Chest'].transposed()
        return R, P['Chest'].translation.copy()


# ====================================================================== club helpers
def club_world(name, fc_target, aim=0.0, lean=0.0, upright=0.0):
    """Club bone matrix with the face centre at fc_target. lean (+ = shaft toward
    target, delofts), upright (+ = hands higher), aim (+ = face closed/left)."""
    A_from_bone = K.A_to_bone(name).inverted()
    R = rz(aim) @ ry(lean) @ rx(upright)
    fcA = K.FACE_CENTERS[name]
    t = Vector(fc_target) - R @ fcA
    W_from_A = frame4(R, t)
    return W_from_A @ A_from_bone


def club_address(name, ball, aim=0.0, lean=0.0, gap=0.004, upright=0.0):
    """Sole on the ground (under the face centre), face just behind the ball."""
    R = rz(aim) @ ry(lean) @ rx(upright)
    fcA = K.FACE_CENTERS[name]
    nrm = R @ Vector((1, 0, 0))
    fc_w = Vector(ball) - nrm * (BALL_R + gap)
    # rest the lowest point of the head on the ground
    fc_w.z = -min((R @ (p - fcA)).z for p in K.HEAD_POINTS[name])
    return club_world(name, fc_w, aim, lean, upright)


def face_center_world(club_M, name):
    return club_M @ K.face_center_local(name)


def face_normal_world(club_M, name):
    return (club_M.to_3x3() @ K.face_normal_local(name)).normalized()


# ====================================================================== swing builder
CHANNELS = ('pel', 'hip', 'chest', 'clav', 'gaze', 'head_roll', 'footL', 'footR', 'kneeL', 'kneeR')


class Builder:
    """Collects key poses for one animation and produces per-frame bone poses."""

    def __init__(self, rig, name, club, last, stance, flat=()):
        self.rig = rig
        self.anim = Animator(rig)
        self.name = name
        self.club = club
        self.last = last
        self.stance = stance          # {'L': ankle Vector, 'R': ankle Vector}
        self.keys = []                # (frame, Pose, club_spec, poles)
        self.flat = set(flat)
        self.override = {}            # frame -> exact club matrix (impact)

    def add(self, frame, pose, club, poles):
        self.keys.append((frame, pose, club, poles))

    # ---------------------------------------------- club spec -> world matrix
    def arm_cost(self, P, side, Mh, pole):
        rig = self.rig
        S = rig.shoulder(P, side)
        a, b = rig.length['UpperArm_' + side], rig.length['Forearm_' + side]
        E, W2, n = rig.two_bone(S, Mh.translation, a, b, pole)
        yf = (W2 - E).normalized()
        Rf = cols(n, yf, n.cross(yf)) @ rig.limb_rest['Forearm_' + side].transposed()
        fo = Rf @ rig.rest3['Forearm_' + side]
        rel_rest = rig.rest3['Forearm_' + side].transposed() @ rig.rest3['Hand_' + side]
        X = fo.transposed() @ Mh.to_3x3() @ rel_rest.transposed()
        q = X.to_quaternion()
        if q.w < 0:
            q.negate()
        tw = 2 * math.degrees(math.atan2(q.y, q.w))
        sw = math.degrees(2 * math.acos(min(1.0, math.sqrt(q.w * q.w + q.y * q.y))))
        excess = max(0.0, (Mh.translation - S).length - (a + b) * 0.999)
        return tw, sw, excess

    def lever(self, P, Rc, side, arm_dir, reach, shaft, poles, roll_bias=0.0, face_hint=None, wrist=None,
              arms='LR', project=None, perp=None):
        rig = self.rig
        S = rig.shoulder(P, side)
        if wrist is not None:
            W = Vector(wrist)
            if project is not None:      # keep the direction, put the wrist at a given arm extension
                W = S + (W - S).normalized() * rig.arm_len * project
        else:
            W = S + (Rc @ Vector(arm_dir)).normalized() * rig.arm_len * reach
        y = Vector(shaft).normalized()
        if perp is not None:
            # make the shaft (90 - perp) degrees from the lead arm, keeping its heading
            a = (W - S).normalized()
            yp = (y - a * y.dot(a)).normalized()
            y = (yp * math.cos(math.radians(perp)) - a * math.sin(math.radians(perp))).normalized()
        ref = Vector((0, 0, 1)) if abs(y.z) < 0.9 else Vector((1, 0, 0))
        z0 = (ref - y * ref.dot(y)).normalized()

        def make(psi):
            R = orthoframe(y, rot_axis(y, psi) @ z0)
            return frame4(R, W - R @ rig.wrist_local[side])

        def cost(psi):
            club = make(psi)
            c = 0.0
            for s2, wgt in (('L', 1.0), ('R', 0.7)):
                if s2 not in arms:
                    continue
                tw, sw, ex = self.arm_cost(P, s2, club @ rig.off[s2], poles[s2])
                c += wgt * (tw * tw + 0.35 * sw * sw) + 4e6 * ex * ex
            if face_hint is not None:
                z = club.to_3x3().col[2]
                c += 400.0 * (1.0 - z.dot(Vector(face_hint).normalized()))
            return c

        best = min(range(0, 360, 4), key=cost)
        b2 = min([best + d * 0.5 for d in range(-8, 9)], key=cost)
        return make(b2 + roll_bias)

    def resolve(self):
        """Turn key specs into chest-relative channels."""
        rig = self.rig
        tracks = {c: [] for c in CHANNELS + ('club_p', 'club_y', 'club_z', 'poleL', 'poleR')}
        self.key_clubs = {}
        for frame, pose, club, poles in self.keys:
            st, P = self.anim.torso_state(pose.p)
            Rc, Oc = Animator.chest_frame(P, rig)
            pw = {}
            for s in 'LR':
                kind, v = poles[s]
                pw[s] = Vector(v) if kind == 'world' else Rc @ Vector(v)
            kind = club[0]
            if kind == 'world':
                M = club[1]
            elif kind == 'lever':
                _, side, arm_dir, reach, shaft = club[:5]
                extra = club[5] if len(club) > 5 else {}
                M = self.lever(P, Rc, side, arm_dir, reach, shaft, pw, **extra)
            elif kind == 'wrist':
                _, side, W, shaft = club[:4]
                extra = dict(club[4]) if len(club) > 4 else {}
                M = self.lever(P, Rc, side, None, 1.0, shaft, pw, wrist=W, **extra)
            elif kind == 'chestrel':
                _, cp, cy, cz = club
                M = frame4(Rc @ orthoframe(cy, cz), Oc + Rc @ cp)
            else:
                raise ValueError(kind)
            self.key_clubs[frame] = M
            RcT = Rc.transposed()
            tracks['club_p'].append((frame, RcT @ (M.translation - Oc)))
            tracks['club_y'].append((frame, RcT @ M.to_3x3().col[1]))
            tracks['club_z'].append((frame, RcT @ M.to_3x3().col[2]))
            tracks['poleL'].append((frame, RcT @ pw['L']))
            tracks['poleR'].append((frame, RcT @ pw['R']))
            for c in CHANNELS:
                v = pose.p.get(c, 0.0)
                tracks[c].append((frame, Vector(v) if isinstance(v, (tuple, list, Vector)) else float(v)))
        self.tracks = {c: Track(k, self.flat) for c, k in tracks.items()}

    # ---------------------------------------------- per frame
    def state(self, f):
        rig = self.rig
        T = self.tracks
        p = {c: T[c](f) for c in CHANNELS}
        st, P = self.anim.torso_state(p)
        Rc, Oc = Animator.chest_frame(P, rig)
        if f in self.override:
            club = self.override[f].copy()
        else:
            y = Rc @ T['club_y'](f)
            z = Rc @ T['club_z'](f)
            R = orthoframe(y, z)
            club = frame4(R, Oc + Rc @ T['club_p'](f))
        st['pole_L'] = Rc @ T['poleL'](f)
        st['pole_R'] = Rc @ T['poleR'](f)
        shifted = Vector()
        if f not in self.override:
            for _ in range(4):
                moved = False
                for s in 'LR':
                    S = rig.shoulder(P, s)
                    W = (club @ rig.off[s]).translation
                    d = (W - S).length
                    lim = rig.arm_len * 0.9985
                    if d > lim:
                        delta = (W - S).normalized() * (d - lim)
                        club.translation = club.translation - delta
                        shifted += delta
                        moved = True
                if not moved:
                    break
        st['club'] = club
        st['club_shift'] = shifted.length
        st['hand_L'] = rig.hand_from_club(club, 'L')
        st['hand_R'] = rig.hand_from_club(club, 'R')
        for s in 'LR':
            fp = p['foot' + s]
            st['foot_' + s] = foot_matrix(rig, s, self.stance[s], fp[0], fp[1], fp[2])
            st['knee_' + s] = p['knee' + s]
        P = rig.solve_limbs(P, st)
        return P, st

    def frames(self):
        self.resolve()
        return [self.state(f)[0] for f in range(self.last + 1)]


# ====================================================================== baking
def bake(rig, name, poses):
    ob = rig.ob
    if ob.animation_data is None:
        ob.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ob.animation_data.action = act
    n = len(poses)
    data = {b: {'loc': [], 'rot': []} for b in Rig.ORDER}
    prev = {}
    for P in poses:
        B = rig.to_basis(P)
        for b in Rig.ORDER:
            loc, q, _ = B[b].decompose()
            if b in prev and prev[b].dot(q) < 0:
                q.negate()
            prev[b] = q
            data[b]['loc'].append(loc)
            data[b]['rot'].append(q)
    for b in Rig.ORDER:
        for path, vals, nidx in (('location', data[b]['loc'], 3), ('rotation_quaternion', data[b]['rot'], 4)):
            for i in range(nidx):
                fc = act.fcurve_ensure_for_datablock(ob, 'pose.bones["%s"].%s' % (b, path), index=i, group_name=b)
                fc.keyframe_points.add(n)
                co = []
                for f in range(n):
                    co += [float(f), float(vals[f][i])]
                fc.keyframe_points.foreach_set('co', co)
                for kp in fc.keyframe_points:
                    kp.interpolation = 'LINEAR'
                fc.update()
    act.frame_range = (0, n - 1)
    act.use_frame_range = True
    return act
