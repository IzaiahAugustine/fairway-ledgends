"""Texture baking framework for the golfer.

Every texture is computed in numpy from per-texel surface samples: the UV layout of a
material is rasterised into position / normal / tangent-frame maps (rest pose, metres),
procedural detail is evaluated on those samples, and the results are written as JPEG/PNG
images that the glTF exporter embeds unchanged.

Normal maps are tangent-space with the frame T = dP/du, B = dP/dv of each triangle (Blender
UV, v up = OpenGL convention). That is the frame three.js builds from screen-space
derivatives when a mesh has no TANGENT attribute, so the GLB is exported without tangents.
"""
import math
import os

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TEX_DIR = os.path.join(HERE, 'golfer_tex')


# ====================================================================== sampling
class Samples:
    """Per-texel surface data of one texture. Arrays are (H, W, ...) with row 0 at v = 0."""

    def __init__(self, W, H):
        self.W, self.H = W, H
        self.mask = np.zeros((H, W), bool)          # covered by a triangle
        self.fill = np.zeros((H, W), bool)          # covered or dilated margin
        self.P = np.zeros((H, W, 3))
        self.N = np.zeros((H, W, 3))
        self.T = np.zeros((H, W, 3))                # dP/du, metres per UV unit
        self.B = np.zeros((H, W, 3))
        self.pid = np.zeros((H, W), np.int32)

    # flat access to the filled texels
    def idx(self):
        return np.nonzero(self.fill)

    def flat(self):
        i = self.idx()
        return Flat(self, i)


class Flat:
    """The filled texels of a Samples object as flat arrays (M, ...)."""

    def __init__(self, S, i):
        self.S, self.i = S, i
        self.P = S.P[i]
        self.N = _unit(S.N[i])
        T, B = S.T[i], S.B[i]
        self.tlen = np.linalg.norm(T, axis=1) / S.W     # metres per texel along u
        self.blen = np.linalg.norm(B, axis=1) / S.H
        self.Tn = _unit(T - self.N * _dot(T, self.N)[:, None])
        self.Bn = _unit(B - self.N * _dot(B, self.N)[:, None])
        self.pid = S.pid[i]
        self.u = (i[1] + 0.5) / S.W
        self.v = (i[0] + 0.5) / S.H
        self.M = len(self.P)

    def scatter(self, vals, default):
        """Put flat values back on the image grid."""
        vals = np.asarray(vals, dtype=np.float64)
        shape = (self.S.H, self.S.W) + vals.shape[1:]
        out = np.empty(shape)
        out[...] = default
        out[self.i] = vals
        return out


def _dot(a, b):
    return np.einsum('ij,ij->i', a, b)


def _unit(a):
    n = np.linalg.norm(a, axis=-1, keepdims=True)
    return a / np.maximum(n, 1e-12)


def part_ids(obj):
    """Integer 'part' face attribute (0 when absent)."""
    me = obj.data
    a = me.attributes.get('part')
    n = len(me.polygons)
    out = np.zeros(n, np.int32)
    if a is not None and a.domain == 'FACE':
        a.data.foreach_get('value', out)
    return out


def set_part(obj, pid, faces=None):
    me = obj.data
    a = me.attributes.get('part') or me.attributes.new('part', 'INT', 'FACE')
    vals = np.zeros(len(me.polygons), np.int32)
    a.data.foreach_get('value', vals)
    if faces is None:
        vals[:] = pid
    else:
        vals[list(faces)] = pid
    a.data.foreach_set('value', vals)


