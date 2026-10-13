// The land beyond the hole: rolling country, forest-covered ridges and coastline out to the
// horizon, plus the open sea with depth-tinted water and breaking surf. Heights continue the hole's
// boundary smoothly; a coarse world height map feeds the water shader.
import * as THREE from 'three';
import { Noise2D, clamp, lerp, smoothstep } from '../core/rng';
import { traits, type CourseDef } from '../data/courses';
import type { HoleField } from './holeGen';
import { CLOUD_GLSL, cloudUniforms, terrainTime, type TerrainTextures } from './terrain';

interface Landscape {
  /** Unit direction toward the sea, or null when landlocked. */
  seaDir: { x: number; z: number } | null;
  /** Distance from the hole centre to the coastline along seaDir. */
  seaDist: number;
  cliffs: boolean;
  rolling: number;
  ridge: number;
  ridgeNear: number;
  forest: number;
}

const RINGS = (() => {
  const r: number[] = [-4, 0];
  let d = 3;
  while (d < 7000) {
    r.push(d);
    d = d * 1.065 + 3;
  }
  return r;
})();

export class OuterWorld {
  readonly group = new THREE.Group();
  readonly seaLevel: number;
  private noise: Noise2D;
  private land: Landscape;
  private cx: number;
  private cz: number;
  private maxX: number;
  private maxZ: number;
  private baseLevel = 0;
  private disposables: { dispose(): void }[] = [];

  constructor(private field: HoleField, private course: CourseDef, t: TerrainTextures) {
    this.noise = new Noise2D(field.index * 7717 + 99);
    this.seaLevel = field.seaLevel;
    this.maxX = field.minX + (field.nx - 1) * 0.5;
    this.maxZ = field.minZ + (field.nz - 1) * 0.5;
    this.cx = (field.minX + this.maxX) / 2;
    this.cz = (field.minZ + this.maxZ) / 2;
    this.land = this.pickLandscape();
    // typical ground level along the boundary (ignoring sea)
    let sum = 0, n = 0;
    for (let k = 0; k < 400; k++) {
      const p = this.edgePoint((k / 400) * this.perimeter);
      const h = field.heightAt(p.x, p.z);
      if (h > this.seaLevel + 0.5) { sum += h; n++; }
    }
    this.baseLevel = n ? sum / n : 0;
    const terrain = this.buildTerrain(t);
    this.group.add(terrain);
    if (this.land.seaDir || field.hasOcean) this.group.add(this.buildSea(t));
  }

  private get perimeter() {
    return 2 * (this.maxX - this.field.minX + this.maxZ - this.field.minZ);
  }

  private edgePoint(u: number): { x: number; z: number } {
    const f = this.field;
    const w = this.maxX - f.minX, d = this.maxZ - f.minZ;
    u = ((u % this.perimeter) + this.perimeter) % this.perimeter;
    if (u < w) return { x: f.minX + u, z: f.minZ };
    u -= w;
    if (u < d) return { x: this.maxX, z: f.minZ + u };
    u -= d;
    if (u < w) return { x: this.maxX - u, z: this.maxZ };
    u -= w;
    return { x: f.minX, z: this.maxZ - u };
  }

  private pickLandscape(): Landscape {
    const f = this.field;
    const T = traits(this.course);
    const play = { x: f.cup.x - f.tee.x, z: f.cup.z - f.tee.z };
    const pl = Math.hypot(play.x, play.z) || 1;
    play.x /= pl; play.z /= pl;
    const right = { x: -play.z, z: play.x };
    let seaDir: Landscape['seaDir'] = null;
    let seaDist = 0;
    if (f.oceanSide !== 0) seaDir = { x: right.x * f.oceanSide, z: right.z * f.oceanSide };
    else if (f.oceanBehind) seaDir = play;
    else if (T.seaAlways) seaDir = f.index % 2 ? right : { x: -right.x, z: -right.z };
    if (seaDir) {
      // find the coastline inside the hole, else put it beyond the boundary
      seaDist = -1;
      for (let d = 0; d < 1500; d += 4) {
        const x = this.cx + seaDir.x * d, z = this.cz + seaDir.z * d;
        if (!f.inBounds(x, z)) break;
        if (f.heightAt(x, z) < this.seaLevel - 0.3) { seaDist = d; break; }
      }
      if (seaDist < 0) {
        const toEdge = Math.min(
          Math.abs(seaDir.x) > 1e-3 ? ((seaDir.x > 0 ? this.maxX : f.minX) - this.cx) / seaDir.x : 1e9,
          Math.abs(seaDir.z) > 1e-3 ? ((seaDir.z > 0 ? this.maxZ : f.minZ) - this.cz) / seaDir.z : 1e9,
        );
        seaDist = toEdge + T.seaDist;
      }
    }
    return {
      seaDir,
      seaDist,
      cliffs: T.cliffs,
      rolling: T.rolling,
      ridge: T.ridge,
      ridgeNear: T.ridgeNear,
      forest: T.forest,
    };
  }

