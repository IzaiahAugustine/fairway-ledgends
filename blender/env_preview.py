"""Preview scene ("Preview") with collection-instance copies of every asset laid out
in a lineup, sky + sun, grass ground; Eevee renders to blender/renders/env_*.png.
Only the main scene is exported, so the assets themselves stay at the origin."""
import math
import os

import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF_TEX = os.path.join(ROOT, "public", "assets", "textures")

TREE_LINEUP = [("Tree_Oak", 0.0), ("Tree_Pine", 17.0), ("Tree_Cypress", 28.0),
               ("Tree_Birch", 46.0), ("Bush_Gorse", 54.0), ("Bush_Green", 58.5)]
PROP_ROW_Y = -60.0
# (x, y, z) offsets in the props row; the cup is lifted so its liner is visible above the ground
PROP_LAYOUT = [("Flagstick", (0.0, 0.0, 0.0)), ("Flag", (0.0, 0.0, 0.0)), ("Cup", (0.55, -0.55, 0.1025)),
               ("Tee", (0.85, -0.65, 0.0)), ("TeeMarker", (1.1, -0.45, 0.0)), ("GolfBag", (1.9, 0.1, 0.0)),
               ("Bench", (3.6, 0.6, 0.0)), ("Rock_A", (-2.3, 0.8, 0.0)), ("Rock_B", (-1.1, -0.2, 0.0))]


def look_at(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def _grass_material():
    m = bpy.data.materials.new("PreviewGrass")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.35, 0.35, 0.35)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    td = nt.nodes.new("ShaderNodeTexImage")
    p = os.path.join(REF_TEX, "grass004_diff_1k.jpg")
    if os.path.exists(p):
        td.image = bpy.data.images.load(p, check_existing=True)
        nt.links.new(mp.outputs["Vector"], td.inputs["Vector"])
        hsv = nt.nodes.new("ShaderNodeHueSaturation")
        hsv.inputs["Value"].default_value = 0.85
        nt.links.new(td.outputs["Color"], hsv.inputs["Color"])
        nt.links.new(hsv.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = (0.12, 0.25, 0.06, 1)
    bsdf.inputs["Roughness"].default_value = 0.95
    return m


def build_preview_scene(main):
    prev = bpy.data.scenes.new("Preview")
    prev.render.engine = 'BLENDER_EEVEE'
    prev.render.resolution_x = 1600
    prev.render.resolution_y = 900
    prev.eevee.taa_render_samples = 48
    prev.eevee.use_shadows = True
    prev.eevee.shadow_ray_count = 2
    prev.eevee.shadow_step_count = 8
    prev.eevee.use_fast_gi = True
    try:
        prev.view_settings.view_transform = 'AgX'
        prev.view_settings.look = 'AgX - Medium High Contrast'
        prev.view_settings.exposure = -0.4
    except TypeError:
        pass

    world = bpy.data.worlds.new("PreviewSky")
    prev.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky")
    for t in ('MULTIPLE_SCATTERING', 'SINGLE_SCATTERING', 'HOSEK_WILKIE'):
        try:
            sky.sky_type = t
            break
        except TypeError:
            continue
    try:
        sky.sun_disc = False
        sky.sun_elevation = math.radians(40)
    except AttributeError:
        pass
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.22

    sun_data = bpy.data.lights.new("PreviewSun", 'SUN')
    sun_data.energy = 7.0
    sun_data.angle = math.radians(1.5)
    sun_data.color = (1.0, 0.96, 0.9)
    sun = bpy.data.objects.new("PreviewSun", sun_data)
    sun.rotation_euler = Vector((-0.55, -0.75, 0.75)).to_track_quat('Z', 'Y').to_euler()
    prev.collection.objects.link(sun)

    me = bpy.data.meshes.new("PreviewGround")
    S = 400.0
    me.from_pydata([(-S, -S, 0), (S, -S, 0), (S, S, 0), (-S, S, 0)], [], [(0, 1, 2, 3)])
    me.materials.append(_grass_material())
    ground = bpy.data.objects.new("PreviewGround", me)
    prev.collection.objects.link(ground)

    def inst(name, loc):
        coll = bpy.data.collections.get(name)
        if coll is None:
            return None
        e = bpy.data.objects.new(f"PV_{name}_{len(prev.objects)}", None)
        e.instance_type = 'COLLECTION'
        e.instance_collection = coll
        e.location = loc
        prev.collection.objects.link(e)
        return e

    for name, x in TREE_LINEUP:
        inst(name, (x, 0.0, 0.0))
    for name, (x, y, z) in PROP_LAYOUT:
        inst(name, (x, PROP_ROW_Y + y, z))
    # a small clump on the second row to judge repetition/instancing
    for i, (name, x, y, rz) in enumerate([("Tree_Oak", -25, 40, 1.3), ("Tree_Pine", -8, 46, 2.2),
                                          ("Tree_Oak", 10, 55, 4.0), ("Tree_Pine", 22, 42, 0.7),
                                          ("Tree_Birch", 36, 38, 3.1), ("Tree_Cypress", 60, 36, 0.4),
                                          ("Bush_Gorse", 50, 20, 2.0), ("Bush_Gorse", 52.5, 21.5, 0.3),
                                          ("Bush_Green", 30, 22, 1.0), ("Tree_Pine", 75, 50, 5.0)]):
        e = inst(name, (x, y, 0.0))
        if e:
            e.rotation_euler = (0, 0, rz)

    cams = {
        "eye": ((28.0, -44.0, 1.7), (28.0, 0.0, 7.0), 24),
        "golf": ((28.0, -64.0, 9.0), (28.0, 0.0, 5.0), 30),
        "aerial": ((28.0, -40.0, 34.0), (28.0, 4.0, 3.0), 30),
        "props": ((0.7, PROP_ROW_Y - 7.0, 2.0), (0.7, PROP_ROW_Y + 0.2, 0.6), 30),
        "props_small": ((0.80, PROP_ROW_Y - 1.25, 0.78), (0.82, PROP_ROW_Y - 0.55, 0.06), 45),
        "bag": ((2.6, PROP_ROW_Y - 1.6, 1.15), (1.9, PROP_ROW_Y + 0.15, 0.6), 50),
        "cup_top": ((0.55, PROP_ROW_Y - 0.62, 0.62), (0.55, PROP_ROW_Y - 0.55, 0.0), 50),
        "oak": ((-2.0, -24.0, 2.5), (0.0, 0.0, 7.0), 32),
        "trunk": ((-1.2, -4.2, 1.5), (0.0, 0.0, 2.2), 35),
        "pine": ((17.0, -24.0, 2.0), (17.0, 0.0, 9.0), 32),
    }
    for name, x in TREE_LINEUP:
        h = {"Tree_Oak": 14, "Tree_Pine": 18, "Tree_Cypress": 9, "Tree_Birch": 11}.get(name, 1.8)
        xc = x + (3.0 if name == "Tree_Cypress" else 0.0)
        dist = max(h * 1.5, 5.0)
        cams[f"close_{name}"] = ((xc, -dist - 2.0, 1.7), (xc, 0.0, h * 0.5), 35)
    for key, (loc, tgt, lens) in cams.items():
        cd = bpy.data.cameras.new(f"Cam_{key}")
        cd.lens = lens
        cd.clip_end = 2000
        cd.clip_start = 0.05
        c = bpy.data.objects.new(f"Cam_{key}", cd)
        c.location = loc
        look_at(c, tgt)
        prev.collection.objects.link(c)
    return prev


def _render(prev, cam, path, res):
    prev.camera = bpy.data.objects[f"Cam_{cam}"]
    prev.render.resolution_x, prev.render.resolution_y = res
    prev.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=prev.name)


