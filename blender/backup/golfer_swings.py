"""Swing and gesture definitions (key poses), fitting and generation.

Coordinates: Blender world, golfer faces -Y, target +X, up +Z, root at origin.
Chest-frame vectors: X = golfer's left, Y = back, Z = up the spine.
Club keys are authored as world wrist targets + shaft directions (grip->head);
the club roll is chosen to minimise forearm twist / wrist bend, address and
impact are exact world placements and the posture is fitted so both arms reach.
"""
import math
from mathutils import Vector, Matrix

import golfer_anim as A
import golfer_clubs as K
from golfer_anim import Builder, Pose, Animator, rx, ry, rz, rot_axis, frame4, orthoframe, BALL_R, Track


def V(*a):
    return Vector(a)


class SwingBuilder(Builder):
    def reach(self, pose, club_M):
        st, P = self.anim.torso_state(pose.p)
        out = {}
        for s in 'LR':
            S = self.rig.shoulder(P, s)
            W = (club_M @ self.rig.off[s]).translation
            out[s] = (W - S).length / self.rig.arm_len
        return out


def fit_posture(sb, pose, M, target_L, max_R, tilt_range=(15.0, 62.0)):
    """Chest tilt so the left arm reaches target_L; then right clavicle
    protraction, a little chest opening and right side-bend until the right arm
    is within max_R (tilt is re-fitted after every adjustment)."""
    p = pose.p

    def fit_tilt():
        lo, hi = tilt_range
        for _ in range(30):
            mid = (lo + hi) * 0.5
            c = p['chest']
            p['chest'] = V(c[0], mid, c[2])
            if sb.reach(pose, M)['L'] > target_L:
                lo = mid
            else:
                hi = mid

    knobs = [('clav', 3, 1.5, 30.0), ('chest', 0, 1.0, p['chest'][0] + 6.0), ('chest', 2, -1.5, p['chest'][2] - 10.0)]
    fit_tilt()
    for key, idx, step, limit in knobs:
        for _ in range(40):
            if sb.reach(pose, M)['R'] <= max_R:
                break
            v = p[key].copy()
            if (step > 0 and v[idx] + step > limit) or (step < 0 and v[idx] + step < limit):
                break
            v[idx] += step
            p[key] = v
            fit_tilt()
    return sb.reach(pose, M)


def fit_impact(sb, pose, M, target_L, target_R, yaw_range=(-10.0, 40.0)):
    """Chest yaw (opening) trades left vs right arm extension; tilt fits the left."""
    p = pose.p
    lo, hi = yaw_range
    for _ in range(22):
        mid = (lo + hi) * 0.5
        c = p['chest']
        p['chest'] = V(mid, c[1], c[2])
        fit_posture(sb, pose, M, target_L, 9.0)
        if sb.reach(pose, M)['R'] < target_R:
            hi = mid      # opening brings the right shoulder toward the hands: close up
        else:
            lo = mid
    return sb.reach(pose, M)


def square_face(club, make):
    """Iterate aim so the face normal points straight down the target line."""
    aim = 0.0
    for _ in range(4):
        M = make(aim)
        n = A.face_normal_world(M, club)
        ang = math.degrees(math.atan2(n.y, n.x))
        aim -= ang
    return make(aim), aim


def impact_club(club, ball, lean, upright=0.0, press=0.75, lift=0.0):
    def make(aim):
        M0 = A.club_world(club, ball, aim, lean, upright)
        n = A.face_normal_world(M0, club)
        fc = ball - n * (BALL_R * press) + V(0, 0, lift)
        return A.club_world(club, fc, aim, lean, upright)
    return square_face(club, make)[0]


def address_club(club, ball, lean, gap=0.006, upright=0.0):
    def make(aim):
        return A.club_address(club, ball, aim, lean, gap, upright)
    return square_face(club, make)[0]


