"""Minimal RGBA PNG writer (numpy + zlib) with per-row adaptive filtering and
optional colour quantisation. Blender's own PNG save uses a fast/weak zlib level;
foliage atlases written here are ~40% smaller, and the glTF exporter embeds a
packed PNG's bytes unchanged."""
import struct
import zlib

import numpy as np


def _chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def _filters(img):
    """All five PNG filter results for every row; img: (h, w*4) uint8."""
    x = img.astype(np.int16)
    a = np.zeros_like(x)
    a[:, 4:] = x[:, :-4]
    b = np.zeros_like(x)
    b[1:] = x[:-1]
    c = np.zeros_like(x)
    c[1:, 4:] = x[:-1, :-4]
    p = a + b - c
    pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
    paeth = np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c))
    outs = [x, x - a, x - b, x - ((a + b) >> 1), x - paeth]
    return [(o & 0xFF).astype(np.uint8) for o in outs]


def write_png(path, rgba, quant=4):
    """rgba: float (h, w, 4) in [0,1], row 0 = BOTTOM (Blender order)."""
    u8 = np.clip(np.round(rgba * 255.0), 0, 255).astype(np.uint8)[::-1]
    if quant > 1:
        rgb = u8[..., :3].astype(np.int32)
        rgb = np.clip((rgb + quant // 2) // quant * quant, 0, 255)
        u8 = np.concatenate([rgb.astype(np.uint8), u8[..., 3:]], axis=2)
        # fully transparent texels: colour only matters for bleeding -> coarser steps
        clear = u8[..., 3] == 0
        u8[clear, :3] = (u8[clear, :3] // 16) * 16 + 8
    h, w, _ = u8.shape
    flat = u8.reshape(h, w * 4)
    cand = _filters(flat)
    cost = np.stack([np.abs(cv.view(np.int8).astype(np.int32)).sum(1) for cv in cand])
    best = cost.argmin(0)
    rows = np.stack(cand)[best, np.arange(h)]
    raw = np.concatenate([best.astype(np.uint8)[:, None], rows], axis=1).tobytes()
    data = b"\x89PNG\r\n\x1a\n"
    data += _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    data += _chunk(b"IDAT", zlib.compress(raw, 9))
    data += _chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)
    return len(data)
