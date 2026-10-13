// Terrain rendering: heightfield mesh with a PBR turf shader driven by anti-aliased surface
// coverage (grain-dependent mowing stripes, first cut, fringe, raked bunkers, fescue, triplanar
// cliffs), water surfaces and the land beyond the hole.
import * as THREE from 'three';
import { loadTexture, makeNoiseTexture, makeWaterNormals } from '../core/assets';
import { traits, type CourseDef } from '../data/courses';
import { HoleField } from './holeGen';

export interface TerrainTextures {
  fine: { tex: THREE.Texture; avg: THREE.Color };
  rough: { tex: THREE.Texture; avg: THREE.Color };
  sand: { tex: THREE.Texture; avg: THREE.Color };
  rock: { tex: THREE.Texture; avg: THREE.Color };
  cliff: { tex: THREE.Texture; avg: THREE.Color };
  fineN: THREE.Texture;
  sandN: THREE.Texture;
  cliffN: THREE.Texture;
  noise: THREE.Texture;
  waterN: THREE.Texture;
}

let texPromise: Promise<TerrainTextures> | null = null;
export function loadTerrainTextures(): Promise<TerrainTextures> {
  if (!texPromise) {
    texPromise = Promise.all([
      loadTexture('grass005_diff_1k.jpg'),
      loadTexture('grass004_diff_1k.jpg'),
      loadTexture('aerial_sand_diff_1k.jpg'),
      loadTexture('coast_sand_rocks_02_diff_1k.jpg'),
      loadTexture('rock_face_03_diff_1k.jpg'),
      loadTexture('grass005_nor_gl_1k.jpg', false),
      loadTexture('aerial_sand_nor_gl_1k.jpg', false),
      loadTexture('rock_face_03_nor_gl_1k.jpg', false),
    ]).then(([fine, rough, sand, rock, cliff, fineN, sandN, cliffN]) => ({
      fine,
      rough,
      sand,
      rock,
      cliff,
      fineN: fineN.tex,
      sandN: sandN.tex,
      cliffN: cliffN.tex,
      noise: makeNoiseTexture(256, 11),
      waterN: makeWaterNormals(256),
    }));
  }
  return texPromise;
}

export const terrainTime = { value: 0 };
/** Drifting cloud shadows: uCloud is the drift velocity in noise-UV per second. */
export const cloudUniforms = { uCloud: { value: new THREE.Vector2(0.0004, 0.0002) }, uCloudCover: { value: 0.35 } };

/** Shared GLSL for drifting cloud shadows (needs tNoise, uTime, uCloud, uCloudCover). */
export const CLOUD_GLSL = /* glsl */ `
  float cloudShade(vec2 wp) {
    vec2 q = wp * 0.0016 + uCloud * uTime;
    float n = texture2D(tNoise, q).a * 0.65 + texture2D(tNoise, q * 2.7 + 0.31).r * 0.35;
    return 1.0 - 0.6 * smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.18, n);
  }`;

