"""Turn the generated golf-bag scan (Artlist, image-to-3D) into the game's GolfBag prop.

    blender --background --factory-startup --python blender/import_golf_bag.py -- <source.glb>

Writes public/models/golf_bag.glb: an empty "GolfBag" holding the mesh, standing on z=0, 1.12 m
tall, ~8k triangles, 1K textures. Faces on the white body panels get the material "Bag" (the
game tints it with the player's shirt colour); trim, headcovers and irons get "BagTrim".
"""
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "public", "models", "golf_bag.glb")
SRC = sys.argv[sys.argv.index("--") + 1]
HEIGHT = 1.12         # metres, base to headcover tops
TRIS = 8000
COLLAR = 0.74         # fraction of the height where the bag body ends (headcovers/irons above)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
obj = next(o for o in bpy.data.objects if o.type == 'MESH')
for o in bpy.data.objects:
    o.select_set(o == obj)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(bpy.data.objects):
    if o != obj:
        bpy.data.objects.remove(o, do_unlink=True)

# stand it on the ground, centred, at real size
v = np.array([vt.co[:] for vt in obj.data.vertices])
lo, hi = v.min(0), v.max(0)
s = HEIGHT / (hi[2] - lo[2])
for vt in obj.data.vertices:
    x, y, z = vt.co
    vt.co = ((x - (lo[0] + hi[0]) / 2) * s, (y - (lo[1] + hi[1]) / 2) * s, (z - lo[2]) * s)

# fewer triangles
tris0 = sum(len(p.vertices) - 2 for p in obj.data.polygons)
dec = obj.modifiers.new("dec", 'DECIMATE')
dec.ratio = min(1.0, TRIS / tris0)
bpy.ops.object.modifier_apply(modifier=dec.name)
tris1 = sum(len(p.vertices) - 2 for p in obj.data.polygons)

# split the material: white body panels (tinted in game) vs everything else
src_mat = obj.data.materials[0]
nodes = src_mat.node_tree.nodes
bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
base_img = next(l.from_node.image for l in src_mat.node_tree.links if l.to_node == bsdf and l.to_socket.name == 'Base Color')
w, h = base_img.size
px = np.array(base_img.pixels[:], dtype=np.float32).reshape(h, w, 4)
bag = src_mat
bag.name = "Bag"
trim = src_mat.copy()
trim.name = "BagTrim"
obj.data.materials.append(trim)
uv = obj.data.uv_layers.active.data
n_bag = 0
for p in obj.data.polygons:
    u = sum(uv[i].uv[0] for i in p.loop_indices) / p.loop_total
    vv = sum(uv[i].uv[1] for i in p.loop_indices) / p.loop_total
    c = px[min(h - 1, max(0, int(vv * h))), min(w - 1, max(0, int(u * w))), :3]
    luma = float(c @ np.array([0.2126, 0.7152, 0.0722]))
    sat = float(c.max() - c.min())
    white = luma > 0.5 and sat < 0.12 and p.center.z < COLLAR * HEIGHT
    p.material_index = 0 if white else 1
    n_bag += white
# the scan marks patches of the white panels as metal; they're synthetic leather
bag_bsdf = next(n for n in bag.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
for link in list(bag.node_tree.links):
    if link.to_node == bag_bsdf and link.to_socket.name == 'Metallic':
        bag.node_tree.links.remove(link)
bag_bsdf.inputs['Metallic'].default_value = 0.0

# 1K textures, JPEG in the file
for img in bpy.data.images:
    if img.size[0] > 1024:
        img.scale(1024, 1024)

root = bpy.data.objects.new("GolfBag", None)
bpy.context.scene.collection.objects.link(root)
obj.name = "GolfBag_Body"
obj.data.name = "GolfBag_Body"
obj.parent = root
for o in bpy.data.objects:
    o.select_set(True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
    export_image_format='JPEG', export_jpeg_quality=88, export_animations=False, export_skins=False,
    export_morph=False, export_cameras=False, export_lights=False,
)
print(f"[bag] {tris0} -> {tris1} tris, {n_bag}/{len(obj.data.polygons)} faces tinted, "
      f"{os.path.getsize(OUT) / 1024:.0f} KB -> {OUT}")