def _load_pixels(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return a


def _save_pixels(arr, path):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels.foreach_set(arr.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def render_all(out_dir, args=()):
    os.makedirs(out_dir, exist_ok=True)
    prev = bpy.data.scenes["Preview"]
    only = [a.split("=", 1)[1] for a in args if a.startswith("--views=")]
    views = only[0].split(",") if only else ["eye", "golf", "aerial", "close", "props"]
    if "eye" in views:
        _render(prev, "eye", os.path.join(out_dir, "env_lineup_eye.png"), (1600, 900))
    if "golf" in views:
        _render(prev, "golf", os.path.join(out_dir, "env_lineup_golf60m.png"), (1600, 900))
    if "aerial" in views:
        _render(prev, "aerial", os.path.join(out_dir, "env_lineup_aerial.png"), (1600, 900))
    if "close" in views:
        tiles = []
        for name, _ in TREE_LINEUP:
            p = os.path.join(out_dir, f"_tmp_close_{name}.png")
            _render(prev, f"close_{name}", p, (720, 720))
            tiles.append(_load_pixels(p))
            os.remove(p)
        row0 = np.concatenate(tiles[3:6], 1)  # bottom row (pixel rows start at bottom)
        row1 = np.concatenate(tiles[0:3], 1)
        _save_pixels(np.concatenate([row0, row1], 0), os.path.join(out_dir, "env_closeups.png"))
    for v in ("oak", "trunk", "pine"):
        if v in views:
            _render(prev, v, os.path.join(out_dir, f"env_detail_{v}.png"), (1200, 1200))
    if "props" in views:
        _render(prev, "props", os.path.join(out_dir, "env_props.png"), (1600, 900))
        _render(prev, "props_small", os.path.join(out_dir, "env_props_small.png"), (1600, 900))
        _render(prev, "bag", os.path.join(out_dir, "env_props_bag.png"), (1200, 900))
        _render(prev, "cup_top", os.path.join(out_dir, "env_props_cup.png"), (900, 900))
