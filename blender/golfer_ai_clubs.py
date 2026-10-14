"""Swap the procedural club heads for the Artlist (Tripo) generated ones.

The generated heads (public/models/ai/<club>.glb, unit-sized, arbitrary orientation) are registered
onto the procedural head in the address frame A: every one of the 24 axis-aligned orientations is
scaled to the procedural head's size and refined with trimmed ICP; the best fit wins. Only the
procedural head -> generated head distance is scored, so the generated hosel / shaft stub (which
the procedural head lacks) doesn't pull the fit. FACE_CENTERS and HEAD_POINTS stay those of the
procedural head, so impact and ground contact are unchanged.
"""
import itertools
import os

import bpy
import numpy as np
from mathutils import Matrix
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.join(HERE, '..', 'public', 'models', 'ai')


# Direction of each generated head's hosel in its imported (Blender Z-up) frame, read off the
# axis-marked previews from ai_optimize.py --preview. Tripo builds them upright, hosel up.
HOSEL_DIR = {
    'Driver': (0.0, 0.4, 1.0),
    'Wood': (0.0, 0.5, 1.0),
    'Hybrid': (0.0, 0.4, 1.0),
    'Iron': (-0.2, -0.3, 1.0),
    'Wedge': (0.0, -0.5, 1.0),
    'Putter': (-0.3, 0.0, 1.0),
}


def _rotations():
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            R = np.zeros((3, 3))
            for i, (p, s) in enumerate(zip(perm, signs)):
                R[i, p] = s
            if np.linalg.det(R) > 0:
                out.append(R)
    return out


def _frame(h, n):
    """Orthonormal frame (columns) from a hosel direction and a face normal."""
    e1 = h / np.linalg.norm(h)
    e2 = n - (n @ e1) * e1
    e2 /= np.linalg.norm(e2)
    return np.stack([e1, e2, np.cross(e1, e2)], axis=1)


def _face_normal(pts, h, iters=1500, seed=1):
    """The club face: the largest flat patch whose normal runs across the hosel axis, facing out.
    (The sole is flat too, but its normal runs along the hosel axis.)"""
    rng = np.random.default_rng(seed)
    tol = np.ptp(pts, 0).max() * 0.006
    c = pts.mean(0)
    best, best_n = 0, None
    for _ in range(iters):
        a, b, d = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(b - a, d - a)
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            continue
        n /= ln
        if abs(n @ h) > 0.75:
            continue
        inl = np.abs((pts - a) @ n) < tol
        cnt = int(inl.sum())
        if cnt > best:
            best, best_n = cnt, n if (pts[inl].mean(0) - c) @ n > 0 else -n
    return best_n


def _kd(pts):
    kd = KDTree(len(pts))
    for i, p in enumerate(pts):
        kd.insert(p, i)
    kd.balance()
    return kd


def _pairs(src, dst_kd, dst, R, s, t, keep_fwd, keep_bwd):
    """Trimmed correspondences both ways: procedural -> generated and generated -> procedural.
    The backward set keeps the generated head honest about scale; its trim drops the hosel."""
    q = (s * (src @ R.T)) + t
    idx = np.array([dst_kd.find(p)[1] for p in q])
    d = np.linalg.norm(dst[idx] - q, axis=1)
    f = d <= np.quantile(d, keep_fwd)
    qkd = _kd(q)
    bi = np.array([qkd.find(p)[1] for p in dst])
    bd = np.linalg.norm(q[bi] - dst, axis=1)
    b = bd <= np.quantile(bd, keep_bwd)
    A = np.concatenate([src[f], src[bi[b]]])
    B = np.concatenate([dst[idx[f]], dst[b]])
    err = np.sqrt(np.mean(np.concatenate([d[f], bd[b]]) ** 2))
    return A, B, err


def _icp(src, dst_kd, dst, R, s, t, iters=40, keep_fwd=0.9, keep_bwd=0.7):
    """Fit x -> s R x + t mapping `src` (procedural head points, mapped *into* the AI frame) onto dst."""
    for _ in range(iters):
        A, B, _ = _pairs(src, dst_kd, dst, R, s, t, keep_fwd, keep_bwd)
        ma, mb = A.mean(0), B.mean(0)
        A0, B0 = A - ma, B - mb
        U, S, Vt = np.linalg.svd(B0.T @ A0)
        D = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))])
        R = U @ D @ Vt
        s = (S * np.diag(D)).sum() / (A0 ** 2).sum()
        t = mb - s * (R @ ma)
    _, _, err = _pairs(src, dst_kd, dst, R, s, t, keep_fwd, keep_bwd)
    return R, s, t, float(err)


