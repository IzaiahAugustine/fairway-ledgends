// Tournament galleries: thousands of spectators (modelled in Blender) behind the ropes down both
// sides of every hole, packed round the green and the tee, standing in a grandstand behind the
// green, and a ring of people around the ball for every shot.
//
// Performance: spectators are instanced, grouped into blocks a few dozen metres across. Each block
// has a detailed version (three poses, ~570 triangles, casting shadows) and a distant version (one
// 96-triangle figure, no shadows); only blocks near the camera use the detailed one, and blocks out
// of view are culled. The model's vertex colours are masks (R shirt, G trousers, B skin, black hair
// and shoes) and every instance carries its own colours; the shader sways them gently and makes
// them bounce when the crowd cheers.
import * as THREE from 'three';
import { loadGLTF } from '../core/assets';
import { Rng } from '../core/rng';
import { HoleField, Surf } from './holeGen';
import { terrainTime } from './terrain';

const SHIRTS = [0xf4f4f2, 0xf4f4f2, 0x1c2b4a, 0xb5121b, 0x7fb6e0, 0xe89ab8, 0xf2d24e, 0x2f7d4a, 0x222222, 0x9aa0a6, 0xe86a10, 0x6a4c9c, 0x3a6fb0, 0xd8d0b8];
const PANTS = [0xc9b48a, 0xc9b48a, 0x1c2b4a, 0x55595f, 0x222222, 0xe8e2d0, 0x6b7a8f];
const SKINS = [0xf1c6a6, 0xe0ac82, 0xc68a62, 0x9a6440, 0x6b4128, 0x4a2c1c];
const HAIRS = [0x1b1410, 0x3b2a1e, 0x6b4a2a, 0xb08850, 0x8a8a8a, 0xd8d0c0, 0x1c2b4a, 0xf2f2f2];

/** Keep in sync with blender/env_grandstand.py. */
const GRANDSTAND = { width: 16, tiers: 6, depth: 0.85, rise: 0.42 };
/** Blocks closer than this (metres, to their edge) draw the detailed spectators. */
const NEAR = 55;
const BLOCK = 36;
const MAX_FOLLOW = 90;
const ATTRS = [['aShirt', 3], ['aPants', 3], ['aSkin', 3], ['aHair', 3], ['aPhase', 1]] as const;

interface Spot {
  x: number;
  y: number;
  z: number;
  rot: number;
  pose: number;
}

interface Block {
  center: THREE.Vector3;
  radius: number;
  hi: THREE.InstancedMesh[];
  lo: THREE.InstancedMesh;
}