  /** Signed distance into the sea (positive offshore). */
  private seaCoord(x: number, z: number): number {
    const s = this.land.seaDir;
    if (!s) return -1e9;
    const along = (x - this.cx) * -s.z + (z - this.cz) * s.x;
    const wig = 70 * this.noise.fbm(along * 0.0025 + 3.3, 7.1, 3) + 18 * this.noise.noise(along * 0.012, 2.2);
    return (x - this.cx) * s.x + (z - this.cz) * s.z - this.land.seaDist - wig;
  }

  private distOutside(x: number, z: number): number {
    const f = this.field;
    const dx = Math.max(f.minX - x, 0, x - this.maxX);
    const dz = Math.max(f.minZ - z, 0, z - this.maxZ);
    return Math.hypot(dx, dz);
  }

  /** Bare-ground height of the far landscape (without the hole and without forest canopy). */
  private farHeight(x: number, z: number): number {
    const n = this.noise, L = this.land;
    let h = this.baseLevel + L.rolling * n.fbm(x * 0.0024 + 11, z * 0.0024 - 4, 4);
    const r = Math.hypot(x - this.cx, z - this.cz);
    const sea = this.seaCoord(x, z);
    // distant ridges rise with distance (and away from the sea)
    let inland = smoothstep(L.ridgeNear, L.ridgeNear + 2300, r);
    if (L.seaDir) inland *= smoothstep(150, 900, -sea);
    const wx = x + 220 * n.noise(x * 0.0006 + 9.1, z * 0.0006 - 3.3), wz = z + 220 * n.noise(x * 0.0006 - 4.4, z * 0.0006 + 8.8);
    const body = smoothstep(-0.35, 0.85, n.fbm(wx * 0.00065 + 5.5, wz * 0.00065 - 1.7, 5, 2.1, 0.47));
    const style = this.course.style;
    if (style === 'alpine') {
      // jagged peaks: sharp ridgelines on top of the massif, always some mountains in view
      const crest = n.ridged(wx * 0.0008 + 3.1, wz * 0.0008 - 6.2, 4);
      const mass = 0.35 + 0.65 * body;
      h += L.ridge * inland * mass * (0.3 + 0.7 * Math.pow(crest, 1.6));
    } else if (style === 'desert') {
      // mesas and buttes: flat tops on sheer sides, in bands of rock
      const raw = L.ridge * inland * body * (0.75 + 0.25 * n.ridged(wx * 0.002, wz * 0.002, 2));
      const step = 55;
      const k = raw / step;
      const fl = Math.floor(k);
      h += (fl + smoothstep(0.72, 0.9, k - fl)) * step;
    } else {
      const ridge = body * body * (0.82 + 0.18 * n.ridged(wx * 0.0024, wz * 0.0024, 2));
      h += L.ridge * inland * ridge;
    }
    if (L.seaDir) {
      if (L.cliffs) {
        // bluffs: land holds ~10-25 m above the sea, then drops steeply into it
        const top = Math.max(h, this.seaLevel + 9 + 9 * (n.noise(x * 0.004, z * 0.004) + 1));
        const t = smoothstep(-260, -40, sea);
        h = lerp(h, top, t);
        h = lerp(h, this.seaLevel - 14, smoothstep(-28, 6, sea));
      } else {
        // low dunes and a beach shelving into the sea
        h = lerp(h, this.seaLevel + 2.2 + 3 * Math.max(0, n.noise(x * 0.01, z * 0.01)), smoothstep(-500, -120, sea));
        h = lerp(h, this.seaLevel + 0.4, smoothstep(-60, -10, sea));
        h = lerp(h, this.seaLevel - 8, smoothstep(-10, 140, sea));
      }
    }
    return h;
  }