# ---------------------------------------------------------------- full swing tables
FULL = {
    'Driver': dict(club='Driver', half=0.255, ball=V(0.150, -0.86, 0.045), lean=-2.0, ilean=0.5, iup=-10.0, aup=-11.0,
                   ilift=0.006, press=0.70, pel=V(-0.035, 0.085, 0.952), hip_t=24.0, tilt=36.0, side=-12.0,
                   timing=(30, 40, 70, 80), turn=1.0,
                   back=[(10, V(-0.30, -0.24, 0.95), V(-0.98, 0.15, 0.00)),
                         (20, V(-0.60, -0.10, 1.25), V(-0.30, 0.40, 0.87)),
                         (30, V(-0.46, -0.04, 1.62), V(1.00, 0.10, 0.02)),
                         (35.5, V(-0.52, -0.13, 1.22), V(-0.20, 0.45, 0.87)),
                         (38.2, V(-0.20, -0.23, 0.97), V(-0.95, 0.30, -0.03))],
                   through=[(43, V(0.42, -0.32, 0.98), V(0.95, -0.22, 0.20)),
                            (47, V(0.55, -0.16, 1.28), V(0.22, 0.30, 0.93)),
                            (55, V(0.35, 0.02, 1.60), V(-0.45, 0.45, 0.77)),
                            (70, V(0.0, 0.15, 1.74), V(-0.55, 0.45, -0.70))]),
    'Iron': dict(club='Iron', half=0.205, ball=V(0.030, -0.685, BALL_R), lean=4.0, ilean=8.0, iup=1.0, aup=-3.0,
                 ilift=0.004, press=0.75, pel=V(-0.010, 0.080, 0.948), hip_t=27.0, tilt=41.0, side=-8.0,
                 timing=(30, 40, 70, 80), turn=1.0,
                 back=[(10, V(-0.26, -0.20, 0.90), V(-0.97, 0.18, -0.05)),
                       (20, V(-0.52, -0.06, 1.20), V(-0.28, 0.40, 0.87)),
                       (30, V(-0.42, -0.02, 1.58), V(0.93, 0.16, -0.24)),
                       (35.5, V(-0.46, -0.10, 1.17), V(-0.20, 0.45, 0.87)),
                       (38.2, V(-0.16, -0.19, 0.93), V(-0.95, 0.30, -0.06))],
                 through=[(43, V(0.36, -0.27, 0.92), V(0.95, -0.20, 0.22)),
                          (47, V(0.48, -0.12, 1.22), V(0.22, 0.30, 0.93)),
                          (55, V(0.30, 0.04, 1.55), V(-0.45, 0.45, 0.77)),
                          (70, V(-0.01, 0.14, 1.70), V(-0.55, 0.45, -0.70))]),
    'Wedge': dict(club='Wedge', half=0.175, ball=V(0.005, -0.640, BALL_R), lean=5.0, ilean=9.0, iup=1.0, aup=-3.0,
                  ilift=0.006, press=0.75, pel=V(-0.002, 0.078, 0.946), hip_t=28.0, tilt=43.0, side=-7.0,
                  timing=(26, 36, 62, 72), turn=0.8,
                  back=[(8, V(-0.24, -0.18, 0.88), V(-0.97, 0.20, -0.06)),
                        (17, V(-0.48, -0.10, 1.02), V(-0.60, 0.35, 0.72)),
                        (26, V(-0.42, -0.02, 1.40), V(0.15, 0.42, 0.89)),
                        (31, V(-0.38, -0.11, 1.10), V(-0.40, 0.42, 0.81)),
                        (33.9, V(-0.14, -0.18, 0.90), V(-0.95, 0.28, -0.06))],
                  through=[(39, V(0.34, -0.25, 0.90), V(0.95, -0.20, 0.22)),
                           (43, V(0.45, -0.14, 1.15), V(0.30, 0.30, 0.90)),
                           (50, V(0.38, -0.03, 1.35), V(0.00, 0.40, 0.92)),
                           (62, V(0.30, 0.02, 1.42), V(-0.25, 0.45, 0.86))]),
}


def _blend_tables(a, b, t):
    out = []
    for (fa, wa, sa), (fb, wb, sb) in zip(a, b):
        out.append((fa, wa.lerp(wb, t), sa.lerp(sb, t).normalized()))
    return out


FULL['Wood'] = dict(FULL['Driver'], club='Wood', half=0.235, ball=V(0.100, -0.790, BALL_R), lean=0.0, ilean=3.0,
                    iup=-2.0, aup=-7.0, ilift=0.002, press=0.75, pel=V(-0.025, 0.083, 0.950), hip_t=25.0, tilt=38.0, side=-10.0,
                    back=_blend_tables(FULL['Driver']['back'], FULL['Iron']['back'], 0.45),
                    through=_blend_tables(FULL['Driver']['through'], FULL['Iron']['through'], 0.45))


