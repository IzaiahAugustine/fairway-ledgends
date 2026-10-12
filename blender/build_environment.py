"""Build the golf-course environment assets (trees, bushes, course props).

Run headless (reproducible, fixed seeds):
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup \
        --python D:\\golfgame\\blender\\build_environment.py [-- --no-render] [-- --only-render]

Outputs
    D:\\golfgame\\blender\\environment.blend      (scene "Scene" = export, scene "Preview" = lineups)
    D:\\golfgame\\public\\models\\environment.glb  (every asset at the origin, Y-up, base on y=0)
    D:\\golfgame\\blender\\textures\\*.png         (generated foliage atlases, also packed/embedded)
    D:\\golfgame\\blender\\renders\\env_*.png      (Eevee previews)
"""
import os
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import env_textures  # noqa: E402
import env_trees  # noqa: E402
import env_props  # noqa: E402
import env_preview  # noqa: E402
import env_inspect_glb  # noqa: E402
import env_png  # noqa: E402

ROOT = os.path.dirname(HERE)
BLEND_PATH = os.path.join(HERE, "environment.blend")
GLB_PATH = os.path.join(ROOT, "public", "models", "environment.glb")
TEX_DIR = os.path.join(HERE, "textures")
REF_TEX = os.path.join(ROOT, "public", "assets", "textures")

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


# ---------------------------------------------------------------------------
# materials

def _nodes(mat):
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return nt, bsdf


def _mul_vertex_color(nt, color_socket_or_value, bsdf):
    """Base Color = A * Color Attribute "Col" (glTF: baseColor * COLOR_0)."""
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs[0].default_value = 1.0
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    if isinstance(color_socket_or_value, tuple):
        mix.inputs[6].default_value = color_socket_or_value
    else:
        nt.links.new(color_socket_or_value, mix.inputs[6])
    nt.links.new(vc.outputs["Color"], mix.inputs[7])
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    return mix


def make_image(name, rgba):
    """Write the atlas with our own PNG encoder, then load + pack it so the glTF
    exporter embeds those exact bytes (image source FILE, packed, not dirty)."""
    os.makedirs(TEX_DIR, exist_ok=True)
    path = os.path.join(TEX_DIR, name + ".png")
    env_png.write_png(path, rgba)
    img = bpy.data.images.load(path, check_existing=False)
    img.name = name
    img.alpha_mode = 'STRAIGHT'
    img.pack()
    return img


def foliage_material(name, img):
    m = bpy.data.materials.new(name)
    nt, bsdf = _nodes(m)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = 'Linear'
    _mul_vertex_color(nt, tex.outputs["Color"], bsdf)
    rnd = nt.nodes.new("ShaderNodeMath")
    rnd.operation = 'ROUND'  # glTF exporter: Round => alphaMode MASK, alphaCutoff 0.5
    nt.links.new(tex.outputs["Alpha"], rnd.inputs[0])
    nt.links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Specular IOR Level"].default_value = 0.2
    m.use_backface_culling = False
    m.surface_render_method = 'DITHERED'
    m.use_transparent_shadow = True
    return m


def bark_material():
    m = bpy.data.materials.new("Bark")
    nt, bsdf = _nodes(m)
    imgs = {}
    for k in ("diff", "nor_gl", "rough"):
        p = os.path.join(REF_TEX, f"bark_brown_02_{k}_1k.jpg")
        imgs[k] = bpy.data.images.load(p, check_existing=True)
        if k != "diff":
            imgs[k].colorspace_settings.name = 'Non-Color'
    td = nt.nodes.new("ShaderNodeTexImage")
    td.image = imgs["diff"]
    td.name = "PREVIEW_diff"
    mix = _mul_vertex_color(nt, td.outputs["Color"], bsdf)
    mix.name = "BarkMix"
    tr = nt.nodes.new("ShaderNodeTexImage")
    tr.image = imgs["rough"]
    tr.name = "PREVIEW_rough"
    nt.links.new(tr.outputs["Color"], bsdf.inputs["Roughness"])
    tn = nt.nodes.new("ShaderNodeTexImage")
    tn.image = imgs["nor_gl"]
    tn.name = "PREVIEW_nor"
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.name = "PREVIEW_normalmap"
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.9
    m.use_backface_culling = True
    return m