function coverTexture(data: Uint8Array, nx: number, nz: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** GPU copies of the hole's coverage grids (also read by the grass renderer). */
export interface TerrainMaps {
  coverA: THREE.DataTexture;
  coverB: THREE.DataTexture;
}

export function buildTerrainMaps(field: HoleField): TerrainMaps {
  return { coverA: coverTexture(field.cover, field.nx, field.nz), coverB: coverTexture(field.cover2, field.nx, field.nz) };
}

/** GLSL helpers to decode the coverage maps (signed distance in metres, +inside). */
export const COVER_GLSL = /* glsl */ `
  float sdf(float v) { return (v - 0.5) * 4.0; }
  float cover(float d, float soft) { float w = max(fwidth(d) * 0.7, soft); return smoothstep(-w, w, d); }`;

/** The cup: (x, z, radius). The terrain is cut away inside it so the cup liner and ball show. */
export const cupUniforms = { uCup: { value: new THREE.Vector3(0, 0, -1) } };

export function makeTerrainMaterial(field: HoleField, course: CourseDef, t: TerrainTextures, maps: TerrainMaps): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  // the normal map is sampled with world UVs in the shader; it is set here for the TBN only
  mat.normalMap = t.fineN;
  const col = (h: number) => new THREE.Color(h);
  const uniforms = {
    covA: { value: maps.coverA },
    covB: { value: maps.coverB },
    tFine: { value: t.fine.tex },
    tRough: { value: t.rough.tex },
    tSand: { value: t.sand.tex },
    tCliff: { value: t.cliff.tex },
    tSandN: { value: t.sandN },
    tCliffN: { value: t.cliffN },
    tNoise: { value: t.noise },
    aFine: { value: t.fine.avg },
    aRough: { value: t.rough.avg },
    aSand: { value: t.sand.avg },
    aCliff: { value: t.cliff.avg },
    cFairway: { value: col(course.colors.fairway) },
    cRough: { value: col(course.colors.rough) },
    cGreen: { value: col(course.colors.green) },
    cDeep: { value: col(course.colors.deep) },
    cSand: { value: col(course.colors.sand) },
    cFescue: { value: col(course.colors.fescue) },
    uFescue: { value: course.fescue ? 1 : 0 },
    uCliffRock: { value: traits(course).cliffRock },
    cRock: { value: col(course.rock ?? 0x605850) },
    // sea floor: white sand on a beach course, dark wet sand under cliffs
    cSeabed: { value: course.style === 'beach' ? col(course.colors.sand).multiplyScalar(0.42) : new THREE.Color(0.32, 0.28, 0.22) },
    uGreenDir: { value: new THREE.Vector2(Math.sin(field.green.rot), -Math.cos(field.green.rot)) },
    uGreenC: { value: new THREE.Vector2(field.green.x, field.green.z) },
    uSea: { value: field.hasOcean ? field.seaLevel : -1000 },
    uRake: { value: new THREE.Vector2(Math.cos(field.index * 1.7), Math.sin(field.index * 1.7)) },
    uTime: terrainTime,
    uCloud: cloudUniforms.uCloud,
    uCloudCover: cloudUniforms.uCloudCover,
    uCup: cupUniforms.uCup,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2 aPath;
         attribute vec2 aDir;
         varying vec2 vPath;
         varying vec2 vDir;
         varying vec2 vSplatUv;
         varying vec3 vWPos;
         varying vec3 vWNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vPath = aPath;
         vDir = aDir;
         vSplatUv = uv;
         vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
         vWNormal = normalize(mat3(modelMatrix) * normal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D covA, covB, tFine, tRough, tSand, tCliff, tSandN, tCliffN, tNoise;
         uniform vec3 aFine, aRough, aSand, aCliff;
         uniform vec3 cFairway, cRough, cGreen, cDeep, cSand, cFescue;
         uniform float uFescue, uCliffRock, uSea, uTime, uCloudCover;
         uniform vec3 cRock, cSeabed;
         uniform vec2 uGreenDir, uGreenC, uCloud, uRake;
         uniform vec3 uCup;
         ${CLOUD_GLSL}
         ${COVER_GLSL}
         varying vec2 vPath;
         varying vec2 vDir;
         varying vec2 vSplatUv;
         varying vec3 vWPos;
         varying vec3 vWNormal;
         float gSand, gGreen, gMown, gSteep, gWet, gEdge, gDeep;
         // alternating mowing lanes (+1 / -1) with anti-aliased transitions
         float lanes(float x, float w) {
           float f = fract(x / w);
           float aa = clamp(fwidth(x / w) * 1.5, 0.02, 0.25);
           float l = (smoothstep(0.0, aa, f) - smoothstep(0.5, 0.5 + aa, f)) * 2.0 - 1.0;
           return l * (1.0 - smoothstep(0.15, 0.4, fwidth(x / w)));
         }`,
      )
      .replace(
        '#include <map_fragment>',
        `
        if (distance(vWPos.xz, uCup.xy) < uCup.z) discard; // the hole
        vec4 ca = texture2D(covA, vSplatUv);
        vec4 cb = texture2D(covB, vSplatUv);
        vec2 wp = vWPos.xz;
        float n1 = texture2D(tNoise, wp * 0.21).r - 0.5;
        float n2 = texture2D(tNoise, wp * 0.93 + 0.4).g - 0.5;
        float nEdge = n1 * 0.55 + n2 * 0.22;
        float dFw = sdf(ca.r), dFr = sdf(ca.g), dGr = sdf(ca.b), dBk = sdf(ca.a);
        float dDeep = sdf(cb.r), dTee = sdf(cb.g), dWet = sdf(cb.b);
        float wFw = cover(dFw + nEdge * 0.35, 0.02);
        float wCut = cover(dFw + 1.6 + nEdge * 0.8, 0.04);
        float wDeep = cover(dDeep + nEdge * 3.0, 0.2);
        float wTee = cover(dTee + n2 * 0.1, 0.02);
        float wFr = cover(dFr + n2 * 0.12, 0.02);
        float wGr = cover(dGr + n2 * 0.06, 0.015);
        float wBk = cover(dBk + n1 * 0.18, 0.015);
        float wWet = cover(dWet * 2.0, 0.05);
        gEdge = clamp(1.0 - abs(dBk) / 0.6, 0.0, 1.0);

        float macro = texture2D(tNoise, wp * 0.0032).r;
        float macro2 = texture2D(tNoise, wp * 0.013 + 0.37).g;
        float micro = texture2D(tNoise, wp * 0.09).b;
        vec3 fineT = mix(texture2D(tFine, wp * 0.31).rgb, texture2D(tFine, wp * 0.067 + 0.5).rgb, 0.4) / aFine;
        vec3 fineS = texture2D(tFine, wp * 0.9).rgb / aFine;
        vec3 fineXS = texture2D(tFine, wp * 2.3 + 0.7).rgb / aFine;
        vec3 rghT = mix(texture2D(tRough, wp * 0.19).rgb, texture2D(tRough, wp * 0.043 + 0.2).rgb, 0.45) / aRough;
        vec3 fine = mix(vec3(1.0), fineT, 0.7);
        vec3 rgh = mix(vec3(1.0), rghT, 0.85);

        // grain-dependent mowing stripes: lanes mown away from the viewer look lighter
        vec3 V = normalize(cameraPosition - vWPos);
        float vh = length(V.xz);
        vec2 vxz = V.xz / max(vh, 1e-4);
        vec2 tdir = normalize(vDir + 1e-5);
        float grain = dot(vxz, tdir) * (0.35 + 0.65 * vh);
        float lane = lanes(vPath.y, 9.0);
        float crossL = lanes(vPath.x, 14.0);
        vec2 gp = wp - uGreenC;
        float gu = dot(gp, uGreenDir), gv = dot(gp, vec2(-uGreenDir.y, uGreenDir.x));
        float gLane = lanes(gv, 1.6);
        float gCross = lanes(gu, 1.6);
        float gGrain = dot(vxz, uGreenDir) * (0.35 + 0.65 * vh);
        float gGrain2 = dot(vxz, vec2(-uGreenDir.y, uGreenDir.x)) * (0.35 + 0.65 * vh);

        vec3 roughCol = cRough * rgh * (0.8 + 0.4 * macro) * (0.9 + 0.2 * macro2);
        // sun-dried patches and lusher hollows in the rough, and a faint hue drift on fairways
        float dry = smoothstep(0.58, 0.82, texture2D(tNoise, wp * 0.0075 + 0.21).b);
        float lush = smoothstep(0.62, 0.85, texture2D(tNoise, wp * 0.011 + 0.77).r);
        roughCol *= mix(vec3(1.0), vec3(1.16, 1.04, 0.7), dry * 0.75) * mix(vec3(1.0), vec3(0.86, 0.97, 0.9), lush * 0.6);
        float clump = smoothstep(0.3, 0.7, texture2D(tNoise, wp * 0.021 + 0.61).a);
        vec3 rghC = pow(rgh, vec3(1.6));
        vec3 fescue = mix(cFescue, cDeep * 0.9, clump * 0.7) * mix(vec3(1.0), rghC, 0.85) * (0.72 + 0.5 * macro2) * (0.85 + 0.3 * micro);
        vec3 deepCol = mix(cDeep * rgh * (0.75 + 0.45 * macro) * (0.85 + 0.3 * micro), fescue, uFescue);
        vec3 fwCol = cFairway * fine * (1.0 + 0.12 * lane * grain + 0.035 * crossL * grain) * (0.9 + 0.2 * macro) * mix(vec3(1.0), vec3(1.06, 1.02, 0.9), dry * 0.35);
        vec3 cutCol = mix(cFairway, cRough, 0.55) * mix(fine, rgh, 0.5) * (0.9 + 0.2 * macro);
        vec3 teeCol = cFairway * 1.03 * fine * (1.0 + 0.06 * lanes(vPath.x, 1.4) * grain);
        vec3 frCol = mix(cFairway, cGreen, 0.45) * mix(vec3(1.0), fineS, 0.45) * (0.97 + 0.06 * macro2);
        vec3 grCol = cGreen * vec3(0.9, 0.97, 1.08) * mix(vec3(1.0), fineS * fineXS, 0.42) * (1.0 + 0.04 * gLane * gGrain + 0.02 * gCross * gGrain2) * (0.93 + 0.14 * macro2);

        // bunker sand: two texture scales, damp and shaded near the lip
        vec3 sT = texture2D(tSand, wp * 0.71).rgb / aSand;
        vec3 sT2 = texture2D(tSand, wp * 0.13 + 0.3).rgb / aSand;
        vec3 sandCol = cSand * mix(vec3(1.0), sT, 0.4) * mix(vec3(1.0), sT2, 0.3) * (0.93 + 0.14 * macro2);
        sandCol *= 1.0 - 0.32 * smoothstep(0.8, 0.0, dBk);

        // steep ground: triplanar cliff rock, or exposed sandy soil on links dunes
        vec3 Nw = normalize(vWNormal);
        vec3 bw = pow(abs(Nw), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
        vec3 rx = texture2D(tCliff, vWPos.zy * 0.11).rgb, ry = texture2D(tCliff, wp * 0.11).rgb, rz = texture2D(tCliff, vWPos.xy * 0.11).rgb;
        vec3 cliffT = (rx * bw.x + ry * bw.y + rz * bw.z) / aCliff;
        vec3 rockCol = cRock * cliffT * (0.8 + 0.4 * macro2);
        // exposed earth / revetted turf walls: dark peaty soil with some sandy streaks
        vec3 soilCol = mix(vec3(0.07, 0.055, 0.038), cSand * 0.38 * vec3(0.95, 0.9, 0.82), 0.35 * sT.r) * (0.8 + 0.4 * micro);
        vec3 steepCol = mix(soilCol, rockCol, uCliffRock);

        // real turf albedo is dark (~0.1-0.2 linear); the palette is authored bright for readability
        vec3 col = roughCol * 0.42;
        col = mix(col, deepCol * mix(0.4, 0.33, uFescue), wDeep);
        col = mix(col, cutCol * 0.42, wCut * (1.0 - wDeep));
        col = mix(col, fwCol * 0.42, wFw);
        col = mix(col, teeCol * 0.42, wTee);
        col = mix(col, frCol * 0.41, wFr);
        col = mix(col, grCol * 0.33, wGr);
        // grass reads oversaturated through the tone mapper: pull it toward grey a little
        col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 0.84);
        col = mix(col, sandCol * 0.5, wBk);
        float steep = smoothstep(0.8, 0.58, Nw.y) * (1.0 - wGr) * (1.0 - wBk * 0.8) * (1.0 - wTee);
        col = mix(col, steepCol, steep);
        // pond and burn banks, and beach sand at sea level
        col *= 1.0 - 0.45 * wWet;
        float wet = 1.0 - smoothstep(uSea - 0.2, uSea + 1.2, vWPos.y);
        col = mix(col, cSeabed * (0.8 + 0.4 * micro) * mix(0.6, 1.0, smoothstep(uSea - 0.4, uSea + 0.8, vWPos.y)), wet * (1.0 - steep * 0.5));
        diffuseColor.rgb = col;
        gDeep = wDeep * uFescue;
        gSand = wBk; gGreen = max(wGr, wFr * 0.6); gMown = max(max(wFw, wTee), wFr); gSteep = steep; gWet = max(wWet, wet);
        float gCloud = cloudShade(wp);
        `,
      )
      .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n directLight.color *= gCloud;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // turf is a forest of blades that shadow each other, so most of the mirror-like sheen a flat
        // surface would show at grazing angles (looking into a low sun) never reaches the eye
        // (the sky reflection is hit hardest; a little sun glint stays on the greens)
        vec2 specKeep = mix(vec2(0.35, 0.2), vec2(0.5, 0.28), gMown);
        specKeep = mix(specKeep, vec2(0.65, 0.35), gGreen);
        specKeep = mix(specKeep, vec2(0.6, 0.5), gSand);
        specKeep = mix(specKeep, vec2(0.8, 0.7), gSteep);
        specKeep = mix(specKeep, vec2(1.0), gWet * 0.7);
        reflectedLight.directSpecular *= specKeep.x;
        reflectedLight.indirectSpecular *= specKeep.y;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = mix(0.95, 0.82, gMown);
         roughnessFactor = mix(roughnessFactor, 0.68, gGreen);
         roughnessFactor = mix(roughnessFactor, 0.96, gSand);
         roughnessFactor = mix(roughnessFactor, 0.88, gSteep);
         roughnessFactor = mix(roughnessFactor, 0.45, gWet * 0.7);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec2 wpn = vWPos.xz;
          vec3 nG = texture2D(normalMap, wpn * 0.31).xyz * 2.0 - 1.0;
          nG.xy *= mix(mix(0.75, 0.45, gMown), 0.3, gGreen) * (1.0 + gDeep * 0.8);
          nG.xy += (texture2D(normalMap, wpn * 0.07 + 0.3).xy * 2.0 - 1.0) * gDeep * 0.6;
          vec3 nS = texture2D(tSandN, wpn * 0.71).xyz * 2.0 - 1.0;
          nS.xy *= 0.4;
          // rake furrows, faded out where they would alias and near the lip
          float rk = dot(wpn, uRake) * 52.0 + sin(dot(wpn, vec2(-uRake.y, uRake.x)) * 0.35) * 1.2;
          float rf = (1.0 - smoothstep(0.05, 0.2, fwidth(rk) / 6.2832)) * (1.0 - gEdge);
          nS.xy += uRake * cos(rk) * 0.12 * rf;
          vec3 mapN = normalize(mix(nG, nS, gSand));
          normal = normalize(tbn * mapN);
          // triplanar cliff normals (whiteout blend) in world space, then to view space
          if (gSteep > 0.01) {
            vec3 Nw = normalize(vWNormal);
            vec3 bw = pow(abs(Nw), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
            vec3 tx = texture2D(tCliffN, vWPos.zy * 0.11).xyz * 2.0 - 1.0;
            vec3 ty = texture2D(tCliffN, wpn * 0.11).xyz * 2.0 - 1.0;
            vec3 tz = texture2D(tCliffN, vWPos.xy * 0.11).xyz * 2.0 - 1.0;
            tx = vec3(tx.xy + Nw.zy, abs(tx.z) * Nw.x);
            ty = vec3(ty.xy + Nw.xz, abs(ty.z) * Nw.y);
            tz = vec3(tz.xy + Nw.xy, abs(tz.z) * Nw.z);
            vec3 nW = normalize(tx.zyx * bw.x + ty.xzy * bw.y + tz.xyz * bw.z);
            vec3 nV = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
            normal = normalize(mix(normal, nV, gSteep));
          }
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'terrain-v8';
  return mat;
}

/**
 * Height and normal of the rendered terrain triangles at (x, z) for a mesh built with `step`
 * (they differ slightly from the smooth physics height between vertices). Used to seat the cup.
 */
export function terrainSurfaceAt(field: HoleField, step: number, x: number, z: number): { y: number; n: THREE.Vector3 } {
  const { nx, nz, minX, minZ, heights } = field;
  const mnx = Math.floor((nx - 1) / step) + 1;
  const mnz = Math.floor((nz - 1) / step) + 1;
  const cell = 0.5 * step;
  const gx = (x - minX) / cell, gz = (z - minZ) / cell;
  const i = Math.max(0, Math.min(mnx - 2, Math.floor(gx)));
  const j = Math.max(0, Math.min(mnz - 2, Math.floor(gz)));
  const fx = gx - i, fz = gz - j;
  const H = (ii: number, jj: number) => heights[jj * step * nx + ii * step];
  const ha = H(i, j), hb = H(i + 1, j), hc = H(i, j + 1), hd = H(i + 1, j + 1);
  let sx: number, sz: number, y: number;
  if ((i + j) % 2 === 0) {
    // diagonal b-c: triangles (a, c, b) and (b, c, d)
    if (fx + fz <= 1) { sx = hb - ha; sz = hc - ha; y = ha + sx * fx + sz * fz; }
    else { sx = hd - hc; sz = hd - hb; y = hd - sx * (1 - fx) - sz * (1 - fz); }
  } else {
    // diagonal a-d: triangles (a, c, d) and (a, d, b)
    if (fz >= fx) { sx = hd - hc; sz = hc - ha; }
    else { sx = hb - ha; sz = hd - hb; }
    y = ha + sx * fx + sz * fz;
  }
  const n = new THREE.Vector3(-sx / cell, 1, -sz / cell).normalize();
  return { y, n };
}

export function buildTerrainMesh(field: HoleField, course: CourseDef, t: TerrainTextures, step = 2): THREE.Group {
  const group = new THREE.Group();
  const { nx, nz, minX, minZ, heights } = field;
  const mnx = Math.floor((nx - 1) / step) + 1;
  const mnz = Math.floor((nz - 1) / step) + 1;
  const cell = 0.5 * step;
  const pos = new Float32Array(mnx * mnz * 3);
  const uv = new Float32Array(mnx * mnz * 2);
  const path = new Float32Array(mnx * mnz * 2);
  const dir = new Float32Array(mnx * mnz * 2);
  const pnx = (nx - 1) / 2 + 1; // path grid is 1 m
  for (let j = 0; j < mnz; j++) {
    for (let i = 0; i < mnx; i++) {
      const gi = i * step, gj = j * step;
      const k = j * mnx + i;
      const x = minX + gi * 0.5, z = minZ + gj * 0.5;
      pos[k * 3] = x;
      pos[k * 3 + 1] = heights[gj * nx + gi];
      pos[k * 3 + 2] = z;
      // coverage values live at grid points, i.e. texel centres
      uv[k * 2] = (gi + 0.5) / nx;
      uv[k * 2 + 1] = (gj + 0.5) / nz;
      const pi = Math.min(pnx - 1, Math.round(gi / 2)), pj = Math.round(gj / 2);
      const ps = field.pathS[pj * pnx + pi] ?? 0;
      path[k * 2] = ps;
      path[k * 2 + 1] = field.pathD[pj * pnx + pi] ?? 0;
      const tg = field.tangentAt(Math.max(0, Math.min(field.length, ps)));
      dir[k * 2] = tg.x;
      dir[k * 2 + 1] = tg.z;
    }
  }
  const idx = new Uint32Array((mnx - 1) * (mnz - 1) * 6);
  let o = 0;
  for (let j = 0; j < mnz - 1; j++)
    for (let i = 0; i < mnx - 1; i++) {
      const a = j * mnx + i, b = a + 1, c = a + mnx, d = c + 1;
      // alternate diagonals to reduce directional artifacts
      if ((i + j) % 2 === 0) {
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      } else {
        idx[o++] = a; idx[o++] = c; idx[o++] = d;
        idx[o++] = a; idx[o++] = d; idx[o++] = b;
      }
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aPath', new THREE.BufferAttribute(path, 2));
  geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  // normals from the fine height grid (smoother than face normals)
  const nrm = new Float32Array(mnx * mnz * 3);
  for (let j = 0; j < mnz; j++)
    for (let i = 0; i < mnx; i++) {
      const x = minX + i * cell, z = minZ + j * cell;
      const g = field.gradAt(x, z);
      const l = Math.hypot(g.x, 1, g.z);
      const k = (j * mnx + i) * 3;
      nrm[k] = -g.x / l;
      nrm[k + 1] = 1 / l;
      nrm[k + 2] = -g.z / l;
    }
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const maps = buildTerrainMaps(field);
  const mat = makeTerrainMaterial(field, course, t, maps);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'Terrain';
  mesh.userData.disposables = [maps.coverA, maps.coverB];
  group.add(mesh);
  group.userData.maps = maps;
  group.userData.step = step;

  // Ponds and burns (the open sea and the land beyond the hole live in OuterWorld).
  for (const w of buildWater(field, t)) group.add(w);
  return group;
}

/** Inland water (ponds, burns): depth-tinted from the hole heights, with soft shoreline ripples. */
export function makePondMaterial(t: TerrainTextures, heights: THREE.Texture, field: HoleField): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.04,
    metalness: 0,
    normalMap: t.waterN,
    normalScale: new THREE.Vector2(0.3, 0.3),
    transparent: true,
    envMapIntensity: 1.0,
    ior: 1.33,
    specularIntensity: 1,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = terrainTime;
    shader.uniforms.tH = { value: heights };
    shader.uniforms.tNoise = { value: t.noise };
    shader.uniforms.uField = { value: new THREE.Vector4(field.minX, field.minZ, field.nx, field.nz) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWw;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWw = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform sampler2D tH, tNoise;
        uniform vec4 uField;
        varying vec3 vWw;
        float gEdgeFoam;`)
      .replace('#include <map_fragment>', `
        vec2 huv = ((vWw.xz - uField.xy) / 0.5 + 0.5) / uField.zw;
        float depth = vWw.y - texture2D(tH, huv).r;
        if (depth < -0.05) discard;
        vec3 shallow = vec3(0.09, 0.12, 0.07);
        vec3 deep = vec3(0.01, 0.03, 0.025);
        diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 1.6, depth));
        diffuseColor.a = mix(0.2, 0.96, smoothstep(0.0, 0.9, depth));
        float n = texture2D(tNoise, vWw.xz * 0.35 + uTime * 0.02).g;
        gEdgeFoam = smoothstep(0.12, 0.0, depth) * smoothstep(0.4, 0.7, n) * 0.5;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.52, 0.48), gEdgeFoam);
      `)
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `vec3 mapN = texture2D( normalMap, vWw.xz * 0.06 + vec2(uTime * 0.012, uTime * 0.008) ).xyz * 2.0 - 1.0;
         mapN += texture2D( normalMap, vWw.xz * 0.15 - vec2(uTime * 0.017, -uTime * 0.011) ).xyz * 2.0 - 1.0;
         mapN = normalize(vec3(mapN.xy * 0.6, 2.0));`,
      );
  };
  mat.customProgramCacheKey = () => 'water-pond-v2';
  return mat;
}