# torso progression for the 9 keys after address (fractions of the swing phase)
#   pel offset, hip(yaw,dtilt,bank), chest(yaw,dtilt,dside), clav, kneeL, kneeR, footL(yaw,lift,roll), footR
def _torso_keys(cfg):
    k = cfg['turn']
    T, s0 = cfg['tilt'], cfg['side']
    ht = cfg['hip_t']
    fin_scale = 1.0 if k >= 1.0 else 0.85
    return [
        dict(pel=V(-0.015, 0.002, 0.000), hip=V(-14 * k, 0, -2), chest=V(-36 * k, -1, 3),
             clav=Vector((6, 14, 4, 8)), kneeL=V(0.10, -1, 0), kneeR=V(-0.25, -1, 0)),
        dict(pel=V(-0.025, 0.006, 0.002), hip=V(-32 * k, -1, -1), chest=V(-68 * k, -3, 6),
             clav=Vector((6, 20, 4, 4)), kneeL=V(-0.15, -1, 0), kneeR=V(-0.25, -1, 0), footL=V(18, 2 * k, 0)),
        dict(pel=V(-0.030, 0.010, 0.004), hip=V(-46 * k, -2, 0), chest=V(-92 * k, -5, 9),
             clav=Vector((5, 24, 6, 0)), kneeL=V(-0.40, -1, -0.05), kneeR=V(-0.20, -1, 0), footL=V(18, 4 * k, 0)),
        dict(pel=V(0.035, 0.004, -0.004), hip=V(-8 * k, 0, -2), chest=V(-58 * k, -2, -2),
             clav=Vector((4, 16, 4, 6)), kneeL=V(0.15, -1, 0), kneeR=V(0.10, -1, 0)),
        dict(pel=V(0.060, 0.000, -0.004), hip=V(18, -1, 1), chest=V(-22, -2, -9),
             clav=Vector((4, 10, 3, 10)), kneeL=V(0.25, -1, 0), kneeR=V(0.35, -1, 0), footR=V(6, 4, 0)),
        # impact (tilt/side are fitted)
        dict(pel=V(0.070, -0.002, -0.002), hip=V(38, -2, 3), chest=V(20, 0, -14),
             clav=Vector((3, 6, 2, 14)), kneeL=V(0.35, -1, 0.15), kneeR=V(0.55, -1, 0), footR=V(8, 10, 0)),
        dict(pel=V(0.085, -0.004, 0.006), hip=V(55, -6, 3), chest=V(45, -4, -16),
             clav=Vector((3, 4, 2, 20)), kneeL=V(0.35, -1, 0.2), kneeR=V(0.80, -1, 0), footR=V(10, 18, 0),
             gaze_off=V(0.10, 0, 0)),
        dict(pel=V(0.100, -0.010, 0.015), hip=V(70, -10, 2), chest=V(85, -10, -14),
             clav=Vector((4, 0, 4, 22)), kneeL=V(0.40, -1, 0.2), kneeR=V(1.0, -0.6, 0), footR=V(14, 30, 0),
             gaze=V(4.0, -0.6, 0.6)),
        dict(pel=V(0.115, -0.020, 0.025), hip=V(85 * fin_scale, 0, 1), chest=V(105 * fin_scale, 0, -10),
             tilt_abs=18.0, hip_abs=ht - 16,
             clav=Vector((10, 0, 8, 22)), kneeL=V(0.5, -1, 0.1), kneeR=V(1.0, -0.2, 0),
             footR=V(25, 55 * fin_scale, 0), footL=V(18, 0, 6), gaze=V(25, -2.0, 3.0)),
        dict(pel=V(0.125, -0.030, 0.035), hip=V(92 * fin_scale, 0, 0), chest=V(112 * fin_scale, 0, -8),
             tilt_abs=6.0 if k >= 1.0 else 12.0, hip_abs=6.0 if k >= 1.0 else 10.0,
             clav=Vector((12, 2, 8, 22)), kneeL=V(0.6, -1, 0), kneeR=V(1.0, 0.0, 0),
             footR=V(30, 70 * fin_scale, 0), footL=V(18, 0, 8), gaze=V(30, -3.0, 4.0)),
    ]