export class Crowd {
  readonly group = new THREE.Group();
  private hiGeo: THREE.BufferGeometry[] = [];
  private loGeo: THREE.BufferGeometry | null = null;
  private mat: THREE.MeshStandardMaterial | null = null;
  private standTpl: THREE.Object3D | null = null;
  private blocks: Block[] = [];
  private follow: THREE.InstancedMesh[] = [];
  private extras = new THREE.Group();
  private uniforms = { uTime: terrainTime, uExcite: { value: 0 } };
  private excite = 0;
  private rng = new Rng(1);
  private field: HoleField | null = null;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.group.name = 'Crowd';
    this.group.add(this.extras);
  }

  async init() {
    const gltf = await loadGLTF('models/environment.glb');
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    const u = this.uniforms;
    mat.onBeforeCompile = (s) => {
      s.uniforms.uTime = u.uTime;
      s.uniforms.uExcite = u.uExcite;
      s.vertexShader = s.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime, uExcite;
          attribute vec3 aShirt, aPants, aSkin, aHair;
          attribute float aPhase;
          varying vec3 vShirt, vPants, vSkin, vHair;
          varying float vCrowdH;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vShirt = aShirt; vPants = aPants; vSkin = aSkin; vHair = aHair;
          float hgt = clamp(position.y / 1.75, 0.0, 1.0);
          // idle: weight shifting side to side; cheering: a little bounce on the toes
          transformed.x += sin(uTime * (0.6 + 0.3 * fract(aPhase)) + aPhase * 6.3) * 0.025 * hgt;
          transformed.y += uExcite * abs(sin(uTime * 7.0 + aPhase * 9.0)) * 0.07;
          vCrowdH = hgt;`,
        );
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vShirt, vPants, vSkin, vHair;\nvarying float vCrowdH;')
        .replace(
          '#include <color_fragment>',
          `diffuseColor.rgb = vShirt * vColor.r + vPants * vColor.g + vSkin * vColor.b + vHair * max(0.0, 1.0 - vColor.r - vColor.g - vColor.b);
          // people packed together shade each other low down: darker legs, lit shoulders and heads
          diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.0, 0.75, vCrowdH));`,
        );
    };
    mat.customProgramCacheKey = () => 'crowd-v3';
    this.mat = mat;
    for (const pose of ['A', 'B', 'C']) {
      const src = gltf?.scene.getObjectByName(`Spectator_${pose}`) as THREE.Mesh | undefined;
      if (src?.isMesh) this.hiGeo.push(src.geometry);
    }
    const lo = gltf?.scene.getObjectByName('Spectator_Lo') as THREE.Mesh | undefined;
    this.loGeo = lo?.isMesh ? lo.geometry : this.hiGeo[0] ?? null;
    this.standTpl = gltf?.scene.getObjectByName('Grandstand') ?? null;
    this.standTpl?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
    });
    // the gallery that follows the ball: detailed, one mesh per pose
    for (const g of this.hiGeo) {
      const m = this.makeMesh(g, MAX_FOLLOW);
      m.count = 0;
      m.castShadow = true;
      this.follow.push(m);
      this.group.add(m);
    }
  }

  /** An instanced mesh of `geo` with room for `n` spectators and their per-instance colours. */
  private makeMesh(geo: THREE.BufferGeometry, n: number): THREE.InstancedMesh {
    const g = geo.clone();
    for (const [name, size] of ATTRS) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * size), size));
    const m = new THREE.InstancedMesh(g, this.mat!, Math.max(1, n));
    m.receiveShadow = true;
    return m;
  }

  /** Write spectator `i` of mesh `m`: placement, size and a random outfit. */
  private writeSpot(m: THREE.InstancedMesh, i: number, s: Spot, rng: Rng) {
    const h = rng.range(0.9, 1.08);
    this.tmpQ.setFromAxisAngle(this.up, s.rot);
    this.tmpS.set(h * rng.range(0.95, 1.12), h, h);
    m.setMatrixAt(i, this.tmpM.compose(this.tmpP.set(s.x, s.y, s.z), this.tmpQ, this.tmpS));
    const set = (name: string, hex: number) => {
      this.tmpC.setHex(hex).convertSRGBToLinear();
      (m.geometry.getAttribute(name) as THREE.InstancedBufferAttribute).setXYZ(i, this.tmpC.r, this.tmpC.g, this.tmpC.b);
    };
    set('aShirt', rng.pick(SHIRTS));
    set('aPants', rng.pick(PANTS));
    set('aSkin', rng.pick(SKINS));
    set('aHair', rng.pick(HAIRS));
    (m.geometry.getAttribute('aPhase') as THREE.InstancedBufferAttribute).setX(i, rng.next() * 10);
  }

  private finish(m: THREE.InstancedMesh, count: number) {
    m.count = count;
    m.instanceMatrix.needsUpdate = true;
    for (const [a] of ATTRS) (m.geometry.getAttribute(a) as THREE.InstancedBufferAttribute).needsUpdate = true;
    m.computeBoundingSphere();
  }

  /** Can a spectator stand here? Off the short grass, out of hazards, not on a cliff. */
  private ok(field: HoleField, x: number, z: number, allowFairway = false) {
    const s = field.surfAt(x, z);
    if (s === Surf.Water || s === Surf.Bunker || s === Surf.Green || s === Surf.Fringe || s === Surf.OB || s === Surf.Tee) return false;
    if (!allowFairway && s === Surf.Fairway) return false;
    const g = field.gradAt(x, z);
    if (Math.hypot(g.x, g.z) > 0.32) return false;
    if (field.hasOcean && field.heightAt(x, z) < field.seaLevel + 1.5) return false;
    return !field.nearWater(x, z, 2.5);
  }

  private clear() {
    for (const b of this.blocks) {
      for (const m of [...b.hi, b.lo]) {
        m.geometry.dispose();
        m.removeFromParent();
      }
    }
    this.blocks = [];
    for (const o of [...this.extras.children]) {
      o.removeFromParent();
      if (o.userData.ownGeo) (o as THREE.Mesh).geometry?.dispose();
    }
  }

  /** Fill the galleries for a hole. */
  place(field: HoleField, seed: number) {
    this.clear();
    if (!this.mat || !this.loGeo || !this.hiGeo.length) return;
    const rng = new Rng(seed);
    this.rng = new Rng(seed ^ 0x9e3779b9);
    this.field = field;
    const spots: Spot[] = [];
    const add = (x: number, z: number, faceX: number, faceZ: number, jitter = 0.35) =>
      spots.push({ x, z, y: field.heightAt(x, z), rot: Math.atan2(faceX, faceZ) + rng.range(-jitter, jitter), pose: rng.int(0, this.hiGeo.length - 1) });
    const ropePts: number[] = [];
    const stakes: THREE.Vector3[] = [];
    const rope = (a: THREE.Vector3 | null, b: THREE.Vector3 | null, stake: boolean) => {
      if (a && b && a.distanceTo(b) < 9) ropePts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (stake && b) stakes.push(b);
    };
    const ropeAt = (x: number, z: number) => (this.ok(field, x, z, true) && field.surfAt(x, z) !== Surf.Fairway ? new THREE.Vector3(x, field.heightAt(x, z) + 0.72, z) : null);

    // --- green: a grandstand behind it and a packed horseshoe round the rest, leaving the approach open
    const g = field.green, cup = field.cup;
    const app = field.pointAt(Math.max(0, field.length - 40));
    const appAng = Math.atan2(g.z - app.z, g.x - app.x);
    const R0 = Math.max(g.rx, g.rz) + 10;
    let standAng: number | null = null;
    for (const da of [0, 0.35, -0.35, 0.7, -0.7]) {
      const a = appAng + da;
      if (this.placeStand(field, g.x + Math.cos(a) * (R0 + 4), g.z + Math.sin(a) * (R0 + 4), cup, spots, rng)) {
        standAng = a;
        break;
      }
    }
    const standHalf = standAng === null ? 0 : (GRANDSTAND.width / 2 + 1) / (R0 + 4);
    let prevRope: THREE.Vector3 | null = null;
    for (let deg = -150; deg <= 150; deg += 1) {
      const ang = appAng + (deg * Math.PI) / 180;
      const cx = Math.cos(ang), cz = Math.sin(ang);
      const here = ropeAt(g.x + cx * (R0 - 1.2), g.z + cz * (R0 - 1.2));
      rope(prevRope, here, deg % 4 === 0);
      prevRope = here;
      if (standAng !== null && Math.abs(Math.atan2(Math.sin(ang - standAng), Math.cos(ang - standAng))) < standHalf) continue;
      for (let row = 0; row < 4; row++) {
        const r = R0 + row * 0.85;
        // about one spectator every 0.7 m along each row, with natural gaps
        if (rng.next() > (0.95 - row * 0.12) * ((r * Math.PI) / 180 / 0.7)) continue;
        const x = g.x + cx * r + rng.range(-0.25, 0.25), z = g.z + cz * r + rng.range(-0.25, 0.25);
        if (this.ok(field, x, z)) add(x, z, cup.x - x, cup.z - z);
      }
    }

    // --- both sides of the hole: a rope line just off the fairway with two to four rows behind it
    const t = field.tee;
    const greenZone = R0 + 6;
    const edgeAt = (s: number, side: number) => {
      const c = field.pointAt(s), tg = field.tangentAt(s);
      const nx = -tg.z * side, nz = tg.x * side;
      for (let d = 2; d < 80; d += 1.5) {
        const sf = field.surfAt(c.x + nx * d, c.z + nz * d);
        if (sf !== Surf.Fairway && sf !== Surf.Tee && sf !== Surf.Bunker) return { c, tg, nx, nz, d };
      }
      return null;
    };
    for (const side of [-1, 1]) {
      let prev: THREE.Vector3 | null = null;
      let k = 0;
      for (let s = 25; s < field.length; s += 0.9, k++) {
        const e = edgeAt(s, side);
        if (!e) { prev = null; continue; }
        const rd = e.d + 5;
        const rx = e.c.x + e.nx * rd, rz = e.c.z + e.nz * rd;
        if (Math.hypot(rx - g.x, rz - g.z) < greenZone || Math.hypot(rx - t.x, rz - t.z) < 14) { prev = null; continue; }
        if (k % 4 === 0) {
          const here = ropeAt(rx, rz);
          rope(prev, here, true);
          prev = here;
        }
        // thick in places, thin in others, like a real gallery
        const dens = 0.45 + 0.5 * (Math.sin(s * 0.045 + seed) * 0.5 + 0.5);
        const rows = 2 + Math.floor(dens * 2.2);
        for (let row = 0; row < rows; row++) {
          if (rng.next() > dens - row * 0.08) continue;
          const out = rd + 1 + row * 0.85 + rng.range(-0.2, 0.2);
          const x = e.c.x + e.nx * out + e.tg.x * rng.range(-0.3, 0.3), z = e.c.z + e.nz * out + e.tg.z * rng.range(-0.3, 0.3);
          if (this.ok(field, x, z)) add(x, z, -e.nx + e.tg.x * 0.25, -e.nz + e.tg.z * 0.25, 0.5);
        }
      }
    }

    // --- tee: a gallery in a horseshoe behind the box
    const d = field.teeDir;
    const teeAng = Math.atan2(-d.z, -d.x);
    for (let deg = -110; deg <= 110; deg += 2) {
      const ang = teeAng + (deg * Math.PI) / 180;
      for (let row = 0; row < 4; row++) {
        const r = 9 + row * 0.85;
        if (rng.next() > 0.75 - row * 0.1) continue;
        const x = t.x + Math.cos(ang) * r, z = t.z + Math.sin(ang) * r;
        if (this.ok(field, x, z)) add(x, z, t.x - x, t.z - z);
      }
    }

    this.buildBlocks(spots, rng);
    // ropes and stakes
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(ropePts, 3));
    const ropes = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xf2e6b8 }));
    ropes.userData.ownGeo = true;
    this.extras.add(ropes);
    if (stakes.length) {
      const sg = new THREE.CylinderGeometry(0.02, 0.025, 0.8, 6).translate(0, -0.32, 0);
      const st = new THREE.InstancedMesh(sg, new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6 }), stakes.length);
      stakes.forEach((p, i) => st.setMatrixAt(i, this.tmpM.makeTranslation(p.x, p.y, p.z)));
      st.computeBoundingSphere();
      st.userData.ownGeo = true;
      this.extras.add(st);
    }
    for (const m of this.follow) m.count = 0;
  }

  /** A grandstand facing the green from (x, z), with spectators on its tiers. False if it won't fit. */
  private placeStand(field: HoleField, x: number, z: number, cup: { x: number; z: number }, spots: Spot[], rng: Rng): boolean {
    if (!this.standTpl) return false;
    const fx = cup.x - x, fz = cup.z - z;
    const fl = Math.hypot(fx, fz) || 1;
    const dx = fx / fl, dz = fz / fl; // the front of the stand faces the green
    const rx = -dz, rz = dx; // along the front
    const depth = GRANDSTAND.tiers * GRANDSTAND.depth;
    let minY = Infinity, maxY = -Infinity;
    for (const a of [-0.5, 0, 0.5]) {
      for (const b of [0, 0.5, 1]) {
        const px = x + rx * a * GRANDSTAND.width - dx * b * depth, pz = z + rz * a * GRANDSTAND.width - dz * b * depth;
        if (!this.ok(field, px, pz, true) || field.surfAt(px, pz) === Surf.Fairway) return false;
        const h = field.heightAt(px, pz);
        minY = Math.min(minY, h);
        maxY = Math.max(maxY, h);
      }
    }
    if (maxY - minY > 1.6) return false;
    const stand = this.standTpl.clone();
    const rot = Math.atan2(dx, dz);
    stand.position.set(x, minY, z);
    stand.rotation.y = rot;
    this.extras.add(stand);
    // spectators along every tier (the model's front faces +Z locally; the tiers step back along -Z)
    const { width, tiers, depth: td, rise } = GRANDSTAND;
    for (let i = 0; i < tiers; i++) {
      for (let lx = -width / 2 + 0.5; lx <= width / 2 - 0.4; lx += 0.62) {
        if (rng.next() < 0.1) continue;
        const lz = -(i * td + 0.62), ly = (i + 1) * rise;
        const wx = x + rx * lx + dx * lz, wz = z + rz * lx + dz * lz;
        spots.push({ x: wx + rng.range(-0.06, 0.06), z: wz, y: minY + ly, rot: rot + rng.range(-0.25, 0.25), pose: rng.int(0, this.hiGeo.length - 1) });
      }
    }
    return true;
  }

  /** Bucket spectators into blocks; each block gets a detailed mesh per pose and one distant mesh. */
  private buildBlocks(spots: Spot[], rng: Rng) {
    const cells = new Map<string, Spot[]>();
    for (const s of spots) {
      const key = `${Math.floor(s.x / BLOCK)},${Math.floor(s.z / BLOCK)}`;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(s);
    }
    for (const list of cells.values()) {
      const center = new THREE.Vector3();
      for (const s of list) center.add(this.tmpP.set(s.x, s.y, s.z));
      center.divideScalar(list.length);
      let radius = 0;
      for (const s of list) radius = Math.max(radius, Math.hypot(s.x - center.x, s.z - center.z));
      const byPose = this.hiGeo.map((_, p) => list.filter((s) => s.pose === p));
      const hi = this.hiGeo.map((geo, p) => {
        const m = this.makeMesh(geo, byPose[p].length);
        byPose[p].forEach((s, i) => this.writeSpot(m, i, s, rng));
        this.finish(m, byPose[p].length);
        m.castShadow = true;
        this.group.add(m);
        return m;
      });
      // the distant figures copy the detailed ones' placement and outfits
      const lo = this.makeMesh(this.loGeo!, list.length);
      let i = 0;
      byPose.forEach((group, p) => {
        const hm = hi[p];
        group.forEach((_, j) => {
          hm.getMatrixAt(j, this.tmpM);
          lo.setMatrixAt(i, this.tmpM);
          for (const [a, size] of ATTRS) {
            const src = hm.geometry.getAttribute(a) as THREE.InstancedBufferAttribute;
            const dst = lo.geometry.getAttribute(a) as THREE.InstancedBufferAttribute;
            for (let c = 0; c < size; c++) dst.array[i * size + c] = src.array[j * size + c];
          }
          i++;
        });
      });
      this.finish(lo, list.length);
      lo.castShadow = false;
      this.group.add(lo);
      this.blocks.push({ center, radius, hi, lo });
    }
  }

  /**
   * The gallery around the ball for this shot, the way marshals hold the crowd back on tour: a ring
   * behind and beside the ball (never in front of it), off the fairway, facing the golfer.
   */
  gatherAt(ball: { x: number; z: number }, aimX: number, aimZ: number) {
    const field = this.field;
    if (!field || !this.follow.length) return;
    const rng = this.rng;
    const aimAng = Math.atan2(aimZ, aimX);
    const used = this.follow.map(() => 0);
    const spot: Spot = { x: 0, y: 0, z: 0, rot: 0, pose: 0 };
    let total = 0;
    for (let tries = 0; tries < 600 && total < MAX_FOLLOW; tries++) {
      // off to either side of the ball (clear of the camera behind it and of the line ahead),
      // from about 10 m out, further when the fairway is wide
      const side = rng.next() < 0.5 ? 1 : -1;
      const a = aimAng + side * Math.PI * (0.32 + rng.next() * 0.5);
      const r = 10 + rng.next() * 6 + tries * 0.04;
      const x = ball.x + Math.cos(a) * r, z = ball.z + Math.sin(a) * r;
      if (!this.ok(field, x, z)) continue;
      const p = rng.int(0, this.follow.length - 1);
      spot.x = x;
      spot.z = z;
      spot.y = field.heightAt(x, z);
      spot.rot = Math.atan2(ball.x - x, ball.z - z) + rng.range(-0.3, 0.3);
      this.writeSpot(this.follow[p], used[p]++, spot, rng);
      total++;
    }
    this.follow.forEach((m, k) => this.finish(m, used[k]));
  }

  /** The gallery reacts: bounce for a while, scaled by how loud the cheer is. */
  cheer(intensity: number) {
    this.excite = Math.max(this.excite, Math.min(1.2, intensity));
  }

  update(dt: number, camera?: THREE.Camera) {
    this.excite = Math.max(0, this.excite - dt * 0.45);
    this.uniforms.uExcite.value = this.excite;
    if (!camera) return;
    const cp = camera.position;
    for (const b of this.blocks) {
      const near = Math.hypot(cp.x - b.center.x, cp.z - b.center.z) - b.radius < NEAR;
      for (const m of b.hi) m.visible = near;
      b.lo.visible = !near;
    }
  }

  /** Spectators placed for this hole, including the ones round the ball. */
  get size() {
    return this.blocks.reduce((s, b) => s + b.lo.count, 0) + this.follow.reduce((s, m) => s + m.count, 0);
  }

  dispose() {
    this.clear();
    for (const m of this.follow) m.geometry.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
