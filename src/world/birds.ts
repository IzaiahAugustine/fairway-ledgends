// A few small flocks wheeling high over the course: dark silhouettes with flapping wings that
// circle, drift and glide. Pure decoration (a few dozen triangles), but they make the sky feel alive.
import * as THREE from 'three';

interface Bird {
  root: THREE.Object3D;
  left: THREE.Object3D;
  right: THREE.Object3D;
  phase: number;
  offset: THREE.Vector3;
}

interface Flock {
  center: THREE.Vector3;
  radius: number;
  height: number;
  speed: number;
  angle: number;
  birds: Bird[];
}

export class Birds {
  readonly group = new THREE.Group();
  private flocks: Flock[] = [];
  private t = 0;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshBasicMaterial;

  constructor() {
    this.group.name = 'Birds';
    // one wing: a thin swept triangle from the body out to the tip (x = span)
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.12, 0, 0, -0.1, 0.55, 0, -0.18], 3));
    this.geo.computeVertexNormals();
    this.mat = new THREE.MeshBasicMaterial({ color: 0x1d2024, side: THREE.DoubleSide });
  }

  /** Scatter flocks around a point (the middle of the hole), within `extent` metres. */
  place(center: THREE.Vector3, extent: number, seed: number) {
    this.clear();
    let s = seed >>> 0 || 1;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const flocks = 2 + Math.floor(rand() * 2);
    for (let f = 0; f < flocks; f++) {
      const fl: Flock = {
        center: new THREE.Vector3(center.x + (rand() - 0.5) * extent, 0, center.z + (rand() - 0.5) * extent),
        radius: 40 + rand() * 80,
        height: center.y + 28 + rand() * 40,
        speed: (0.05 + rand() * 0.05) * (rand() < 0.5 ? -1 : 1),
        angle: rand() * Math.PI * 2,
        birds: [],
      };
      const n = 3 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const root = new THREE.Object3D();
        const left = new THREE.Mesh(this.geo, this.mat);
        const right = new THREE.Mesh(this.geo, this.mat);
        right.scale.x = -1;
        const lp = new THREE.Object3D(), rp = new THREE.Object3D();
        lp.add(left);
        rp.add(right);
        root.add(lp, rp);
        root.scale.setScalar(0.9 + rand() * 0.5);
        this.group.add(root);
        fl.birds.push({ root, left: lp, right: rp, phase: rand() * 10, offset: new THREE.Vector3((rand() - 0.5) * 9, (rand() - 0.5) * 4, (rand() - 0.5) * 9) });
      }
      this.flocks.push(fl);
    }
  }

  update(dt: number) {
    this.t += dt;
    for (const fl of this.flocks) {
      fl.angle += fl.speed * dt;
      const cx = fl.center.x + Math.cos(fl.angle) * fl.radius;
      const cz = fl.center.z + Math.sin(fl.angle) * fl.radius;
      // heading along the circle
      const hx = -Math.sin(fl.angle) * Math.sign(fl.speed), hz = Math.cos(fl.angle) * Math.sign(fl.speed);
      for (const b of fl.birds) {
        const bob = Math.sin(this.t * 0.7 + b.phase) * 1.2;
        b.root.position.set(cx + b.offset.x, fl.height + b.offset.y + bob, cz + b.offset.z);
        b.root.rotation.set(0, Math.atan2(hx, hz), 0);
        // flap in bursts, then glide with the wings held slightly up
        const burst = Math.sin(this.t * 0.45 + b.phase * 1.7) > -0.2 ? 1 : 0;
        const flap = burst ? Math.sin(this.t * 9 + b.phase * 3) * 0.75 : 0.18;
        b.left.rotation.z = flap;
        b.right.rotation.z = -flap;
      }
    }
  }

  clear() {
    this.group.clear();
    this.flocks = [];
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
