"""Inspect environment.glb: parse the JSON/BIN chunks and list top-level nodes,
child meshes, materials (alpha mode, double sided), embedded images (PNG size),
triangles and bounds per asset (glTF space, Y up), and check contract names.
Also checks that foliage custom normals survived export (they should point away
from the crown centre). Usable inside Blender or with any Python + numpy:
    python env_inspect_glb.py D:\\golfgame\\public\\models\\environment.glb
"""
import json
import os
import struct
import sys

import numpy as np

CONTRACT = ["Tree_Oak", "Tree_Pine", "Tree_Cypress", "Tree_Birch", "Bush_Gorse", "Bush_Green",
            "Flagstick", "Flag", "Cup", "TeeMarker", "Tee", "GolfBag", "Rock_A", "Rock_B", "Bench"]

CTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load(path):
    data = open(path, "rb").read()
    magic, ver, length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF", "not a GLB"
    off, js, bn = 12, None, None
    while off < len(data):
        clen, ctype = struct.unpack_from("<I4s", data, off)
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == b"JSON":
            js = json.loads(chunk)
        elif ctype == b"BIN\x00":
            bn = chunk
    return js, bn


def accessor(g, bn, i):
    a = g["accessors"][i]
    bv = g["bufferViews"][a["bufferView"]]
    dt = np.dtype(CTYPES[a["componentType"]])
    n = NCOMP[a["type"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", 0)
    if stride and stride != dt.itemsize * n:
        raw = np.frombuffer(bn, np.uint8, count=stride * a["count"], offset=start).reshape(a["count"], stride)
        arr = raw[:, :dt.itemsize * n].copy().view(dt).reshape(a["count"], n)
    else:
        arr = np.frombuffer(bn, dt, count=a["count"] * n, offset=start).reshape(a["count"], n)
    return arr


def png_size(g, bn, img):
    bv = g["bufferViews"][img["bufferView"]]
    b = bn[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", b[16:24])
        return w, h, bv["byteLength"]
    return None, None, bv["byteLength"]


def report(path, verbose=True):
    g, bn = load(path)
    out = {"file_kb": os.path.getsize(path) / 1024.0, "assets": {}, "materials": {}, "images": []}
    nodes = g["nodes"]
    scene = g["scenes"][g.get("scene", 0)]
    top = scene["nodes"]

    def walk(i, acc):
        nd = nodes[i]
        for k in ("translation", "rotation", "scale", "matrix"):
            if k in nd:
                acc["transforms"].append((nd.get("name"), k, nd[k]))
        if "mesh" in nd:
            m = g["meshes"][nd["mesh"]]
            tris = 0
            mats = []
            attrs = set()
            for pr in m["primitives"]:
                cnt = g["accessors"][pr["indices"]]["count"] if "indices" in pr else \
                    g["accessors"][pr["attributes"]["POSITION"]]["count"]
                tris += cnt // 3
                if "material" in pr:
                    mats.append(g["materials"][pr["material"]].get("name"))
                attrs |= set(pr["attributes"].keys())
                pa = g["accessors"][pr["attributes"]["POSITION"]]
                acc["min"] = np.minimum(acc["min"], pa["min"])
                acc["max"] = np.maximum(acc["max"], pa["max"])
            acc["meshes"].append(dict(node=nd.get("name"), tris=tris, materials=mats, attrs=sorted(attrs)))
            acc["tris"] += tris
        for c in nd.get("children", []):
            walk(c, acc)

    for i in top:
        acc = dict(meshes=[], tris=0, min=np.full(3, 1e9), max=np.full(3, -1e9), transforms=[])
        walk(i, acc)
        out["assets"][nodes[i].get("name")] = acc

    for m in g.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        tex = pbr.get("baseColorTexture")
        img = None
        if tex is not None:
            img = g["images"][g["textures"][tex["index"]]["source"]].get("name")
        out["materials"][m.get("name")] = dict(
            alphaMode=m.get("alphaMode", "OPAQUE"), alphaCutoff=m.get("alphaCutoff"),
            doubleSided=m.get("doubleSided", False), baseColorFactor=pbr.get("baseColorFactor"),
            metallic=pbr.get("metallicFactor"), roughness=pbr.get("roughnessFactor"), texture=img)
    for im in g.get("images", []):
        w, h, nbytes = png_size(g, bn, im)
        out["images"].append(dict(name=im.get("name"), mime=im.get("mimeType"), w=w, h=h, kb=nbytes / 1024.0))

    # custom normal survival: foliage normals vs direction from crown centre
    normal_check = {}
    for mi, m in enumerate(g["meshes"]):
        if not m.get("name", "").endswith("_Leaves"):
            continue
        pr = m["primitives"][0]
        P = accessor(g, bn, pr["attributes"]["POSITION"]).astype(float)
        N = accessor(g, bn, pr["attributes"]["NORMAL"]).astype(float)
        c = P.mean(0)
        d = P - c
        d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
        dots = (d * N).sum(1)
        # flat card normals would be identical for the 4 verts of a card
        idx = accessor(g, bn, pr["indices"]).ravel()
        tri = idx[:3 * (len(idx) // 3)].reshape(-1, 3)
        var = np.linalg.norm(N[tri[:, 0]] - N[tri[:, 1]], axis=1).mean()
        # winding vs custom normal: three.js DoubleSide flips normals on back faces, so the
        # geometric front (CCW) should agree with the outward custom normal
        e1 = P[tri[:, 1]] - P[tri[:, 0]]
        e2 = P[tri[:, 2]] - P[tri[:, 0]]
        gn = np.cross(e1, e2)
        vn = N[tri[:, 0]] + N[tri[:, 1]] + N[tri[:, 2]]
        agree = float(((gn * vn).sum(1) > 0).mean())
        normal_check[m["name"]] = dict(mean_dot_outward=float(dots.mean()), frac_outward=float((dots > 0).mean()),
                                       per_card_normal_spread=float(var), winding_agrees=agree)
        col = pr["attributes"].get("COLOR_0")
        if col is not None:
            ca = g["accessors"][col]
            normal_check[m["name"]]["color0"] = f'{ca["type"]}/{ca["componentType"]}'

    out["normals"] = normal_check

    names = set(out["assets"].keys())
    out["missing"] = [n for n in CONTRACT if n not in names]
    out["extra"] = sorted(names - set(CONTRACT))

    if verbose:
        print(f"\n=== GLB {path}  {out['file_kb']:.0f} KB ===")
        print(f"{'asset':14s} {'tris':>6s} {'height(y)':>9s}  {'x-range':>15s} {'z-range':>15s}  children / materials")
        for name, a in out["assets"].items():
            mn, mx = a["min"], a["max"]
            kids = "; ".join(f"{m['node']}[{m['tris']}] {','.join(m['materials'])} {{{','.join(x for x in m['attrs'] if x not in ('POSITION', 'NORMAL'))}}}" for m in a["meshes"])
            print(f"{name:14s} {a['tris']:6d} {mx[1]:9.3f}  [{mn[0]:6.2f},{mx[0]:6.2f}] [{mn[2]:6.2f},{mx[2]:6.2f}]  {kids}"
                  f"  ymin={mn[1]:.3f}")
            if a["transforms"]:
                print("     !! non-identity transforms:", a["transforms"])
        print("\nmaterials:")
        for n, m in out["materials"].items():
            print(f"  {n:14s} alpha={m['alphaMode']}{'' if m['alphaCutoff'] is None else '@' + str(m['alphaCutoff'])}"
                  f" doubleSided={m['doubleSided']} baseColor={m['baseColorFactor']} tex={m['texture']}"
                  f" rough={m['roughness']} metal={m['metallic']}")
        print("\nimages:")
        for im in out["images"]:
            print(f"  {im['name']} {im['mime']} {im['w']}x{im['h']} {im['kb']:.0f} KB")
        print("\nfoliage normals (custom spherical normals survive if mean_dot_outward >> 0 and spread > 0):")
        for n, v in normal_check.items():
            print(f"  {n:22s} " + " ".join(f"{k}={val:.3f}" if isinstance(val, float) else f"{k}={val}"
                                            for k, val in v.items()))
        # flag UV orientation (contract: u runs 0 at the pole -> 1 at the free end, along +X)
        for m in g["meshes"]:
            if m.get("name") == "Flag":
                pr = m["primitives"][0]
                P = accessor(g, bn, pr["attributes"]["POSITION"])
                UV = accessor(g, bn, pr["attributes"]["TEXCOORD_0"])
                i0, i1 = P[:, 0].argmin(), P[:, 0].argmax()
                j0, j1 = P[:, 1].argmin(), P[:, 1].argmax()
                print(f"\nFlag UV: x={P[i0,0]:.3f} -> u={UV[i0,0]:.2f}; x={P[i1,0]:.3f} -> u={UV[i1,0]:.2f}; "
                      f"y={P[j0,1]:.3f} -> v={UV[j0,1]:.2f}; y={P[j1,1]:.3f} -> v={UV[j1,1]:.2f}")
        print(f"\nmissing contract names: {out['missing']}   extra top-level: {out['extra']}")
    return out


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a.endswith(".glb")]
    report(args[0] if args else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                              "public", "models", "environment.glb"))