def _import(name):
    path = os.path.join(AI_DIR, name.lower() + '.glb')
    if not os.path.exists(path):
        return None
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in objs if o.type == 'MESH']
    for o in meshes:
        o.data.transform(o.matrix_world)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    for o in objs:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    if len(meshes) > 1:
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    return meshes[0]


# Index into candidates() of the orientation picked for each head, chosen by eye from the
# face-on renders of every candidate (blender/test_ai_clubs.py --candidates).
CHOICE = {'Driver': 0, 'Wood': 0, 'Hybrid': 2, 'Iron': 1, 'Wedge': 3, 'Putter': 0}
# The generated hybrid sits rolled toe-up and the wedge's tall toe gets clipped by the hosel trim,
# so those two keep their procedural heads.
AI_CLUBS = ('Driver', 'Wood', 'Iron', 'Putter')


def candidates(name, hp):
    """Axis-aligned starting rotations that point the procedural hosel along the generated one."""
    hg = np.array(HOSEL_DIR[name]) / np.linalg.norm(HOSEL_DIR[name])
    return [R0 for R0 in _rotations() if (R0 @ hp) @ hg > 0.5]


def fit(name, proc, head_pts, gen, kd, hp, s0, k):
    """Coarse fit with the hosel axis included (keeps the chosen orientation), then refine on the
    head alone so the sole sits flat even where the generated hosel is more upright than the lie."""
    R0 = candidates(name, hp)[k]
    t0 = gen.mean(0) - s0 * (R0 @ proc.mean(0))
    R, s, t, _ = _icp(proc, kd, gen, R0, s0, t0, iters=15)
    return _icp(head_pts, kd, gen, R, s, t, iters=60, keep_fwd=0.9, keep_bwd=0.6)


def _clip_above(ob, z):
    """Drop the generated hosel / shaft stub above z (address frame); the procedural hosel and
    shaft take over from there."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if max(v.co.z for v in f.verts) > z], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(ob.data)
    bm.free()


def replace_head(name, head, hosel_base, hosel_top, face_normal=None):
    """Return a mesh object (address frame A) to use instead of `head`, or `head` if unavailable.

    The hosel axis (hosel_base -> hosel_top) is sampled densely into the fit so the generated
    hosel lines up with the shaft; head shape alone is too symmetric to pin heel/toe and sole/top."""
    if name not in AI_CLUBS:
        return head
    ai = _import(name)
    if ai is None:
        return head
    head_pts = np.array([v.co[:] for v in head.data.vertices])
    b, tp = np.array(hosel_base[:]), np.array(hosel_top[:])
    hosel = b + np.linspace(0, 1, max(60, len(head_pts) // 3))[:, None] * (tp - b)
    proc = np.concatenate([head_pts, hosel])
    gen = np.array([v.co[:] for v in ai.data.vertices])
    kd = _kd(gen)
    # pre-scale: procedural head extent -> generated extent (the generated one includes its hosel)
    s0 = np.ptp(gen, 0).max() / np.ptp(proc, 0).max() * 0.85
    hg = np.array(HOSEL_DIR[name]) / np.linalg.norm(HOSEL_DIR[name])
    hp = (tp - head_pts.mean(0)) / np.linalg.norm(tp - head_pts.mean(0))
    R, s, t, err = fit(name, proc, head_pts, gen, kd, hp, s0, CHOICE.get(name, 0))
    print('AICLUB %s hosel agreement cos %.3f' % (name, (R @ hp) @ hg))
    # invert x_gen = s R x_A + t  ->  x_A = R^T (x_gen - t) / s
    M = Matrix.Identity(4)
    Ri = R.T / s
    for i in range(3):
        for j in range(3):
            M[i][j] = Ri[i, j]
        M[i][3] = -(Ri @ t)[i]
    ai.data.transform(M)
    _clip_above(ai, head_pts[:, 2].max() + 0.004)
    ai.name = head.name
    for slot in ai.material_slots:
        if slot.material:
            slot.material.name = 'ClubHead'
    extent = np.ptp(head_pts, 0).max()
    print('AICLUB %s fit rms %.4f m (%.1f%% of head size)' % (name, err / s, 100 * err / s / extent))
    bpy.data.objects.remove(head)
    return ai
