// Driving range targets: target greens at set yardages down the range, each with a coloured flag,
// a white ring draped over the ground and a yardage board that faces the tee.
import * as THREE from 'three';
import type { HoleField } from './holeGen';

const YD = 0.9144;

export interface RangeTarget {
  yards: number;
  x: number;
  z: number;
  /** Radius of the target green, metres. */
  r: number;
  color: number;
  name: string;
}

/** Yardage, sideways offset (m, + is right of the line) and flag colour of each target. */
const LAYOUT: [number, number, number, string][] = [
  [60, -9, 0xd8322b, 'red'],
  [100, 10, 0xf2c230, 'yellow'],
  [150, -12, 0x2f6fd8, 'blue'],
  [200, 9, 0xf2f2f2, 'white'],
  [250, -4, 0x222222, 'black'],
];

export class RangeTargets {
  readonly group = new THREE.Group();
  targets: RangeTarget[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(field: HoleField) {
    this.group.name = 'RangeTargets';
    const t = field.tee;
    const fwd = new THREE.Vector2(field.cup.x - t.x, field.cup.z - t.z).normalize();
    const right = new THREE.Vector2(-fwd.y, fwd.x);
    const pole = new THREE.CylinderGeometry(0.02, 0.02, 2.4, 6).translate(0, 1.2, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.5 });
    const flagGeo = new THREE.PlaneGeometry(0.6, 0.42).translate(0.3, 2.15, 0);
    this.disposables.push(pole, poleMat, flagGeo);
    for (const [yards, side, color, name] of LAYOUT) {
      const d = yards * YD;
      const x = t.x + fwd.x * d + right.x * side, z = t.z + fwd.y * d + right.y * side;
      // farther targets are bigger, like a real range
      const r = 5 + yards * 0.045;
      this.targets.push({ yards, x, z, r, color, name });
      this.group.add(this.drape(field, x, z, 0, r, 0x7fbf4a, 0.55, 48));
      this.group.add(this.drape(field, x, z, r - 0.35, r, 0xffffff, 0.9, 64));
      this.group.add(this.drape(field, x, z, r * 0.45 - 0.2, r * 0.45, 0xffffff, 0.7, 48));
      const y = field.heightAt(x, z);
      const p = new THREE.Mesh(pole, poleMat);
      p.position.set(x, y, z);
      p.castShadow = true;
      const flagMat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, side: THREE.DoubleSide });
      const flag = new THREE.Mesh(flagGeo, flagMat);
      flag.position.set(x, y, z);
      flag.rotation.y = Math.atan2(-right.y, right.x); // flag side-on to the tee
      flag.castShadow = true;
      this.disposables.push(flagMat);
      this.group.add(p, flag);
      // yardage board beside the target, readable from the tee
      const sign = this.sign(`${yards}`, color);
      const sx = x + right.x * (r + 3) * Math.sign(side || 1), sz = z + right.y * (r + 3) * Math.sign(side || 1);
      sign.position.set(sx, field.heightAt(sx, sz) + 1.2 + yards * 0.012, sz);
      const s = 2.2 + yards * 0.02;
      sign.scale.set(s * 1.6, s, 1);
      this.group.add(sign);
    }
  }

  /** A flat ring (or disc, inner = 0) that follows the ground. */
  private drape(field: HoleField, cx: number, cz: number, inner: number, outer: number, color: number, opacity: number, seg: number): THREE.Mesh {
    const g = new THREE.RingGeometry(Math.max(0.001, inner), outer, seg, 2);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      pos.setXYZ(i, x, field.heightAt(x, z) + 0.03, z);
    }
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.disposables.push(g, m);
    return mesh;
  }

  private sign(text: string, color: number): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 160;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(20, 32, 24, 0.92)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 248, 152, 18);
    ctx.fill();
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.fillRect(4, 128, 248, 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 92px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, fog: false });
    this.disposables.push(tex, mat);
    return new THREE.Sprite(mat);
  }

  /** The target a resting ball is nearest to, and how far from its flag (metres). */
  nearest(x: number, z: number): { target: RangeTarget; dist: number } {
    let best = this.targets[0], bd = Infinity;
    for (const t of this.targets) {
      const d = Math.hypot(x - t.x, z - t.z);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return { target: best, dist: bd };
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.group.clear();
  }
}
