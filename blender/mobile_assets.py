"""Build the phone copies of the game's images and models under public/m/.

Phones load from m/ instead (see src/core/device.ts). Mobile Safari keeps an extra full-size copy
of every image a page uploads to WebGL, so on iPhone the full-size set ran past the memory limit
and Safari closed the page. Here everything is capped at 512 px except the colour maps of what's
seen up close (the ground, the golfer and their face) and tree leaves, which keep 1024.

Needs Pillow:
  python3 blender/mobile_assets.py
"""
import io
import json
import os
import shutil
import struct

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '..', 'public')
OUT = os.path.join(PUBLIC, 'm')
CAP = 512
# colour maps are what reads as sharp or blurry; normal/roughness/AO maps can be smaller
COLOR_CAP = 1024

IMAGE_DIRS = ['assets/textures', 'assets/trees', 'assets/golfer/faces']
MODEL_DIRS = ['models', 'models/ai']


def _pad(b, fill=b'\0'):
    return b + fill * (-len(b) % 4)


def _shrink(img, cap):
    """Returns the image scaled so its longer side is at most cap (or None if it already fits)."""
    w, h = img.size
    if max(w, h) <= cap:
        return None
    k = cap / max(w, h)
    return img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)


def _encode(img, mime):
    buf = io.BytesIO()
    if mime == 'image/png':
        img.save(buf, 'PNG', optimize=True)
    else:
        img.convert('RGB').save(buf, 'JPEG', quality=88, optimize=True)
    return buf.getvalue()


def image_file(src, dst, cap):
    img = Image.open(src)
    small = _shrink(img, cap)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if small is None:
        shutil.copyfile(src, dst)
    else:
        small.save(dst, **({'optimize': True} if dst.endswith('.png') else {'quality': 88, 'optimize': True}))


def glb_file(src, dst, color_cap):
    data = open(src, 'rb').read()
    jlen = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + jlen])
    blen = struct.unpack_from('<I', data, 20 + jlen)[0]
    binb = data[28 + jlen:28 + jlen + blen]

    swap = {}  # bufferView index -> new image bytes
    for im in gltf.get('images', []):
        if 'bufferView' not in im:
            continue
        bv = gltf['bufferViews'][im['bufferView']]
        raw = binb[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        img = Image.open(io.BytesIO(raw))
        name = im.get('name', '')
        color = name.startswith('Skin') or name.endswith('_albedo') or name.startswith('Color_')
        small = _shrink(img, color_cap if color else CAP)
        if small is not None:
            swap[im['bufferView']] = _encode(small, im.get('mimeType', 'image/jpeg'))

    # rebuild the binary chunk, keeping every other buffer view's bytes and 4-byte alignment
    out = bytearray()
    for i, bv in enumerate(gltf['bufferViews']):
        chunk = swap[i] if i in swap else binb[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        out += b'\0' * (-len(out) % 4)
        bv['byteOffset'] = len(out)
        bv['byteLength'] = len(chunk)
        out += chunk
    out = _pad(bytes(out))
    gltf['buffers'][0]['byteLength'] = len(out)

    js = _pad(json.dumps(gltf, separators=(',', ':')).encode(), b' ')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(out), 0x004E4942) + out)
    return len(swap)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    for d in IMAGE_DIRS:
        for f in sorted(os.listdir(os.path.join(PUBLIC, d))):
            if f.lower().endswith(('.jpg', '.jpeg', '.png')) and '_2k.' not in f:
                # the ground, the golfer's face and tree leaves (the bulk of every tree) stay sharper
                color = d.endswith('faces') or '_diff' in f or '_leaf' in f
                image_file(os.path.join(PUBLIC, d, f), os.path.join(OUT, d, f), COLOR_CAP if color else CAP)
    for d in MODEL_DIRS:
        for f in sorted(os.listdir(os.path.join(PUBLIC, d))):
            if f.endswith('.glb'):
                # the golfer is seen up close; landmarks and props from a distance
                n = glb_file(os.path.join(PUBLIC, d, f), os.path.join(OUT, d, f), COLOR_CAP if f == 'golfer.glb' else CAP)
                print(f'{d}/{f}: {n} textures shrunk')
    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(OUT) for f in fs)
    print(f'public/m: {size / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
