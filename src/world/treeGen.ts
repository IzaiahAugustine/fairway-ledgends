// Procedural trees and bushes: a TypeScript port of the ez-tree branching algorithm
// (MIT, (c) 2024 Daniel Greenheck) scaled to metres, with photographic leaf cards, canopy
// normals and AO, leaf translucency and instancing-aware wind sway shared with the shadow pass.
import * as THREE from 'three';

export interface TreePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
  /** Shadow-pass material with the same wind sway; assign to InstancedMesh.customDepthMaterial. */
  depthMaterial?: THREE.Material;
}
export interface TreeTemplate {
  parts: TreePart[];
  height: number;
  radius: number;
  trunkR: number;
  crownY: number;
  crownR: number;
  crownH: number;
  triangles: number;
}
export interface WindUniforms {
  uTime: { value: number };
  uWind: { value: THREE.Vector2 };
}

type Quality = 'low' | 'medium' | 'high';
type L4 = [number, number, number, number];

interface Params {
  type: 'deciduous' | 'evergreen';
  levels: number;
  angle: L4;
  children: L4;
  force: [number, number, number];
  forceStrength: number;
  gnarl: L4;
  length: L4;
  radius: L4;
  sections: L4;
  segments: L4;
  start: L4;
  taper: L4;
  twist: L4;
  /** shorten children toward the end of their parent (0 = ez-tree behaviour) */
  lenFall: L4;
  /** random +-degrees on child angle and +-fraction on child length */
  angleVar: L4;
  lenVar: L4;
  /** per-section bend toward horizontal (radians), for layered/shelved crowns */
  horiz: L4;
  /** deepest level that gets bark geometry (finer twigs are in the leaf photos) */
  barkLevel: number;
  /** length multiplier for terminal continuations, by parent level */
  terminal: L4;
  lean: [number, number];
  clusterLevel: number;
  /** size in metres; count2/start2 put extra cards near the ends of the second-finest level */
  leaves: { count: number; start: number; angle: number; size: number; sizeVar: number; double: boolean; flat: number; tip: boolean; count2: number; start2: number };
}

interface KindSpec {
  bark: 'oak' | 'pine' | 'birch';
  leaf: 'oak' | 'pine' | 'birch' | 'cypress' | 'gorse' | 'shrub';
  barkTint: number;
  /** albedo multiplier on the bark texture */
  barkGain?: number;
  twigTint: number;
  /** tint toward the top of the stem (Scots pine's orange upper bark) */
  upperTint?: number;
  leafTint: number;
  /** bark texture tile size in metres */
  barkTile: number;
  /** branches thinner than this (m) get no bark geometry */
  minTwigR: number;
  flare: number;
  /** canopy normal blend: global ellipsoid, cluster ellipsoid, up */
  nrm: [number, number, number];
  sway: [number, number, number];
  trans: number;
  base: Params;
  variants: { seed: number; height: number; p?: (p: Params) => void }[];
}

class Rng {
  private w: number;
  private z: number;
  constructor(seed: number) {
    this.w = (123456789 + seed) & 0xffffffff;
    this.z = (987654321 - seed) & 0xffffffff;
  }
  random(max = 1, min = 0) {
    this.z = (36969 * (this.z & 65535) + (this.z >> 16)) & 0xffffffff;
    this.w = (18000 * (this.w & 65535) + (this.w >> 16)) & 0xffffffff;
    const r = (((this.z << 16) + (this.w & 65535)) >>> 0) / 4294967296;
    return (max - min) * r + min;
  }
}

// ---------------------------------------------------------------- skeleton (ez-tree units)

interface Section { o: THREE.Vector3; e: THREE.Euler; r: number }
interface Branch { o: THREE.Vector3; e: THREE.Euler; length: number; radius: number; level: number; nSec: number; nSeg: number; cluster: number; stem: boolean }
interface BranchOut { level: number; secs: Section[]; nSeg: number; cluster: number; stem: boolean }
// size is a multiplier on the kind's card size (metres)
interface Leaf { o: THREE.Vector3; q: THREE.Quaternion; size: number; roll: number; cluster: number }

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

