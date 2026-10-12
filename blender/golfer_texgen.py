"""Procedural textures for the golfer: albedo / normal / ORM per material.

Recolourable materials (Skin, Hair, Shirt, Pants, Shoes, Belt, Hat) get near-white albedo
(mean ~0.93, subtle variation) so the runtime tint gives the intended colour; their detail is
in the normal map (weave, seams, stitching, folds, creases, pores) and in roughness/AO.
Features are defined in rest-pose 3D space (metres) or in a part's own parametric UVs.
"""
import math
import time

import bpy
import numpy as np
from mathutils import Vector

import golfer_common as C
import golfer_mh as MH
import golfer_tex as TX
from golfer_tex import noise3, fbm3, noise2, cells2, smoothstep as sst
from golfer_skeleton import JOINTS as J

PART = C.PART
SIZE = {'Skin': 2048, 'Shirt': 1024, 'Pants': 1024, 'Belt': 512, 'Shoes': 1024, 'Sole': 512, 'Glove': 1024,
        'Hat': 1024, 'Hair': 1024, 'Eyes': 512, 'Lashes': 512}
ORM_SIZE = {'Skin': 1024, 'Shirt': 1024, 'Pants': 1024, 'Belt': 512, 'Shoes': 1024, 'Sole': 512, 'Glove': 512,
            'Hat': 1024}


# ====================================================================== helpers
def gauss(d2, r):
    return np.exp(-d2 / (r * r))


def ridge(d, w):
    """Smooth bump of half-width w at signed distance d."""
    return np.exp(-(d / w) ** 2)


def groove(d, w):
    return -ridge(d, w)


def stitches(along, d, pitch=0.003, w=0.00045, dash=0.62):
    """Dashed stitch line: along = arc length (m), d = distance from the line (m)."""
    ph = (along / pitch) % 1.0
    on = sst(0.0, 0.08, ph) * (1.0 - sst(dash - 0.08, dash, ph))
    return ridge(d, w) * on


