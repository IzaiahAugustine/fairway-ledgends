// Divots: the scar a full iron/wedge strike tears out of the turf, and the strip of turf it throws.
// Both meshes are modelled in Blender (blender/env_divot.py → environment.glb "Divot" and
// "DivotChunk"); the grass shader reads `divotUniforms` and removes the blades inside each scar.
import * as THREE from 'three';
import { loadGLTF } from '../core/assets';
import type { HoleField } from './holeGen';

/** Most scars kept per hole; the oldest is recycled after that. Must match the grass shader. */
export const MAX_DIVOTS = 48;
/** Scar footprint in model space at scale 1 (forward from the ball): matches blender/env_divot.py. */
const DIVOT_CENTER = 0.15;
const DIVOT_HALF_L = 0.18;
const DIVOT_HALF_W = 0.065;

/** Per scar: (x, z, forward.x * scale, forward.z * scale). */
export const divotUniforms = {
  uDivots: { value: Array.from({ length: MAX_DIVOTS }, () => new THREE.Vector4()) },
  uDivotCount: { value: 0 },
  uDivotShape: { value: new THREE.Vector3(DIVOT_CENTER, DIVOT_HALF_L, DIVOT_HALF_W) },
};

/** GLSL: 1.0 when world point `p` (xz) lies inside any divot scar. */
export const DIVOT_GLSL = `
  uniform vec4 uDivots[${MAX_DIVOTS}];
  uniform int uDivotCount;
  uniform vec3 uDivotShape;
  float inDivot(vec2 p) {
    float hit = 0.0;
    for (int i = 0; i < ${MAX_DIVOTS}; i++) {
      if (i >= uDivotCount) break;
      vec4 d = uDivots[i];
      float s = length(d.zw);
      vec2 f = d.zw / s;
      vec2 r = p - d.xy;
      float along = dot(r, f) / s - uDivotShape.x;
      float side = (r.x * f.y - r.y * f.x) / s;
      hit = max(hit, step(abs(along), uDivotShape.y) * step(abs(side), uDivotShape.z));
    }
    return hit;
  }`;