function grow(p: Params, seed: number): { branches: BranchOut[]; leaves: Leaf[] } {
  const rng = new Rng(seed);
  const branches: BranchOut[] = [];
  const leaves: Leaf[] = [];
  const qForce = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...p.force).normalize());
  const qTwist = new THREE.Quaternion();
  let clusterId = 0;

  const addLeaf = (o: THREE.Vector3, q: THREE.Quaternion, cluster: number) => {
    const L = p.leaves;
    const size = 1 + rng.random(L.sizeVar, -L.sizeVar);
    let qq = q;
    if (L.flat > 0) {
      // tilt the card toward horizontal (cypress pads)
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const target = n.y >= 0 ? UP : new THREE.Vector3(0, -1, 0);
      const qa = new THREE.Quaternion().setFromUnitVectors(n, target);
      qq = new THREE.Quaternion().slerp(qa, L.flat).multiply(q);
    }
    if (L.double) {
      leaves.push({ o: o.clone(), q: qq, size, roll: 0, cluster });
      leaves.push({ o: o.clone(), q: qq, size, roll: Math.PI / 2, cluster });
    } else {
      leaves.push({ o: o.clone(), q: qq, size, roll: rng.random(Math.PI), cluster });
    }
  };

  const along = (secs: Section[], t: number) => {
    const idx = Math.floor(t * (secs.length - 1));
    const a = secs[idx];
    const b = idx === secs.length - 1 ? a : secs[idx + 1];
    const alpha = (t - idx / (secs.length - 1)) / (1 / (secs.length - 1));
    const o = new THREE.Vector3().lerpVectors(a.o, b.o, alpha);
    const qa = new THREE.Quaternion().setFromEuler(a.e);
    const qb = new THREE.Quaternion().setFromEuler(b.e);
    return { o, q: qb.slerp(qa, alpha), r: (1 - alpha) * a.r + alpha * b.r };
  };

  const queue: Branch[] = [
    {
      o: new THREE.Vector3(),
      e: new THREE.Euler(p.lean[0], 0, p.lean[1]),
      length: p.length[0],
      radius: p.radius[0],
      level: 0,
      nSec: p.sections[0],
      nSeg: p.segments[0],
      cluster: -1,
      stem: true,
    },
  ];

  while (queue.length > 0) {
    const b = queue.shift()!;
    const cluster = b.level === p.clusterLevel ? clusterId++ : b.cluster;
    const secs: Section[] = [];
    const e = b.e.clone();
    const o = b.o.clone();
    const secLen = b.length / b.nSec;
    qTwist.setFromAxisAngle(UP, p.twist[b.level]);
    for (let i = 0; i <= b.nSec; i++) {
      let r = b.radius;
      if (i === b.nSec && b.level === p.levels) r = 0.001;
      else if (p.type === 'deciduous') r *= 1 - p.taper[b.level] * (i / b.nSec);
      else r *= 1 - i / b.nSec;
      secs.push({ o: o.clone(), e: e.clone(), r });
      o.add(new THREE.Vector3(0, secLen, 0).applyEuler(e));
      const rr = Math.max(r, 0.02);
      const g = Math.max(1, 1 / Math.sqrt(rr)) * p.gnarl[b.level];
      e.x += rng.random(g, -g);
      e.z += rng.random(g, -g);
      const q = new THREE.Quaternion().setFromEuler(e).multiply(qTwist);
      q.rotateTowards(qForce, p.forceStrength / rr);
      if (p.horiz[b.level] > 0) {
        const d = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const h = new THREE.Vector3(d.x, 0.12 * Math.hypot(d.x, d.z), d.z);
        if (h.lengthSq() > 1e-6) {
          h.normalize();
          const ang = d.angleTo(h);
          if (ang > 1e-4) q.premultiply(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(d, h), Math.min(1, p.horiz[b.level] / ang)));
        }
      }
      e.setFromQuaternion(q);
    }
    branches.push({ level: b.level, secs, nSeg: b.nSeg, cluster, stem: b.stem });

    if (p.type === 'deciduous') {
      const last = secs[secs.length - 1];
      if (b.level < p.levels) {
        queue.push({
          o: last.o,
          e: last.e,
          length: p.length[b.level + 1] * p.terminal[b.level],
          radius: last.r,
          level: b.level + 1,
          nSec: p.sections[b.level + 1],
          nSeg: b.nSeg, // keep ring resolution so the continuation joins seamlessly
          cluster,
          stem: b.stem,
        });
      } else if (p.leaves.tip) {
        addLeaf(last.o, new THREE.Quaternion().setFromEuler(last.e), cluster);
      }
    }

    const L = p.leaves;
    const nLeaves = b.level === p.levels ? L.count : b.level === p.levels - 1 ? L.count2 : 0;
    if (nLeaves > 0) {
      const radialOffset = rng.random();
      const st = b.level === p.levels ? L.start : L.start2;
      for (let i = 0; i < nLeaves; i++) {
        const a = along(secs, rng.random(1, st));
        const q1 = new THREE.Quaternion().setFromAxisAngle(X_AXIS, THREE.MathUtils.degToRad(L.angle + rng.random(12, -12)));
        const q2 = new THREE.Quaternion().setFromAxisAngle(UP, 2 * Math.PI * (radialOffset + i / nLeaves));
        addLeaf(a.o, a.q.multiply(q2.multiply(q1)), cluster);
      }
    }
    if (b.level < p.levels) {
      const level = b.level + 1;
      const count = p.children[b.level];
      const radialOffset = rng.random();
      for (let i = 0; i < count; i++) {
        const t = rng.random(1, p.start[level]);
        const a = along(secs, t);
        const ang = p.angle[level] + (p.angleVar[level] ? rng.random(p.angleVar[level], -p.angleVar[level]) : 0);
        const q1 = new THREE.Quaternion().setFromAxisAngle(X_AXIS, THREE.MathUtils.degToRad(ang));
        const q2 = new THREE.Quaternion().setFromAxisAngle(UP, 2 * Math.PI * (radialOffset + (i + rng.random(0.3, -0.3)) / count));
        const q = a.q.multiply(q2.multiply(q1));
        let len = p.length[level] * (p.type === 'evergreen' ? 1 - t : 1);
        len *= 1 - p.lenFall[level] * t;
        if (p.lenVar[level]) len *= 1 + rng.random(p.lenVar[level], -p.lenVar[level]);
        queue.push({
          o: a.o,
          e: new THREE.Euler().setFromQuaternion(q),
          length: len,
          radius: p.radius[level] * a.r,
          level,
          nSec: p.sections[level],
          nSeg: p.segments[level],
          cluster,
          stem: false,
        });
      }
    }
  }
  return { branches, leaves };
}

// ---------------------------------------------------------------- kinds

const DEFAULTS: Params = {
  type: 'deciduous',
  levels: 3,
  angle: [0, 60, 50, 40],
  children: [7, 5, 3, 0],
  force: [0, 1, 0],
  forceStrength: 0,
  gnarl: [0, 0.1, 0.1, 0.05],
  length: [40, 20, 10, 4],
  radius: [2, 0.7, 0.7, 0.8],
  sections: [12, 8, 5, 2],
  segments: [10, 6, 4, 3],
  start: [0, 0.4, 0.2, 0.1],
  taper: [0.7, 0.6, 0.6, 0.7],
  twist: [0, 0, 0, 0],
  lenFall: [0, 0, 0, 0],
  angleVar: [0, 0, 0, 0],
  lenVar: [0, 0, 0, 0],
  horiz: [0, 0, 0, 0],
  barkLevel: 3,
  terminal: [1, 1, 1, 1],
  lean: [0, 0],
  clusterLevel: 1,
  leaves: { count: 8, start: 0.15, angle: 40, size: 1, sizeVar: 0.3, double: false, flat: 0, tip: true, count2: 0, start2: 0.5 },
};