def build_full_swing(rig, kind):
    cfg = FULL[kind]
    club = cfg['club']
    top, imp, fin, last = cfg['timing']
    h = cfg['half']
    stance = {'L': V(h, 0.035, 0.09), 'R': V(-h, 0.035, 0.09)}
    sb = SwingBuilder(rig, 'Swing_' + kind, club, last, stance, flat=(0, top, fin, last))
    ball = cfg['ball'].copy()

    addr = Pose(pel=cfg['pel'].copy(), hip=V(0, cfg['hip_t'], -2), chest=V(0, cfg['tilt'], cfg['side']),
                clav=Vector((6, 10, 4, 14)), gaze=ball.copy(), head_roll=0.0,
                footL=V(18, 0, 0), footR=V(6, 0, 0), kneeL=V(0.30, -1, 0.0), kneeR=V(-0.25, -1, 0.0))
    M_addr = address_club(club, ball, cfg['lean'], upright=cfg.get('aup', 0.0))
    r_addr = fit_posture(sb, addr, M_addr, 0.97, 0.985)
    polesA = {'L': ('chest', V(0.55, 0.45, -1.0)), 'R': ('chest', V(-0.45, 0.55, -1.0))}
    sb.add(0, addr, ('world', M_addr), polesA)

    tk = _torso_keys(cfg)
    T0 = addr.p['chest'][1]
    S0 = addr.p['chest'][2]
    poles = [
        {'L': ('chest', V(0.5, 0.5, -1.0)), 'R': ('chest', V(-0.3, 0.7, -1.0))},
        {'L': ('world', V(0.0, 0.4, -1.0)), 'R': ('world', V(0.0, 0.5, -1.0))},
        {'L': ('world', V(-0.2, 0.3, -1.0)), 'R': ('world', V(0.15, 0.2, -1.0))},
        {'L': ('world', V(0.1, 0.5, -1.0)), 'R': ('world', V(0.1, 0.4, -1.0))},
        {'L': ('chest', V(0.6, 0.4, -1.0)), 'R': ('chest', V(-0.3, 0.6, -1.0))},
        {'L': ('chest', V(0.7, 0.4, -1.0)), 'R': ('chest', V(-0.35, 0.55, -1.0))},
        {'L': ('chest', V(0.4, 0.4, -1.0)), 'R': ('chest', V(-0.6, 0.5, -1.0))},
        {'L': ('world', V(0.2, -0.3, -1.0)), 'R': ('world', V(0.0, 0.3, -1.0))},
        {'L': ('world', V(0.3, -0.5, -1.0)), 'R': ('world', V(0.5, 0.4, -1.0))},
        {'L': ('world', V(0.2, -0.6, -1.0)), 'R': ('world', V(0.3, 0.5, -1.0))},
    ]
    proj_back = cfg.get('proj_back', (0.975, 0.985, 0.985, 0.975, 0.98))
    proj_thru = cfg.get('proj_thru', (0.95, 0.94, None, None))
    specs = [('L', f, w, s, pj) for (f, w, s), pj in zip(cfg['back'], proj_back)] + \
            [('imp', imp, None, None, None)] + \
            [('R', f, w, s, pj) for (f, w, s), pj in zip(cfg['through'], proj_thru)]
    reach_imp = None
    M_imp = None
    for i, (side, f, w, shaft, pj) in enumerate(specs):
        t = tk[i]
        hip = t['hip']
        ch = t['chest']
        hip_tilt = t.get('hip_abs', cfg['hip_t'] + (hip[1] or 0.0))
        tilt = t.get('tilt_abs', T0 + (ch[1] or 0.0))
        pose = addr.copy(pel=cfg['pel'] + t['pel'], hip=V(hip[0], hip_tilt, hip[2]),
                         chest=V(ch[0], tilt, S0 + ch[2] if 'tilt_abs' not in t else ch[2]),
                         clav=t['clav'].copy(), kneeL=t['kneeL'].copy(), kneeR=t['kneeR'].copy())
        if 'footL' in t:
            pose.p['footL'] = t['footL'].copy()
        if 'footR' in t:
            pose.p['footR'] = t['footR'].copy()
        if 'gaze' in t:
            pose.p['gaze'] = t['gaze'].copy()
        elif 'gaze_off' in t:
            pose.p['gaze'] = ball + t['gaze_off']
        if side == 'imp':
            M_imp = impact_club(club, ball, cfg['ilean'], cfg['iup'], cfg['press'], cfg['ilift'])
            reach_imp = fit_impact(sb, pose, M_imp, 0.992, cfg.get('imp_right', 0.94))
            sb.add(f, pose, ('world', M_imp), poles[i])
            sb.override[f] = M_imp
        else:
            ex = {'project': pj} if pj else {}
            spec = ('wrist', side, w, shaft, ex)
            sb.add(f, pose, spec, poles[i])
        if f == fin:
            sb.add(last, pose.copy(), spec, poles[i])
    print("    fitted address chest", tuple(round(x, 1) for x in addr.p['chest']), "clav", tuple(round(x, 1) for x in addr.p['clav']),
          "reach", {k: round(v, 3) for k, v in r_addr.items()})
    print("    fitted impact  chest", tuple(round(x, 1) for x in sb.keys[6][1].p['chest']),
          "reach", {k: round(v, 3) for k, v in reach_imp.items()})
    info = dict(ball=ball, top=top, impact=imp, finish=fin, last=last, club=club,
                reach_address=r_addr, reach_impact=reach_imp,
                preview_frames=[0] + [round(s[1]) for s in specs], closeups=[0, imp])
    return sb, info


