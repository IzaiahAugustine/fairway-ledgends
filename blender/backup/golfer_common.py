"""Shared helpers: scene reset, materials, metaball meshing, bmesh utilities."""
import math
import bpy
import bmesh
from mathutils import Vector, Matrix, Quaternion

MB_THRESHOLD = 0.6


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start = 0
    scene.frame_end = 80
    scene.unit_settings.system = 'METRIC'
    return scene


def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def set_active(obj):
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        if o.select_get():
            o.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


# ---------------------------------------------------------------- materials
MATERIAL_COLORS = {
    'Skin': ((0.80, 0.56, 0.42, 1), 0.55),
    'Hair': ((0.12, 0.075, 0.045, 1), 0.6),
    'Shirt': ((0.11, 0.25, 0.55, 1), 0.75),
    'Pants': ((0.78, 0.74, 0.65, 1), 0.8),
    'Belt': ((0.10, 0.07, 0.05, 1), 0.45),
    'Shoes': ((0.95, 0.95, 0.93, 1), 0.35),
    'Sole': ((0.18, 0.18, 0.19, 1), 0.7),
    'Hat': ((0.95, 0.95, 0.95, 1), 0.75),
    'Glove': ((0.97, 0.97, 0.96, 1), 0.6),
    'Eyes': ((0.92, 0.92, 0.90, 1), 0.2),
    'Iris': ((0.18, 0.11, 0.06, 1), 0.2),
    'Buckle': ((0.75, 0.75, 0.72, 1), 0.25),
    'Lens': ((0.03, 0.03, 0.04, 1), 0.08),
    'Frame': ((0.05, 0.05, 0.05, 1), 0.3),
    'ClubHead': ((0.62, 0.63, 0.66, 1), 0.25),
    'ClubFace': ((0.78, 0.79, 0.80, 1), 0.35),
    'Shaft': ((0.70, 0.71, 0.73, 1), 0.2),
    'Grip': ((0.06, 0.06, 0.065, 1), 0.85),
}
METALLIC = {'Buckle': 1.0, 'ClubHead': 0.9, 'ClubFace': 1.0, 'Shaft': 1.0, 'Frame': 0.2}


def make_materials():
    mats = {}
    for name, (col, rough) in MATERIAL_COLORS.items():
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = col
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = METALLIC.get(name, 0.0)
        m.diffuse_color = col
        m.roughness = rough
        m.metallic = METALLIC.get(name, 0.0)
        mats[name] = m
    return mats


def add_material(obj, name):
    mat = bpy.data.materials[name]
    for i, s in enumerate(obj.data.materials):
        if s and s.name == name:
            return i
    obj.data.materials.append(mat)
    return len(obj.data.materials) - 1


# ---------------------------------------------------------------- metaballs
def _k(stiff):
    return math.sqrt(1.0 - (MB_THRESHOLD / stiff) ** (1.0 / 3.0))


class Meta:
    """Collects metaball primitives specified by their *isolated surface*
    radius (not Blender's influence radius)."""

    def __init__(self, name, resolution=0.006):
        self.mb = bpy.data.metaballs.new(name)
        self.mb.resolution = resolution
        self.mb.render_resolution = resolution
        self.mb.threshold = MB_THRESHOLD
        self.mb.update_method = 'UPDATE_ALWAYS'
        self.obj = link(bpy.data.objects.new(name, self.mb))

    def ball(self, co, r, stiff=3.0, neg=False):
        e = self.mb.elements.new(type='BALL')
        e.co = Vector(co)
        e.stiffness = stiff
        e.radius = r / _k(stiff)
        e.use_negative = neg
        return e

    def ellipsoid(self, co, semi, stiff=3.0, xdir=None, ydir=None, neg=False):
        """semi = (a,b,c) surface semi-axes. Optional local axis directions."""
        e = self.mb.elements.new(type='ELLIPSOID')
        e.co = Vector(co)
        e.stiffness = stiff
        R = max(semi)
        e.radius = R / _k(stiff)
        e.size_x = semi[0] / R
        e.size_y = semi[1] / R
        e.size_z = semi[2] / R
        e.use_negative = neg
        if xdir is not None:
            e.rotation = basis_quat(xdir, ydir)
        return e

    def capsule(self, a, b, r, stiff=3.0, neg=False, updir=None):
        a, b = Vector(a), Vector(b)
        e = self.mb.elements.new(type='CAPSULE')
        e.co = (a + b) * 0.5
        e.stiffness = stiff
        e.radius = r / _k(stiff)
        e.size_x = max((b - a).length * 0.5, 1e-4)
        e.rotation = basis_quat(b - a, updir)
        e.use_negative = neg
        return e

    def to_mesh(self, name):
        dg = bpy.context.evaluated_depsgraph_get()
        ev = self.obj.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev)
        me.name = name
        ob = link(bpy.data.objects.new(name, me))
        bpy.data.objects.remove(self.obj)
        bpy.data.metaballs.remove(self.mb)
        return ob