function buildWater(field: HoleField, t: TerrainTextures): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  if (field.ponds.length === 0 && !field.crossings.some((c) => !c.ocean)) return out;
  const hdata = new Uint16Array(field.nx * field.nz);
  for (let k = 0; k < hdata.length; k++) hdata[k] = THREE.DataUtils.toHalfFloat(field.heights[k]);
  const hTex = new THREE.DataTexture(hdata, field.nx, field.nz, THREE.RedFormat, THREE.HalfFloatType);
  hTex.magFilter = hTex.minFilter = THREE.LinearFilter;
  hTex.needsUpdate = true;
  const pondMat = makePondMaterial(t, hTex, field);
  for (const p of field.ponds) {
    const r = Math.max(p.rx, p.rz) * 1.7;
    const g = new THREE.PlaneGeometry(r * 2, r * 2, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, pondMat);
    m.position.set(p.x, p.level, p.z);
    m.receiveShadow = true;
    out.push(m);
  }
  for (const cr of field.crossings) {
    if (cr.ocean) continue;
    const pt = field.pointAt(cr.s);
    const tg = field.tangentAt(cr.s);
    const g = new THREE.PlaneGeometry(260, (cr.half + 14) * 2, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, pondMat);
    m.position.set(pt.x, cr.level, pt.z);
    m.rotation.y = Math.atan2(tg.x, tg.z);
    m.receiveShadow = true;
    out.push(m);
  }
  if (out.length) out[0].userData.disposables = [hTex];
  return out;
}