interface Chunk {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  flip: boolean;
  yaw: number;
  resting: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const GRAVITY = 9.8;

export class Divots {
  readonly group = new THREE.Group();
  private scarTemplate: THREE.Object3D | null = null;
  private chunkTemplate: THREE.Object3D | null = null;
  private scars: THREE.Object3D[] = [];
  private chunks: Chunk[] = [];
  private field: HoleField | null = null;
  /** Pitch marks on the greens: a small dented ring where an approach landed. */
  private marks: THREE.Mesh[] = [];
  private markGeo = new THREE.RingGeometry(0.004, 0.022, 20).rotateX(-Math.PI / 2);
  private markMat = new THREE.MeshStandardMaterial({ color: 0x24341a, roughness: 1, transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  constructor(scene: THREE.Scene) {
    this.group.name = 'Divots';
    scene.add(this.group);
  }

  async init() {
    const gltf = await loadGLTF('models/environment.glb');
    this.scarTemplate = gltf?.scene.getObjectByName('Divot') ?? null;
    this.chunkTemplate = gltf?.scene.getObjectByName('DivotChunk') ?? null;
    // the scar lies on the ground: pull it toward the camera in depth so it never z-fights the turf
    this.scarTemplate?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = (m.material as THREE.Material).clone();
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -2;
      mat.polygonOffsetUnits = -2;
      m.material = mat;
      m.receiveShadow = true;
    });
    this.chunkTemplate?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
    });
  }

  /** New hole: drop every scar and chunk. */
  reset(field: HoleField) {
    this.field = field;
    this.group.clear();
    this.scars = [];
    this.chunks = [];
    this.marks = [];
    divotUniforms.uDivotCount.value = 0;
  }

  addPitchMark(x: number, z: number) {
    const field = this.field;
    if (!field) return;
    if (this.marks.length >= 40) this.marks.shift()?.removeFromParent();
    const m = new THREE.Mesh(this.markGeo, this.markMat);
    const g = field.gradAt(x, z);
    m.quaternion.setFromUnitVectors(UP, new THREE.Vector3(-g.x, 1, -g.z).normalize());
    m.position.set(x, field.heightAt(x, z) + 0.002, z);
    m.scale.set(1, 1, 1.3);
    m.receiveShadow = true;
    this.group.add(m);
    this.marks.push(m);
  }

  /**
   * Tear a divot starting at the ball and running along the shot direction (dirX, dirZ).
   * `scale` sizes the scar (1 = a full 7-iron); `throwChunk` launches the cut turf forward.
   */
  add(x: number, z: number, dirX: number, dirZ: number, scale: number, throwChunk: boolean) {
    const field = this.field;
    if (!field || !this.scarTemplate) return;
    const l = Math.hypot(dirX, dirZ) || 1;
    const fx = dirX / l, fz = dirZ / l;
    const yaw = Math.atan2(-fx, -fz); // model forward is -Z
    if (this.scars.length >= MAX_DIVOTS) this.scars.shift()?.removeFromParent();
    const scar = this.scarTemplate.clone();
    scar.scale.setScalar(scale);
    this.orientOnGround(scar, x, z, yaw, false);
    this.group.add(scar);
    this.scars.push(scar);
    this.syncUniforms();

    if (throwChunk && this.chunkTemplate) {
      const obj = this.chunkTemplate.clone();
      obj.scale.setScalar(scale);
      const sx = x + fx * 0.2 * scale, sz = z + fz * 0.2 * scale;
      obj.position.set(sx, field.heightAt(sx, sz) + 0.03, sz);
      obj.rotation.set(0, yaw, 0);
      const speed = 2.4 + Math.random() * 1.8;
      const sideways = (Math.random() - 0.5) * 1.2;
      const vel = new THREE.Vector3(fx * speed - fz * sideways, 2.2 + Math.random() * 1.2, fz * speed + fx * sideways);
      const spin = new THREE.Vector3((Math.random() - 0.3) * 14, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8);
      this.group.add(obj);
      this.chunks.push({ obj, vel, spin, flip: Math.random() < 0.45, yaw: yaw + (Math.random() - 0.5) * 1.6, resting: false });
    }
  }

  update(dt: number) {
    const field = this.field;
    if (!field) return;
    for (const c of this.chunks) {
      if (c.resting) continue;
      c.vel.y -= GRAVITY * dt;
      c.obj.position.addScaledVector(c.vel, dt);
      c.obj.rotation.x += c.spin.x * dt;
      c.obj.rotation.y += c.spin.y * dt;
      c.obj.rotation.z += c.spin.z * dt;
      const p = c.obj.position;
      if (c.vel.y < 0 && p.y <= field.heightAt(p.x, p.z)) {
        // land flat: grass up or roots up
        this.orientOnGround(c.obj, p.x, p.z, c.yaw, c.flip);
        c.resting = true;
      }
    }
  }

  /** Sit `obj` on the terrain at (x, z), tilted to the slope, turned to `yaw`. */
  private orientOnGround(obj: THREE.Object3D, x: number, z: number, yaw: number, flip: boolean) {
    const field = this.field!;
    const g = field.gradAt(x, z);
    const n = new THREE.Vector3(-g.x, 1, -g.z).normalize();
    const tilt = new THREE.Quaternion().setFromUnitVectors(UP, n);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    if (flip) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
    obj.quaternion.copy(tilt).multiply(q);
    // a flipped chunk's grass side (model top, ~4 cm) now points down: lift it back above the ground
    const lift = flip ? 0.03 * obj.scale.x : 0;
    obj.position.set(x, field.heightAt(x, z) + lift, z);
  }

  private syncUniforms() {
    const arr = divotUniforms.uDivots.value;
    const f = new THREE.Vector3();
    this.scars.forEach((s, i) => {
      // model forward (-Z) in world space, length = scale
      f.set(0, 0, -1).applyQuaternion(s.quaternion);
      f.y = 0;
      f.normalize().multiplyScalar(s.scale.x);
      arr[i].set(s.position.x, s.position.z, f.x, f.z);
    });
    divotUniforms.uDivotCount.value = this.scars.length;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.clear();
    this.scars = [];
    this.chunks = [];
    divotUniforms.uDivotCount.value = 0;
  }
}
