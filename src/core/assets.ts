// Asset loading with caching: PBR textures (with measured average colour) and glTF models.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl, isTouchDevice } from './device';

const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

export interface TexInfo {
  tex: THREE.Texture;
  /** Average linear colour of the texture. */
  avg: THREE.Color;
}

const texCache = new Map<string, Promise<TexInfo>>();

function averageColor(img: HTMLImageElement | ImageBitmap): THREE.Color {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img as CanvasImageSource, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let r = 0, g = 0, b = 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  for (let i = 0; i < d.length; i += 4) {
    r += lin(d[i]);
    g += lin(d[i + 1]);
    b += lin(d[i + 2]);
  }
  const n = d.length / 4;
  return new THREE.Color(r / n, g / n, b / n);
}

/**
 * Phones: once a texture is on the GPU, let go of its source image. Mobile Safari keeps a decoded
 * copy of every image a page has uploaded to WebGL for as long as the page holds the image, which
 * on iPhone cost ~160 MB. Nothing re-uploads these textures (they're never disposed); if the GPU
 * context is ever lost, main reloads the page instead.
 */
export function releaseAfterUpload(tex: THREE.Texture) {
  if (!isTouchDevice) return;
  tex.onUpdate = () => {
    tex.onUpdate = null;
    const im = tex.image as HTMLImageElement | ImageBitmap | null;
    if (!im) return;
    tex.image = { width: im.width, height: im.height };
    if (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) im.close();
  };
}

let hiRes = false;
/** High quality: terrain textures shipped at 2K load as "_2k" instead of "_1k". */
export function setHiResTextures(on: boolean) {
  hiRes = on;
}
export const hiResTextures = () => hiRes;

export function loadTexture(name: string, srgb = true, maxAniso = 16): Promise<TexInfo> {
  const file = hiRes && !isTouchDevice ? name.replace(/_1k\.jpg$/, '_2k.jpg') : name;
  const key = `${file}|${srgb}`;
  let p = texCache.get(key);
  if (!p) {
    // a missing 2K file falls back to the 1K one
    p = texLoader
      .loadAsync(assetUrl(`assets/textures/${file}`))
      .catch((e) => (file !== name ? texLoader.loadAsync(assetUrl(`assets/textures/${name}`)) : Promise.reject(e)))
      .then((tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = maxAniso;
        const avg = srgb ? averageColor(tex.image as HTMLImageElement) : new THREE.Color(0.5, 0.5, 0.5);
        releaseAfterUpload(tex);
        return { tex, avg };
      });
    texCache.set(key, p);
  }
  return p;
}

const gltfCache = new Map<string, Promise<GLTF | null>>();

/** Loads a glTF; resolves null if the file is missing so the game can fall back to placeholders. */
export function loadGLTF(path: string): Promise<GLTF | null> {
  let p = gltfCache.get(path);
  if (!p) {
    p = gltfLoader.loadAsync(assetUrl(path)).then(
      (g) => {
        const seen = new Set<THREE.Texture>();
        g.scene.traverse((o) => {
          const mats = (o as THREE.Mesh).material;
          for (const m of Array.isArray(mats) ? mats : mats ? [mats] : [])
            for (const v of Object.values(m))
              if (v instanceof THREE.Texture && !seen.has(v)) {
                seen.add(v);
                releaseAfterUpload(v);
              }
        });
        return g;
      },
      (e) => {
        console.warn(`[assets] could not load ${path}`, e);
        return null;
      },
    );
    gltfCache.set(path, p);
  }
  return p;
}

/** Simple tiling noise texture (RGBA channels hold independent value noise). */
export function makeNoiseTexture(size = 256, seed = 1): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let ch = 0; ch < 4; ch++) {
    const grid = 8 << (ch % 2);
    const g: number[] = [];
    for (let i = 0; i < grid * grid; i++) g.push(rand());
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let v = 0, amp = 0.5, tot = 0;
        for (let o = 0; o < 4; o++) {
          const gs = grid << o;
          const fx = (x / size) * gs, fy = (y / size) * gs;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = fx - x0, ty = fy - y0;
          const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
          const at = (i: number, j: number) => g[((j % gs) * 7919 + (i % gs) * 104729 + o * 31) % g.length];
          const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
          v += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
          tot += amp;
          amp *= 0.5;
        }
        data[(y * size + x) * 4 + ch] = Math.round((v / tot) * 255);
      }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Tileable normal map built from layered sine waves, used for water. */
export function makeWaterNormals(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const waves: [number, number, number, number][] = [];
  let s = 7;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 24; i++) {
    const kx = Math.round((rand() * 2 - 1) * 9);
    const ky = Math.round((rand() * 2 - 1) * 9);
    waves.push([kx, ky, rand() * Math.PI * 2, 1 / (1 + Math.hypot(kx, ky))]);
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const [kx, ky, ph, a] of waves) {
        const arg = ((kx * x + ky * y) / size) * Math.PI * 2 + ph;
        const c = Math.cos(arg) * a;
        dx += c * kx;
        dy += c * ky;
      }
      const nx = -dx * 0.06, ny = -dy * 0.06;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / l) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / l) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