  /** Ground height anywhere: the hole inside its grid, the far landscape outside. */
  heightAt(x: number, z: number): number {
    const f = this.field;
    const d = this.distOutside(x, z);
    const edge = f.heightAt(clamp(x, f.minX, this.maxX), clamp(z, f.minZ, this.maxZ));
    if (d <= 0) return edge;
    return lerp(edge, this.farHeight(x, z), smoothstep(0, 280, d));
  }

  private forestAt(x: number, z: number, h: number, slope: number): number {
    const n = this.noise, L = this.land;
    if (L.forest <= 0) return 0;
    const d = this.distOutside(x, z);
    const patch = n.fbm(x * 0.0035 + 40, z * 0.0035 - 40, 3) + (L.forest - 0.5) * 1.1;
    let f = smoothstep(-0.05, 0.25, patch);
    f *= smoothstep(380, 620, d);
    f *= smoothstep(this.seaLevel + 2.5, this.seaLevel + 7, h);
    f *= 1 - smoothstep(0.85, 1.3, slope);
    // no trees above the treeline
    const tl = traits(this.course).snowLine;
    if (tl !== undefined) f *= 1 - smoothstep(tl - 330, tl - 230, h - this.baseLevel);
    if (L.seaDir) f *= smoothstep(-40, -160, this.seaCoord(x, z));
    return f;
  }