def seg_dist(P, a, b):
    """Distance from points P (M,3) to segment ab, and the parameter along it (0..1)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab), 0.0, 1.0)
    q = a + t[:, None] * ab
    return np.linalg.norm(P - q, axis=1), t


def polyline_dist(P, pts):
    """Distance to a polyline and arc length of the closest point."""
    best = np.full(len(P), 9.0)
    arc = np.zeros(len(P))
    acc = 0.0
    for a, b in zip(pts[:-1], pts[1:]):
        d, t = seg_dist(P, a, b)
        L = float(np.linalg.norm(np.asarray(b) - np.asarray(a)))
        sel = d < best
        best = np.where(sel, d, best)
        arc = np.where(sel, acc + t * L, arc)
        acc += L
    return best, arc


def downsample(a, k):
    if k == 1:
        return a
    H, W = a.shape[:2]
    return a.reshape(H // k, k, W // k, k, *a.shape[2:]).mean(axis=(1, 3))


def finish(name, S, F, alb=None, alpha=None, slopes=None, rough=None, ao=None, metal=0.0, base=None,
           normal_strength=1.0, alpha_clip=False, q_alb=90, q_nrm=92, q_orm=88):
    """Write the images of a material and wire its node tree."""
    if F.M == 0:
        raise RuntimeError('texture %s: no texels sampled (check the UVs)' % name)
    W = S.W
    imgs = {}
    if alb is not None:
        a = F.scatter(np.clip(alb, 0, 1), tuple(np.median(np.clip(alb, 0, 1), axis=0)))
        a = TX.lin2srgb(a)
        if alpha is not None:
            al = F.scatter(alpha, 0.0)
            a = np.concatenate([a, al[..., None]], axis=2)
            imgs['albedo'] = TX.save(name + '_albedo', a, fmt='PNG', srgb=True)
        else:
            imgs['albedo'] = TX.save(name + '_albedo', a, quality=q_alb, srgb=True)
    if slopes is not None:
        n = TX.encode_normal(F, slopes[0], slopes[1])
        imgs['normal'] = TX.save(name + '_normal', n, quality=q_nrm, srgb=False)
    if rough is not None:
        Wo = ORM_SIZE.get(name, W)
        k = W // Wo
        r = F.scatter(np.clip(rough, 0.02, 1.0), float(np.median(rough)))
        o = ao if ao is not None else np.ones((S.H, S.W))
        if o.shape[0] != S.H:
            o = np.kron(o, np.ones((S.H // o.shape[0], S.W // o.shape[1])))
        orm = np.stack([downsample(o, k), downsample(r, k), np.full((S.H // k, S.W // k), metal)], axis=2)
        imgs['orm'] = TX.save(name + '_orm', orm, quality=q_orm, srgb=False)
    TX.setup_material(name, albedo=imgs.get('albedo'), normal=imgs.get('normal'), orm=imgs.get('orm'),
                      base=base or tuple(C.MATERIAL_COLORS[name][0]), metal=metal,
                      rough=float(np.median(rough)) if rough is not None else None,
                      alpha_clip=alpha_clip, normal_strength=normal_strength)
    return imgs


def uv_noise(F, cells_px, seed=0):
    """Smooth noise on the texel grid, `cells_px` texels per lattice cell."""
    col = F.i[1].astype(np.float64)
    row = F.i[0].astype(np.float64)
    return noise2(col / cells_px, row / cells_px, seed=seed)


def uv_grain(F, cells_px, seed=0):
    col = F.i[1].astype(np.float64)
    row = F.i[0].astype(np.float64)
    d, rid = cells2(col / cells_px, row / cells_px, seed=seed)
    return d, rid


def grid_slopes(F, S, h):
    """Slopes of a flat per-texel height (M,) via the texel grid. Texel-scale detail is defined
    per texel, so where a part's UVs are much denser than usual (thin rims, edges) the same
    height step would become a steep slope; damp it there."""
    g = F.scatter(h, 0.0)
    su, sv = TX.slopes_uv(F, g)
    for p in np.unique(F.pid):
        sel = F.pid == p
        mt, mb = np.median(F.tlen[sel]), np.median(F.blen[sel])
        su[sel] *= np.clip(F.tlen[sel] / (0.6 * mt), 0.0, 1.0)
        sv[sel] *= np.clip(F.blen[sel] / (0.6 * mb), 0.0, 1.0)
    return su, sv


# ====================================================================== landmarks
def face_landmarks(body):
    me = body.data
    pids = TX.part_ids(body)
    vs = set()
    for p in me.polygons:
        if pids[p.index] == PART['head']:
            vs.update(p.vertices)
    co = np.array([me.vertices[i].co[:] for i in vs])
    mid = co[np.abs(co[:, 0]) < 0.0035]
    win = mid[(mid[:, 2] > 1.58) & (mid[:, 2] < 1.70)]
    nose = win[np.argmin(win[:, 1])]
    # mouth: most recessed midline point between nose and chin on the front surface
    lip = mid[(mid[:, 2] < nose[2] - 0.022) & (mid[:, 2] > nose[2] - 0.050) & (mid[:, 1] < nose[1] + 0.035)]
    # upper / lower lip protrusions are local minima of y; the stomion is the max between them
    order = np.argsort(-lip[:, 2])
    lip = lip[order]
    front = lip[lip[:, 1] < np.percentile(lip[:, 1], 70)]
    stom = front[np.argmax(front[:, 1])] if len(front) else lip[len(lip) // 2]
    chin_pts = mid[(mid[:, 2] < stom[2] - 0.01) & (mid[:, 1] < stom[1] + 0.02)]
    chin = chin_pts[np.argmin(chin_pts[:, 1])] if len(chin_pts) else stom - np.array([0, 0, 0.04])
    eyes = MH.eye_spheres()
    ec, er = eyes['L']
    return {'nose': nose, 'stomion': stom, 'chin': chin, 'eye': np.array(ec), 'eye_r': er,
            'brow_z': ec.z + er + 0.006}


# ====================================================================== skin
def tex_skin(body, ao):
    W = SIZE['Skin']
    S = TX.sample([(body, {'Skin'}, None)], W)
    F = S.flat()
    P, N, pid = F.P, F.N, F.pid
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    ax = np.abs(x)
    L = face_landmarks(body)
    head = np.isin(pid, [PART['head'], PART['neck'], PART['mouth'], PART['socket']])
    mouth = pid == PART['mouth']
    socket = pid == PART['socket']
    hand = pid == PART['hand_R']
    front = np.clip(-N[:, 1], 0, 1)
    ec, er = L['eye'], L['eye_r']
    st = L['stomion']
    nose = L['nose']
    M = F.M
    alb = np.ones((M, 3))
    # mottling and tone variation
    mott = fbm3(P, 38.0, 3, seed=11)
    alb *= (1.0 + 0.030 * mott)[:, None]
    alb[:, 0] *= 1.0 + 0.012 * fbm3(P, 15.0, 2, seed=12)
    # redness: cheeks, nose, ears, lips handled separately
    red = np.zeros(M)
    for s in (1, -1):
        c = np.array([s * 0.043, ec[1] + 0.004, ec[2] - 0.030])
        red += 0.55 * gauss(np.sum((P - c) ** 2 / np.array([1.0, 1.6, 1.0]), axis=1), 0.020)
    red += 0.45 * gauss(np.sum((P - nose) ** 2, axis=1), 0.013)
    ear = head & (ax > 0.066) & (z > 1.62) & (z < 1.76) & (y > -0.03) & (y < 0.06)
    red += 0.45 * ear
    red = np.clip(red, 0, 1) * head + 0.22 * hand
    alb *= 1.0 - red[:, None] * np.array([0.0, 0.12, 0.13])
    # beard shadow (clean-shaven, five o'clock) on jaw, chin, upper lip, under the jaw
    jaw_line = ec[2] - 0.040 - 0.020 * np.clip((ax - 0.02) / 0.05, 0, 1)
    beard = head & (z < jaw_line) & (y < 0.045) & ~mouth
    bmask = beard * sst(0.0, 0.010, jaw_line - z) * sst(1.535, 1.578, z)   # fades out down the neck
    bmask *= 1.0 - 0.6 * gauss((y - 0.04) ** 2, 0.012)          # fade toward the neck back
    # stubble / follicle dots at a physical scale (identical on every UV island: no seams)
    stub = sst(0.42, 0.62, noise3(P, 1700.0, seed=21))
    alb *= (1.0 - bmask[:, None] * (np.array([0.085, 0.085, 0.070]) + 0.07 * stub[:, None]))
    # under-eye shadow
    for s in (1, -1):
        c = np.array([s * ec[0], ec[1] - 0.004, ec[2] - 0.017])
        ue = gauss(np.sum((P - c) ** 2 / np.array([1.0, 1.0, 0.45]), axis=1), 0.012) * head
        alb *= 1.0 - ue[:, None] * np.array([0.05, 0.07, 0.04])
    # lash line / lid margin darkening, inner-corner caruncle
    lid = np.zeros(M)
    for s in (1, -1):
        c = np.array([s * ec[0], ec[1], ec[2]])
        d = np.linalg.norm(P - c, axis=1) - er
        lid = np.maximum(lid, (1.0 - sst(0.0004, 0.0026, d)) * head)
        # soft contact shadow of the upper lid around the eye opening
        up = sst(-0.003, 0.002, P[:, 2] - c[2])
        alb *= (1.0 - 0.16 * (1.0 - sst(0.0015, 0.0080, d)) * head * up)[:, None]
        car = gauss(np.sum((P - (c + np.array([-s * er * 0.95, -er * 0.25, -0.001]))) ** 2, axis=1), 0.0032) * head
        alb *= 1.0 - car[:, None] * np.array([0.0, 0.25, 0.22])
    alb *= 1.0 - lid[:, None] * 0.42
    # brow follicles: soft darker band under the brow cards (fills between hairs)
    for s_ in (1, -1):
        tb = np.clip((x * s_ - 0.010) / 0.050, 0, 1)
        zc = ec[2] + er * 0.95 + 0.0055 * np.sin(np.pi * np.minimum(1.0, tb * 1.15)) - 0.0035 * tb
        half = 0.0050 * (1.0 - 0.45 * tb) + 0.0006
        on = head * (x * s_ > 0.007) * (x * s_ < 0.062) * (y < -0.05)
        bb = on * (1 - sst(half * 0.6, half * 1.3, np.abs(z - zc - 0.0004)))
        alb *= 1.0 - bb[:, None] * 0.16
    # lips
    lx = x
    lz = z - st[2]
    hw = 0.0255
    u = np.clip(ax / hw, 0, 1.2)
    upper_h = 0.0078 * np.clip(1 - u ** 2.2, 0, 1) ** 0.55 - 0.0009 * gauss(lx ** 2, 0.0025) + 0.0006 * gauss((ax - 0.0055) ** 2, 0.0025)
    lower_h = 0.0098 * np.clip(1 - (ax / (hw * 0.95)) ** 2.2, 0, 1) ** 0.6
    in_up = sst(-0.0012, 0.0002, lz) * (1 - sst(upper_h - 0.0006, upper_h + 0.0006, lz))
    in_lo = (1 - sst(-0.0002, 0.0012, lz)) * sst(-lower_h - 0.0007, -lower_h + 0.0005, lz)
    lipm = np.clip(in_up + in_lo, 0, 1) * head * (y < st[1] + 0.006) * (ax < hw + 0.003) * (np.abs(lz) < 0.014)
    alb *= 1.0 - lipm[:, None] * np.array([0.20, 0.46, 0.43])
    # scalp under the hair: darker (cropped hair roots / stubble) above the hairline
    import golfer_accessories as ACC
    sk = ACC.SKULL_C
    rel = P - np.array(sk[:])
    alpha_az = np.arctan2(rel[:, 0], -rel[:, 1])
    hl = np.array([ACC._interp_periodic(ACC.HAIRLINE_SHORT, a) for a in np.linspace(-math.pi, math.pi, 721)])
    hz = np.interp(alpha_az, np.linspace(-math.pi, math.pi, 721), hl)
    dzh = rel[:, 2] - hz
    scalp = head * sst(-0.006, 0.004, dzh)
    # hair shadow: a feathered band of darker skin just below the hairline (forehead, temples)
    hshadow = head * (1.0 - sst(0.0, 0.011, -dzh)) * (1.0 - scalp) * (y < 0.06)
    alb *= 1.0 - scalp[:, None] * (0.22 + 0.10 * stub[:, None]) - hshadow[:, None] * 0.10
    # fingernails (right hand)
    import golfer_body as BODY
    nails = np.zeros(M)
    nail_tip = np.zeros(M)
    for fd in BODY.HAND_DATA.get('R', []):
        tip, dr, dors = np.array(fd['tip'][:]), np.array(fd['dir'][:]), np.array(fd['dorsal'][:])
        c = tip - dr * fd['r'] * 0.9 + dors * fd['r'] * 0.6
        rel_n = P - c
        a_ = rel_n @ dr
        side_v = np.cross(dr, dors)
        b_ = rel_n @ side_v
        on = (rel_n @ dors > -fd['r'] * 0.4) * hand
        e = (a_ / (fd['r'] * 1.15)) ** 2 + (b_ / (fd['r'] * 0.78)) ** 2
        nails = np.maximum(nails, on * (1 - sst(0.75, 1.0, e)))
        nail_tip = np.maximum(nail_tip, on * (1 - sst(0.75, 1.0, e)) * sst(0.2, 0.7, a_ / (fd['r'] * 1.15)))
    # cavity: the baked AO darkens eye sockets, nostrils, mouth corners and ear folds a little in the
    # albedo too (AO maps only affect ambient light in three.js)
    if ao.get('Skin') is not None:
        a_img = ao['Skin']
        k = S.H // a_img.shape[0]
        a_full = np.kron(a_img, np.ones((k, k))) if k > 1 else a_img
        raw = np.clip((a_full[F.i] - 0.35) / 0.65, 0, 1)
        # face only: fade out down the neck so the collar's occlusion does not paint a band there
        wface = np.maximum(sst(1.55, 1.59, z), (y < -0.06).astype(float))
        fh = 1.0 - (0.22 * (1.0 - raw ** 0.8)) * wface
        alb *= np.where(head, fh, 0.92 + 0.08 * raw)[:, None]
    # mouth cavity: dark, so the lip seam reads as a clean closed line
    if mouth.any():
        depth = np.clip((y - st[1]) / 0.004, 0, 1)
        inner = np.array([0.42, 0.20, 0.20]) * (1 - depth[:, None]) + np.array([0.10, 0.035, 0.035]) * depth[:, None]
        alb = np.where(mouth[:, None], inner, alb)
    alb = np.where(socket[:, None], alb * 0.35, alb)
    alb = alb * (1 - nails[:, None]) + nails[:, None] * np.array([1.0, 0.90, 0.88]) * 1.02
    alb = alb * (1 - nail_tip[:, None] * 0.4) + nail_tip[:, None] * 0.4 * np.array([1.05, 1.03, 1.0])
    # ---- height
    def h3(Q, F_):
        qx, qy, qz = Q[:, 0], Q[:, 1], Q[:, 2]
        h = np.zeros(len(Q))
        qax = np.abs(qx)
        # nasolabial folds
        for s in (1, -1):
            a = np.array([s * 0.0175, nose[1] + 0.010, nose[2] - 0.006])
            b = np.array([s * 0.0305, st[1] + 0.006, st[2] - 0.007])
            d, t = seg_dist(Q, a, b)
            h += -0.00030 * ridge(d, 0.0022) * np.sin(np.pi * np.clip(t, 0, 1)) ** 0.5
        # forehead lines
        for k, dz in enumerate((0.021, 0.031, 0.041)):
            zz = L['brow_z'] + dz + 0.0015 * np.sin(qx * 90 + k)
            h += -0.00004 * ridge(qz - zz, 0.0007) * (1 - sst(0.030, 0.045, qax)) * (qy < -0.05)
        # crow's feet
        for s in (1, -1):
            c0 = np.array([s * (ec[0] + er * 0.95), ec[1] + 0.006, ec[2]])
            for ang in (-25.0, 0.0, 25.0):
                dvec = np.array([s * math.cos(math.radians(ang)), 0.25, math.sin(math.radians(ang))])
                d, t = seg_dist(Q, c0 + dvec * 0.004, c0 + dvec * 0.013)
                h += -0.00007 * ridge(d, 0.0006) * np.sin(np.pi * t)
            # lower lid crease
            cc = np.array([s * ec[0], ec[1] + 0.002, ec[2] - 0.012])
            d = np.abs(np.linalg.norm((Q - cc) * np.array([1.0, 1.0, 1.6]), axis=1) - 0.010)
            h += -0.00010 * ridge(d, 0.0008) * (qz < ec[2] - 0.006) * (np.abs(qx - s * ec[0]) < 0.014)
        # lip vertical wrinkles + philtrum
        lzq = qz - st[2]
        lipzone = (np.abs(lzq) < 0.010) * (qax < 0.026) * (qy < st[1] + 0.006)
        h += 0.000013 * np.sin(qx * 2 * np.pi / 0.0021 + 2.5 * noise3(Q, 260.0, seed=35)) * lipzone             * (1 - sst(0.0, 0.0012, np.abs(lzq) - 0.0085))
        return h
    st3 = TX.slopes3(F, h3, eps=0.00025)
    # pores and micro relief defined in 3D (same physical scale on every UV island, so the
    # MakeHuman face, its neck island and the neck extension read as one continuous skin)
    dens = np.where(head, 1.0, 0.45) * (1 + 0.6 * gauss(np.sum((P - nose) ** 2, axis=1), 0.03))
    dens = dens * (~mouth)

    def hmicro(Q, F_):
        pores = sst(0.38, 0.78, noise3(Q, 1250.0, seed=31))
        return (-0.000032 * pores + 0.000008 * noise3(Q, 2600.0, seed=33)) * dens             + 0.000014 * noise3(Q, 480.0, seed=34)
    sm = TX.slopes3(F, hmicro, eps=0.00011)
    hp = 0.00006 * nails * sst(0.5, 1.0, 1 - nails)        # nail rim
    su, sv = grid_slopes(F, S, hp)
    slopes = (st3[0] + sm[0] + su, st3[1] + sm[1] + sv)
    # ---- roughness
    rough = np.full(M, 0.55)
    tz = head * (gauss(x ** 2 / 0.6 + (z - (ec[2] + 0.03)) ** 2, 0.025) * (y < -0.05)
                 + gauss(np.sum((P - nose) ** 2, axis=1), 0.016))
    rough -= 0.13 * np.clip(tz, 0, 1)
    rough -= 0.08 * lipm
    rough += 0.08 * scalp + 0.04 * (~head)
    rough -= 0.25 * nails
    rough = np.where(mouth, 0.75, rough)
    rough += 0.04 * fbm3(P, 60.0, 2, seed=41)
    finish('Skin', S, F, alb=alb * 0.97, slopes=slopes, rough=rough, ao=ao.get('Skin'))
    return L


# ====================================================================== eyes and lashes
def tex_eyes(body):
    W = SIZE['Eyes']
    S = TX.sample([(body, {'Eyes'}, None)], W, margin=4)
    F = S.flat()
    du, dv = F.u - 0.5, F.v - 0.5
    rr = np.hypot(du, dv)
    ang = np.pi * np.clip(2 * rr, 0, 1) ** (1 / 0.6)          # angle from the gaze axis
    phi = np.arctan2(dv, du)
    r_eye = MH.eye_spheres()['L'][1] * 0.97
    iris_a = math.asin(min(0.99, 0.00575 / r_eye))            # 11.5 mm iris
    pupil_a = math.radians(6.4)
    M = F.M
    # sclera ~ sRGB 0.83 (not paper white), warmer / pinker toward the corners, darker near the lids
    sclera = np.array([0.66, 0.62, 0.58]) * (1 + 0.04 * noise2(du * 40, dv * 40, seed=3))[:, None]
    corner = np.abs(np.cos(phi)) * sst(0.50, 1.00, ang)
    sclera = sclera * (1 - corner[:, None] * np.array([0.04, 0.17, 0.19]))
    vein = (np.abs(noise2(np.cos(phi) * 9 + 40, ang * 12, seed=5)) < 0.05) * sst(0.6, 1.2, ang)
    sclera = sclera * (1 - vein[:, None] * np.array([0.0, 0.25, 0.25]))
    sclera *= (1 - 0.30 * sst(0.55, 0.95, ang))[:, None]                    # ring under the lid margins
    t = np.clip(ang / iris_a, 0, 1.5)
    fib = 0.5 + 0.5 * noise2(phi * 38 / (2 * np.pi) * 6, t * 3, seed=7) + 0.25 * noise2(phi * 160 / (2 * np.pi), t * 2, seed=8)
    base = np.array([0.070, 0.044, 0.026])                    # natural brown / hazel
    light = np.array([0.20, 0.135, 0.075])
    iris = base + (light - base) * np.clip(fib, 0, 1)[:, None] * (0.6 + 0.4 * sst(0.3, 0.6, t))[:, None]
    iris *= (1 - 0.78 * sst(0.74, 1.0, t))[:, None]                    # dark limbal ring
    iris *= (1 - 0.25 * gauss((t - 0.42) ** 2, 0.06))[:, None]           # collarette
    pupil = (ang < pupil_a)
    edge = sst(iris_a * 0.985, iris_a * 1.05, ang)            # soft limbus into the sclera
    sclera = sclera * (1 - 0.35 * (1 - sst(iris_a, iris_a * 1.12, ang)))[:, None]
    col = iris * (1 - edge[:, None]) + sclera * edge[:, None]
    col = np.where(pupil[:, None], np.array([0.012, 0.010, 0.010]), col)
    # the upper lid shades the top of the eyeball (no contact shadows at this scale in real time)
    up = np.sin(phi) * np.clip(ang / 1.2, 0, 1)
    col = col * (1 - 0.32 * sst(-0.05, 0.55, up))[:, None]
    rough = np.full(M, 0.06)
    finish('Eyes', S, F, alb=col, rough=rough, base=(1, 1, 1, 1))


def _strokes(Wd, Hd, hairs, width_px, soft=False):
    """Rasterise hair strokes into an alpha image (H, W). hairs: list of polylines in px.
    soft: gaussian cross-section (alpha fades over ~2-3 texels, for alpha-to-coverage)."""
    img = np.zeros((Hd, Wd))
    yy, xx = np.mgrid[0:Hd, 0:Wd]
    for pts, w0 in hairs:
        pts = np.asarray(pts, float)
        n = len(pts)
        for k in range(n - 1):
            a, b = pts[k], pts[k + 1]
            w = w0 * (1 - 0.75 * (k + 0.5) / (n - 1))
            x0, x1 = int(max(0, min(a[0], b[0]) - 3)), int(min(Wd, max(a[0], b[0]) + 4))
            y0, y1 = int(max(0, min(a[1], b[1]) - 3)), int(min(Hd, max(a[1], b[1]) + 4))
            if x1 <= x0 or y1 <= y0:
                continue
            X, Y = xx[y0:y1, x0:x1], yy[y0:y1, x0:x1]
            ab = b - a
            L2 = max(ab @ ab, 1e-9)
            t = np.clip(((X - a[0]) * ab[0] + (Y - a[1]) * ab[1]) / L2, 0, 1)
            d = np.hypot(X - (a[0] + t * ab[0]), Y - (a[1] + t * ab[1]))
            v = np.exp(-(d / max(w, 0.35)) ** 2) * min(1.0, w + 0.35) if soft else np.clip(w - d + 0.5, 0, 1)
            img[y0:y1, x0:x1] = np.maximum(img[y0:y1, x0:x1], v)
    return img


def tex_lashes():
    W = H = SIZE['Lashes']
    rng = np.random.default_rng(7)
    alpha = np.zeros((H, W))
    for b in range(4):
        upper = b in (0, 2)
        v0 = (b * 0.25 + 0.01) * H
        vh = 0.23 * H
        n = 70 if upper else 34
        hairs = []
        for i in range(n):
            u = (0.04 + 0.92 * (i + rng.random() * 0.8) / n) * W
            length = (0.85 if upper else 0.5) * (0.55 + 0.45 * math.sin(math.pi * min(1, u / W * 1.1))) * vh
            lean = (u / W - 0.35) * 30 + rng.normal(0, 4)
            pts = []
            for k in range(6):
                f = k / 5
                pts.append((u + lean * f * f, v0 + 1 + length * f))
            hairs.append((pts, 1.6 if upper else 1.2))
        alpha = np.maximum(alpha, _strokes(W, H, hairs, 1.5))
    rgba = np.zeros((H, W, 4))
    rgba[..., :3] = TX.lin2srgb(np.full((H, W, 3), 0.025))
    rgba[..., 3] = alpha
    img = TX.save('Lashes_albedo', rgba, fmt='PNG')
    TX.setup_material('Lashes', albedo=img, base=(1, 1, 1, 1), rough=0.6, alpha_clip=True)
    bpy.data.materials['Lashes'].use_backface_culling = False


# ====================================================================== hair (shells, ponytail, brows)
def tex_hair(body, acc):
    import golfer_body as BODY
    import golfer_accessories as ACC
    W = SIZE['Hair']
    hair_objs = [o for o in acc if o.name in ('Hair_Short', 'Hair_Long')]
    S = TX.sample([(body, {'Hair'}, None)] + [(o, {'Hair'}, None) for o in hair_objs], W, margin=6)
    F = S.flat()
    M = F.M
    pid = F.pid
    alb = np.ones(M)
    alpha = np.ones(M)
    hgt = np.zeros(M)
    col = F.i[1].astype(float)
    row = F.i[0].astype(float)
    # --- shells: u around, vv 0 = crown .. 1 = edge
    for key, pids in (('short', (PART['hair_short'],)), ('long', (PART['hair_long'],))):
        r = ACC.UV['Hair'][key]
        sel = np.isin(pid, pids)
        uu = (F.u - r[0]) / (r[2] - r[0])
        vv = (r[3] - F.v) / (r[3] - r[1])
        sx = uu * (1600 if key == 'short' else 1300)
        crown = sst(0.03, 0.16, vv)                  # streaks fade out where the columns converge
        s1 = noise2(sx, vv * (10 if key == 'short' else 5), seed=51) * crown
        s2 = noise2(sx * 2.3, vv * 18, seed=52) * crown
        clump = noise2(uu * 90, vv * 3, seed=53)
        a = 0.86 + 0.10 * s1 + 0.06 * s2 + 0.05 * clump
        a *= 1.0 - 0.10 * sst(0.75, 1.0, vv)          # thinner, darker at the edge
        a *= 1.0 - 0.08 * (1 - sst(0.0, 0.12, vv))     # crown whorl shade
        # feathered hairline: an alpha gradient over the last ~5 mm above the edge ring, broken into
        # individual strands of random reach (for alpha-to-coverage; no hard binary cut)
        n_r = 14 if key == 'short' else 12
        edge_v = n_r / (n_r + 1.0)
        ramp = 0.055
        sid = np.floor(uu * (760 if key == 'short' else 640)).astype(np.int64)
        reach = 0.45 + 0.75 * TX._rand(sid, seed=54)
        xr = (vv - (edge_v - ramp)) / ramp
        fine = 0.70 + 0.30 * noise2(uu * 2600, vv * 40, seed=55)
        al = np.where(xr <= 0, 1.0, np.clip(1.0 - xr / reach, 0, 1) ** 1.3 * fine)
        al = np.where(vv > edge_v + 0.010, 0.0, al)
        alb = np.where(sel, a, alb)
        alpha = np.where(sel, al, alpha)
        hgt = np.where(sel, 0.00006 * s1 + 0.00004 * s2 + 0.00008 * clump, hgt)
    # --- hairline cards: strands from the root (top of the strip) to tapered tips
    r = ACC.UV['Hair']['cards']
    sel = pid == PART['hair_card']
    uu = (F.u - r[0]) / (r[2] - r[0])
    vt = (r[3] - F.v) / (r[3] - r[1])                    # 0 root .. 1 tip
    sx = uu * 520.0
    sid = np.floor(sx)
    frac = sx - sid
    slen = 0.45 + 0.55 * TX._rand(sid.astype(np.int64), seed=58)
    lean = (TX._rand(sid.astype(np.int64), seed=59) - 0.5) * 0.6
    core = np.abs(frac - 0.5 - lean * vt) < 0.30 * (1.0 - 0.6 * vt)
    al = np.where(vt < 0.18, 1.0, (core & (vt < slen)).astype(float))
    alpha = np.where(sel, al, alpha)
    alb = np.where(sel, 0.80 + 0.14 * TX._rand(sid.astype(np.int64), seed=60), alb)
    hgt = np.where(sel, 0.00004 * np.sin(frac * 2 * np.pi), hgt)
    # --- outer clump layer over the short hair: separate locks with soft edges
    r = ACC.UV['Hair']['layer']
    sel = pid == PART['hair_layer']
    uu = (F.u - r[0]) / (r[2] - r[0])
    vl = (r[3] - F.v) / (r[3] - r[1])
    sxl = uu * 150.0 + 0.6 * noise2(uu * 40, vl * 3, seed=61)
    sidl = np.floor(sxl).astype(np.int64)
    frac = sxl - sidl
    wid = 0.22 + 0.14 * TX._rand(sidl, seed=62)
    lock = np.exp(-((frac - 0.5) / wid) ** 2) * (TX._rand(sidl, seed=63) > 0.40)
    taper = sst(0.0, 0.20, vl) * (1.0 - sst(0.70, 1.0, vl * (0.8 + 0.4 * TX._rand(sidl, seed=64))))
    al = np.clip(lock * taper * 1.25, 0, 1) * (0.75 + 0.25 * noise2(uu * 2000, vl * 20, seed=65))
    alpha = np.where(sel, al, alpha)
    alb = np.where(sel, 0.90 + 0.10 * TX._rand(sidl, seed=66), alb)
    hgt = np.where(sel, 0.00005 * np.cos((frac - 0.5) * np.pi), hgt)
    # --- ponytail
    r = ACC.UV['Hair']['tail']
    sel = pid == PART['ponytail']
    uu = (F.u - r[0]) / (r[2] - r[0])
    vv = (r[3] - F.v) / (r[3] - r[1])
    s1 = noise2(uu * 260, vv * 4, seed=56)
    alb = np.where(sel, 0.86 + 0.12 * s1, alb)
    hgt = np.where(sel, 0.0001 * s1, hgt)
    # --- brows: strokes in their rectangle
    rb = BODY.UV['Hair']['brow']
    bw = int(round((rb[2] - rb[0]) * W))
    bh = int(round((rb[3] - rb[1]) * W))
    rng = np.random.default_rng(3)
    hairs = []
    BL = 0.050                                          # brow card length (m), see golfer_body.build_brows

    def card_h(t):                                      # card height (m) at t
        return 2.0 * (0.0052 * (1.0 - 0.45 * t) + 0.0008)
    for i in range(620):
        t = rng.random()
        # brow footprint in card v: rounded head, arch peak ~0.6, thin tapering tail
        lo = 0.24 + 0.10 * math.sin(math.pi * min(1.0, t * 1.2)) - 0.02 * t
        hi = 0.80 + 0.06 * math.sin(math.pi * min(1.0, t * 1.15)) - 0.45 * t ** 2.0
        if hi - lo < 0.05:
            continue
        keep = (0.15 + 0.85 * sst(0.0, 0.14, t)) * (1.0 - 0.7 * sst(0.60, 1.0, t))
        if rng.random() > keep:
            continue
        v = lo + (hi - lo) * rng.random()
        # head hairs grow up and out, body hairs outward, tail hairs out and slightly down
        deg = 28.0 + 40.0 * (1.0 - sst(0.0, 0.22, t)) - 34.0 * sst(0.45, 1.0, t) + rng.normal(0, 7)
        L = (0.0050 + 0.0030 * rng.random()) * (1.0 - 0.3 * t)
        dx = math.cos(math.radians(deg)) * L / BL * bw
        dy = math.sin(math.radians(deg)) * L / card_h(t) * bh
        x0, y0 = t * bw, v * bh
        pts = [(x0 + dx * f, y0 + dy * f - 0.12 * abs(dx) * f * f * sst(0.1, 0.3, t)) for f in np.linspace(0, 1, 5)]
        hairs.append((pts, 0.55 + 0.30 * rng.random()))
    brow_alpha = _strokes(bw, bh, hairs, 1.0, soft=True)
    sel = pid == PART['brow']
    bx = np.clip(((F.u - rb[0]) * W).astype(int), 0, bw - 1)
    by = np.clip(((F.v - rb[1]) * W).astype(int), 0, bh - 1)
    ba = brow_alpha[by, bx]
    alpha = np.where(sel, np.clip(ba * 0.90, 0, 1), alpha)
    alb = np.where(sel, 0.95 + 0.05 * uv_noise(F, 1.5, seed=58), alb)   # ~1.1x the hair shell albedo
    # height -> slopes on the grid (texel space)
    su, sv = grid_slopes(F, S, hgt)
    rough = np.full(M, 0.60) + 0.08 * noise2(col / 7, row / 40, seed=57)
    albc = np.stack([alb, alb * 0.985, alb * 0.97], axis=1)
    finish('Hair', S, F, alb=albc, alpha=alpha, slopes=(su, sv), rough=rough, alpha_clip=True)


# ====================================================================== shirt
def _torso_axis_coords(P):
    """Cylindrical coordinates around the torso axis: angle from the front (+x toward the left)."""
    rel = P - np.array([0.0, 0.012, 0.0])
    th = np.arctan2(rel[:, 0], -rel[:, 1])
    rad = np.hypot(rel[:, 0], rel[:, 1])
    return th, rad


def tex_shirt(body, ao):
    import golfer_body as BODY
    W = SIZE['Shirt']
    S = TX.sample([(body, {'Shirt'}, None)], W)
    F = S.flat()
    P, N, pid = F.P, F.N, F.pid
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    M = F.M
    torso = pid == PART['torso']
    collar = pid == PART['collar']
    placket = pid == PART['placket']
    sleeve = pid == PART['sleeve']
    sh = {s: np.array(J['shoulder_' + s][:]) for s in 'LR'}
    el = {s: np.array(J['elbow_' + s][:]) for s in 'LR'}

    def h3(Q, F_):
        qx, qy, qz = Q[:, 0], Q[:, 1], Q[:, 2]
        th, rad = _torso_axis_coords(Q)
        h = np.zeros(len(Q))
        body_ = (np.abs(qx) < 0.20) & (qz > 1.0)
        # side seams (theta = +-90 deg) from the armpit to the hem
        for s in (1, -1):
            d = (th - s * math.pi / 2 * 1.02) * rad
            h += (0.00030 * ridge(d, 0.0016) - 0.00018 * ridge(d - 0.0028 * s, 0.0007)) * body_ * (qz < 1.33)
        # shoulder seams: line from the neck side to the shoulder point (on top)
        for s in (1, -1):
            a = np.array([s * 0.060, 0.030, 1.505])
            b = sh['L' if s > 0 else 'R'] + np.array([0, 0.004, 0.045])
            d, t = seg_dist(Q, a, b)
            h += 0.00025 * ridge(d, 0.0015) * (qz > 1.40)
        # armhole seams (around the arm at the shoulder joint)
        for side in 'LR':
            du = (el[side] - sh[side]) / np.linalg.norm(el[side] - sh[side])
            along = (Q - sh[side]) @ du
            radial = np.linalg.norm((Q - sh[side]) - along[:, None] * du, axis=1)
            near = radial < 0.09
            h += (0.00025 * ridge(along - 0.012, 0.0016) - 0.00015 * ridge(along - 0.0155, 0.0006)) * near
        # drape folds from the armpits down/inward (front and back)
        for s in (1, -1):
            for fy, k in ((-1, 0), (1, 1)):
                for j, off in enumerate((0.0, 0.035, 0.070)):
                    a = np.array([s * (0.150 - off * 0.3), 0.012 + fy * 0.07, 1.30 - off * 0.4])
                    b = np.array([s * (0.060 - off * 0.2), 0.012 + fy * 0.09, 1.10 - off * 0.2])
                    d, t = seg_dist(Q, a, b)
                    side_ok = (qy - 0.012) * fy > 0
                    h += 0.0030 * ridge(d, 0.012 + 0.005 * j) * np.sin(np.pi * t) ** 1.2 * side_ok * (0.8 - 0.2 * j)
        # tucking / blousing folds above the belt: irregular, patchy
        bl = sst(1.03, 1.05, qz) * (1 - sst(1.08, 1.17, qz)) * body_
        gate = sst(-0.25, 0.35, noise3(Q, 11.0, seed=62))
        h += 0.0034 * bl * gate * np.sin(th * 8.5 + 3.2 * noise3(Q, 9.0, seed=61) + 40 * (qz - 1.05) * noise3(Q, 6.0, seed=60))
        # soft large-scale drape noise everywhere
        h += 0.0018 * fbm3(Q, 9.0, 3, seed=63)
        # lower-back compression folds and sleeve folds near the armpit
        back = (qy > 0.06) * sst(1.05, 1.08, qz) * (1 - sst(1.15, 1.22, qz)) * body_
        gate = sst(-0.1, 0.45, noise3(Q, 9.0, seed=66))
        h += 0.0016 * back * gate * np.sin(qz * 2 * np.pi / 0.034 + 4.0 * noise3(Q, 7.0, seed=64) + 8.0 * qx)
        for side in 'LR':
            du = (el[side] - sh[side]) / np.linalg.norm(el[side] - sh[side])
            along = (Q - sh[side]) @ du
            radial = np.linalg.norm((Q - sh[side]) - along[:, None] * du, axis=1)
            arm_ = (radial < 0.075) * sst(0.03, 0.06, along) * (1 - sst(0.13, 0.17, along))
            gate = sst(-0.2, 0.4, noise3(Q, 16.0, seed=67))
            tw = (Q - sh[side]) @ np.array([0.0, 0.0, 1.0])
            h += 0.0011 * arm_ * gate * np.sin(along * 2 * np.pi / 0.030 + 3.5 * noise3(Q, 12.0, seed=65) + 25.0 * tw)
        return h
    st3 = TX.slopes3(F, h3, eps=0.0006)
    # collar: flat-knit ribs across, edge stitches; placket stitches and buttonholes; sleeve hem
    hc = np.zeros(M)
    r = BODY.UV['Shirt']['collar']
    cu = (F.u - r[0]) / (r[2] - r[0])                    # around the neck
    cv = (F.v - r[1]) / (r[3] - r[1])                    # profile parameter
    hc += collar * 0.00005 * np.sin(cu * 2 * np.pi * 260)
    hc += collar * 0.00008 * (np.abs(((cv * 8.0) % 1.0) - 0.5) < 0.04)
    rp = BODY.UV['Shirt']['placket']
    pu = (F.u - rp[0]) / (rp[2] - rp[0])                  # down the placket
    pv = (F.v - rp[1]) / (rp[3] - rp[1])                  # across
    stitch = ((pu * 140) % 1.0 < 0.6)
    hc += placket * (-0.00012 * (np.abs(pv - 0.08) < 0.02) * stitch - 0.00012 * (np.abs(pv - 0.92) < 0.02) * stitch)
    # buttonholes (vertical slits above each button)
    for bz in BODY.BUTTON_Z:
        hc += placket * -0.0002 * (np.abs(z - (bz + 0.0)) < 0.008) * (np.abs(x) < 0.0009)
    rs = BODY.UV['Shirt']['sleeve']
    sv_ = (F.u - rs[0]) / (rs[2] - rs[0])
    sk = (sv_ % 0.5) / 0.5                                 # ring index param 0..1 per sleeve
    hc += sleeve * -0.00010 * ((np.abs(sk - 0.40) < 0.03) | (np.abs(sk - 0.30) < 0.03)) * ((F.v * 400) % 1.0 < 0.6)
    # knit grain (texel grid)
    g = 0.000045 * uv_noise(F, 1.6, seed=64) + 0.00004 * uv_noise(F, 3.5, seed=65)
    gd, grid_ = uv_grain(F, 2.4, seed=66)
    g += -0.00003 * (1 - sst(0.0, 0.45, gd))
    su, sv = grid_slopes(F, S, hc + g)
    slopes = (st3[0] + su, st3[1] + sv)
    alb = np.ones((M, 3)) * (0.965 + 0.015 * uv_noise(F, 2.0, seed=67))[:, None]
    alb *= (1 - 0.03 * np.clip(-st3[0] * 0 + 0, 0, 1))[:, None]
    rough = 0.80 + 0.04 * uv_noise(F, 3.0, seed=68)
    finish('Shirt', S, F, alb=alb, slopes=slopes, rough=rough, ao=ao.get('Shirt'))


# ====================================================================== trousers
def tex_pants(body, ao):
    W = SIZE['Pants']
    S = TX.sample([(body, {'Pants'}, None)], W)
    F = S.flat()
    P, N, pid = F.P, F.N, F.pid
    M = F.M
    kn = {s: np.array(J['knee_' + s][:]) for s in 'LR'}
    hp = {s: np.array(J['hip_' + s][:]) for s in 'LR'}

    def leg_coords(Q, side):
        s = 1.0 if side == 'L' else -1.0
        an = np.array(J['ankle_' + side][:])
        axis_x = np.interp(Q[:, 2], [0.0, 0.5, 0.92], [an[0], kn[side][0], hp[side][0]])
        axis_y = np.interp(Q[:, 2], [0.0, 0.5, 0.92], [an[1] + 0.01, kn[side][1], 0.0])
        rx_, ry_ = Q[:, 0] - axis_x, Q[:, 1] - axis_y
        th = np.arctan2(rx_ * s, -ry_)          # 0 = front, +pi/2 = outside
        return th, np.hypot(rx_, ry_)

    def h3(Q, F_):
        qx, qy, qz = Q[:, 0], Q[:, 1], Q[:, 2]
        h = np.zeros(len(Q))
        for side, s in (('L', 1.0), ('R', -1.0)):
            on = (qx * s > 0.015) & (qz < 0.90)
            th, rad = leg_coords(Q, side)
            # front and back pressed creases
            h += 0.00055 * ridge(th * rad, 0.0016) * on * (qz > 0.05)
            h += 0.00035 * ridge((np.abs(th) - math.pi) * rad, 0.0018) * on * (qz < 0.62)
            # outseam and inseam
            for ang, amp in ((math.pi / 2, 1.0), (-math.pi / 2, 0.8)):
                d = (th - ang) * rad
                h += amp * (0.00025 * ridge(d, 0.0014) - 0.00012 * ridge(d - 0.0024, 0.0006)) * on
            # knee wrinkles behind the knee and break folds above the hem
            back = np.abs(th) > 2.0
            h += 0.0007 * np.sin((qz - 0.50) * 2 * np.pi / 0.024 + th * 2 + 3.0 * noise3(Q, 14.0, seed=78)) * gauss((qz - 0.50) ** 2, 0.04) * back * on
            frontf = np.abs(th) < 1.3
            gate = sst(-0.3, 0.3, noise3(Q, 22.0, seed=76 + int(s > 0)))
            h += 0.0011 * gate * np.sin((qz - 0.08) * 2 * np.pi / 0.032 + th * 1.5 + 3.0 * noise3(Q, 15.0, seed=77)) * gauss((qz - 0.12) ** 2, 0.045) * frontf * on
        # waistband seam and front pocket openings, fly J-stitch, back welt pockets
        h += -0.00025 * ridge(qz - 0.955, 0.0010) * (qz > 0.93)
        for s in (1, -1):
            a = np.array([s * 0.095, -0.090, 0.985])
            b = np.array([s * 0.145, -0.020, 0.855])
            d, t = seg_dist(Q, a, b)
            h += (-0.0005 * ridge(d, 0.0012) + 0.00015 * ridge(d - 0.004, 0.0006)) * (qy < 0.0)
            # back welt pockets
            c = (np.abs(qz - 0.935) < 0.008) * (np.abs(np.abs(qx) - 0.075) < 0.060) * (qy > 0.08)
            h += -0.0004 * c * ridge(qz - 0.935, 0.0012) * (np.sign(qx) == s)
        fly, arc = polyline_dist(Q, [np.array([0.022, -0.12, 0.985]), np.array([0.022, -0.12, 0.880]),
                                     np.array([0.012, -0.12, 0.855]), np.array([0.0, -0.12, 0.848])])
        h += -0.00018 * ridge(fly, 0.0008) * (qy < -0.03) * ((arc / 0.003) % 1.0 < 0.6)
        h += -0.0003 * ridge(np.abs(qx), 0.0012) * (qz > 0.84) * (qz < 1.0)       # centre seams
        h += 0.0006 * fbm3(Q, 8.0, 3, seed=71)
        return h
    st3 = TX.slopes3(F, h3, eps=0.0006)
    # twill grain on the texel grid (diagonal) + noise
    col = F.i[1].astype(float)
    row = F.i[0].astype(float)
    tw = 0.000030 * np.sin((col + row) * 2 * np.pi / 4.6) + 0.00003 * uv_noise(F, 2.2, seed=72)
    hm = np.zeros(M)
    hm += (pid == PART['belt_loop']) * 0.0
    su, sv = grid_slopes(F, S, tw + hm)
    alb = np.ones((M, 3)) * (0.955 + 0.02 * uv_noise(F, 2.2, seed=73) + 0.012 * fbm3(P, 12.0, 2, seed=74))[:, None]
    rough = 0.78 + 0.05 * uv_noise(F, 4.0, seed=75)
    finish('Pants', S, F, alb=alb, slopes=(st3[0] + su, st3[1] + sv), rough=rough, ao=ao.get('Pants'))


# ====================================================================== belt
def tex_belt(body, ao):
    import golfer_body as BODY
    W = SIZE['Belt']
    S = TX.sample([(body, {'Belt'}, None)], W, margin=4)
    F = S.flat()
    M = F.M
    pid = F.pid
    rb = BODY.UV['Belt']['band']
    vv = (F.v - rb[1]) / (rb[3] - rb[1])
    uu = (F.u - rb[0]) / (rb[2] - rb[0])
    band = pid == PART['belt']
    h = 0.00004 * uv_noise(F, 1.3, seed=81) + 0.00003 * uv_noise(F, 4.0, seed=82)
    d, _ = uv_grain(F, 3.0, seed=83)
    h += -0.00004 * (1 - sst(0.0, 0.4, d))
    stitch = (uu * 1100) % 1.0 < 0.6
    h += band * -0.00012 * ((np.abs(vv - 0.20) < 0.022) | (np.abs(vv - 0.80) < 0.022)) * stitch
    # tail: holes and edge stitches
    rm = BODY.UV['Belt']['misc']
    tu = (F.u - rm[0]) / (rm[2] - rm[0])
    tv = (F.v - rm[1]) / (rm[3] - rm[1])
    tail = pid == PART['belt_tail']
    for k in range(5):
        hc = np.hypot((tu - (0.12 + 0.09 * k)) * 3.0, (tv - 0.225) * 1.0)
        h += tail * -0.0006 * (hc < 0.018)
    su, sv = grid_slopes(F, S, h)
    alb = np.ones((M, 3)) * (0.93 + 0.05 * uv_noise(F, 6.0, seed=84))[:, None]
    rough = 0.42 + 0.08 * uv_noise(F, 5.0, seed=85)
    finish('Belt', S, F, alb=alb, slopes=(su, sv), rough=rough, ao=ao.get('Belt'))


# ====================================================================== shoes, soles, laces
def tex_shoes(body, ao):
    W = SIZE['Shoes']
    S = TX.sample([(body, {'Shoes'}, None)], W, margin=6)
    F = S.flat()
    M = F.M
    t = F.u                                    # heel 0 -> toe 1
    ph = F.v                                   # medial 0 -> top 0.5 -> lateral 1
    top = np.abs(ph - 0.5)                     # 0 on top
    h = np.zeros(M)
    alb = np.ones(M) * 0.96
    rough = np.full(M, 0.38)
    # toe cap seam (curved), perforations on the cap
    cap_line = 0.79 - 0.05 * (top / 0.5) ** 2
    d_cap = (t - cap_line) * 0.29
    h += -0.0003 * ridge(d_cap, 0.0006) + 0.00012 * ridge(d_cap - 0.0022, 0.0005) * ((t * 600) % 1 < 0.6)
    capz = t > cap_line + 0.01
    pcol = (t * 0.29 / 0.0042)
    prow = (ph * 0.21 / 0.0042)
    pd = np.hypot(pcol - np.round(pcol), prow - np.round(prow))
    perf = capz * (pd < 0.18) * (top < 0.38) * (t < 0.97)
    h += -0.00035 * perf
    alb -= 0.25 * perf
    # eyestay overlay outline around the lace area (stitched edge)
    eye_d = np.abs(top - (0.175 - 0.045 * np.clip((t - 0.475) / 0.225, 0, 1))) * 0.21
    lace_zone = (t > 0.44) & (t < 0.75)
    h += lace_zone * (0.00025 * ridge(eye_d, 0.0008) - 0.00012 * ridge(eye_d - 0.002, 0.0004))
    alb -= 0.05 * lace_zone * ridge(eye_d - 0.002, 0.0005)
    # eyelets
    import golfer_body as BODY
    for tt in BODY.LACE_T:
        for s in (-1, 1):
            de = np.hypot((t - tt) * 0.29, (ph - 0.5 - s * (BODY.lace_half(tt) + 0.012)) * 0.21)
            h += -0.0005 * (de < 0.0018) + 0.0002 * ridge(de - 0.0024, 0.0005)
            alb -= 0.35 * (de < 0.0018)
    # side saddle panel: sweep from the eyestay down to the sole
    for s in (-1, 1):
        sd = (ph - 0.5) * s
        line = np.abs((t - 0.40) * 0.29 - (sd - 0.18) * 0.21 * 1.4)
        h += (sd > 0.15) * (t > 0.3) * (t < 0.75) * (0.0002 * ridge(line, 0.0007) - 0.0001 * ridge(line - 0.0022, 0.0004))
    # heel counter overlay
    hc = (t - (0.17 + 0.05 * (top / 0.5) ** 2)) * 0.29
    h += 0.00025 * ridge(hc, 0.0007) - 0.0001 * ridge(hc + 0.0022, 0.0004) * ((ph * 500) % 1 < 0.6)
    # collar padding / top line near the ankle
    pad = (t < 0.42) & (top < 0.2)
    h += pad * 0.0004 * sst(0.0, 0.2, 0.2 - top)
    rough += 0.15 * pad
    # leather grain
    gd, _ = uv_grain(F, 2.0, seed=91)
    h += -0.000025 * (1 - sst(0.0, 0.45, gd)) + 0.00002 * uv_noise(F, 4.0, seed=92)
    su, sv = grid_slopes(F, S, h)
    # panel definition: toe cap, heel counter and eyestay overlays a shade darker, seams darker still
    alb -= 0.06 * capz + 0.08 * (t < 0.17 + 0.05 * (top / 0.5) ** 2) + 0.05 * lace_zone * (top < 0.20)
    alb -= 0.18 * ridge(d_cap, 0.0009) + 0.15 * ridge(hc, 0.0009) + 0.12 * lace_zone * ridge(eye_d, 0.0009)
    alb = np.clip(alb + 0.015 * uv_noise(F, 3.0, seed=93), 0.5, 1.0)
    finish('Shoes', S, F, alb=np.stack([alb] * 3, axis=1), slopes=(su, sv), rough=rough, ao=ao.get('Shoes'))


def tex_sole(body, ao):
    W = SIZE['Sole']
    S = TX.sample([(body, {'Sole'}, None)], W, margin=4)
    F = S.flat()
    M = F.M
    P = F.P
    z = P[:, 2]
    bottom = F.v < 0.5
    alb = np.ones((M, 3)) * np.array([0.90, 0.90, 0.88])
    outsole = (z < 0.0065) | bottom
    alb = np.where(outsole[:, None], np.array([0.045, 0.045, 0.05]), alb)
    h = np.zeros(M)
    # midsole sidewall grooves
    h += (~bottom) * -0.00025 * ridge(z - 0.013, 0.0007)
    # outsole pattern: spikes + traction nubs
    uu, vv = F.u * 512, F.v * 512
    d, rid = cells2(uu / 9.0, vv / 9.0, seed=95, jitter=0.4)
    h += bottom * 0.0006 * (1 - sst(0.18, 0.30, d))
    su, sv = grid_slopes(F, S, h)
    rough = np.where(outsole, 0.85, 0.6)
    finish('Sole', S, F, alb=alb, slopes=(su, sv), rough=rough, ao=ao.get('Sole'), base=(1, 1, 1, 1))


# ====================================================================== glove
def tex_glove(body, ao):
    import golfer_body as BODY
    from golfer_skeleton import hand_frame
    W = SIZE['Glove']
    S = TX.sample([(body, {'Glove'}, None)], W)
    F = S.flat()
    P, pid = F.P, F.pid
    M = F.M
    hf = hand_frame('L')
    Wr, a, p, tdir = (np.array(hf[k][:]) for k in ('wrist', 'along', 'palm', 'thumb'))
    rel = P - Wr
    al = rel @ a
    pal = rel @ p
    th = rel @ tdir
    tab = pid == PART['glove_tab']
    h = np.zeros(M)
    alb = np.ones((M, 3)) * np.array([0.93, 0.925, 0.90])
    # elastic wrist: gathered ridges across
    wrist = (al < 0.012) & (al > -0.03)
    h += wrist * 0.00012 * np.sin(th * 2 * np.pi / 0.0025)
    alb = np.where((wrist & (al < -0.018))[:, None], np.array([0.80, 0.80, 0.80]), alb)
    # perforations over the finger backs
    fingers = BODY.HAND_DATA.get('L', [])
    perf_zone = np.zeros(M, bool)
    seam = np.zeros(M)
    for fd in fingers:
        kn_ = np.array(fd['knuckle'][:])
        tip = np.array(fd['tip'][:])
        d, t = seg_dist(P, kn_, tip)
        perf_zone |= (d < fd['r'] * 1.6) & (t > 0.15) & (t < 0.85) & ((P - kn_) @ np.array(fd['dorsal'][:]) > -0.002)
        seam = np.maximum(seam, ridge(d - fd['r'] * 1.35, 0.0006) * (t > 0.05))
    pc = (al / 0.0035)
    pr = (th / 0.0035)
    pdd = np.hypot(pc - np.round(pc), pr - np.round(pr))
    perf = perf_zone * (pdd < 0.16)
    h += -0.0003 * perf - 0.00012 * seam
    alb -= 0.20 * perf[:, None]
    # tab: border stitch, slightly darker grey edge
    tc = np.zeros(M)
    if tab.any():
        e = np.abs(rel @ tdir + 0.004)
        tc = tab * (np.abs(e - 0.0115) < 0.0012)
        alb = np.where(tab[:, None], np.array([0.88, 0.88, 0.87]), alb)
        h += -0.00015 * tc
    gd, _ = uv_grain(F, 2.0, seed=97)
    h += -0.00002 * (1 - sst(0.0, 0.45, gd)) + 0.00002 * uv_noise(F, 3.0, seed=98)
    su, sv = grid_slopes(F, S, h)
    rough = np.full(M, 0.55) + 0.05 * uv_noise(F, 5.0, seed=99)
    finish('Glove', S, F, alb=alb, slopes=(su, sv), rough=rough, ao=ao.get('Glove'), base=(1, 1, 1, 1))


# ====================================================================== hats
def tex_hat(acc, ao):
    import golfer_accessories as ACC
    W = SIZE['Hat']
    hats = [o for o in acc if o.name.startswith('Hat_')]
    S = TX.sample([(o, {'Hat'}, None) for o in hats], W)
    F = S.flat()
    M = F.M
    pid = F.pid
    h = np.zeros(M)
    alb = np.ones(M) * 0.96
    U = ACC.UV['Hat']

    def local(rect):
        return (F.u - rect[0]) / (rect[2] - rect[0]), (F.v - rect[1]) / (rect[3] - rect[1])
    # cap crown: 6 panel seams (double stitched), eyelets, band stitching at the edge
    cu, cv = local(U['cap'])
    cap = pid == PART['cap']
    vv = 1 - cv                                     # 0 crown -> 1 edge
    az = cu * 360.0 - 180.0
    for sd in ACC.CAP_SEAMS:
        dd = ((az - sd + 180) % 360 - 180)
        arcw = np.maximum(np.sin(np.clip(vv, 0.02, 1) * 1.4), 0.08) * 0.09
        dm = np.radians(dd) * arcw
        stitch = ((vv * 160) % 1.0) < 0.6
        h += cap * (-0.0007 * ridge(dm, 0.0009) + 0.00022 * (ridge(np.abs(dm) - 0.0028, 0.0005)) * stitch)
    for k in range(6):
        ac = -150.0 + 60.0 * k
        de = np.hypot(np.radians(((az - ac + 180) % 360 - 180)) * 0.09 * np.sin(0.35 * 1.4), (vv - 0.34) * 0.12)
        h += cap * (-0.0005 * (de < 0.0014) + 0.0002 * ridge(de - 0.0022, 0.0005))
        alb -= cap * 0.3 * (de < 0.0014)
    h += cap * -0.00015 * (np.abs(vv - 0.90) < 0.008) * ((cu * 900) % 1.0 < 0.6)
    # bills: rows of stitching parallel to the front edge (top surface: left half of the rect)
    for key, pk in (('cap_bill', 'cap_bill'), ('visor_bill', 'visor_bill')):
        bu, bv = local(U[key])
        sel = pid == PART[pk]
        topside = bu < 0.5
        bvv = bv                                   # 0 = attached edge, 1 = front edge
        rows = np.zeros(M)
        for k in range(7):
            rows += ridge(bvv - (0.18 + 0.105 * k), 0.008)
        stitch = ((bu * 2 * 0.19 / 0.0032) % 1.0) < 0.62
        h += sel * topside * -0.00009 * rows * (0.35 + 0.65 * stitch)
        h += sel * 0.0003 * ridge(bvv - 1.0, 0.04)
    # visor band: edge stitches; bucket: stitching rows on the brim and crown band
    vu, vvv = local(U['visor_band'])
    h += (pid == PART['visor_band']) * -0.0001 * ((np.abs(vvv - 0.15) < 0.04) | (np.abs(vvv - 0.85) < 0.04)) * ((vu * 900) % 1 < 0.6)
    bu, bv = local(U['bucket_brim'])
    sel = pid == PART['bucket_brim']
    rows = sum(ridge(bu - (0.08 + 0.06 * k), 0.006) for k in range(5))
    h += sel * -0.00012 * rows * ((bv * 900) % 1 < 0.6)
    # cotton twill grain
    col = F.i[1].astype(float)
    row = F.i[0].astype(float)
    h += 0.000012 * np.sin((col - row) * 2 * np.pi / 4.6) + 0.000015 * uv_noise(F, 2.2, seed=101)
    su, sv = grid_slopes(F, S, h)
    alb = np.clip(alb + 0.015 * uv_noise(F, 2.5, seed=102), 0.6, 1.0)
    rough = np.full(M, 0.78) + 0.04 * uv_noise(F, 4.0, seed=103)
    finish('Hat', S, F, alb=np.stack([alb] * 3, axis=1), slopes=(su, sv), rough=rough, ao=ao.get('Hat'))


# ====================================================================== driver
def bake_all_ao(arm, body, acc):
    """AO in rest pose. Brow and lash cards are moved away so they do not shade the skin."""
    arm.data.pose_position = 'REST'
    pids = TX.part_ids(body)
    me = body.data
    hide_v = set()
    for p in me.polygons:
        if pids[p.index] in (PART['brow'], PART['lash']):
            hide_v.update(p.vertices)
    saved = {i: me.vertices[i].co.copy() for i in hide_v}
    for i in hide_v:
        me.vertices[i].co.z -= 10.0
    me.update()
    sizes = {m: (ORM_SIZE[m], ORM_SIZE[m]) for m in ('Skin', 'Shirt', 'Pants', 'Belt', 'Shoes', 'Sole', 'Glove')}
    ao = TX.bake_ao([body], [body], sizes, samples=64, distance=0.10)
    for i, co in saved.items():
        me.vertices[i].co = co
    me.update()
    hat_ao = None
    for o in acc:
        if not o.name.startswith('Hat_'):
            continue
        a = TX.bake_ao([o], [o, body], {'Hat': (ORM_SIZE['Hat'], ORM_SIZE['Hat'])}, samples=48, distance=0.06)['Hat']
        hat_ao = a if hat_ao is None else np.minimum(hat_ao, a)
    ao['Hat'] = hat_ao
    arm.data.pose_position = 'POSE'
    # soften: AO only modulates indirect light in three.js; keep it gentle
    return {k: (0.35 + 0.65 * v) if v is not None else None for k, v in ao.items()}


def generate(arm, body, acc):
    t0 = time.time()
    ao = bake_all_ao(arm, body, acc)
    print('  AO baked %.1fs' % (time.time() - t0))
    steps = [('Skin', lambda: tex_skin(body, ao)), ('Eyes', lambda: tex_eyes(body)), ('Lashes', tex_lashes),
             ('Hair', lambda: tex_hair(body, acc)), ('Shirt', lambda: tex_shirt(body, ao)),
             ('Pants', lambda: tex_pants(body, ao)), ('Belt', lambda: tex_belt(body, ao)),
             ('Shoes', lambda: tex_shoes(body, ao)), ('Sole', lambda: tex_sole(body, ao)),
             ('Glove', lambda: tex_glove(body, ao)), ('Hat', lambda: tex_hat(acc, ao))]
    for name, fn in steps:
        t1 = time.time()
        fn()
        print('  texture %-7s %.1fs' % (name, time.time() - t1))