def bark_preview_textures(enable):
    """The game applies the bark texture itself: strip it for export, keep it for previews.
    Export variant: baseColorFactor white (so the game's map shows true) * COLOR_0 AO."""
    m = bpy.data.materials["Bark"]
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    mix = nt.nodes["BarkMix"]
    for l in list(nt.links):
        if l.from_node.name.startswith("PREVIEW_"):
            nt.links.remove(l)
    if enable:
        nt.links.new(nt.nodes["PREVIEW_diff"].outputs["Color"], mix.inputs[6])
        nt.links.new(nt.nodes["PREVIEW_rough"].outputs["Color"], bsdf.inputs["Roughness"])
        nt.links.new(nt.nodes["PREVIEW_nor"].outputs["Color"], nt.nodes["PREVIEW_normalmap"].inputs["Color"])
        nt.links.new(nt.nodes["PREVIEW_normalmap"].outputs["Normal"], bsdf.inputs["Normal"])
    else:
        mix.inputs[6].default_value = (1.0, 1.0, 1.0, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.9


def simple_material(name, color, rough=0.6, metal=0.0, vcol=False, double=False, spec=0.5):
    m = bpy.data.materials.new(name)
    nt, bsdf = _nodes(m)
    if vcol:
        _mul_vertex_color(nt, tuple(color) + (1.0,), bsdf)
    else:
        bsdf.inputs["Base Color"].default_value = tuple(color) + (1.0,)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Specular IOR Level"].default_value = spec
    m.use_backface_culling = not double
    m.diffuse_color = tuple(color) + (1.0,)
    return m


# ---------------------------------------------------------------------------

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.name = "Scene"
    sc.unit_settings.system = 'METRIC'
    return sc


def asset_collection(scene, name):
    coll = bpy.data.collections.new(name)
    scene.collection.children.link(coll)
    return coll


def build_trees(scene, mats):
    from env_mesh import new_empty
    report = {}
    for name, (builder, params, seed, leaf_mat, target_h) in env_trees.SPECS.items():
        t = time.time()
        bark, leaves = builder(params, seed)
        s = env_trees.scale_to_height([bark, leaves], target_h)
        coll = asset_collection(scene, name)
        root = new_empty(name, coll, 1.0)
        ob_b = bark.to_object(f"{name}_Bark", mats["Bark"], coll, parent=root)
        ob_l = leaves.to_object(f"{name}_Leaves", mats[leaf_mat], coll, parent=root)
        report[name] = dict(bark_tris=bark.tri_count(), leaf_tris=leaves.tri_count(),
                            cards=len(leaves.faces), scale=round(s, 3))
        print(f"[trees] {name}: bark {bark.tri_count()} tris, leaves {leaves.tri_count()} tris "
              f"({len(leaves.faces)} cards), scale {s:.3f}, {time.time() - t:.1f}s")
    return report


def export_glb(scene):
    bark_preview_textures(False)
    os.makedirs(os.path.dirname(GLB_PATH), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=GLB_PATH,
        export_format='GLB',
        use_active_scene=True,
        use_visible=False,
        use_renderable=False,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_tangents=False,
        export_texcoords=True,
        export_vertex_color='MATERIAL',
        export_all_vertex_colors=False,
        export_image_format='AUTO',
        export_materials='EXPORT',
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
    )
    bark_preview_textures(True)
    print(f"[export] {GLB_PATH} {os.path.getsize(GLB_PATH) / 1024:.0f} KB")


def main():
    t0 = time.time()
    scene = reset_scene()

    # textures + materials
    mats = {}
    for name, (fn, S) in env_textures.ATLASES.items():
        t = time.time()
        img = make_image(f"tex_{name}", fn(S))
        mats[name] = foliage_material(name, img)
        print(f"[tex] {name} {img.size[0]}x{img.size[1]} {time.time() - t:.1f}s")
    mats["Bark"] = bark_material()

    tree_report = build_trees(scene, mats)
    prop_report = env_props.build_props(scene, asset_collection, simple_material)

    env_preview.build_preview_scene(scene)
    bpy.context.window_manager  # noqa
    export_glb(scene)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH, compress=True)
    print(f"[save] {BLEND_PATH}")

    env_inspect_glb.report(GLB_PATH)

    if "--no-render" not in ARGS:
        env_preview.render_all(os.path.join(HERE, "renders"), ARGS)
    print(f"[done] {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
