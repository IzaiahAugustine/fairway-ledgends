// Course landmarks generated with Artlist (Tripo text-to-3D, decimated by blender/ai_optimize.py):
// a stone clubhouse by the first tee and the home green, a lighthouse on the Coral Cove coast,
// saguaro cactus across the Red Mesa desert and a covered bridge / mill on Maple Hollow's water.
// The GLBs are unit-sized; each is scaled to a real size and sat on the terrain out of play.
import * as THREE from 'three';
import { loadGLTF } from '../core/assets';
import { Rng } from '../core/rng';
import type { TreeCollider } from '../physics/ballPhysics';
import { HoleField, Surf } from './holeGen';

type Kind = 'clubhouse' | 'lighthouse' | 'saguaro' | 'bridge';

/** Real-world size of each model's longest dimension, metres. */
const SIZE: Record<Kind, number> = { clubhouse: 34, lighthouse: 26, saguaro: 9, bridge: 24 };

interface Ground {
  heightAt(x: number, z: number): number;
}

export class Landmarks {
  readonly group = new THREE.Group();
  readonly colliders: TreeCollider[] = [];
  private templates = new Map<Kind, THREE.Object3D>();

  async init() {
    const kinds: Kind[] = ['clubhouse', 'lighthouse', 'saguaro', 'bridge'];
    await Promise.all(
      kinds.map(async (k) => {
        const gltf = await loadGLTF(`models/ai/${k}.glb`);
        if (!gltf) return;
        // loadGLTF caches the scene, so normalise a copy (a second round would rescale it again)
        const root = gltf.scene.clone();
        // normalise: longest side -> SIZE[k], base on y = 0, centred on x/z
        const box = new THREE.Box3().setFromObject(root);
        const sz = box.getSize(new THREE.Vector3());
        const s = SIZE[k] / Math.max(sz.x, sz.y, sz.z);
        const c = box.getCenter(new THREE.Vector3());
        root.position.set(-c.x * s, -box.min.y * s, -c.z * s);
        root.scale.setScalar(s);
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = true;
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat.map) mat.map.anisotropy = 8;
          // Tripo's metalness map reads stone, timber and cactus as part-metal, which turns
          // them near-black away from the sky reflection: none of these are metal
          mat.metalness = 0;
          mat.metalnessMap = null;
        });
        const holder = new THREE.Group();
        holder.add(root);
        this.templates.set(k, holder);
      }),
    );
  }

  clear() {
    this.group.clear();
    this.colliders.length = 0;
  }

  /** Populate the landmarks for one hole. `ground` covers the land beyond the hole too. */
  place(field: HoleField, ground: Ground, holeCount: number, seed: number) {
    this.clear();
    const course = field.course;
    const rng = new Rng(seed);
    const last = field.index === holeCount - 1;
    if (field.index === 0 || last) this.placeClubhouse(field, ground, last);
    if (course.id === 'coral-cove' && field.hasOcean) this.placeLighthouse(field, ground);
    if (course.id === 'red-mesa') this.placeSaguaros(field, ground, rng);
    if (course.id === 'maple-hollow') this.placeBridge(field, ground);
  }

  private add(kind: Kind, x: number, z: number, rotY: number, ground: Ground, scale = 1, sink = 0.3) {
    const t = this.templates.get(kind);
    if (!t) return null;
    const o = t.clone();
    // sit on the lowest ground under the footprint so no corner floats
    const r = (SIZE[kind] * scale) / 2;
    let y = ground.heightAt(x, z);
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      y = Math.min(y, ground.heightAt(x + Math.cos(ang) * r * 0.6, z + Math.sin(ang) * r * 0.6));
    }
    o.position.set(x, y - sink, z);
    o.rotation.y = rotY;
    o.scale.setScalar(scale);
    this.group.add(o);
    return { o, y };
  }

  /** True if a footprint of radius r around (x, z) is clear of play and water. */
  private clear_(field: HoleField, ground: Ground, x: number, z: number, r: number, minD: number): boolean {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const px = x + Math.cos(ang) * r, pz = z + Math.sin(ang) * r;
      const s = field.surfAt(px, pz);
      if (s !== Surf.OB && s !== Surf.Deep && s !== Surf.Rough) return false;
      if (field.hasOcean && ground.heightAt(px, pz) < field.seaLevel + 1) return false;
    }
    const pc = field.pathCoords(x, z);
    if (field.inBounds(x, z) && Math.abs(pc.d) < minD) return false;
    if (Math.hypot(x - field.tee.x, z - field.tee.z) < minD) return false;
    if (Math.hypot(x - field.green.x, z - field.green.z) < minD + 10) return false;
    return true;
  }

  private placeClubhouse(field: HoleField, ground: Ground, home: boolean) {
    // behind the first tee, or past the home green, off to one side and facing the hole
    const t = home ? field.tangentAt(field.length - 2) : field.teeDir;
    const anchor = home ? field.green : field.tee;
    const back = home ? 1 : -1;
    for (const side of [1, -1]) {
      for (const [b, l] of [[55, 30], [70, 45], [90, 20], [45, 60], [110, 50]]) {
        const x = anchor.x + t.x * b * back - t.z * l * side;
        const z = anchor.z + t.z * b * back + t.x * l * side;
        if (!this.clear_(field, ground, x, z, 18, 32)) continue;
        // its front (+X) looks at the tee / green
        const rot = Math.atan2(-(anchor.z - z), anchor.x - x);
        const p = this.add('clubhouse', x, z, rot, ground, 1, 0.4);
        if (p) this.colliders.push({ x, z, base: p.y, trunkR: 13, crownY: p.y + 10, crownR: 0.1, crownH: 0.1 });
        return;
      }
    }
  }

  private placeLighthouse(field: HoleField, ground: Ground) {
    // look for a headland: land just above sea level with sea close by, in front of the tee
    const play = field.tangentAt(field.length * 0.5);
    const mid = field.pointAt(field.length * 0.6);
    let best: { x: number; z: number; score: number } | null = null;
    for (let a = 0; a < 48; a++) {
      const ang = (a / 48) * Math.PI * 2;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const facing = dx * play.x + dz * play.z;
      if (facing < -0.2) continue;
      let wasLand = false;
      for (let d = 60; d < 700; d += 8) {
        const x = mid.x + dx * d, z = mid.z + dz * d;
        const h = ground.heightAt(x, z);
        if (h > field.seaLevel + 1.2) { wasLand = true; continue; }
        if (!wasLand) break;
        // first sea sample after land: step back onto the shore
        const lx = x - dx * 14, lz = z - dz * 14;
        if (!this.clear_(field, ground, lx, lz, 5, 40)) break;
        const score = facing * 2 - d / 400;
        if (!best || score > best.score) best = { x: lx, z: lz, score };
        break;
      }
    }
    if (!best) return;
    const p = this.add('lighthouse', best.x, best.z, Math.atan2(best.z - mid.z, mid.x - best.x), ground, 1, 0.6);
    if (p) this.colliders.push({ x: best.x, z: best.z, base: p.y, trunkR: 3.2, crownY: p.y + 24, crownR: 0.1, crownH: 0.1 });
  }

  private placeSaguaros(field: HoleField, ground: Ground, rng: Rng) {
    const want = 26;
    let placed = 0;
    for (let tries = 0; tries < 600 && placed < want; tries++) {
      const s = rng.range(-20, field.length + 40);
      const side = rng.next() < 0.5 ? -1 : 1;
      const off = rng.range(field.fwBase + 18, field.fwBase + 140);
      const c = field.pointAt(Math.max(0, Math.min(field.length, s)));
      const t = field.tangentAt(Math.max(1, Math.min(field.length - 1, s)));
      const x = c.x - t.z * off * side, z = c.z + t.x * off * side;
      if (!this.clear_(field, ground, x, z, 2, field.fwBase + 12)) continue;
      if (this.colliders.some((k) => Math.hypot(k.x - x, k.z - z) < 14)) continue;
      const scale = rng.range(0.7, 1.15);
      const p = this.add('saguaro', x, z, rng.range(0, Math.PI * 2), ground, scale, 0.2);
      if (!p) return;
      this.colliders.push({ x, z, base: p.y, trunkR: 0.35 * scale, crownY: p.y + 8 * scale, crownR: 0.1, crownH: 0.1 });
      placed++;
    }
  }

  private placeBridge(field: HoleField, ground: Ground) {
    // a covered bridge carries the cart path over the creek; on pond holes it stands by the pond as the mill
    const cr = field.crossings[0];
    if (cr) {
      const c = field.pointAt(cr.s);
      const t = field.tangentAt(cr.s);
      for (const side of [1, -1]) {
        for (const off of [field.fwBase + 16, field.fwBase + 26, field.fwBase + 38]) {
          const x = c.x - t.z * off * side, z = c.z + t.x * off * side;
          const sAt = field.surfAt(x, z);
          if (sAt === Surf.Fairway || sAt === Surf.Green || sAt === Surf.Tee || sAt === Surf.Bunker) continue;
          // span along the hole, across the creek, resting on the banks
          const bank = Math.max(ground.heightAt(x + t.x * 12, z + t.z * 12), ground.heightAt(x - t.x * 12, z - t.z * 12));
          const o = this.add('bridge', x, z, Math.atan2(t.x, t.z), ground, 1, 0);
          if (o) o.o.position.y = bank - 2.2;
          return;
        }
      }
    }
    const pond = field.ponds[0];
    if (!pond) return;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const r = Math.max(pond.rx, pond.rz) + 14;
      const x = pond.x + Math.cos(ang) * r, z = pond.z + Math.sin(ang) * r;
      if (!this.clear_(field, ground, x, z, 10, field.fwBase + 14)) continue;
      // the mill's long side faces the water
      this.add('bridge', x, z, Math.atan2(Math.cos(ang), Math.sin(ang)) + Math.PI / 2, ground, 0.85, 0.3);
      return;
    }
  }

  dispose() {
    this.clear();
  }
}
