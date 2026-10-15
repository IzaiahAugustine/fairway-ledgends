// Image-based sky and lighting: an HDRI drives the background, the ambient/specular IBL and the
// direction of the shadow-casting sun, so lighting matches the photographed sky.
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { isTouchDevice } from '../core/device';

interface HdriInfo {
  texture: THREE.DataTexture;
  sunDir: THREE.Vector3; // in texture space
  horizon: THREE.Color;
  envMap: THREE.Texture;
}

const cache = new Map<string, Promise<HdriInfo>>();

function analyse(tex: THREE.DataTexture): { sunDir: THREE.Vector3; horizon: THREE.Color } {
  const img = tex.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const { width: W, height: H, data } = img;
  const half = data instanceof Uint16Array;
  const get = (i: number) => (half ? THREE.DataUtils.fromHalfFloat((data as Uint16Array)[i]) : (data as Float32Array)[i]);
  const ch = data.length / (W * H);
  let best = -1, bx = 0, by = 0;
  const step = 2;
  for (let y = 0; y < H / 2; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * ch;
      const l = 0.2126 * get(i) + 0.7152 * get(i + 1) + 0.0722 * get(i + 2);
      if (l > best) { best = l; bx = x; by = y; }
    }
  }
  // flipY: first data row is the top of the sky
  const u = (bx + 0.5) / W;
  const v = 1 - (by + 0.5) / H;
  const phi = (u - 0.5) * Math.PI * 2;
  const lat = (v - 0.5) * Math.PI;
  const sunDir = new THREE.Vector3(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)).normalize();
  // average colour just above the horizon (for fog)
  const r0 = Math.floor(H * 0.47);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = r0; y < r0 + Math.max(2, Math.floor(H * 0.02)); y++)
    for (let x = 0; x < W; x += 8) {
      const i = (y * W + x) * ch;
      r += get(i); g += get(i + 1); b += get(i + 2); n++;
    }
  const horizon = new THREE.Color(r / n, g / n, b / n);
  return { sunDir, horizon };
}

export class SkyEnvironment {
  readonly sun: THREE.DirectionalLight;
  readonly sunTarget = new THREE.Object3D();
  private pmrem: THREE.PMREMGenerator;
  sunDirWorld = new THREE.Vector3(0.4, 0.7, 0.3).normalize();
  horizon = new THREE.Color(0xbfd3e6);
  /** Un-normalised sky radiance just above the horizon (for aerial perspective). */
  horizonRadiance = new THREE.Color(0.8, 0.9, 1.0);
  /** Aerial-perspective settings read by the atmosphere pass; null scene fog when used. */
  haze = { density: 0.0003, falloff: 0.0025, base: 0, skyHaze: 0.5 };
  useSceneFog = true;
  private shadowExtent = 80;

  constructor(renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sun = new THREE.DirectionalLight(0xfff3e0, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.035;
    this.sun.target = this.sunTarget;
    scene.add(this.sun, this.sunTarget);
    this.setShadowExtent(80);
  }

  setQuality(q: 'low' | 'medium' | 'high') {
    // phones: a 1024 shadow map (a 2048 one with its depth buffer is ~34 MB)
    const size = isTouchDevice ? 1024 : q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  get shadowSize() {
    return this.shadowExtent;
  }

  setShadowExtent(e: number) {
    this.shadowExtent = e;
    const cam = this.sun.shadow.camera;
    cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
    cam.near = 1; cam.far = 900;
    cam.updateProjectionMatrix();
  }

  load(name: string): Promise<HdriInfo> {
    let p = cache.get(name);
    if (!p) {
      // phones get the 2K sky: the 4K one plus its lighting maps alone is ~170 MB of GPU memory
      p = new HDRLoader().loadAsync(`assets/hdri/${name}_${isTouchDevice ? '2k' : '4k'}.hdr`).then((tex) => {
        const t = tex as THREE.DataTexture;
        t.mapping = THREE.EquirectangularReflectionMapping;
        const a = analyse(t);
        const envMap = this.pmrem.fromEquirectangular(t).texture;
        // free the generator's scratch target (as big as the env map itself); it's rebuilt on demand
        this.pmrem.dispose();
        return { texture: t, envMap, ...a };
      });
      cache.set(name, p);
    }
    return p;
  }

  /**
   * Applies a sky. `azimuth` rotates the sky about the vertical so the sun comes from a
   * pleasing direction relative to the hole's line of play.
   */
  async apply(name: string, opts: { envIntensity: number; sunIntensity: number; playDir: THREE.Vector2; sunOffsetDeg: number; minSunY?: number; sunColor?: THREE.Color }) {
    const info = await this.load(name);
    const s = this.scene;
    s.background = info.texture;
    s.environment = info.envMap;
    s.environmentIntensity = opts.envIntensity;
    s.backgroundIntensity = 1.0;
    // Rotate so the sun's azimuth sits sunOffsetDeg from the play direction.
    const texAz = Math.atan2(info.sunDir.z, info.sunDir.x);
    const playAz = Math.atan2(opts.playDir.y, opts.playDir.x);
    const want = playAz + (opts.sunOffsetDeg * Math.PI) / 180;
    // Rotating the sky by +theta about Y maps texture direction az -> az - theta (three.js Y rotation).
    const theta = texAz - want;
    s.backgroundRotation.set(0, theta, 0);
    s.environmentRotation.set(0, theta, 0);
    this.sunDirWorld.copy(info.sunDir).applyAxisAngle(new THREE.Vector3(0, 1, 0), theta);
    // keep the sun high enough for readable shadows
    const minY = opts.minSunY ?? 0.32;
    if (this.sunDirWorld.y < minY) {
      this.sunDirWorld.y = minY;
      this.sunDirWorld.normalize();
    }
    this.sun.intensity = opts.sunIntensity;
    this.horizon.copy(info.horizon);
    this.horizonRadiance.copy(info.horizon).multiplyScalar(s.backgroundIntensity);
    const lum = this.horizon.r * 0.2126 + this.horizon.g * 0.7152 + this.horizon.b * 0.0722;
    this.horizon.multiplyScalar(0.55 / Math.max(lum, 0.05));
    if (!this.useSceneFog) s.fog = null;
    else if (s.fog instanceof THREE.FogExp2) s.fog.color.copy(this.horizon);
    else s.fog = new THREE.FogExp2(this.horizon.getHex(), 0.00028);
    // tint the sun slightly by the sky colour temperature
    if (opts.sunColor) this.sun.color.copy(opts.sunColor);
    else this.sun.color.setRGB(1, 0.96, 0.9);
  }

  /** Centre the shadow frustum on a point of interest. */
  focus(p: THREE.Vector3) {
    const d = this.sunDirWorld;
    // snap to texel grid to avoid shimmering
    const texel = (this.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(p.x / texel) * texel;
    const fz = Math.round(p.z / texel) * texel;
    this.sunTarget.position.set(fx, p.y, fz);
    this.sun.position.set(fx + d.x * 400, p.y + d.y * 400, fz + d.z * 400);
    this.sunTarget.updateMatrixWorld();
  }
}