function params(over: Partial<Params> & { leaves?: Partial<Params['leaves']> }): Params {
  return { ...DEFAULTS, ...over, leaves: { ...DEFAULTS.leaves, ...(over.leaves ?? {}) } } as Params;
}

const KINDS: Record<string, KindSpec> = {
  Tree_Oak: {
    bark: 'oak',
    leaf: 'oak',
    barkTint: 0xffffff,
    barkGain: 1.45,
    twigTint: 0xb8aa98,
    leafTint: 0xffffff,
    barkTile: 1.3,
    minTwigR: 0.02,
    flare: 0.45,
    nrm: [1, 0.35, 0.35],
    sway: [0.3, 0.22, 0.05],
    trans: 1,
    base: params({
      levels: 3,
      angle: [0, 46, 45, 40],
      angleVar: [0, 10, 12, 15],
      children: [8, 5, 4, 0],
      forceStrength: -0.02,
      gnarl: [-0.03, 0.16, -0.06, 0.09],
      length: [42, 25, 15, 7],
      lenVar: [0, 0.15, 0.2, 0.25],
      radius: [2.5, 0.7, 0.6, 0.6],
      sections: [14, 8, 5, 2],
      segments: [12, 6, 4, 3],
      start: [0, 0.42, 0.1, 0.0],
      taper: [0.72, 0.45, 0.65, 0.75],
      twist: [-0.2, 0.4, 0, 0],
      terminal: [0.35, 1, 1, 1],
      barkLevel: 2,
      leaves: { count: 12, start: 0, angle: 40, size: 1.25, sizeVar: 0.3, double: false, flat: 0, tip: true, count2: 7, start2: 0.3 },
    }),
    variants: [
      { seed: 23399, height: 16 },
      { seed: 4127, height: 15, p: (p) => { p.children[0] = 9; p.angle[1] = 52; } },
      { seed: 9871, height: 17.5, p: (p) => { p.children[0] = 7; p.start[1] = 0.46; p.length[1] = 27; } },
    ],
  },
  Tree_Pine: {
    bark: 'pine',
    leaf: 'pine',
    barkTint: 0xffffff,
    barkGain: 1.2,
    twigTint: 0xd09070,
    upperTint: 0xffb080,
    leafTint: 0xd0d4d0,
    barkTile: 1.1,
    minTwigR: 0.015,
    flare: 0.3,
    nrm: [0.6, 0.7, 0.35],
    sway: [0.35, 0.2, 0.04],
    trans: 0.7,
    base: params({
      levels: 3,
      angle: [0, 78, 42, 35],
      angleVar: [0, 15, 15, 15],
      children: [10, 3, 3, 0],
      forceStrength: 0.015,
      gnarl: [0.03, 0.18, 0.2, 0.15],
      length: [64, 24, 9, 4],
      lenVar: [0, 0.35, 0.3, 0.2],
      radius: [1.6, 0.45, 0.6, 0.6],
      sections: [16, 7, 3, 2],
      segments: [10, 5, 3, 3],
      start: [0, 0.68, 0.35, 0.3],
      taper: [0.75, 0.6, 0.6, 0.7],
      terminal: [0.35, 0.6, 1, 1],
      lenFall: [0, 0.5, 0, 0],
      barkLevel: 2,
      leaves: { count: 9, start: 0.3, angle: 35, size: 1.2, sizeVar: 0.25, double: false, flat: 0, tip: true, count2: 4, start2: 0.7 },
    }),
    variants: [
      { seed: 44166, height: 16.5, p: (p) => { p.lean = [0.06, -0.04]; } },
      { seed: 13977, height: 14, p: (p) => { p.lean = [-0.1, 0.05]; p.start[1] = 0.62; } },
      { seed: 7319, height: 19, p: (p) => { p.lean = [0.03, 0.08]; p.start[1] = 0.72; p.children[0] = 11; } },
    ],
  },
  Tree_Birch: {
    bark: 'birch',
    leaf: 'birch',
    barkTint: 0xf0ece4,
    twigTint: 0x4a3a30,
    leafTint: 0xffffff,
    barkTile: 0.9,
    minTwigR: 0.012,
    flare: 0.25,
    nrm: [1, 0.3, 0.35],
    sway: [0.4, 0.28, 0.07],
    trans: 1.2,
    base: params({
      levels: 3,
      angle: [0, 40, 50, 45],
      angleVar: [0, 10, 15, 20],
      children: [14, 4, 3, 0],
      forceStrength: 0.004,
      gnarl: [0.02, 0.08, 0.15, 0.12],
      length: [62, 16, 8, 4],
      lenVar: [0, 0.2, 0.25, 0.25],
      radius: [1.1, 0.5, 0.6, 0.6],
      sections: [14, 6, 4, 2],
      segments: [9, 5, 3, 3],
      start: [0, 0.32, 0.2, 0.1],
      taper: [0.8, 0.6, 0.6, 0.7],
      lenFall: [0, 0.5, 0, 0],
      terminal: [0.7, 1, 1, 1],
      barkLevel: 2,
      leaves: { count: 10, start: 0, angle: 40, size: 0.9, sizeVar: 0.3, double: false, flat: 0, tip: true, count2: 2, start2: 0.5 },
    }),
    variants: [
      { seed: 30631, height: 13 },
      { seed: 5501, height: 11.5, p: (p) => { p.lean = [0.05, 0.04]; } },
      { seed: 18223, height: 14.5, p: (p) => { p.children[0] = 15; p.start[1] = 0.36; } },
    ],
  },
  Tree_Cypress: {
    bark: 'oak',
    leaf: 'cypress',
    barkTint: 0xe0d6cc,
    barkGain: 1.45,
    twigTint: 0x9a8a7a,
    leafTint: 0xbcc0bc,
    barkTile: 1.2,
    minTwigR: 0.02,
    flare: 0.5,
    nrm: [0.45, 0.55, 0.75],
    sway: [0.18, 0.16, 0.035],
    trans: 0.5,
    base: params({
      levels: 3,
      angle: [0, 40, 60, 35],
      angleVar: [0, 14, 20, 15],
      children: [5, 8, 4, 0],
      force: [0.35, 1, 0],
      forceStrength: -0.012,
      gnarl: [0.08, 0.12, 0.1, 0.1],
      length: [16, 20, 9, 5],
      lenVar: [0, 0.2, 0.3, 0.2],
      radius: [2.4, 0.65, 0.55, 0.6],
      sections: [8, 9, 5, 2],
      segments: [12, 7, 4, 3],
      start: [0, 0.45, 0.3, 0.2],
      taper: [0.6, 0.55, 0.6, 0.7],
      terminal: [0.75, 0.8, 1, 1],
      horiz: [0, 0.018, 0.16, 0.12],
      lean: [0.2, 0.1],
      clusterLevel: 2,
      barkLevel: 2,
      leaves: { count: 12, start: 0.1, angle: 30, size: 1.45, sizeVar: 0.3, double: false, flat: 0.8, tip: true, count2: 5, start2: 0.4 },
    }),
    variants: [
      { seed: 777, height: 11 },
      { seed: 3301, height: 9.5, p: (p) => { p.lean = [-0.25, 0.15]; p.children[0] = 4; } },
      { seed: 12001, height: 12.5, p: (p) => { p.lean = [0.1, -0.3]; p.children[0] = 6; } },
    ],
  },
  Bush_Gorse: {
    bark: 'oak',
    leaf: 'gorse',
    barkTint: 0x8a7a6a,
    twigTint: 0x6a5a4a,
    leafTint: 0xffffff,
    barkTile: 0.6,
    minTwigR: 0.02,
    flare: 0,
    nrm: [1, 0.2, 0.3],
    sway: [0.05, 0.05, 0.02],
    trans: 0.6,
    base: params({
      levels: 2,
      angle: [0, 40, 50, 0],
      angleVar: [0, 28, 20, 0],
      children: [18, 4, 0, 0],
      forceStrength: -0.015,
      gnarl: [0, 0.12, 0.15, 0],
      length: [0.1, 14, 6, 0],
      lenVar: [0, 0.3, 0.3, 0],
      radius: [0.5, 0.9, 0.7, 0],
      sections: [1, 4, 2, 0],
      segments: [4, 4, 3, 0],
      start: [0, 0, 0.3, 0],
      taper: [0.7, 0.7, 0.7, 0],
      barkLevel: 1,
      leaves: { count: 7, start: 0, angle: 50, size: 0.55, sizeVar: 0.3, double: false, flat: 0, tip: true, count2: 4, start2: 0.3 },
    }),
    variants: [
      { seed: 45590, height: 1.35 },
      { seed: 811, height: 1.1, p: (p) => { p.children[0] = 16; } },
      { seed: 6203, height: 1.6, p: (p) => { p.angle[1] = 34; } },
    ],
  },
  Bush_Green: {
    bark: 'oak',
    leaf: 'shrub',
    barkTint: 0x8a7a6a,
    twigTint: 0x6a5a4a,
    leafTint: 0xffffff,
    barkTile: 0.6,
    minTwigR: 0.02,
    flare: 0,
    nrm: [1, 0.2, 0.3],
    sway: [0.06, 0.06, 0.025],
    trans: 1,
    base: params({
      levels: 2,
      angle: [0, 36, 55, 0],
      angleVar: [0, 26, 20, 0],
      children: [15, 4, 0, 0],
      forceStrength: -0.02,
      gnarl: [0, 0.1, 0.12, 0],
      length: [0.1, 15, 7, 0],
      lenVar: [0, 0.3, 0.3, 0],
      radius: [0.5, 0.9, 0.7, 0],
      sections: [1, 4, 2, 0],
      segments: [4, 4, 3, 0],
      start: [0, 0, 0.35, 0],
      taper: [0.7, 0.7, 0.7, 0],
      barkLevel: 1,
      leaves: { count: 7, start: 0, angle: 50, size: 0.65, sizeVar: 0.3, double: false, flat: 0, tip: true, count2: 4, start2: 0.3 },
    }),
    variants: [
      { seed: 2207, height: 1.25 },
      { seed: 9154, height: 0.95, p: (p) => { p.children[0] = 12; } },
      { seed: 31343, height: 1.55, p: (p) => { p.angle[1] = 30; } },
    ],
  },
};

