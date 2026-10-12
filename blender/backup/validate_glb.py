"""Parse golfer.glb (JSON chunk + accessors) and check it against the contract.

Usable with any Python 3 (no Blender needed):
  python validate_glb.py [path/to/golfer.glb]
"""
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(os.path.dirname(HERE), 'public', 'models', 'golfer.glb')

BONES = ['Root', 'Hips', 'Spine', 'Chest', 'Neck', 'Head', 'Shoulder_L', 'UpperArm_L', 'Forearm_L', 'Hand_L',
         'Shoulder_R', 'UpperArm_R', 'Forearm_R', 'Hand_R', 'Thigh_L', 'Shin_L', 'Foot_L', 'Thigh_R', 'Shin_R',
         'Foot_R', 'Club']
CLUBS = ['Club_Driver', 'Club_Wood', 'Club_Hybrid', 'Club_Iron', 'Club_Wedge', 'Club_Putter']
VARIANTS = ['Hat_Cap', 'Hat_Visor', 'Hat_Bucket', 'Hair_Short', 'Hair_Long', 'Sunglasses']
MARKERS = ['Ball_Driver', 'Ball_Wood', 'Ball_Iron', 'Ball_Wedge', 'Ball_Chip', 'Ball_Putt']
MATERIALS = ['Skin', 'Hair', 'Shirt', 'Pants', 'Belt', 'Shoes', 'Hat', 'Glove', 'Eyes', 'ClubHead', 'ClubFace',
             'Shaft', 'Grip']
ANIMS = {'Swing_Driver': 80, 'Swing_Wood': 80, 'Swing_Iron': 80, 'Swing_Wedge': 72, 'Swing_Chip': 50,
         'Swing_Putt': 55, 'Idle': 60, 'Celebrate': 45, 'Dejected': 45}

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546C67, 'not a GLB'
    off = 12
    js, binc = None, None
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode('utf-8'))
        elif ctype == 0x004E4942:
            binc = chunk
        off += 8 + clen
    return js, binc


def accessor(js, binc, i):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    fmt, size = COMP[a['componentType']]
    n = NCOMP[a['type']]
    stride = bv.get('byteStride', size * n)
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    out = []
    for k in range(a['count']):
        out.append(struct.unpack_from('<' + fmt * n, binc, base + k * stride))
    return out


def main(path):
    js, binc = load(path)
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(('  OK   ' if cond else '  FAIL ') + msg)
        ok = ok and cond

    nodes = js['nodes']
    names = [n.get('name', '') for n in nodes]
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    print('GLB:', path, '%.2f MB' % (os.path.getsize(path) / 1e6))
    print('\nNodes (%d):' % len(nodes))
    for i, n in enumerate(nodes):
        extra = []
        if 'mesh' in n:
            extra.append('mesh=%s' % js['meshes'][n['mesh']]['name'])
        if 'skin' in n:
            extra.append('skin=%d' % n['skin'])
        p = parent.get(i)
        print('  [%2d] %-14s parent=%-12s %s' % (i, n.get('name'), names[p] if p is not None else '-', ' '.join(extra)))

    print('\nContract checks:')
    for b in BONES:
        check(b in names, 'bone node %s' % b)
    skins = js.get('skins', [])
    check(len(skins) == 1, 'one skin (%d)' % len(skins))
    if skins:
        joints = [names[j] for j in skins[0]['joints']]
        print('  skin joints:', ', '.join(joints))
        for b in BONES:
            if b not in ('Root', 'Club'):
                check(b in joints, 'joint %s in skin' % b)
    for c in CLUBS:
        check(c in names and names[parent.get(names.index(c), -1)] == 'Club' if c in names else False,
              '%s is a child of bone Club' % c)
    for v in VARIANTS:
        check(v in names and names[parent.get(names.index(v), -1)] == 'Head' if v in names else False,
              '%s is a child of bone Head' % v)
    marker_pos = {}
    for m in MARKERS:
        if m in names:
            n = nodes[names.index(m)]
            t = n.get('translation', [0, 0, 0])
            marker_pos[m] = t
            p = parent.get(names.index(m))
            check(True, '%s at (%.4f, %.4f, %.4f) parent=%s' % (m, t[0], t[1], t[2], names[p] if p is not None else 'scene'))
        else:
            check(False, 'marker %s' % m)
    mats = [m['name'] for m in js.get('materials', [])]
    for m in MATERIALS:
        check(m in mats, 'material %s' % m)
    print('  all materials:', ', '.join(mats))

    print('\nMeshes:')
    total_tris = 0
    for mi, m in enumerate(js['meshes']):
        tris = 0
        targets = None
        for p in m['primitives']:
            if 'indices' in p:
                tris += js['accessors'][p['indices']]['count'] // 3
            if 'targets' in p:
                targets = len(p['targets'])
        tn = m.get('extras', {}).get('targetNames')
        total_tris += tris
        print('  %-14s prims=%d tris=%d morphs=%s %s' % (m['name'], len(m['primitives']), tris, targets, tn or ''))
    print('  TOTAL triangles: %d' % total_tris)
    check(total_tris < 40000, 'triangle budget < 40k (%d)' % total_tris)
    body = [m for m in js['meshes'] if m.get('extras', {}).get('targetNames')]
    check(any('Heavy' in m['extras']['targetNames'] for m in body), 'morph target "Heavy" present')

    print('\nAnimations:')
    anim_names = []
    for a in js.get('animations', []):
        tmax = 0.0
        for s in a['samplers']:
            acc = js['accessors'][s['input']]
            tmax = max(tmax, acc['max'][0])
        targets = {names[c['target']['node']] for c in a['channels'] if 'node' in c['target']}
        anim_names.append(a['name'])
        exp = ANIMS.get(a['name'])
        dur_ok = exp is not None and abs(tmax - exp / 30.0) < 1e-3
        check(dur_ok, '%-13s duration %.4f s (%d frames @30)  channels=%d  nodes=%d' % (
            a['name'], tmax, round(tmax * 30), len(a['channels']), len(targets)))
    for n in ANIMS:
        check(n in anim_names, 'animation %s exported' % n)
    return ok, js, binc


if __name__ == '__main__':
    p = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    ok, _, _ = main(p)
    print('\nRESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