def sample(entries, W, H=None, margin=8, uv_name='UVMap'):
    """entries: list of (object, material_names or None, polygon_filter or None).
    Rasterises those faces' UVs. Positions/normals are object-space x matrix_world."""
    H = H or W
    S = Samples(W, H)
    for obj, mats, pfilter in entries:
        me = obj.data
        me.calc_loop_triangles()
        nlt = len(me.loop_triangles)
        if nlt == 0:
            continue
        lt_loops = np.zeros(nlt * 3, np.int32)
        me.loop_triangles.foreach_get('loops', lt_loops)
        lt_verts = np.zeros(nlt * 3, np.int32)
        me.loop_triangles.foreach_get('vertices', lt_verts)
        lt_poly = np.zeros(nlt, np.int32)
        me.loop_triangles.foreach_get('polygon_index', lt_poly)
        mat_idx = np.zeros(len(me.polygons), np.int32)
        me.polygons.foreach_get('material_index', mat_idx)
        keep = np.ones(nlt, bool)
        if mats is not None:
            ok = [i for i, m in enumerate(me.materials) if m and m.name in mats]
            keep &= np.isin(mat_idx[lt_poly], ok)
        if pfilter is not None:
            keep &= np.isin(lt_poly, np.array(sorted(pfilter), np.int32))
        if not keep.any():
            continue
        co = np.zeros(len(me.vertices) * 3)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        Mw = np.array(obj.matrix_world)
        co = co @ Mw[:3, :3].T + Mw[:3, 3]
        cn = np.zeros(len(me.loops) * 3)
        me.corner_normals.foreach_get('vector', cn)
        cn = cn.reshape(-1, 3) @ np.linalg.inv(Mw[:3, :3])
        uvl = me.uv_layers[uv_name]
        uv = np.zeros(len(me.loops) * 2)
        uvl.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        pids = part_ids(obj)
        L = lt_loops.reshape(-1, 3)[keep]
        Vt = lt_verts.reshape(-1, 3)[keep]
        Pl = lt_poly[keep]
        _raster_tris(S, uv[L], co[Vt], cn[L], pids[Pl])
    S.fill[:] = S.mask
    dilate(S, margin)
    return S