// ---------------------------------------------------------------- materials

const loader = new THREE.TextureLoader();
const texCache = new Map<string, Promise<THREE.Texture>>();
function tex(name: string, srgb: boolean, repeat: boolean): Promise<THREE.Texture> {
  let p = texCache.get(name);
  if (!p) {
    p = loader.loadAsync(`assets/trees/${name}`).then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.anisotropy = 8;
      return t;
    });
    texCache.set(name, p);
  }
  return p;
}

const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
attribute vec3 aWind;
`;

// aWind: x = whole-tree bend (m), y = branch sway (m), z = leaf flutter (m), per unit wind
const WIND_VERT = /* glsl */ `
{
  mat3 wm = mat3( modelMatrix );
  vec3 wo = modelMatrix[ 3 ].xyz;
  #ifdef USE_INSTANCING
  wo += wm * instanceMatrix[ 3 ].xyz;
  wm = wm * mat3( instanceMatrix );
  #endif
  // world wind expressed in template space, so instanced rotation/scale is handled
  vec3 wl = ( vec3( uWind.x, 0.0, uWind.y ) * wm ) / max( dot( wm[ 0 ], wm[ 0 ] ), 1e-6 );
  float wsl = length( wl );
  float ph = dot( wo.xz, vec2( 0.071, 0.053 ) );
  float gust = 0.62 + 0.38 * sin( uTime * 0.43 + ph ) * sin( uTime * 0.27 + ph * 1.7 + 1.3 );
  vec3 off = wl * aWind.x * ( gust + 0.14 * sin( uTime * 1.35 + ph * 2.1 ) );
  float bp = ph * 3.0 + dot( transformed, vec3( 0.23, 0.11, 0.19 ) );
  vec3 side = vec3( -wl.z, 0.0, wl.x );
  off += ( wl * ( 0.25 + 0.6 * sin( uTime * 1.9 + bp ) ) + side * 0.5 * sin( uTime * 1.43 + bp * 1.37 )
         + vec3( 0.0, 0.35 * wsl, 0.0 ) * sin( uTime * 2.3 + bp * 0.8 ) ) * aWind.y * gust;
  float fp = ph * 7.0 + dot( transformed, vec3( 3.7, 2.9, 3.3 ) );
  off += vec3( sin( uTime * 6.1 + fp ), 0.6 * sin( uTime * 7.3 + fp * 1.21 ), cos( uTime * 5.3 + fp * 0.83 ) )
         * aWind.z * wsl * ( 0.25 + gust );
  transformed += off;
  transformed.y -= dot( off.xz, off.xz ) / max( 2.0 * transformed.y, 2.0 );
}
`;

// keep alpha-tested coverage from thinning out in the smaller mips
const MIP_ALPHA = /* glsl */ `
#ifdef USE_MAP
{
  vec2 tuv = vMapUv * vec2( textureSize( map, 0 ) );
  vec2 tdx = dFdx( tuv ), tdy = dFdy( tuv );
  float lod = max( 0.0, 0.5 * log2( max( dot( tdx, tdx ), dot( tdy, tdy ) ) ) );
  diffuseColor.a *= 1.0 + lod * 0.3;
}
#endif
`;

// dissolve cards seen edge-on instead of showing smeared texture streaks
const EDGE_FADE = /* glsl */ `
{
  vec3 gn = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
  diffuseColor.a *= smoothstep( 0.1, 0.4, abs( dot( gn, normalize( vViewPosition ) ) ) );
}
`;

const LEAF_LIGHT = /* glsl */ `
uniform vec3 uTrans;
uniform float uWrap;
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float ndl = dot( geometryNormal, directLight.direction );
  float wrap = max( ( ndl + uWrap ) / ( 1.0 + uWrap ), 0.0 ) - max( ndl, 0.0 );
  float back = pow( saturate( dot( - geometryViewDir, directLight.direction ) ), 4.0 );
  float thin = 0.35 + 0.65 * saturate( - ndl );
  reflectedLight.directDiffuse += directLight.color * BRDF_Lambert( material.diffuseColor ) * ( wrap + back * thin * 1.8 ) * uTrans;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`;

// skylight transmitted through the leaves (undersides seen from below glow green)
const SKY_TRANS = /* glsl */ `
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
iblIrradiance += getIBLIrradiance( - geometryNormal ) * uTrans * 0.45;
#endif
`;

// light bounced off the sunlit grass, which a sky-only HDRI lacks (its lower half is a dim fill):
// ground irradiance from the sun * grass albedo * the fraction of ground the surface faces
const GROUND_BOUNCE = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float sunUp = saturate( dot( directionalLights[ 0 ].direction, upV ) );
  irradiance += directionalLights[ 0 ].color * sunUp * ( 0.5 - 0.5 * dot( geometryNormal, upV ) ) * uBounce;
}
#endif
`;