def basis_quat(xdir, ydir=None):
    """Quaternion rotating local X to xdir (and local Y toward ydir)."""
    x = Vector(xdir).normalized()
    if ydir is None:
        ref = Vector((0, 0, 1)) if abs(x.z) < 0.9 else Vector((0, 1, 0))
        y = ref.cross(x).normalized()
    else:
        y = Vector(ydir)
        y = (y - x * y.dot(x)).normalized()
    z = x.cross(y)
    m = Matrix((x, y, z)).transposed()
    return m.to_quaternion()


# ---------------------------------------------------------------- mesh ops
def apply_modifier(obj, mod):
    set_active(obj)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def voxel_remesh(obj, voxel):
    m = obj.modifiers.new('Remesh', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    m.adaptivity = 0.0
    apply_modifier(obj, m)


def quadriflow(obj, faces, symmetry=False, seed=0):
    # QuadriFlow refuses meshes with edges shorter than 0.1 mm (voxel remesh makes a few)
    bm = bm_from(obj)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=2.5e-4)
    bm_to(bm, obj)
    set_active(obj)
    r = bpy.ops.object.quadriflow_remesh(target_faces=faces, use_mesh_symmetry=symmetry,
                                         use_preserve_sharp=False, use_preserve_boundary=False,
                                         smooth_normals=False, seed=seed)
    if 'FINISHED' not in r:
        raise RuntimeError('QuadriFlow failed on %s' % obj.name)
    return r


def smooth_mesh(obj, factor=0.5, iterations=2):
    m = obj.modifiers.new('Smooth', 'SMOOTH')
    m.factor = factor
    m.iterations = iterations
    apply_modifier(obj, m)


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def assign_all(obj, matname):
    idx = add_material(obj, matname)
    for p in obj.data.polygons:
        p.material_index = idx


def bm_from(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    return bm


def bm_to(bm, obj):
    bm.to_mesh(obj.data)
    obj.data.update()
    bm.free()


def new_mesh_obj(name, verts, faces, mat=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = link(bpy.data.objects.new(name, me))
    if mat:
        assign_all(ob, mat)
    return ob


def loft(name, rings, closed_start=False, closed_end=False, mat=None):
    """Build a tube from a list of rings (each a list of Vectors, same count)."""
    n = len(rings[0])
    verts = []
    for r in rings:
        verts.extend(r)
    faces = []
    for i in range(len(rings) - 1):
        for j in range(n):
            a = i * n + j
            b = i * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    if closed_start:
        c = len(verts)
        verts.append(sum(rings[0], Vector()) / n)
        for j in range(n):
            faces.append(((j + 1) % n, j, c))
    if closed_end:
        c = len(verts)
        last = (len(rings) - 1) * n
        verts.append(sum(rings[-1], Vector()) / n)
        for j in range(n):
            faces.append((last + j, last + (j + 1) % n, c))
    ob = new_mesh_obj(name, verts, faces, mat)
    return ob


def recalc_normals(obj):
    bm = bm_from(obj)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm_to(bm, obj)


def join(objs, name):
    objs = [o for o in objs if o is not None]
    set_active(objs[0])
    for o in objs:
        o.select_set(True)
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def verify_bounds(obj):
    vs = [obj.matrix_world @ v.co for v in obj.data.vertices]
    b = {
        'x': (min(v.x for v in vs), max(v.x for v in vs)),
        'y': (min(v.y for v in vs), max(v.y for v in vs)),
        'z': (min(v.z for v in vs), max(v.z for v in vs)),
    }
    print(f"{obj.name}: X[{b['x'][0]:.4f},{b['x'][1]:.4f}] Y[{b['y'][0]:.4f},{b['y'][1]:.4f}]"
          f" Z[{b['z'][0]:.4f},{b['z'][1]:.4f}] tris={tri_count(obj)}")
    return b


def frame_matrix(origin, x, y, z):
    M = Matrix.Identity(4)
    for i in range(3):
        M[i][0], M[i][1], M[i][2], M[i][3] = x[i], y[i], z[i], origin[i]
    return M
