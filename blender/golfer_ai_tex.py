"""Swap AI-enhanced albedo maps (Artlist) into an exported golfer GLB.

golfer_tex/ is regenerated procedurally on every build; golfer_tex_ai/ holds hand-checked
replacements painted over those exact UV layouts (skin face detail, glove and shoe leather).
Each file replaces the GLB image of the same name, so UVs and materials are untouched.

Pure Python (no bpy), so it also runs standalone:
  python3 blender/golfer_ai_tex.py [path/to/golfer.glb]
"""
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.join(HERE, 'golfer_tex_ai')
GLB_PATH = os.path.join(HERE, '..', 'public', 'models', 'golfer.glb')


def _pad(b, fill=b'\0'):
    return b + fill * (-len(b) % 4)


def patch_glb(path=GLB_PATH, ai_dir=AI_DIR):
    if not os.path.isdir(ai_dir):
        return 0
    repl = {os.path.splitext(f)[0]: os.path.join(ai_dir, f) for f in os.listdir(ai_dir)
            if f.lower().endswith(('.jpg', '.jpeg', '.png'))}
    data = open(path, 'rb').read()
    jlen = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + jlen])
    blen = struct.unpack_from('<I', data, 20 + jlen)[0]
    binb = data[28 + jlen:28 + jlen + blen]

    swap = {}  # bufferView index -> (bytes, mime)
    for im in gltf.get('images', []):
        src = repl.get(im.get('name', ''))
        if src and 'bufferView' in im:
            mime = 'image/png' if src.lower().endswith('.png') else 'image/jpeg'
            swap[im['bufferView']] = (open(src, 'rb').read(), mime)
            im['mimeType'] = mime
    if not swap:
        return 0

    # rebuild the binary chunk, keeping every other buffer view's bytes and 4-byte alignment
    out = bytearray()
    for i, bv in enumerate(gltf['bufferViews']):
        chunk = swap[i][0] if i in swap else binb[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        out += b'\0' * (-len(out) % 4)
        bv['byteOffset'] = len(out)
        bv['byteLength'] = len(chunk)
        out += chunk
    out = _pad(bytes(out))
    gltf['buffers'][0]['byteLength'] = len(out)

    js = _pad(json.dumps(gltf, separators=(',', ':')).encode(), b' ')
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(out), 0x004E4942) + out)
    print('ai textures patched into', path, sorted(gltf['images'][j]['name'] for j in range(len(gltf['images']))
                                                   if gltf['images'][j].get('bufferView') in swap))
    return len(swap)


if __name__ == '__main__':
    patch_glb(sys.argv[1] if len(sys.argv) > 1 else GLB_PATH)