const AO_APPLY = /* glsl */ `
reflectedLight.indirectDiffuse *= vAO;
reflectedLight.indirectSpecular *= vAO * vAO * uSpecAO;
reflectedLight.directDiffuse *= mix( 1.0, vAO, uDirectAO );
reflectedLight.directSpecular *= vAO * uSpecAO;
`;

function windVertex(shader: THREE.WebGLProgramParametersWithUniforms, wind: WindUniforms, ao: boolean) {
  shader.uniforms.uTime = wind.uTime;
  shader.uniforms.uWind = wind.uWind;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_PARS}${ao ? 'attribute float aAO;\nvarying float vAO;\n' : ''}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERT}${ao ? 'vAO = aAO;\n' : ''}`);
}

function depthMaterial(wind: WindUniforms, key: string): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    windVertex(shader, wind, false);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `${MIP_ALPHA}#include <alphatest_fragment>`);
  };
  m.customProgramCacheKey = () => `ftree-depth-${key}-1`;
  return m;
}

function barkMaterial(kind: KindSpec, maps: THREE.Texture[], wind: WindUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: maps[0],
    normalMap: maps[1],
    roughnessMap: maps[2],
    aoMap: maps[3],
    aoMapIntensity: 0.5,
    color: new THREE.Color(kind.barkTint).multiplyScalar(kind.barkGain ?? 1),
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });
  m.onBeforeCompile = (shader) => {
    windVertex(shader, wind, true);
    shader.uniforms.uDirectAO = { value: 0.6 };
    shader.uniforms.uSpecAO = { value: 1 };
    shader.uniforms.uBounce = { value: new THREE.Vector3(0.9, 1.0, 0.65).multiplyScalar(0.2) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAO;\nuniform float uDirectAO;\nuniform float uSpecAO;\nuniform vec3 uBounce;')
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${GROUND_BOUNCE}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${AO_APPLY}`);
  };
  m.customProgramCacheKey = () => 'ftree-bark-2';
  return m;
}

function leafMaterial(kind: KindSpec, map: THREE.Texture, wind: WindUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map,
    color: kind.leafTint,
    alphaTest: 0.5,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0,
    vertexColors: true,
  });
  m.onBeforeCompile = (shader) => {
    windVertex(shader, wind, true);
    shader.uniforms.uDirectAO = { value: 0.5 };
    shader.uniforms.uSpecAO = { value: 0.35 };
    shader.uniforms.uTrans = { value: new THREE.Vector3(0.95, 1.1, 0.42).multiplyScalar(kind.trans) };
    shader.uniforms.uWrap = { value: 0.45 };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAO;\nuniform float uDirectAO;\nuniform float uSpecAO;')
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${LEAF_LIGHT}`)
      .replace('#include <alphatest_fragment>', `${EDGE_FADE}${MIP_ALPHA}#include <alphatest_fragment>`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
${SKY_TRANS}`)
      // canopy normals: never flip on back faces
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${AO_APPLY}`);
  };
  m.customProgramCacheKey = () => 'ftree-leaf-1';
  return m;
}