def _raster_tris(S, UV, PO, NO, PID):
    W, H = S.W, S.H
    px = UV * np.array([W, H])                      # pixel space (texel centres at i + 0.5)
    # per-triangle tangent frame (metres per UV unit)
    e1, e2 = PO[:, 1] - PO[:, 0], PO[:, 2] - PO[:, 0]
    d1, d2 = UV[:, 1] - UV[:, 0], UV[:, 2] - UV[:, 0]
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]
    good = np.abs(det) > 1e-14
    r = np.where(good, 1.0 / np.where(good, det, 1.0), 0.0)
    T = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) * r[:, None]
    B = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) * r[:, None]
    x0 = np.floor(px[:, :, 0].min(1) - 0.5).astype(int)
    x1 = np.ceil(px[:, :, 0].max(1) - 0.5).astype(int)
    y0 = np.floor(px[:, :, 1].min(1) - 0.5).astype(int)
    y1 = np.ceil(px[:, :, 1].max(1) - 0.5).astype(int)
    size = np.maximum(x1 - x0, y1 - y0) + 1
    bucket = np.ceil(np.log2(np.maximum(size, 1))).astype(int)
    for bk in np.unique(bucket):
        sel = np.nonzero((bucket == bk) & good)[0]
        if len(sel) == 0:
            continue
        s = 2 ** int(bk)
        for chunk in np.array_split(sel, max(1, len(sel) * s * s // 4_000_000 + 1)):
            if len(chunk) == 0:
                continue
            g = np.arange(s)
            X = x0[chunk][:, None, None] + g[None, None, :]
            Y = y0[chunk][:, None, None] + g[None, :, None]
            X = np.broadcast_to(X, (len(chunk), s, s))
            Y = np.broadcast_to(Y, (len(chunk), s, s))
            cx, cy = X + 0.5, Y + 0.5
            a, b, c = px[chunk, 0], px[chunk, 1], px[chunk, 2]
            den = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
            den = np.where(np.abs(den) < 1e-12, 1e-12, den)[:, None, None]
            wb = ((cx - a[:, 0, None, None]) * (c[:, 1, None, None] - a[:, 1, None, None])
                  - (c[:, 0, None, None] - a[:, 0, None, None]) * (cy - a[:, 1, None, None])) / den
            wc = ((b[:, 0, None, None] - a[:, 0, None, None]) * (cy - a[:, 1, None, None])
                  - (cx - a[:, 0, None, None]) * (b[:, 1, None, None] - a[:, 1, None, None])) / den
            wa = 1.0 - wb - wc
            eps = -1e-4
            inside = (wa >= eps) & (wb >= eps) & (wc >= eps) & (X >= 0) & (X < W) & (Y >= 0) & (Y < H)
            ti, gy, gx = np.nonzero(inside)
            if len(ti) == 0:
                continue
            tri = chunk[ti]
            xx, yy = X[ti, gy, gx], Y[ti, gy, gx]
            A, Bw, Cw = wa[ti, gy, gx], wb[ti, gy, gx], wc[ti, gy, gx]
            P = PO[tri, 0] * A[:, None] + PO[tri, 1] * Bw[:, None] + PO[tri, 2] * Cw[:, None]
            Nn = NO[tri, 0] * A[:, None] + NO[tri, 1] * Bw[:, None] + NO[tri, 2] * Cw[:, None]
            S.P[yy, xx] = P
            S.N[yy, xx] = _unit(Nn)
            S.T[yy, xx] = T[tri]
            S.B[yy, xx] = B[tri]
            S.pid[yy, xx] = PID[tri]
            S.mask[yy, xx] = True


def dilate(S, iters):
    """Grow the filled region by `iters` texels, averaging covered neighbours."""
    H, W = S.H, S.W
    for _ in range(iters):
        filled = S.fill
        acc = {k: np.zeros_like(getattr(S, k)) for k in ('P', 'N', 'T', 'B')}
        cnt = np.zeros((H, W))
        pid = np.zeros((H, W), np.int32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                ys = slice(max(0, dy), H + min(0, dy))
                yd = slice(max(0, -dy), H + min(0, -dy))
                xs = slice(max(0, dx), W + min(0, dx))
                xd = slice(max(0, -dx), W + min(0, -dx))
                m = filled[ys, xs]
                cnt[yd, xd] += m
                for k in acc:
                    acc[k][yd, xd] += getattr(S, k)[ys, xs] * m[..., None]
                pid[yd, xd] = np.where(m, np.maximum(pid[yd, xd], S.pid[ys, xs]), pid[yd, xd])
        new = (~filled) & (cnt > 0)
        if not new.any():
            break
        for k in acc:
            getattr(S, k)[new] = acc[k][new] / cnt[new][:, None]
        S.N[new] = _unit(S.N[new])
        S.pid[new] = pid[new]
        S.fill = filled | new


# ====================================================================== noise
def _hash(*ints, seed=0):
    h = np.uint32((2166136261 + seed * 16777619) % 4294967296)
    out = np.full(np.shape(ints[0]), h, np.uint32)
    for k in ints:
        out ^= np.asarray(k).astype(np.int64).astype(np.uint32)
        out *= np.uint32(16777619)
        out ^= out >> np.uint32(13)
        out *= np.uint32(0x5bd1e995)
        out ^= out >> np.uint32(15)
    return out


def _rand(*ints, seed=0):
    return _hash(*ints, seed=seed).astype(np.float64) / 4294967295.0


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def noise3(P, freq=1.0, seed=0):
    """Smooth value noise in [-1, 1] at points P (M, 3) metres, `freq` cycles per metre."""
    X = np.asarray(P) * freq
    i = np.floor(X).astype(np.int64)
    f = X - i
    u = _fade(f)
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[:, 0] if dx else 1 - u[:, 0]) * (u[:, 1] if dy else 1 - u[:, 1]) * (u[:, 2] if dz else 1 - u[:, 2])
                out = out + w * _rand(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed=seed)
    return out * 2.0 - 1.0


def fbm3(P, freq, octaves=4, seed=0, gain=0.5, lac=2.03):
    out, amp, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        out = out + amp * noise3(P, freq * lac ** o, seed + 17 * o)
        tot += amp
        amp *= gain
    return out / tot


def noise2(x, y, seed=0):
    """Smooth 2D value noise in [-1, 1]; x, y in lattice units."""
    i, j = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = _fade(x - i), _fade(y - j)
    a = _rand(i, j, seed=seed)
    b = _rand(i + 1, j, seed=seed)
    c = _rand(i, j + 1, seed=seed)
    d = _rand(i + 1, j + 1, seed=seed)
    return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * 2 - 1


def cells2(x, y, seed=0, jitter=0.9):
    """2D Worley noise: (F1 distance, cell random) in lattice units."""
    i, j = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    best = np.full(np.shape(x), 9.0)
    rid = np.zeros(np.shape(x))
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            ci, cj = i + di, j + dj
            px = ci + 0.5 + (_rand(ci, cj, seed=seed) - 0.5) * jitter
            py = cj + 0.5 + (_rand(ci, cj, seed=seed + 1) - 0.5) * jitter
            d = np.hypot(x - px, y - py)
            closer = d < best
            best = np.where(closer, d, best)
            rid = np.where(closer, _rand(ci, cj, seed=seed + 2), rid)
    return best, rid


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ====================================================================== normals
def slopes3(F, hfun, eps=0.0003):
    """Surface slopes (dh/dT, dh/dB) of a 3D height function hfun(P, F) (metres)."""
    ht = (hfun(F.P + F.Tn * eps, F) - hfun(F.P - F.Tn * eps, F)) / (2 * eps)
    hb = (hfun(F.P + F.Bn * eps, F) - hfun(F.P - F.Bn * eps, F)) / (2 * eps)
    return ht, hb


def slopes_uv(F, hgrid):
    """Slopes of a texel-grid height map (metres) via central differences."""
    g = hgrid
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = (g[:, 2:] - g[:, :-2]) * 0.5
    gy[1:-1, :] = (g[2:, :] - g[:-2, :]) * 0.5
    return gx[F.i] / np.maximum(F.tlen, 1e-7), gy[F.i] / np.maximum(F.blen, 1e-7)


def encode_normal(F, st, sb, strength=1.0):
    n = np.stack([-st * strength, -sb * strength, np.ones_like(st)], axis=1)
    n = _unit(n)
    return F.scatter(n * 0.5 + 0.5, (0.5, 0.5, 1.0))


# ====================================================================== images
def save(name, arr, fmt='JPEG', quality=90, srgb=True):
    """arr (H, W, 3|4) of encoded values in [0, 1]. Returns the image loaded from disk."""
    os.makedirs(TEX_DIR, exist_ok=True)
    arr = np.clip(np.asarray(arr, dtype=np.float32), 0.0, 1.0)
    H, W, Cn = arr.shape
    rgba = np.ones((H, W, 4), np.float32)
    rgba[..., :Cn] = arr
    ext = '.jpg' if fmt == 'JPEG' else '.png'
    path = os.path.join(TEX_DIR, name + ext)
    old = bpy.data.images.get(name + ext)
    if old:
        bpy.data.images.remove(old)
    img = bpy.data.images.new('tmp_' + name, W, H, alpha=(Cn == 4))
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = fmt
    if fmt == 'PNG':
        img.save()
    else:
        img.save(quality=quality)
    bpy.data.images.remove(img)
    out = bpy.data.images.load(path)
    out.name = name + ext
    out.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    if Cn == 4:
        out.alpha_mode = 'STRAIGHT'
    return out


def lin2srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb2lin(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.04045, x / 12.92, np.power((x + 0.055) / 1.055, 2.4))


# ====================================================================== ambient occlusion
def bake_ao(targets, visible, size_by_mat, samples=48, distance=0.08):
    """Cycles AO of `targets` (objects) with only `visible` objects renderable.
    size_by_mat: {material name: (W, H)}. Returns {material: (H, W) float AO}."""
    sc = bpy.context.scene
    prev_engine = sc.render.engine
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = samples
    sc.cycles.device = 'CPU'
    try:
        sc.world.light_settings.distance = distance
    except Exception:
        pass
    hidden = {}
    for o in sc.objects:
        hidden[o.name] = o.hide_render
        o.hide_render = o not in visible and o not in targets
    imgs, nodes = {}, []
    for name, (W, H) in size_by_mat.items():
        img = bpy.data.images.new('ao_' + name, W, H, float_buffer=True, alpha=False)
        img.colorspace_settings.name = 'Non-Color'
        img.pixels.foreach_set(np.ones(W * H * 4, np.float32))
        imgs[name] = img
        mat = bpy.data.materials[name]
        n = mat.node_tree.nodes.new('ShaderNodeTexImage')
        n.image = img
        mat.node_tree.nodes.active = n
        nodes.append((mat, n))
    for o in sc.objects:
        o.select_set(False)
    for o in targets:
        o.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.bake(type='AO', margin=8, margin_type='EXTEND', use_clear=False)
    out = {}
    for name, img in imgs.items():
        W, H = img.size
        a = np.zeros(W * H * 4, np.float32)
        img.pixels.foreach_get(a)
        out[name] = a.reshape(H, W, 4)[..., 0].astype(np.float64)
        bpy.data.images.remove(img)
    for mat, n in nodes:
        mat.node_tree.nodes.remove(n)
    for o in sc.objects:
        o.hide_render = hidden.get(o.name, False)
    sc.render.engine = prev_engine
    return out


# ====================================================================== materials
def _settings_group():
    try:
        from io_scene_gltf2.blender.com.material_helpers import get_gltf_node_name, create_settings_group
        name = get_gltf_node_name()
        return bpy.data.node_groups.get(name) or create_settings_group(name)
    except Exception:
        g = bpy.data.node_groups.get('glTF Material Output')
        if g is None:
            g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
            g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        return g


def setup_material(name, albedo=None, normal=None, orm=None, base=None, rough=None, metal=0.0,
                   alpha_clip=False, normal_strength=1.0):
    """Principled material wired the way the glTF exporter maps it:
    baseColor = base factor x albedo, normalTexture, metallicRoughness from ORM (G, B),
    occlusion from ORM (R) through the glTF Material Output group."""
    mat = bpy.data.materials[name]
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (600, 0)
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (250, 0)
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    col = tuple(base) if base is not None else tuple(mat.diffuse_color)
    bsdf.inputs['Base Color'].default_value = col
    bsdf.inputs['Metallic'].default_value = metal
    if rough is not None:
        bsdf.inputs['Roughness'].default_value = rough
    if albedo is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = albedo
        t.location = (-500, 250)
        if base is not None and tuple(base[:3]) != (1.0, 1.0, 1.0):
            mix = nt.nodes.new('ShaderNodeMix')
            mix.data_type = 'RGBA'
            mix.blend_type = 'MULTIPLY'
            mix.location = (-150, 250)
            mix.inputs['Factor'].default_value = 1.0
            nt.links.new(t.outputs['Color'], mix.inputs[6])
            mix.inputs[7].default_value = col
            nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
        else:
            nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha_clip:
            rnd = nt.nodes.new('ShaderNodeMath')
            rnd.operation = 'ROUND'
            rnd.location = (-150, 50)
            nt.links.new(t.outputs['Alpha'], rnd.inputs[0])
            nt.links.new(rnd.outputs[0], bsdf.inputs['Alpha'])
            try:
                mat.surface_render_method = 'DITHERED'
            except Exception:
                pass
    if normal is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal
        t.location = (-500, -250)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.location = (-150, -250)
        nm.uv_map = 'UVMap'
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if orm is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = orm
        t.location = (-800, -50)
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        sep.location = (-500, -50)
        nt.links.new(t.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
        g = nt.nodes.new('ShaderNodeGroup')
        g.node_tree = _settings_group()
        g.location = (250, -350)
        nt.links.new(sep.outputs['Red'], g.inputs['Occlusion'])
    mat.diffuse_color = col
    return mat


# ====================================================================== UV layout
def _select_faces(obj, faces):
    import bmesh
    bm = bmesh.from_edit_mesh(obj.data)
    fs = set(faces)
    for f in bm.faces:
        f.select_set(f.index in fs)
    bmesh.update_edit_mesh(obj.data)


def ensure_uv(obj, name='UVMap'):
    me = obj.data
    if name not in me.uv_layers:
        me.uv_layers.new(name=name)
    me.uv_layers.active = me.uv_layers[name]
    return me.uv_layers[name]


def unwrap(obj, faces, rect, angle=60.0, margin=0.004, method='SMART', rotate=True):
    """UV-unwrap `faces` of obj (Smart UV Project) and shelf-pack the islands into rect."""
    import golfer_common as C
    if not faces:
        return
    ensure_uv(obj)
    C.set_active(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    _select_faces(obj, faces)
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.002, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    pack_rect(obj, faces, rect, margin, rotate)


def fit_rect(obj, faces, rect, keep_aspect=False):
    """Affinely map the UV bounding box of `faces` onto rect."""
    me = obj.data
    uv = me.uv_layers['UVMap'].data
    loops = [li for f in faces for li in me.polygons[f].loop_indices]
    us = np.array([uv[li].uv[0] for li in loops])
    vs = np.array([uv[li].uv[1] for li in loops])
    u0, v0, u1, v1 = us.min(), vs.min(), us.max(), vs.max()
    x0, y0, x1, y1 = rect
    sx = (x1 - x0) / max(u1 - u0, 1e-9)
    sy = (y1 - y0) / max(v1 - v0, 1e-9)
    if keep_aspect:
        sx = sy = min(sx, sy)
    for li, u, v in zip(loops, us, vs):
        uv[li].uv = (x0 + (u - u0) * sx, y0 + (v - v0) * sy)


def _islands(me, faces, uvarr):
    """Group faces into UV islands (faces sharing a vertex with the same UV)."""
    parent = {f: f for f in faces}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    key_face = {}
    for f in faces:
        p = me.polygons[f]
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            k = (vi, round(uvarr[li, 0], 5), round(uvarr[li, 1], 5))
            g = key_face.get(k)
            if g is None:
                key_face[k] = f
            else:
                ra, rb = find(f), find(g)
                if ra != rb:
                    parent[ra] = rb
    groups = {}
    for f in faces:
        groups.setdefault(find(f), []).append(f)
    return list(groups.values())


def pack_rect(obj, faces, rect, margin=0.004, rotate=True):
    """Shelf-pack the UV islands of `faces` (keeping their relative scale) into rect."""
    me = obj.data
    layer = me.uv_layers['UVMap']
    uvarr = np.zeros(len(me.loops) * 2)
    layer.data.foreach_get('uv', uvarr)
    uvarr = uvarr.reshape(-1, 2)
    isl = _islands(me, faces, uvarr)
    items = []
    for fs in isl:
        L = np.array([li for f in fs for li in me.polygons[f].loop_indices])
        c = uvarr[L]
        lo, hi = c.min(0), c.max(0)
        w, h = hi - lo
        rot = rotate and h > w * 1.15
        items.append((L, lo, (h, w) if rot else (w, h), rot))
    x0, y0, x1, y1 = rect
    RW, RH = x1 - x0, y1 - y0

    def place(scale):
        order = sorted(range(len(items)), key=lambda i: -items[i][2][1])
        pos = {}
        x = y = 0.0
        shelf = 0.0
        for i in order:
            w, h = items[i][2][0] * scale, items[i][2][1] * scale
            if x + w > RW + 1e-9:
                x = 0.0
                y += shelf + margin
                shelf = 0.0
            if w > RW + 1e-9 or y + h > RH + 1e-9:
                return None
            pos[i] = (x, y)
            x += w + margin
            shelf = max(shelf, h)
        return pos
    lo_s, hi_s = 1e-4, 100.0
    best = None
    for _ in range(40):
        mid = (lo_s * hi_s) ** 0.5
        pos = place(mid)
        if pos is None:
            hi_s = mid
        else:
            lo_s, best = mid, (mid, pos)
    scale, pos = best
    for i, (L, lo, (w, h), rot) in enumerate(items):
        px, py = pos[i]
        c = (uvarr[L] - lo) * scale
        if rot:      # swap axes (a mirror; normal maps are derived from the final UVs, so this is safe)
            c = c[:, ::-1]
        uvarr[L] = c + np.array([x0 + px, y0 + py])
    layer.data.foreach_set('uv', uvarr.ravel())


def pack(obj, faces, rect, margin=0.004, rotate=True):
    pack_rect(obj, faces, rect, margin, rotate)


def transform_uv(obj, faces, fn):
    me = obj.data
    uv = me.uv_layers['UVMap'].data
    for f in faces:
        for li in me.polygons[f].loop_indices:
            uv[li].uv = fn(uv[li].uv[0], uv[li].uv[1])