# ---------------------------------------------------------------- chip
def _arm_swing_rel(sb, pose, base_rel, wrist_rel, theta, hinge, pivot=V(0.0, -0.06, 0.20)):
    """Chest-relative club after swinging the arm triangle about a pivot between the
    shoulders (theta, + = back) and hinging the club about the lead wrist (hinge)."""
    cp, cy, cz = base_rel
    R = ry(theta)
    p1 = pivot + R @ (cp - pivot)
    w1 = pivot + R @ (wrist_rel - pivot)
    H = ry(hinge)
    p2 = w1 + H @ (p1 - w1)
    Rt = H @ R
    return ('chestrel', p2, Rt @ cy, Rt @ cz)


def build_chip(rig):
    club = 'Wedge'
    top, imp, fin, last = 18, 26, 42, 50
    stance = {'L': V(0.105, 0.075, 0.09), 'R': V(-0.105, 0.035, 0.09)}
    sb = SwingBuilder(rig, 'Swing_Chip', club, last, stance, flat=(0, top, fin, last))
    ball = V(-0.035, -0.53, BALL_R)
    addr = Pose(pel=V(0.030, 0.058, 0.940), hip=V(14, 23, 3), chest=V(8, 44, -2),
                clav=Vector((6, 12, 4, 14)), gaze=ball.copy(), head_roll=0.0,
                footL=V(32, 0, 0), footR=V(10, 0, 0), kneeL=V(0.45, -1, 0), kneeR=V(0.05, -1, 0))
    M_addr = address_club(club, ball, 12.0)
    r_addr = fit_posture(sb, addr, M_addr, 0.95, 0.975)
    T0, S0, Y0 = addr.p['chest'][1], addr.p['chest'][2], addr.p['chest'][0]
    st, P = sb.anim.torso_state(addr.p)
    Rc, Oc = Animator.chest_frame(P, rig)
    RcT = Rc.transposed()
    base = (RcT @ (M_addr.translation - Oc), RcT @ M_addr.to_3x3().col[1], RcT @ M_addr.to_3x3().col[2])
    wrist = RcT @ ((M_addr @ rig.off['L']).translation - Oc)
    poles = {'L': ('chest', V(0.55, 0.45, -1.0)), 'R': ('chest', V(-0.45, 0.55, -1.0))}
    sb.add(0, addr, ('world', M_addr), poles)
    ptop = addr.copy(pel=addr['pel'] + V(-0.004, 0.002, 0.0), hip=V(8, 23, 3), chest=V(Y0 - 16, T0 - 1, S0 + 2),
                     clav=Vector((6, 16, 4, 10)), kneeR=V(0.0, -1, 0))
    sb.add(top, ptop, _arm_swing_rel(sb, ptop, base, wrist, 20.0, 14.0), poles)
    pimp = addr.copy(pel=addr['pel'] + V(0.010, -0.002, 0.0), hip=V(20, 23, 3), chest=V(Y0 + 4, T0, S0 - 2),
                     kneeR=V(0.25, -1, 0))
    M_imp = impact_club(club, ball, 10.0, 1.0, 0.75, 0.006)
    reach_imp = fit_posture(sb, pimp, M_imp, 0.975, 0.99)
    sb.add(imp, pimp, ('world', M_imp), poles)
    sb.override[imp] = M_imp
    pthr = addr.copy(pel=addr['pel'] + V(0.016, -0.004, 0.002), hip=V(28, 22, 3), chest=V(Y0 + 16, T0 - 2, S0 - 4),
                     kneeR=V(0.45, -1, 0), footR=V(10, 4, 0))
    sb.add(33, pthr, _arm_swing_rel(sb, pthr, base, wrist, -16.0, -4.0), poles)
    pfin = addr.copy(pel=addr['pel'] + V(0.022, -0.006, 0.006), hip=V(34, 21, 3), chest=V(Y0 + 26, T0 - 4, S0 - 5),
                     kneeR=V(0.6, -1, 0), footR=V(12, 8, 0), gaze=ball + V(0.25, 0.0, 0.0))
    sb.add(fin, pfin, _arm_swing_rel(sb, pfin, base, wrist, -26.0, -2.0), poles)
    sb.add(last, pfin.copy(), sb.keys[-1][2], sb.keys[-1][3])
    info = dict(ball=ball, top=top, impact=imp, finish=fin, last=last, club=club, reach_address=r_addr,
                reach_impact=reach_imp, preview_frames=[0, 9, top, 22, imp, 33, fin])
    return sb, info