// ---------------------------------------------------------------- geometry (metres)

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function makeGeometry(pos: number[], nrm: number[], uv: number[], col: number[], wind: number[], ao: number[], idx: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aWind', new THREE.Float32BufferAttribute(wind, 3));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  const n = pos.length / 3;
  g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

interface BuiltTree {
  bark: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  tpl: Omit<TreeTemplate, 'parts' | 'triangles'>;
  triangles: number;
}

interface Card { o: THREE.Vector3; q: THREE.Quaternion; size: number; roll: number; cluster: number }

function buildTree(kind: KindSpec, variant: KindSpec['variants'][number], quality: Quality): BuiltTree {
  const p: Params = structuredClone(kind.base);
  variant.p?.(p);
  const { branches, leaves } = grow(p, variant.seed);
  const vrng = new Rng(variant.seed * 7 + 13);

  // scale ez-tree units to metres from the tallest branch point or card stem (cards are sized in metres)
  let top = 0;
  for (const b of branches) for (const s of b.secs) top = Math.max(top, s.o.y);
  for (const l of leaves) top = Math.max(top, l.o.y);
  const S = (variant.height - p.leaves.size * 0.6) / top;

  // fewer, slightly larger cards at lower quality (same tree shape)
  const keep = quality === 'high' ? 1 : quality === 'medium' ? 0.72 : 0.5;
  const grow2 = keep < 1 ? Math.pow(1 / keep, 0.4) : 1;
  const cards: Card[] = leaves
    .filter((_, i) => keep >= 1 || ((i * 2654435761) >>> 0) / 4294967296 < keep)
    .map((l) => ({ o: l.o.clone().multiplyScalar(S), q: l.q, size: l.size * p.leaves.size * grow2, roll: l.roll, cluster: l.cluster }));
  const cardCentre = (c: Card) => new THREE.Vector3(0, c.size / 2, 0).applyQuaternion(c.q).add(c.o);

  // card-centre grid, to find where thin bark would show through the foliage
  const cell = Math.max(0.5, p.leaves.size);
  const grid = new Map<string, THREE.Vector3[]>();
  for (const c of cards) {
    const v = cardCentre(c);
    const k = `${Math.floor(v.x / cell)},${Math.floor(v.y / cell)},${Math.floor(v.z / cell)}`;
    const list = grid.get(k);
    if (list) list.push(v);
    else grid.set(k, [v]);
  }
  const foliageAround = (pt: THREE.Vector3, r: number) => {
    let count = 0;
    const cx = Math.floor(pt.x / cell), cy = Math.floor(pt.y / cell), cz = Math.floor(pt.z / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (list) for (const v of list) if (v.distanceToSquared(pt) < r * r) count++;
        }
    return count;
  };

  // bark rings in metres; the finest drawn level stops where the foliage thins (at most half way)
  // and its end is capped with a few cards, so no bare tips poke through the crown
  interface Ring { o: THREE.Vector3; e: THREE.Euler; r: number }
  const barkBranches: { b: BranchOut; rings: Ring[]; rb: number }[] = [];
  const dir = new THREE.Vector3();
  const jitter = new THREE.Vector3();
  for (const b of branches) {
    const rb = b.secs[0].r * S;
    if (b.level > 0 && (rb < kind.minTwigR || b.level > p.barkLevel)) continue;
    let rings: Ring[] = b.secs.map((s) => ({ o: s.o.clone().multiplyScalar(S), e: s.e, r: s.r * S }));
    if (b.level > 0 && b.level === p.barkLevel && rings.length > 2) {
      const minN = Math.max(2, Math.ceil(rings.length * 0.25));
      let n = Math.max(minN, Math.ceil(rings.length * 0.5));
      for (let i = minN; i < n; i++) {
        if (foliageAround(rings[i].o, p.leaves.size * 0.9) < 6) {
          n = i;
          break;
        }
      }
      rings = rings.slice(0, n);
      const end = rings[n - 1];
      dir.set(0, 1, 0).applyEuler(end.e);
      // short rounded cap rather than an open cut or a long spear
      rings[n - 1] = { ...end, r: end.r * 0.45 };
      rings.push({ o: end.o.clone().addScaledVector(dir, end.r * 0.8), e: end.e, r: end.r * 0.05 });
      for (let k = 0; k < 3; k++) {
        const d = jitter.set(vrng.random(0.6, -0.6), vrng.random(0.6, -0.6), vrng.random(0.6, -0.6)).add(dir).normalize().clone();
        const size = p.leaves.size * grow2 * vrng.random(1.05, 0.8);
        cards.push({
          o: end.o.clone().addScaledVector(d, -size * 0.3),
          q: new THREE.Quaternion().setFromUnitVectors(UP, d),
          size,
          roll: vrng.random(Math.PI),
          cluster: b.cluster,
        });
      }
    }
    if (b.level === 0 && rings.length > 1) {
      // extra rings near the flared base and one underground
      const a = rings[0], c = rings[1];
      const mid = (t: number) => ({ o: new THREE.Vector3().lerpVectors(a.o, c.o, t), e: a.e, r: a.r + (c.r - a.r) * t });
      rings = [{ o: a.o.clone().add(new THREE.Vector3(0, -0.5, 0)), e: a.e, r: a.r }, a, mid(0.2), mid(0.5), ...rings.slice(1)];
    }
    barkBranches.push({ b, rings, rb });
  }

  // trunk centre line (trunk + leader) for branch-sway distances
  const stem: THREE.Vector3[] = [];
  for (const b of branches) if (b.stem) for (const s of b.secs) stem.push(s.o.clone().multiplyScalar(S));
  stem.sort((a, b) => a.y - b.y);
  const stemAt = (y: number, out: THREE.Vector3) => {
    if (y <= stem[0].y) return out.copy(stem[0]);
    for (let i = 1; i < stem.length; i++) {
      if (stem[i].y >= y) return out.lerpVectors(stem[i - 1], stem[i], (y - stem[i - 1].y) / Math.max(1e-6, stem[i].y - stem[i - 1].y));
    }
    return out.copy(stem[stem.length - 1]);
  };

  // leaf card corners: the crown ellipsoid drives normals, AO and wind on both parts
  const L_pos: number[] = [];
  const L_uv: number[] = [];
  const L_col: number[] = [];
  const L_idx: number[] = [];
  const L_cluster: number[] = [];
  const L_flut: number[] = [];
  const centres: THREE.Vector3[] = [];
  const corner = new THREE.Vector3();
  const roll = new THREE.Euler();
  const lc = new THREE.Color();
  for (const c of cards) {
    const w = c.size / 2;
    roll.set(0, c.roll, 0);
    const base = L_pos.length / 3;
    const quad = [[-w, c.size], [-w, 0], [w, 0], [w, c.size]];
    for (const [qx, qy] of quad) {
      corner.set(qx, qy, 0).applyEuler(roll).applyQuaternion(c.q).add(c.o);
      L_pos.push(corner.x, corner.y, corner.z);
      L_flut.push(qy / c.size);
    }
    L_uv.push(0, 1, 0, 0, 1, 0, 1, 1);
    L_idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // per-card colour variation: brightness and a slight yellow/blue drift
    const br = 0.84 + vrng.random() * 0.3;
    const hue = vrng.random(1, -1);
    lc.setRGB(br * (1 + 0.1 * hue), br * (1 + 0.03 * hue), br * (1 - 0.12 * hue));
    for (let k = 0; k < 4; k++) {
      L_col.push(lc.r, lc.g, lc.b);
      L_cluster.push(c.cluster);
    }
    centres.push(cardCentre(c));
  }

  // crown ellipsoid from card centres (padded by the mean card half-size)
  const cb = new THREE.Box3().setFromPoints(centres);
  const C = cb.getCenter(new THREE.Vector3());
  const pad = p.leaves.size * 0.35;
  const E = cb.getSize(new THREE.Vector3()).multiplyScalar(0.5).addScalar(pad);
  // per-cluster ellipsoids
  const clusters = new Map<number, THREE.Box3>();
  cards.forEach((c, i) => {
    let b = clusters.get(c.cluster);
    if (!b) clusters.set(c.cluster, (b = new THREE.Box3()));
    b.expandByPoint(centres[i]);
  });
  const clusterC = new Map<number, { c: THREE.Vector3; e: THREE.Vector3 }>();
  for (const [id, b] of clusters) clusterC.set(id, { c: b.getCenter(new THREE.Vector3()), e: b.getSize(new THREE.Vector3()).multiplyScalar(0.5).addScalar(pad) });

  const H = variant.height;
  const R = Math.max(E.x, E.z);
  const [swBend, swBranch, swFlutter] = kind.sway;
  const sc = new THREE.Vector3();
  const windAt = (x: number, y: number, z: number, out: number[], flutter: number) => {
    stemAt(y, sc);
    const d = Math.hypot(x - sc.x, z - sc.z);
    const hy = Math.max(0, y) / H;
    out.push(swBend * hy * hy, swBranch * Math.pow(smooth(0, R, d), 1.3), swFlutter * flutter);
  };
  const crownDepth = (x: number, y: number, z: number) => Math.hypot((x - C.x) / E.x, (y - C.y) / E.y, (z - C.z) / E.z);

  const L_nrm: number[] = [];
  const L_wind: number[] = [];
  const L_ao: number[] = [];
  const g = new THREE.Vector3();
  const loc = new THREE.Vector3();
  const n = new THREE.Vector3();
  const [wG, wL, wU] = kind.nrm;
  for (let i = 0; i < L_pos.length / 3; i++) {
    const x = L_pos[i * 3], y = L_pos[i * 3 + 1], z = L_pos[i * 3 + 2];
    g.set((x - C.x) / (E.x * E.x), (y - C.y) / (E.y * E.y), (z - C.z) / (E.z * E.z)).normalize();
    const cl = clusterC.get(L_cluster[i])!;
    loc.set((x - cl.c.x) / (cl.e.x * cl.e.x), (y - cl.c.y) / (cl.e.y * cl.e.y), (z - cl.c.z) / (cl.e.z * cl.e.z)).normalize();
    n.copy(g).multiplyScalar(wG).addScaledVector(loc, wL).addScaledVector(UP, wU).normalize();
    L_nrm.push(n.x, n.y, n.z);
    windAt(x, y, z, L_wind, L_flut[i]);
    const rg = crownDepth(x, y, z);
    const rl = Math.hypot((x - cl.c.x) / cl.e.x, (y - cl.c.y) / cl.e.y, (z - cl.c.z) / cl.e.z);
    const hb = Math.min(1, Math.max(0, (y - (C.y - E.y)) / (2 * E.y)));
    let ao = (0.45 + 0.55 * smooth(0.1, 1.0, rg)) * (0.65 + 0.35 * Math.pow(hb, 0.7)) * (0.8 + 0.2 * smooth(0.0, 1.0, rl));
    ao = Math.min(1, Math.max(0.2, ao));
    L_ao.push(ao);
  }

  // bark
  const B_pos: number[] = [];
  const B_nrm: number[] = [];
  const B_uv: number[] = [];
  const B_col: number[] = [];
  const B_wind: number[] = [];
  const B_ao: number[] = [];
  const B_idx: number[] = [];
  const tw = new THREE.Color(kind.twigTint);
  const upper = new THREE.Color(kind.upperTint ?? 0xffffff);
  const rootPhase = vrng.random(Math.PI * 2);
  let trunkR1 = 0;
  for (const { b, rings, rb } of barkBranches) {
    const nSeg = b.nSeg;
    const uRep = Math.max(1, Math.round((2 * Math.PI * rb) / kind.barkTile));
    let v = 0;
    const base = B_pos.length / 3;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      if (i > 0) {
        const prev = rings[i - 1];
        const ravg = Math.max(0.015, (ring.r + prev.r) / 2);
        v += ring.o.distanceTo(prev.o) / ((2 * Math.PI * ravg) / uRep);
      }
      const h = ring.o.y;
      const twig = 1 - smooth(0.015, 0.06, ring.r);
      for (let j = 0; j <= nSeg; j++) {
        const ang = (2 * Math.PI * j) / nSeg;
        dir.set(Math.cos(ang), 0, Math.sin(ang)).applyEuler(ring.e);
        let r = ring.r;
        if (b.level === 0) {
          const buttress = Math.pow(Math.max(0, Math.cos(5 * ang + rootPhase)), 2);
          r *= 1 + kind.flare * Math.exp(-Math.max(0, h) / 0.55) * (0.45 + 0.55 * buttress);
          r *= 1 + 0.035 * Math.sin(3 * ang + h * 1.7 + rootPhase) * Math.sin(h * 2.3 + ang);
        }
        const x = ring.o.x + dir.x * r, y = ring.o.y + dir.y * r, z = ring.o.z + dir.z * r;
        B_pos.push(x, y, z);
        B_nrm.push(dir.x, dir.y, dir.z);
        B_uv.push((j / nSeg) * uRep, v);
        lc.setRGB(1, 1, 1).lerp(upper, smooth(0.3, 0.75, y / variant.height)).lerp(tw, twig);
        B_col.push(lc.r, lc.g, lc.b);
        windAt(x, y, z, B_wind, 0);
        const inside = crownDepth(x, y, z);
        const ao = (0.4 + 0.6 * smooth(0.35, 1.15, inside)) * (0.55 + 0.45 * smooth(-0.3, 0.7, y));
        B_ao.push(ao);
      }
      if (b.level === 0 && trunkR1 === 0 && h >= 1.0 && i > 0) {
        const prev = rings[i - 1];
        const t = (1.0 - prev.o.y) / Math.max(1e-6, h - prev.o.y);
        trunkR1 = prev.r + (ring.r - prev.r) * Math.min(1, Math.max(0, t));
      }
    }
    const N = nSeg + 1;
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < nSeg; j++) {
        const v1 = base + i * N + j;
        const v2 = v1 + 1;
        const v3 = v1 + N;
        const v4 = v2 + N;
        B_idx.push(v1, v3, v2, v2, v3, v4);
      }
    }
  }
  if (trunkR1 === 0) trunkR1 = branches[0].secs[0].r * S;

  const bark = makeGeometry(B_pos, B_nrm, B_uv, B_col, B_wind, B_ao, B_idx);
  const leavesGeo = makeGeometry(L_pos, L_nrm, L_uv, L_col, L_wind, L_ao, L_idx);
  const box = new THREE.Box3().union(bark.boundingBox!).union(leavesGeo.boundingBox!);
  const lb = leavesGeo.boundingBox!;
  return {
    bark,
    leaves: leavesGeo,
    triangles: (B_idx.length + L_idx.length) / 3,
    tpl: {
      height: box.max.y,
      radius: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2,
      trunkR: trunkR1,
      crownY: (lb.min.y + lb.max.y) / 2,
      crownR: ((lb.max.x - lb.min.x + lb.max.z - lb.min.z) / 4) * 0.85,
      crownH: ((lb.max.y - lb.min.y) / 2) * 0.85,
    },
  };
}

