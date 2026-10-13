// Weather for a round: fair, breezy, overcast or rain. Weather changes the sky and light, the
// wind range, how firm and fast the turf plays, and (for rain) draws falling streaks around the
// camera and plays a rain bed.
import * as THREE from 'three';
import type { Rng } from '../core/rng';
import { traits, type CourseDef } from '../data/courses';

export type WeatherKind = 'fair' | 'breezy' | 'overcast' | 'rain';

export interface Weather {
  kind: WeatherKind;
  label: string;
  /** Sky to use instead of the course's own (overcast / rain). */
  hdri?: string;
  sunMul: number;
  envMul: number;
  windMul: number;
  hazeMul: number;
  cloudCover: number | null;
  /** 0 dry .. 1 soaked: softer landings, slower greens. */
  wet: number;
  exposureMul: number;
}

const KINDS: Record<WeatherKind, Omit<Weather, 'kind'>> = {
  fair: { label: 'Fair', sunMul: 1, envMul: 1, windMul: 1, hazeMul: 1, cloudCover: null, wet: 0, exposureMul: 1 },
  breezy: { label: 'Breezy', sunMul: 1, envMul: 1, windMul: 1.6, hazeMul: 0.8, cloudCover: 0.4, wet: 0, exposureMul: 1 },
  overcast: { label: 'Overcast', hdri: 'kloofendal_28d_misty_puresky', sunMul: 0.5, envMul: 1.15, windMul: 1.1, hazeMul: 1.6, cloudCover: 0.75, wet: 0.2, exposureMul: 1.02 },
  rain: { label: 'Rain', hdri: 'kloofendal_28d_misty_puresky', sunMul: 0.3, envMul: 1.05, windMul: 1.25, hazeMul: 2.4, cloudCover: 0.85, wet: 1, exposureMul: 0.92 },
};

/** Weighted pick for a course: sea courses see more wind and grey days, the desert almost never rains. */
export function pickWeather(course: CourseDef, rng: Rng, mode: 'random' | 'fair', force?: WeatherKind): Weather {
  if (force) return { kind: force, ...KINDS[force] };
  if (mode === 'fair') return { kind: 'fair', ...KINDS.fair };
  const w: Record<WeatherKind, number> = { ...traits(course).weather };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (const k of Object.keys(w) as WeatherKind[]) {
    r -= w[k];
    if (r <= 0) return { kind: k, ...KINDS[k] };
  }
  return { kind: 'fair', ...KINDS.fair };
}

/**
 * Rain streaks: a fixed box of short lines that follows the camera. Each streak falls in the
 * vertex shader (wrapping inside the box), slanted by the wind, so there is no per-frame CPU cost.
 */
export class Rain {
  readonly mesh: THREE.LineSegments;
  private uniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2() },
  };

  constructor(count = 9000) {
    const pos = new Float32Array(count * 6);
    const seed = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      for (let e = 0; e < 2; e++) {
        const k = (i * 2 + e) * 3;
        seed[k] = x;
        seed[k + 1] = y;
        seed[k + 2] = z;
        pos[k + 1] = e; // 0 = bottom of the streak, 1 = top
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime;
        uniform vec3 uCenter;
        uniform vec2 uWind;
        varying float vA;
        const vec3 BOX = vec3(36.0, 18.0, 36.0);
        void main() {
          float speed = 9.0 + aSeed.x * 3.0;
          // wrap each streak inside a box centred on the camera
          vec3 p = aSeed * BOX;
          p.y = mod(p.y - uTime * speed, BOX.y);
          p.xz += uWind * (BOX.y - p.y) * 0.08;
          p.xz = mod(p.xz - uCenter.xz + BOX.xz * 0.5, BOX.xz);
          vec3 w = vec3(uCenter.x - BOX.x * 0.5 + p.x, uCenter.y - 6.0 + p.y, uCenter.z - BOX.z * 0.5 + p.z);
          // streak length along the fall direction
          vec3 dir = normalize(vec3(-uWind.x * 0.08, 1.0, -uWind.y * 0.08));
          w += dir * position.y * 0.32;
          vA = position.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() { gl_FragColor = vec4(0.78, 0.82, 0.88, 0.32 * vA + 0.06); }`,
    });
    this.mesh = new THREE.LineSegments(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'Rain';
  }

  update(dt: number, cam: THREE.Camera, windX: number, windZ: number) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uCenter.value.copy(cam.position);
    this.uniforms.uWind.value.set(windX, windZ);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
