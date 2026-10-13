// GPU grass: hundreds of thousands of instanced blades generated entirely in the vertex shader
// around the camera (no per-blade CPU data). Blade placement, height and colour come from the
// hole's coverage maps and turf textures so the blades sit on, and match, the ground beneath.
import * as THREE from 'three';
import type { CourseDef } from '../data/courses';
import type { HoleField } from './holeGen';
import { COVER_GLSL, terrainTime, type TerrainMaps, type TerrainTextures } from './terrain';
import { DIVOT_GLSL, divotUniforms } from './divots';

type Quality = 'low' | 'medium' | 'high';

export const grassWind = { uWind: { value: new THREE.Vector2(1, 0) } };

interface LayerDef {
  name: string;
  spacing: number;
  half: number; // half size of the square around the focus point
  ahead: number; // how far in front of the camera the square is centred
  segs: number;
  fadeIn: [number, number]; // camera distance where blades grow in
  fadeOut: [number, number];
  tall: boolean;
}

const LAYERS: Record<Quality, LayerDef[]> = {
  high: [
    { name: 'near', spacing: 0.05, half: 12, ahead: 7, segs: 3, fadeIn: [-1, 0], fadeOut: [8.5, 11.5], tall: false },
    { name: 'mid', spacing: 0.14, half: 38, ahead: 22, segs: 3, fadeIn: [8.5, 11.5], fadeOut: [30, 40], tall: false },
    { name: 'tall', spacing: 0.15, half: 42, ahead: 24, segs: 5, fadeIn: [-1, 0], fadeOut: [40, 52], tall: true },
    { name: 'tallFar', spacing: 0.34, half: 80, ahead: 60, segs: 3, fadeIn: [40, 52], fadeOut: [95, 130], tall: true },
  ],
  medium: [
    { name: 'near', spacing: 0.07, half: 11, ahead: 6, segs: 3, fadeIn: [-1, 0], fadeOut: [8, 10.5], tall: false },
    { name: 'mid', spacing: 0.2, half: 30, ahead: 17, segs: 2, fadeIn: [8, 10.5], fadeOut: [24, 31], tall: false },
    { name: 'tall', spacing: 0.21, half: 32, ahead: 18, segs: 4, fadeIn: [-1, 0], fadeOut: [30, 40], tall: true },
    { name: 'tallFar', spacing: 0.45, half: 60, ahead: 45, segs: 2, fadeIn: [30, 40], fadeOut: [70, 95], tall: true },
  ],
  low: [
    { name: 'near', spacing: 0.1, half: 9, ahead: 5, segs: 2, fadeIn: [-1, 0], fadeOut: [7, 9], tall: false },
    { name: 'tall', spacing: 0.3, half: 24, ahead: 13, segs: 3, fadeIn: [-1, 0], fadeOut: [20, 26], tall: true },
  ],
};