// ---------------------------------------------------------------- public API

const LEAF_FILE: Record<KindSpec['leaf'], string> = {
  oak: 'oak_leaf.png',
  pine: 'pine_leaf.png',
  birch: 'birch_leaf.png',
  cypress: 'cypress_leaf.png',
  gorse: 'gorse_leaf.png',
  shrub: 'shrub_leaf.png',
};

/** Builds every tree/bush kind (3 variants each). Template origin is the trunk base at ground level. */
export async function buildTreeTemplates(wind: WindUniforms, opts?: { quality?: Quality }): Promise<Map<string, TreeTemplate[]>> {
  const quality = opts?.quality ?? 'high';
  const barkMaps = new Map<string, Promise<THREE.Texture[]>>();
  const getBark = (b: string) => {
    let p = barkMaps.get(b);
    if (!p) {
      p = Promise.all([
        tex(`bark_${b}_color.jpg`, true, true),
        tex(`bark_${b}_normal.jpg`, false, true),
        tex(`bark_${b}_roughness.jpg`, false, true),
        tex(`bark_${b}_ao.jpg`, false, true),
      ]);
      barkMaps.set(b, p);
    }
    return p;
  };
  const out = new Map<string, TreeTemplate[]>();
  await Promise.all(
    Object.entries(KINDS).map(async ([name, kind]) => {
      const [bm, lm] = await Promise.all([getBark(kind.bark), tex(LEAF_FILE[kind.leaf], true, false)]);
      const barkMat = barkMaterial(kind, bm, wind);
      const leafMat = leafMaterial(kind, lm, wind);
      const barkDepth = depthMaterial(wind, 'bark');
      const leafDepth = depthMaterial(wind, 'leaf');
      const list: TreeTemplate[] = kind.variants.map((v) => {
        const t = buildTree(kind, v, quality);
        const parts: TreePart[] = [];
        if (t.bark.index!.count > 0) parts.push({ geometry: t.bark, material: barkMat, matrix: new THREE.Matrix4(), depthMaterial: barkDepth });
        parts.push({ geometry: t.leaves, material: leafMat, matrix: new THREE.Matrix4(), depthMaterial: leafDepth });
        return { parts, triangles: t.triangles, ...t.tpl };
      });
      out.set(name, list);
    }),
  );
  return out;
}

export const TREE_KINDS = Object.keys(KINDS);
