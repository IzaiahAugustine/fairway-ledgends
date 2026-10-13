"""Gallery spectators (Blender space, Z up, metres; feet on z=0, facing -Y).

Three low-poly poses for the crowds around greens and tees: Spectator_A (arms down),
Spectator_B (hands on hips) and Spectator_C (arms folded). They're drawn instanced in the game,
so the vertex colour is not a colour but a mask that picks each spectator's own colours:
  R = shirt, G = trousers, B = skin, black = hair / shoes / belt (dark).
"""
import math

import numpy as np

from env_mesh import MeshAccum

SHIRT, PANTS, SKIN, DARK = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (0.0, 0.0, 0.0)
Z3 = np.array([0.0, 0.0, 1.0])


def _paint(acc, start, col):
    for i in range(start, len(acc.verts)):
        acc.cols[i] = col


def _limb(acc, pts, radii, col, sides=7):
    s = len(acc.verts)
    acc.tube(pts, radii, sides, cap_end=True)
    _paint(acc, s, col)


def spectator(pose):
    acc = MeshAccum()
    # legs and shoes
    for sx in (-1, 1):
        _limb(acc, [(sx * 0.1, 0.0, 0.93), (sx * 0.105, 0.01, 0.5), (sx * 0.11, 0.0, 0.09)], [0.075, 0.062, 0.05], PANTS)
        s = len(acc.verts)
        acc.box((sx * 0.11, -0.04, 0.045), (0.05, 0.12, 0.045))
        _paint(acc, s, DARK)
    # hips (trousers) and torso (shirt), flattened front-to-back
    frame = (np.zeros(3), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), Z3)
    s = len(acc.verts)
    acc.lathe([(0.0, 0.84), (0.17, 0.86), (0.18, 0.98), (0.17, 1.0)], 10, frame=frame)
    _paint(acc, s, PANTS)
    s = len(acc.verts)
    acc.lathe([(0.17, 0.99), (0.165, 1.01), None, (0.165, 1.01), (0.175, 1.12), (0.195, 1.3), (0.2, 1.4), (0.15, 1.47), (0.06, 1.5), (0.0, 1.5)], 10, frame=frame)
    _paint(acc, s, SHIRT)
    s = len(acc.verts)
    acc.lathe([(0.172, 0.985), (0.172, 1.015)], 10, frame=frame)
    _paint(acc, s, DARK)  # belt
    # flatten the body front-to-back (people are wider than they are deep)
    body_end = len(acc.verts)
    acc.verts = [(x, y * 0.68, z) if 0.8 < z < 1.55 and i < body_end else (x, y, z) for i, (x, y, z) in enumerate(acc.verts)]
    # neck and head; hair on the crown
    s = len(acc.verts)
    acc.lathe([(0.045, 1.48), (0.048, 1.56)], 8, frame=frame)
    _paint(acc, s, SKIN)
    s = len(acc.verts)
    prof = [(0.105 * math.sin(math.radians(a)), 1.635 - 0.115 * math.cos(math.radians(a))) for a in range(0, 181, 20)]
    prof[0] = (0.0, prof[0][1])
    prof[-1] = (0.0, prof[-1][1])
    acc.lathe(prof, 10, frame=frame)
    for i in range(s, len(acc.verts)):
        x, y, z = acc.verts[i]
        acc.cols[i] = DARK if z > 1.66 or (z > 1.6 and y > 0.04) else SKIN
    # arms by pose (shoulders at +-0.2, z 1.42); sleeves are shirt, forearms skin
    for sx in (-1, 1):
        sh = (sx * 0.2, 0.0, 1.42)
        if pose == 'A':  # relaxed, arms by the sides
            el, wr = (sx * 0.25, 0.02, 1.15), (sx * 0.26, -0.03, 0.88)
        elif pose == 'B':  # hands on hips
            el, wr = (sx * 0.36, 0.06, 1.16), (sx * 0.19, -0.04, 1.0)
        else:  # arms folded across the chest
            el, wr = (sx * 0.23, -0.14, 1.14), (-sx * 0.09, -0.19, 1.22)
        _limb(acc, [sh, el], [0.058, 0.05], SHIRT)
        _limb(acc, [el, wr], [0.045, 0.038], SKIN)
    return acc


def spectator_lo():
    """Distant spectator: ~40 triangles of boxes, same colour masks, same height and footprint."""
    acc = MeshAccum()
    parts = [
        ((-0.1, 0.0, 0.47), (0.065, 0.06, 0.46), PANTS), ((0.1, 0.0, 0.47), (0.065, 0.06, 0.46), PANTS),
        ((0.0, 0.0, 0.92), (0.17, 0.11, 0.09), PANTS),
        ((0.0, 0.0, 1.22), (0.19, 0.12, 0.23), SHIRT),
        ((-0.25, 0.0, 1.16), (0.045, 0.045, 0.27), SHIRT), ((0.25, 0.0, 1.16), (0.045, 0.045, 0.27), SHIRT),
        ((0.0, 0.0, 1.6), (0.085, 0.095, 0.11), SKIN),
        ((0.0, 0.01, 1.72), (0.088, 0.098, 0.035), DARK),
    ]
    for c, half, col in parts:
        s = len(acc.verts)
        acc.box(c, half)
        _paint(acc, s, col)
    return acc


def build(scene, asset_collection, simple_material, report):
    mat = simple_material("Spectator", (1.0, 1.0, 1.0), rough=0.85, vcol=True, spec=0.3)
    for pose in ('A', 'B', 'C'):
        name = f"Spectator_{pose}"
        acc = spectator(pose)
        coll = asset_collection(scene, name)
        acc.to_object(name, mat, coll, colors=True, custom_normals=False)
        v = np.array(acc.verts)
        report[name] = dict(tris=acc.tri_count(), lo=v.min(0), hi=v.max(0))
        print(f"[props] {name}: {acc.tri_count()} tris  Z[{v[:, 2].min():.3f},{v[:, 2].max():.3f}]")
    acc = spectator_lo()
    coll = asset_collection(scene, "Spectator_Lo")
    acc.to_object("Spectator_Lo", mat, coll, colors=True, custom_normals=True, smooth=False)
    v = np.array(acc.verts)
    report["Spectator_Lo"] = dict(tris=acc.tri_count(), lo=v.min(0), hi=v.max(0))
    print(f"[props] Spectator_Lo: {acc.tri_count()} tris")