  /**
   * Tree positions for the impostor band just outside the hole (0-650 m), following the same
   * forest patches as the far canopy so the two blend.
   */
  impostorSpots(): { x: number; y: number; z: number; kind: string; scale: number }[] {
    const out: { x: number; y: number; z: number; kind: string; scale: number }[] = [];
    const c = this.course, L = this.land, n = this.noise;
    const kinds = c.trees.length ? c.trees : c.bushes;
    if (kinds.length === 0) return out;
    const bushes = c.trees.length === 0;
    const spacing = bushes ? 5 : 7;
    const band = bushes ? 320 : 650;
    const f = this.field;
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let z = f.minZ - band; z < this.maxZ + band; z += spacing)
      for (let x = f.minX - band; x < this.maxX + band; x += spacing) {
        const jx = x + (rnd() - 0.5) * spacing * 0.9, jz = z + (rnd() - 0.5) * spacing * 0.9;
        const d = this.distOutside(jx, jz);
        if (d <= 2 || d > band) continue;
        const patch = n.fbm(jx * 0.0035 + 40, jz * 0.0035 - 40, 3) + (L.forest - 0.5) * 1.1;
        let p = smoothstep(-0.12, 0.2, patch);
        if (c.style === 'parkland') p = Math.max(p, 0.75 * (1 - smoothstep(60, 180, d)));
        if (bushes) p = smoothstep(0.0, 0.35, n.noise(jx * 0.02 + 50, jz * 0.02 - 50)) * 0.6;
        p *= 1 - smoothstep(band * 0.7, band, d);
        if (rnd() > p) continue;
        const h = this.heightAt(jx, jz);
        if (h < this.seaLevel + 3) continue;
        if (L.seaDir && this.seaCoord(jx, jz) > -50) continue;
        const g = Math.hypot(this.heightAt(jx + 3, jz) - this.heightAt(jx - 3, jz), this.heightAt(jx, jz + 3) - this.heightAt(jx, jz - 3)) / 6;
        if (g > 0.75) continue;
        out.push({ x: jx, y: h - 0.2, z: jz, kind: kinds[Math.floor(rnd() * kinds.length)], scale: 0.8 + rnd() * 0.45 });
      }
    return out;
  }

  private buildTerrain(t: TerrainTextures): THREE.Mesh {
    const f = this.field;
    const step = 4;
    const nEdge = Math.ceil(this.perimeter / step);
    const nR = RINGS.length;
    const pos = new Float32Array(nEdge * nR * 3);
    const nrm = new Float32Array(nEdge * nR * 3);
    const forest = new Float32Array(nEdge * nR);
    const canopy = (x: number, z: number, fo: number) => fo * (13 + 5 * this.noise.noise(x * 0.03, z * 0.03));
    for (let i = 0; i < nEdge; i++) {
      const e = this.edgePoint(i * step);
      const dx = e.x - this.cx, dz = e.z - this.cz;
      const l = Math.hypot(dx, dz) || 1;
      for (let r = 0; r < nR; r++) {
        const ring = RINGS[r];
        const x = e.x + (dx / l) * ring, z = e.z + (dz / l) * ring;
        let h: number;
        if (ring <= 0) h = f.heightAt(clamp(x, f.minX, this.maxX), clamp(z, f.minZ, this.maxZ)) - (ring < 0 ? 2 : 0.04);
        else h = this.heightAt(x, z);
        // slope from the bare ground
        const eps = Math.max(2, ring * 0.02);
        const gx = (this.heightAt(x + eps, z) - this.heightAt(x - eps, z)) / (2 * eps);
        const gz = (this.heightAt(x, z + eps) - this.heightAt(x, z - eps)) / (2 * eps);
        const fo = ring > 0 ? this.forestAt(x, z, h, Math.hypot(gx, gz)) : 0;
        const k = i * nR + r;
        pos[k * 3] = x;
        pos[k * 3 + 1] = h + canopy(x, z, fo);
        pos[k * 3 + 2] = z;
        const nl = Math.hypot(gx, 1, gz);
        nrm[k * 3] = -gx / nl;
        nrm[k * 3 + 1] = 1 / nl;
        nrm[k * 3 + 2] = -gz / nl;
        forest[k] = fo;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < nEdge; i++) {
      const i2 = (i + 1) % nEdge;
      for (let r = 0; r < nR - 1; r++) {
        const a = i * nR + r, b = i2 * nR + r, c = i * nR + r + 1, d = i2 * nR + r + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aForest', new THREE.BufferAttribute(forest, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = this.makeLandMaterial(t);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'OuterLand';
    this.disposables.push(geo, mat);
    return mesh;
  }

  private makeLandMaterial(t: TerrainTextures): THREE.MeshStandardMaterial {
    const c = this.course.colors;
    const style = this.course.style;
    const T = traits(this.course);
    // autumn canopy: the average of the course's leaf colours
    const canopy = new THREE.Color(0, 0, 0);
    if (this.course.foliage?.length) {
      for (const f of this.course.foliage) canopy.add(new THREE.Color(f));
      canopy.multiplyScalar(1 / this.course.foliage.length).multiply(new THREE.Color(2.2, 1.5, 0.9));
    }
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    const uniforms = {
      tRough: { value: t.rough.tex },
      tSand: { value: t.sand.tex },
      tCliff: { value: t.cliff.tex },
      tNoise: { value: t.noise },
      aRough: { value: t.rough.avg },
      aSand: { value: t.sand.avg },
      aCliff: { value: t.cliff.avg },
      cMeadow: { value: style === 'alpine' ? new THREE.Color(c.deep).multiplyScalar(0.75) : new THREE.Color(style === 'links' || style === 'desert' ? c.deep : c.rough) },
      cDry: { value: new THREE.Color(style === 'links' || style === 'desert' ? c.fescue : style === 'coastal' ? 0xa08a52 : c.deep) },
      cSand: { value: new THREE.Color(c.sand) },
      uDry: { value: T.dry },
      cRock: { value: new THREE.Color(this.course.rock ?? 0x605850) },
      cCanopy: { value: canopy },
      uSnow: { value: T.snowLine !== undefined ? this.baseLevel + T.snowLine : 1e9 },
      uStrata: { value: style === 'desert' ? 1 : 0.25 },
      // desert: everything that rises off the valley floor is red rock
      uRedRock: { value: style === 'desert' ? this.baseLevel + 12 : 1e9 },
      // how high above the sea the beach sand reaches (a low tropical island stays green inland)
      uBeach: { value: style === 'beach' ? new THREE.Vector2(0.4, 1.4) : new THREE.Vector2(1.2, 3.2) },
      cDeep: { value: new THREE.Color(c.deep) },
      cFescue: { value: new THREE.Color(c.fescue) },
      uFescue: { value: this.course.fescue ? 1 : 0 },
      uRect: { value: new THREE.Vector4(this.field.minX, this.field.minZ, this.maxX, this.maxZ) },
      uSea: { value: this.seaLevel },
      uTime: terrainTime,
      uCloud: cloudUniforms.uCloud,
      uCloudCover: cloudUniforms.uCloudCover,
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aForest;
          varying float vForest;
          varying vec3 vWPos;
          varying vec3 vWN;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vForest = aForest;
          vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
          vWN = normalize(mat3(modelMatrix) * normal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tRough, tSand, tCliff, tNoise;
          uniform vec3 aRough, aSand, aCliff, cMeadow, cDry, cSand, cDeep, cFescue, cRock, cCanopy;
          uniform float uDry, uSea, uTime, uCloudCover, uFescue, uSnow, uStrata, uRedRock;
          uniform vec2 uBeach;
          uniform vec4 uRect;
          uniform vec2 uCloud;
          varying float vForest;
          varying vec3 vWPos;
          varying vec3 vWN;
          float gForest, gCrownLod, gSteep, gSnow;
          vec3 gCrownN;
          ${CLOUD_GLSL}
          vec2 hash22(vec2 p) {
            p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
            return fract(sin(p) * 43758.5453);
          }
          // nearest tree crown: xy = offset to its centre (cell units), z = normalised distance, w = id
          vec4 crowns(vec2 p) {
            vec2 ip = floor(p), fp = fract(p);
            float best = 9.0;
            vec4 res = vec4(0.0);
            for (int j = -1; j <= 1; j++)
              for (int i = -1; i <= 1; i++) {
                vec2 g = vec2(float(i), float(j));
                vec2 h = hash22(ip + g);
                vec2 r = g + 0.15 + h * 0.7 - fp;
                float rad = 0.5 + 0.32 * fract(h.x * 7.13 + h.y * 3.7);
                float d = length(r) / rad;
                if (d < best) { best = d; res = vec4(r / rad, d, fract(h.x * 13.1 + h.y * 5.3)); }
              }
            return res;
          }`)
        .replace('#include <map_fragment>', `
          vec2 wp = vWPos.xz;
          float macro = texture2D(tNoise, wp * 0.0019).r;
          float macro2 = texture2D(tNoise, wp * 0.0071 + 0.37).g;
          vec3 rg = texture2D(tRough, wp * 0.043).rgb / aRough;
          vec3 meadow = cMeadow * mix(vec3(1.0), rg, 0.6) * (0.75 + 0.5 * macro);
          vec3 dry = cDry * mix(vec3(1.0), rg, 0.6) * (0.8 + 0.4 * macro2);
          vec3 col = mix(meadow, dry, smoothstep(0.35, 0.75, macro2 + uDry - 0.3)) * 0.38;
          // near the hole, match its out-of-bounds turf exactly, then fade to the far palette
          {
            vec2 dd = max(max(uRect.xy - wp, vec2(0.0)), wp - uRect.zw);
            float near = 1.0 - smoothstep(0.0, 420.0, length(dd));
            float fm = texture2D(tNoise, wp * 0.0032).r;
            float fm2 = texture2D(tNoise, wp * 0.013 + 0.37).g;
            float fmi = texture2D(tNoise, wp * 0.09).b;
            vec3 rgh = mix(vec3(1.0), mix(texture2D(tRough, wp * 0.19).rgb, texture2D(tRough, wp * 0.043 + 0.2).rgb, 0.45) / aRough, 0.85);
            float clump = smoothstep(0.3, 0.7, texture2D(tNoise, wp * 0.021 + 0.61).a);
            vec3 fes = mix(cFescue, cDeep * 0.9, clump * 0.7) * mix(vec3(1.0), pow(rgh, vec3(1.6)), 0.85) * (0.72 + 0.5 * fm2) * (0.85 + 0.3 * fmi);
            vec3 dc = mix(cDeep * rgh * (0.75 + 0.45 * fm) * (0.85 + 0.3 * fmi), fes, uFescue) * 0.4;
            dc = mix(vec3(dot(dc, vec3(0.2126, 0.7152, 0.0722))), dc, 0.84);
            col = mix(col, dc, near);
          }
          // beach and wet sand at the waterline
          float beach = 1.0 - smoothstep(uSea + uBeach.x, uSea + uBeach.y, vWPos.y);
          vec3 sand = cSand * mix(vec3(1.0), texture2D(tSand, wp * 0.05).rgb / aSand, 0.5) * 0.45;
          sand *= mix(0.55, 1.0, smoothstep(uSea - 0.3, uSea + 0.9, vWPos.y));
          col = mix(col, sand, beach);
          // steep ground: triplanar rock
          vec3 Nw = normalize(vWN);
          vec3 bw = pow(abs(Nw), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
          vec3 rk = (texture2D(tCliff, vWPos.zy * 0.035).rgb * bw.x + texture2D(tCliff, wp * 0.035).rgb * bw.y + texture2D(tCliff, vWPos.xy * 0.035).rgb * bw.z) / aCliff;
          gSteep = smoothstep(0.78, 0.55, Nw.y);
          // rock strata: banded light and dark layers on the cliffs
          float strata = 1.0 + uStrata * (0.3 * sin(vWPos.y * 0.45 + macro * 6.0) * sin(vWPos.y * 0.13 + 1.7) - 0.18);
          // above the treeline: grass thins to scree and bare rock
          float alpine = smoothstep(uSnow - 330.0, uSnow - 120.0, vWPos.y + 60.0 * (macro - 0.5));
          col = mix(col, cRock * rk * 0.85 * (0.85 + 0.3 * macro2), alpine * 0.85);
          col = mix(col, cRock * rk * strata * 0.9, smoothstep(uRedRock, uRedRock + 30.0, vWPos.y + 20.0 * (macro - 0.5)));
          col = mix(col, cRock * rk * strata, gSteep);
          // snow on the high peaks: settles on gentle slopes, leaves the steep faces as rock
          float snowH = uSnow + 90.0 * (macro - 0.5) + 40.0 * (macro2 - 0.5);
          float snow = smoothstep(snowH, snowH + 80.0, vWPos.y) * smoothstep(0.38, 0.68, Nw.y + 0.2 * (macro2 - 0.5));
          col = mix(col, vec3(0.82, 0.85, 0.9) * (0.9 + 0.15 * macro2), snow);
          gSnow = max(snow, alpine * 0.0);
          // forest canopy: individual crowns, faded to an average where they would alias
          float fn = texture2D(tNoise, wp * 0.011).r - 0.5;
          gForest = smoothstep(0.3, 0.6, vForest + fn * 0.35);
          vec2 cp = wp / 6.5;
          vec4 cr = crowns(cp);
          gCrownLod = 1.0 - smoothstep(0.2, 0.55, length(fwidth(cp)));
          float inCrown = 1.0 - smoothstep(0.82, 1.05, cr.z);
          vec3 leaf = mix(vec3(0.03, 0.06, 0.022), vec3(0.055, 0.075, 0.03), cr.w) * (0.8 + 0.4 * macro2);
          leaf *= mix(vec3(1.0), cCanopy * (0.7 + 0.6 * fract(cr.w * 7.3)), step(0.001, cCanopy.r + cCanopy.g));
          vec3 canopyCol = mix(vec3(0.012, 0.018, 0.01), leaf, inCrown);
          canopyCol = mix(vec3(0.04, 0.06, 0.025) * (0.8 + 0.4 * macro2), canopyCol, gCrownLod);
          float hz = sqrt(max(0.0, 1.0 - min(cr.z * cr.z, 1.0)));
          gCrownN = normalize(vec3(-cr.x, hz * 1.1 + 0.15, -cr.y));
          col = mix(col, canopyCol, gForest * (1.0 - gSnow));
          diffuseColor.rgb = col;
          float gCloud = cloudShade(wp);
        `)
        .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n directLight.color *= gCloud;')
        .replace('#include <normal_fragment_maps>', `
          {
            float k = gForest * gCrownLod;
            if (k > 0.01) {
              vec3 nV = normalize((viewMatrix * vec4(gCrownN, 0.0)).xyz);
              normal = normalize(mix(normal, nV, k * 0.85));
            }
          }`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(mix(0.95, 0.85, gForest), 0.6, gSnow);');
    };
    mat.customProgramCacheKey = () => 'outer-land-v2';
    return mat;
  }

  /** Coarse height map (relative to sea level) around the hole for the water shader. */
  private buildWorldHeightTexture(size: number, res: number): { tex: THREE.DataTexture; rect: THREE.Vector4 } {
    const n = Math.round(size / res);
    const data = new Uint16Array(n * n);
    const x0 = this.cx - size / 2, z0 = this.cz - size / 2;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const h = this.heightAt(x0 + (i + 0.5) * res, z0 + (j + 0.5) * res) - this.seaLevel;
        data[j * n + i] = THREE.DataUtils.toHalfFloat(clamp(h, -60, 60));
      }
    const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.disposables.push(tex);
    return { tex, rect: new THREE.Vector4(x0, z0, size, size) };
  }

  private buildSea(t: TerrainTextures): THREE.Mesh {
    const wh = this.buildWorldHeightTexture(4000, 8);
    const geo = new THREE.PlaneGeometry(40000, 40000, 1, 1).rotateX(-Math.PI / 2);
    const mat = makeSeaMaterial(t, wh.tex, wh.rect, this.course.sea);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(this.cx, this.seaLevel, this.cz);
    m.receiveShadow = true;
    m.name = 'Sea';
    m.renderOrder = 1;
    this.disposables.push(geo, mat);
    return m;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
  }
}

/** Open-sea material: depth tint from the world height map, breaking surf and foam at the shore. */
export function makeSeaMaterial(t: TerrainTextures, heightTex: THREE.Texture, rect: THREE.Vector4, sea?: { shallow: number; deep: number }): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.05,
    metalness: 0,
    normalMap: t.waterN,
    normalScale: new THREE.Vector2(0.4, 0.4),
    transparent: true,
    envMapIntensity: 1.0,
    ior: 1.33,
    specularIntensity: 1,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = terrainTime;
    shader.uniforms.tWorldH = { value: heightTex };
    shader.uniforms.uRect = { value: rect };
    shader.uniforms.tNoise = { value: t.noise };
    shader.uniforms.cShallow = { value: sea ? new THREE.Color(sea.shallow).multiplyScalar(0.55) : new THREE.Color(0.05, 0.2, 0.19) };
    shader.uniforms.cDeepSea = { value: sea ? new THREE.Color(sea.deep).multiplyScalar(0.55) : new THREE.Color(0.004, 0.03, 0.05) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeaW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeaW = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform sampler2D tWorldH, tNoise;
        uniform vec4 uRect;
        uniform vec3 cShallow, cDeepSea;
        varying vec3 vSeaW;
        float gFoam;`)
      .replace('#include <map_fragment>', `
        vec2 huv = (vSeaW.xz - uRect.xy) / uRect.zw;
        float inside = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
        float depth = mix(60.0, -texture2D(tWorldH, clamp(huv, 0.0, 1.0)).r, inside);
        float dist = length(vSeaW - cameraPosition);
        vec3 shallow = cShallow;
        vec3 deep = cDeepSea;
        diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 12.0, depth));
        diffuseColor.a = mix(0.35, 0.985, smoothstep(0.0, 4.0, depth));
        // surf: bands rolling toward the shore, broken up by noise
        float fn = texture2D(tNoise, vSeaW.xz * 0.045 + vec2(uTime * 0.01, 0.0)).r;
        float fn2 = texture2D(tNoise, vSeaW.xz * 0.21 - vec2(0.0, uTime * 0.02)).g;
        float band = sin(depth * 2.4 + uTime * 1.3 + fn * 5.0) * 0.5 + 0.5;
        gFoam = smoothstep(2.6, 0.2, depth) * smoothstep(0.62, 0.95, band) * smoothstep(0.3, 0.6, fn2 + 0.15);
        gFoam += smoothstep(0.45, 0.0, depth) * smoothstep(0.25, 0.55, fn2);
        gFoam = clamp(gFoam, 0.0, 1.0) * (1.0 - smoothstep(300.0, 900.0, dist));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.78, 0.8), gFoam);
        diffuseColor.a = max(diffuseColor.a, gFoam * 0.95);
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.6, gFoam);')
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `vec2 wxz = vSeaW.xz;
         vec3 mapN = texture2D( normalMap, wxz * 0.031 + vec2(uTime * 0.011, uTime * 0.007) ).xyz * 2.0 - 1.0;
         mapN += texture2D( normalMap, wxz * 0.083 - vec2(uTime * 0.015, -uTime * 0.01) ).xyz * 2.0 - 1.0;
         mapN += (texture2D( normalMap, wxz * 0.0093 + vec2(-uTime * 0.003, uTime * 0.004) ).xyz * 2.0 - 1.0) * 1.2;
         // calmer-looking far water so the sky reflection reads at grazing angles
         float fade = 1.0 - smoothstep(200.0, 2500.0, length(vSeaW - cameraPosition));
         mapN = normalize(vec3(mapN.xy * mix(0.35, 1.0, fade), 2.0));`,
      );
  };
  mat.customProgramCacheKey = () => 'sea-v1';
  return mat;
}