# ---------------------------------------------------------------- putt
def build_putt(rig):
    club = 'Putter'
    top, imp, fin, last = 18, 30, 45, 55
    stance = {'L': V(0.165, 0.035, 0.09), 'R': V(-0.165, 0.035, 0.09)}
    sb = SwingBuilder(rig, 'Swing_Putt', club, last, stance, flat=(0, top, fin, last))
    ball = V(0.045, -0.445, BALL_R)
    addr = Pose(pel=V(-0.005, 0.060, 0.948), hip=V(0, 22, 0), chest=V(0, 48, -5),
                clav=Vector((4, 14, 3, 16)), gaze=ball.copy(), head_roll=0.0,
                footL=V(10, 0, 0), footR=V(6, 0, 0), kneeL=V(0.25, -1, 0), kneeR=V(-0.25, -1, 0))
    M_addr = address_club(club, ball, 3.0, gap=0.008)
    r_addr = fit_posture(sb, addr, M_addr, 0.90, 0.93)
    st, P = sb.anim.torso_state(addr.p)
    Rc, Oc = Animator.chest_frame(P, rig)
    RcT = Rc.transposed()
    rel = ('chestrel', RcT @ (M_addr.translation - Oc), RcT @ M_addr.to_3x3().col[1], RcT @ M_addr.to_3x3().col[2])
    poles = {'L': ('chest', V(0.9, 0.35, -1.0)), 'R': ('chest', V(-0.9, 0.35, -1.0))}
    S0 = addr.p['chest'][2]
    Y0 = addr.p['chest'][0]
    sb.add(0, addr, rel, poles)
    # impact side-bend chosen so the face reaches the ball (pendulum about the chest)
    target_fc = ball - V(1, 0, 0) * (BALL_R * 0.85)

    def fc_x(side):
        pz = addr.copy(chest=V(Y0, addr.p['chest'][1], side))
        st2, P2 = sb.anim.torso_state(pz.p)
        Rc2, Oc2 = Animator.chest_frame(P2, rig)
        M = frame4(Rc2 @ orthoframe(rel[2], rel[3]), Oc2 + Rc2 @ rel[1])
        return A.face_center_world(M, club).x

    lo, hi = S0 - 8.0, S0 + 2.0
    for _ in range(40):
        mid = (lo + hi) * 0.5
        if fc_x(mid) < target_fc.x:
            hi = mid          # less side bend moves the putter toward the target
        else:
            lo = mid
    s_imp = (lo + hi) * 0.5
    sb.add(top, addr.copy(chest=V(Y0, addr.p['chest'][1], S0 + 9.0)), rel, poles)
    sb.add(imp, addr.copy(chest=V(Y0, addr.p['chest'][1], s_imp)), rel, poles)
    pfin = addr.copy(chest=V(Y0 + 1.0, addr.p['chest'][1] - 1.0, S0 - 13.5))
    sb.add(fin, pfin, rel, poles)
    sb.add(last, pfin.copy(), rel, poles)
    info = dict(ball=ball, top=top, impact=imp, finish=fin, last=last, club=club, reach_address=r_addr,
                preview_frames=[0, top, imp, fin])
    return sb, info