function bladeGeometry(segs: number, count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pos.push(-1, t, 0, 1, t, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

function heightTexture(field: HoleField): THREE.DataTexture {
  const tex = new THREE.DataTexture(field.heights, field.nx, field.nz, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export class GrassField {
  readonly group = new THREE.Group();
  private layers: { def: LayerDef; mesh: THREE.Mesh; origin: THREE.Vector3; grid: number }[] = [];
  private hTex: THREE.DataTexture;
  private disposables: { dispose(): void }[] = [];

  constructor(field: HoleField, course: CourseDef, t: TerrainTextures, maps: TerrainMaps, quality: Quality) {
    this.hTex = heightTexture(field);
    this.disposables.push(this.hTex);
    for (const def of LAYERS[quality]) {
      const grid = Math.round((def.half * 2) / def.spacing);
      const geo = bladeGeometry(def.segs, grid * grid);
      const mat = this.makeMaterial(field, course, t, maps, def, grid);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = `Grass_${def.name}`;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
      this.layers.push({ def, mesh, origin: mat.userData.origin as THREE.Vector3, grid });
    }
  }

  private makeMaterial(field: HoleField, course: CourseDef, t: TerrainTextures, maps: TerrainMaps, def: LayerDef, grid: number): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
    const origin = new THREE.Vector3();
    mat.userData.origin = origin;
    const col = (h: number) => new THREE.Color(h);
    const uniforms = {
      uOrigin: { value: origin },
      uSpacing: { value: def.spacing },
      uGrid: { value: grid },
      uFade: { value: new THREE.Vector4(def.fadeIn[0], def.fadeIn[1], def.fadeOut[0], def.fadeOut[1]) },
      tHeight: { value: this.hTex },
      covA: { value: maps.coverA },
      covB: { value: maps.coverB },
      tNoise: { value: t.noise },
      tRough: { value: t.rough.tex },
      tFine: { value: t.fine.tex },
      aRough: { value: t.rough.avg },
      aFine: { value: t.fine.avg },
      uField: { value: new THREE.Vector4(field.minX, field.minZ, field.nx, field.nz) },
      cFairway: { value: col(course.colors.fairway) },
      cRough: { value: col(course.colors.rough) },
      cDeep: { value: col(course.colors.deep) },
      cFescue: { value: col(course.colors.fescue) },
      uFescue: { value: course.fescue ? 1 : 0 },
      uSea: { value: field.hasOcean ? field.seaLevel : -1000 },
      uTime: terrainTime,
      uWind: grassWind.uWind,
      ...divotUniforms,
    };
    const tall = def.tall;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec3 uOrigin;
          uniform float uSpacing, uGrid, uFescue, uTime, uSea;
          uniform vec4 uFade, uField;
          uniform sampler2D tHeight, covA, covB, tNoise, tRough, tFine;
          uniform vec3 aRough, aFine, cFairway, cRough, cDeep, cFescue;
          uniform vec2 uWind;
          varying vec3 vGrassCol;
          varying float vGrassT;
          ${COVER_GLSL.replace(/fwidth\(d\) \* 0\.7/g, '0.0')}
          ${DIVOT_GLSL}
          vec2 hash22(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.xx + p3.yz) * p3.zy);
          }
          float hash12(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
          }
          // bilinear ground height on the 1 m mesh lattice (matches the rendered terrain)
          float groundH(vec2 w) {
            vec2 g = (w - uField.xy) / 1.0;
            vec2 i = floor(g);
            vec2 f = g - i;
            ivec2 i0 = ivec2(i) * 2;
            ivec2 mx = ivec2(uField.zw) - 1;
            float h00 = texelFetch(tHeight, clamp(i0, ivec2(0), mx), 0).r;
            float h10 = texelFetch(tHeight, clamp(i0 + ivec2(2, 0), ivec2(0), mx), 0).r;
            float h01 = texelFetch(tHeight, clamp(i0 + ivec2(0, 2), ivec2(0), mx), 0).r;
            float h11 = texelFetch(tHeight, clamp(i0 + ivec2(2, 2), ivec2(0), mx), 0).r;
            return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
          }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `
          float gid = float(gl_InstanceID);
          vec2 cell = vec2(mod(gid, uGrid), floor(gid / uGrid)) - uGrid * 0.5;
          vec2 ci = floor(uOrigin.xz / uSpacing + 0.5) + cell;
          vec2 hj = hash22(ci);
          float hr = hash12(ci + 17.3);
          vec2 root = (ci + (hj - 0.5) * 0.95) * uSpacing;
          vec2 fuv = ((root - uField.xy) / 0.5 + 0.5) / uField.zw;
          float inField = step(0.0, fuv.x) * step(fuv.x, 1.0) * step(0.0, fuv.y) * step(fuv.y, 1.0);
          vec4 ca = texture2D(covA, fuv);
          vec4 cb = texture2D(covB, fuv);
          float n1 = texture2D(tNoise, root * 0.21).r - 0.5;
          float n2 = texture2D(tNoise, root * 0.93 + 0.4).g - 0.5;
          float nEdge = n1 * 0.55 + n2 * 0.22;
          float dFw = sdf(ca.r), dFr = sdf(ca.g), dGr = sdf(ca.b), dBk = sdf(ca.a);
          float dDeep = sdf(cb.r), dTee = sdf(cb.g), dWet = sdf(cb.b);
          float wFw = step(0.0, dFw + nEdge * 0.35);
          float wCut = step(0.0, dFw + 1.6 + nEdge * 0.8);
          float wDeep = smoothstep(-0.3, 0.3, dDeep + nEdge * 3.0);
          float noGrass = max(max(step(0.0, dGr + 0.15), step(0.0, dFr + 0.05)), max(step(0.0, dBk + n1 * 0.18 + 0.02), step(0.0, dTee)));
          noGrass = max(noGrass, step(0.0, dWet * 2.0));
          noGrass = max(noGrass, inDivot(root)); // turf torn out by a divot
          float slope = cb.a * 2.55;
          noGrass = max(noGrass, smoothstep(0.55, 0.85, slope + (hr - 0.5) * 0.25));
          float camD = distance(cameraPosition.xz, root);
          float fade = smoothstep(uFade.x, uFade.y, camD) * (1.0 - smoothstep(uFade.z, uFade.w, camD));
          // blade height by surface (metres)
          float rough = 0.065 + 0.05 * hr;
          float hgt;
          #ifdef GRASS_TALL
            float clump = smoothstep(0.35, 0.75, texture2D(tNoise, root * 0.045 + 0.61).a + (hr - 0.5) * 0.25);
            hgt = mix(0.16 + 0.12 * hr, (0.45 + 0.45 * hr) * mix(0.55, 1.0, clump), uFescue) * wDeep;
            hgt *= step(0.25, wDeep);
          #else
            hgt = mix(0.042, rough, 1.0 - wCut);
            hgt = mix(hgt, 0.016 + 0.006 * hr, wFw);
            hgt *= mix(1.0, 1.0 - smoothstep(4.0, 7.0, camD), wFw); // fairway fuzz only right by the camera
            hgt = mix(hgt, 0.11 + 0.07 * hr, wDeep * (1.0 - uFescue));
            hgt *= mix(1.0, 0.75, wDeep * uFescue);
          #endif
          hgt *= fade * inField * (1.0 - noGrass);
          float gy = groundH(root) - 0.012;
          hgt *= step(uSea + 0.6, gy);
          float alive = step(0.004, hgt);
          // blade frame: random facing, lean and wind
          float ang = hr * 6.2832;
          vec2 face = vec2(cos(ang), sin(ang));
          vec2 lean = normalize(hj - 0.5 + 1e-4) * (0.15 + 0.35 * hash12(ci + 3.7));
          float gust = texture2D(tNoise, root * 0.035 - uWind * uTime * 0.06).r;
          float flutter = sin(uTime * (2.0 + 2.0 * hr) + hr * 40.0) * 0.06;
          vec2 bend = lean + uWind * (0.25 + 1.1 * gust) * 0.5 + face * flutter;
          #ifdef GRASS_TALL
            bend *= 1.35;
          #endif
          float tY = position.y;
          float width = hgt * ${tall ? '0.035' : '0.09'} * (1.0 - tY * 0.85) * (0.8 + 0.4 * hj.y);
          #ifdef GRASS_TALL
            width *= max(1.0, uSpacing / 0.15);
          #else
            width *= uSpacing / 0.05 * 0.55 + 0.45;
          #endif
          vec2 off = bend * hgt * tY * tY;
          float drop = dot(off, off) / max(hgt, 1e-3) * 0.5;
          vec3 bladePos = vec3(root.x + off.x + face.y * width * position.x, gy + hgt * tY - drop, root.y + off.y - face.x * width * position.x);
          bladePos *= alive;
          // lit like the ground with a hint of the blade's own facing so it reads as grass
          vec3 objectNormal = normalize(vec3(face.x * 0.35 + bend.x * 0.3, 1.0, face.y * 0.35 + bend.y * 0.3));
          // colour from the turf texture at the root, darker at the base
          vec3 rgt = mix(texture2D(tRough, root * 0.19).rgb, texture2D(tRough, root * 0.043 + 0.2).rgb, 0.45) / aRough;
          vec3 fnt = texture2D(tFine, root * 0.31).rgb / aFine;
          float macro = texture2D(tNoise, root * 0.0032).r;
          float macro2 = texture2D(tNoise, root * 0.013 + 0.37).g;
          vec3 base = cRough * mix(vec3(1.0), rgt, 0.85) * (0.8 + 0.4 * macro) * (0.9 + 0.2 * macro2);
          base = mix(base, mix(cFairway, cRough, 0.55) * mix(fnt, rgt, 0.5), wCut * (1.0 - wFw));
          base = mix(base, cFairway * fnt, wFw);
          vec3 deepC = mix(cDeep * mix(vec3(1.0), rgt, 0.85) * (0.75 + 0.45 * macro), mix(cFescue, cDeep * 0.9, hr * 0.6), uFescue);
          base = mix(base, deepC, wDeep);
          base *= 0.42;
          base = mix(vec3(dot(base, vec3(0.2126, 0.7152, 0.0722))), base, 0.84);
          float tip = tY * tY;
          #ifdef GRASS_TALL
            vec3 dry = mix(cFescue * 0.42, vec3(0.32, 0.28, 0.18), 0.35 * hj.x);
            base = mix(base, dry, uFescue * smoothstep(0.2, 1.0, tY) * (0.6 + 0.4 * hj.y));
          #endif
          vGrassCol = base * (0.92 + 0.22 * hj.x) * mix(0.76, 1.2, tY) * mix(vec3(1.0), vec3(1.08, 1.05, 0.85), tip * 0.5);
          vGrassT = tY;
          `,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = bladePos;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vGrassCol;
          varying float vGrassT;`,
        )
        .replace('#include <map_fragment>', 'diffuseColor.rgb = vGrassCol;')
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          #if NUM_DIR_LIGHTS > 0
            // sunlight glowing through backlit blades
            float back = pow(max(0.0, dot(-geometryViewDir, directionalLights[0].direction)), 4.0);
            reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * back * vGrassT * 0.6;
          #endif`,
        );
    };
    if (tall) {
      const m = mat as unknown as { defines?: Record<string, string> };
      m.defines = { ...(m.defines ?? {}), GRASS_TALL: '' };
    }
    mat.customProgramCacheKey = () => `grass-v2-${def.name}`;
    return mat;
  }

  /** Re-centre the blade grids in front of the camera. */
  update(camera: THREE.Camera, groundY: number) {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const high = camera.position.y - groundY > 45;
    for (const l of this.layers) {
      l.mesh.visible = !high;
      const cx = camera.position.x + fwd.x * l.def.ahead;
      const cz = camera.position.z + fwd.z * l.def.ahead;
      const s = l.def.spacing;
      l.origin.set(Math.round(cx / s) * s, 0, Math.round(cz / s) * s);
    }
  }

  setWind(x: number, z: number) {
    const l = Math.hypot(x, z);
    grassWind.uWind.value.set(x, z).multiplyScalar(Math.min(1.6, 0.2 + l / 5) / (l || 1));
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
    this.layers = [];
  }
}
