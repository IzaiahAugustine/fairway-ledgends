"""Compare the game contract of two golfer GLBs (no Blender needed):
bone hierarchy and rest transforms, skin joints + inverse bind matrices, animation
channels (keyframe times and values), ball markers, toggled object names and
recolourable materials.

  python compare_glb.py backup/golfer_v1.glb ../public/models/golfer.glb
"""
import sys

import validate_glb as V

BONES = V.BONES


def node_index(js):
    return {n.get('name', ''): i for i, n in enumerate(js['nodes'])}


def parents(js):
    p = {}
    for i, n in enumerate(js['nodes']):
        for c in n.get('children', []):
            p[c] = i
    return p


def maxdiff(a, b):
    if len(a) != len(b):
        return float('inf')
    m = 0.0
    for x, y in zip(a, b):
        for u, v in zip(x, y):
            m = max(m, abs(u - v))
    return m


def main(pa, pb):
    ja, ba = V.load(pa)
    jb, bb = V.load(pb)
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(('  OK   ' if cond else '  FAIL ') + msg)
        ok = ok and cond

    ia, ib = node_index(ja), node_index(jb)
    pa_, pb_ = parents(ja), parents(jb)
    names_a = [n.get('name', '') for n in ja['nodes']]
    names_b = [n.get('name', '') for n in jb['nodes']]
    print('Bones / hierarchy / rest transforms:')
    worst = 0.0
    for b in BONES:
        if b not in ia or b not in ib:
            check(False, 'bone %s present in both' % b)
            continue
        na, nb = ja['nodes'][ia[b]], jb['nodes'][ib[b]]
        par_a = names_a[pa_[ia[b]]] if ia[b] in pa_ else None
        par_b = names_b[pb_[ib[b]]] if ib[b] in pb_ else None
        if par_a != par_b:
            check(False, '%s parent %s vs %s' % (b, par_a, par_b))
        for k, d in (('translation', [0, 0, 0]), ('rotation', [0, 0, 0, 1]), ('scale', [1, 1, 1])):
            worst = max(worst, maxdiff([na.get(k, d)], [nb.get(k, d)]))
    check(worst < 1e-5, 'bone parents identical, rest TRS max diff %.2e' % worst)

    sa, sb = ja['skins'][0], jb['skins'][0]
    ja_names = [names_a[j] for j in sa['joints']]
    jb_names = [names_b[j] for j in sb['joints']]
    check(ja_names == jb_names, 'skin joint order identical (%d joints)' % len(ja_names))
    ibm_a = V.accessor(ja, ba, sa['inverseBindMatrices'])
    ibm_b = V.accessor(jb, bb, sb['inverseBindMatrices'])
    check(maxdiff(ibm_a, ibm_b) < 1e-5, 'inverse bind matrices max diff %.2e' % maxdiff(ibm_a, ibm_b))

    print('Animations:')
    anims_a = {a['name']: a for a in ja.get('animations', [])}
    anims_b = {a['name']: a for a in jb.get('animations', [])}
    check(sorted(anims_a) == sorted(anims_b), 'same animation names %s' % sorted(anims_b))
    for name in sorted(set(anims_a) & set(anims_b)):
        A, B = anims_a[name], anims_b[name]

        def chans(js, anim, names):
            out = {}
            for c in anim['channels']:
                t = c['target']
                if 'node' not in t:
                    continue
                s = anim['samplers'][c['sampler']]
                out[(names[t['node']], t['path'])] = (s['input'], s['output'], s.get('interpolation', 'LINEAR'))
            return out
        ca, cb = chans(ja, A, names_a), chans(jb, B, names_b)
        same_keys = sorted(ca) == sorted(cb)
        worst_t = worst_v = 0.0
        for k in set(ca) & set(cb):
            worst_t = max(worst_t, maxdiff(V.accessor(ja, ba, ca[k][0]), V.accessor(jb, bb, cb[k][0])))
            worst_v = max(worst_v, maxdiff(V.accessor(ja, ba, ca[k][1]), V.accessor(jb, bb, cb[k][1])))
        check(same_keys and worst_t < 1e-6 and worst_v < 1e-5,
              '%-13s channels %d/%d  max dt %.1e  max dvalue %.1e' % (name, len(ca), len(cb), worst_t, worst_v))

    print('Markers / toggled objects / materials:')
    for m in V.MARKERS:
        ta = ja['nodes'][ia[m]].get('translation') if m in ia else None
        tb = jb['nodes'][ib[m]].get('translation') if m in ib else None
        check(ta is not None and tb is not None and maxdiff([ta], [tb]) < 1e-6, '%s %s -> %s' % (m, ta, tb))
    for n in V.CLUBS + V.VARIANTS:
        pa_n = names_b[pb_[ib[n]]] if n in ib and ib[n] in pb_ else None
        check(n in ib and pa_n == ('Club' if n.startswith('Club_') else 'Head'), '%s present, parent %s' % (n, pa_n))
    mats_b = [m['name'] for m in jb.get('materials', [])]
    for m in ('Skin', 'Hair', 'Shirt', 'Pants', 'Shoes', 'Belt', 'Hat', 'ClubHead'):
        check(m in mats_b, 'material %s' % m)
    return ok


if __name__ == '__main__':
    r = main(sys.argv[1], sys.argv[2])
    print('\nCONTRACT:', 'IDENTICAL' if r else 'DIFFERS')
    sys.exit(0 if r else 1)