# ---------------------------------------------------------------- gestures
class GestureBuilder(Builder):
    """Club held in the right hand only; left arm free (wrist target + pole)."""

    def __init__(self, rig, name, last, stance, loop=False):
        super().__init__(rig, name, 'Iron', last, stance, flat=(0, last))
        self.free = []          # (frame, wristL world, poleL world, wrist euler deg)
        self.loop = loop
        self.extra = {}

    def add_free(self, frame, wrist, pole, rot=(0, 0, 0)):
        self.free.append((frame, Vector(wrist), Vector(pole), Vector(rot)))

    def resolve(self):
        super().resolve()
        fl = set(self.flat)
        self.ftr = {
            'w': Track([(f, w) for f, w, p, r in self.free], fl),
            'p': Track([(f, p) for f, w, p, r in self.free], fl),
            'r': Track([(f, r) for f, w, p, r in self.free], fl),
        }

    def state(self, f):
        rig = self.rig
        T = self.tracks
        p = {c: T[c](f) for c in A.CHANNELS}
        for k, fn in self.extra.items():
            p[k] = fn(f, p[k])
        st, P = self.anim.torso_state(p)
        Rc, Oc = Animator.chest_frame(P, rig)
        y = Rc @ T['club_y'](f)
        z = Rc @ T['club_z'](f)
        club = frame4(orthoframe(y, z), Oc + Rc @ T['club_p'](f))
        st['club'] = club
        st['hand_R'] = rig.hand_from_club(club, 'R')
        st['hand_L'] = None
        st['wrist_L'] = self.ftr['w'](f)
        e = self.ftr['r'](f)
        st['wrist_rot_L'] = (rz(e.z) @ ry(e.y) @ rx(e.x))
        st['pole_L'] = self.ftr['p'](f)
        st['pole_R'] = Rc @ T['poleR'](f)
        for s in 'LR':
            fp = p['foot' + s]
            st['foot_' + s] = A.foot_matrix(rig, s, self.stance[s], fp[0], fp[1], fp[2])
            st['knee_' + s] = p['knee' + s]
        P = rig.solve_limbs(P, st)
        return P, st


def _stand(**kw):
    p = dict(pel=V(0.0, 0.012, 0.952), hip=V(0, 2, 0), chest=V(0, 3, 0), clav=Vector((0, 4, 0, 4)),
             gaze=V(0.0, -4.0, 1.2), head_roll=0.0, footL=V(12, 0, 0), footR=V(12, 0, 0),
             kneeL=V(0.15, -1, 0), kneeR=V(-0.15, -1, 0))
    p.update(kw)
    return Pose(**p)


STAND = {'L': V(0.13, 0.03, 0.09), 'R': V(-0.13, 0.03, 0.09)}
HOLD_R = (V(-0.235, -0.055, 0.845), V(-0.22, -0.55, -0.80))     # right wrist, shaft: club leaning out-front
POLE_R_STAND = ('world', V(-0.5, 0.8, -0.3))


def _club_hold(wrist=None, shaft=None):
    w = wrist if wrist is not None else HOLD_R[0]
    s = shaft if shaft is not None else HOLD_R[1]
    return ('wrist', 'R', w, s, {'arms': 'R'})


def build_gesture(rig, kind):
    if kind == 'Idle':
        last = 60
        gb = GestureBuilder(rig, 'Idle', last, STAND, loop=True)
        base = _stand()
        polesL = ('world', V(0.5, 0.8, -0.4))
        for f in (0, 30, 60):
            gb.add(f, base.copy(), _club_hold(), {'L': polesL, 'R': POLE_R_STAND})
            gb.add_free(f, V(0.235, -0.01, 0.865), V(0.5, 0.8, -0.4), (0, 0, 0))
        gb.flat = {0, 30, 60}

        def breathe_chest(f, v):
            a = math.sin(2 * math.pi * f / 60.0)
            return Vector((v[0] + 1.5 * math.sin(2 * math.pi * f / 60.0 + 0.6), v[1] - 0.9 * a, v[2]))

        def breathe_clav(f, v):
            a = math.sin(2 * math.pi * f / 60.0)
            return Vector((v[0] + 1.2 * a, v[1], v[2] + 1.2 * a, v[3]))

        def sway(f, v):
            return v + Vector((0.008 * math.sin(2 * math.pi * f / 60.0 + 1.0), 0.0, 0.002 * math.sin(4 * math.pi * f / 60.0)))

        def look(f, v):
            return v + Vector((0.35 * math.sin(2 * math.pi * f / 60.0 + 2.0), 0.0, 0.0))

        gb.extra = {'chest': breathe_chest, 'clav': breathe_clav, 'pel': sway, 'gaze': look}
        info = dict(club='Iron', last=last, preview_frames=[0, 15, 30, 45])
        return gb, info

    if kind == 'Celebrate':
        last = 45
        gb = GestureBuilder(rig, 'Celebrate', last, STAND)
        b0 = _stand()
        up = _stand(chest=V(-8, -4, 2), pel=V(0.0, 0.016, 0.955), gaze=V(1.0, -5.0, 2.2),
                    clav=Vector((6, 0, 2, 4)))
        down = _stand(chest=V(-14, 14, -2), hip=V(-6, 8, 0), pel=V(0.0, 0.030, 0.925), gaze=V(0.0, -3.0, 0.6),
                      clav=Vector((-2, 10, 0, 6)), kneeL=V(0.3, -1, 0), kneeR=V(-0.3, -1, 0))
        keys = [(0, b0, V(0.235, -0.01, 0.865), V(0.5, 0.8, -0.4), (0, 0, 0), None),
                (6, _stand(chest=V(-6, 7, 0), pel=V(0, 0.022, 0.942), gaze=V(0.5, -5.0, 1.0)),
                 V(0.30, -0.22, 1.08), V(0.9, 0.3, -0.6), (-25, 0, 0), V(-0.22, -0.10, 0.88)),
                (11, up, V(0.27, -0.34, 1.40), V(0.9, -0.2, -0.6), (-35, 0, 15), V(-0.22, -0.12, 0.92)),
                (15, down, V(0.23, -0.15, 1.00), V(0.4, 1.0, -0.2), (15, 0, 0), V(-0.21, -0.12, 0.84)),
                (19, up.copy(chest=V(-6, -2, 2)), V(0.27, -0.32, 1.34), V(0.9, -0.2, -0.6), (-35, 0, 15),
                 V(-0.22, -0.12, 0.90)),
                (23, down.copy(chest=V(-12, 11, -2)), V(0.25, -0.20, 1.06), V(0.5, 1.0, -0.3), (15, 0, 0),
                 V(-0.21, -0.12, 0.85)),
                (33, _stand(chest=V(-4, 4, 0), gaze=V(0.5, -4.0, 1.4)), V(0.24, -0.06, 0.90), V(0.5, 0.8, -0.4),
                 (0, 0, 0), V(-0.235, -0.07, 0.85)),
                (45, _stand(chest=V(-3, 3, 0), gaze=V(0.5, -4.0, 1.3)), V(0.235, -0.02, 0.87), V(0.5, 0.8, -0.4),
                 (0, 0, 0), None)]
        for f, pose, wl, pl, rot, wr in keys:
            gb.add(f, pose, _club_hold(wr), {'L': ('world', pl), 'R': POLE_R_STAND})
            gb.add_free(f, wl, pl, rot)
        info = dict(club='Iron', last=last, preview_frames=[0, 6, 11, 15, 19, 23, 33, 45])
        return gb, info

    if kind == 'Dejected':
        last = 45
        gb = GestureBuilder(rig, 'Dejected', last, STAND)
        b0 = _stand()
        slump = dict(chest=V(0, 13, 0), clav=Vector((-5, 10, -5, 10)), pel=V(0.0, 0.020, 0.946))
        ground = V(0.0, -0.75, 0.0)
        hipL = V(0.205, 0.035, 1.02)
        keys = [(0, b0, V(0.235, -0.01, 0.865), V(0.5, 0.8, -0.4), (0, 0, 0)),
                (8, _stand(gaze=ground + V(0, -0.3, 0), **slump), V(0.235, 0.0, 0.86), V(0.5, 0.8, -0.4), (0, 0, 0)),
                (15, _stand(gaze=ground, **slump), hipL, V(1.0, 0.6, 0.1), (60, 0, -30)),
                (21, _stand(gaze=ground + V(-0.35, 0, 0), **slump), hipL, V(1.0, 0.6, 0.1), (60, 0, -30)),
                (27, _stand(gaze=ground + V(0.35, 0, 0), **slump), hipL, V(1.0, 0.6, 0.1), (60, 0, -30)),
                (33, _stand(gaze=ground + V(-0.30, 0, 0), **slump), hipL, V(1.0, 0.6, 0.1), (60, 0, -30)),
                (39, _stand(gaze=ground + V(0.10, 0, 0), **slump), hipL, V(1.0, 0.6, 0.1), (60, 0, -30)),
                (45, _stand(gaze=ground, **slump), hipL, V(1.0, 0.6, 0.1), (60, 0, -30))]
        for f, pose, wl, pl, rot in keys:
            gb.add(f, pose, _club_hold(), {'L': ('world', pl), 'R': POLE_R_STAND})
            gb.add_free(f, wl, pl, rot)
        info = dict(club='Iron', last=last, preview_frames=[0, 8, 15, 21, 27, 45])
        return gb, info
    raise ValueError(kind)
