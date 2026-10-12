// Shot-planning overlays: trajectory arc, landing target, roll-out marker, putt line and the
// 2K-style putting-green grid with downhill flow dots.
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { SimResult } from '../physics/ballPhysics';
import type { HoleField } from './holeGen';
import { terrainTime } from './terrain';

function ringMesh(inner: number, outer: number, color: number, opacity: number) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false }),
  );
  m.renderOrder = 5;
  return m;
}

export class AimOverlay {
  readonly group = new THREE.Group();
  private arc: Line2;
  private arcGeo = new LineGeometry();
  private arcMat: LineMaterial;
  private landing: THREE.Group;
  private restMarker: THREE.Mesh;
  private putt: Line2;
  private puttGeo = new LineGeometry();
  private puttMat: LineMaterial;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.arcMat = new LineMaterial({ color: 0xffffff, linewidth: 3, dashed: true, dashSize: 2.2, gapSize: 1.4, transparent: true, opacity: 0.85, depthTest: true });
    this.arcGeo.setPositions([0, 0, 0, 0, 1, 0]);
    this.arc = new Line2(this.arcGeo, this.arcMat);
    this.arc.frustumCulled = false;
    this.group.add(this.arc);
    this.landing = new THREE.Group();
    this.landing.add(ringMesh(2.6, 3.0, 0xffffff, 0.9), ringMesh(0.0, 2.6, 0xffffff, 0.12), ringMesh(0.5, 0.75, 0xffd84a, 0.95));
    this.group.add(this.landing);
    this.restMarker = ringMesh(0.6, 0.85, 0x7fe0ff, 0.9);
    this.group.add(this.restMarker);
    this.puttMat = new LineMaterial({ color: 0xffffff, linewidth: 3, dashed: true, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.9 });
    this.puttGeo.setPositions([0, 0, 0, 0, 0, 1]);
    this.putt = new Line2(this.puttGeo, this.puttMat);
    this.putt.frustumCulled = false;
    this.group.add(this.putt);
    this.hide();
  }

  setResolution(w: number, h: number) {
    this.arcMat.resolution.set(w, h);
    this.puttMat.resolution.set(w, h);
  }

  hide() {
    this.arc.visible = false;
    this.landing.visible = false;
    this.restMarker.visible = false;
    this.putt.visible = false;
  }

  private orient(obj: THREE.Object3D, field: HoleField, x: number, z: number, lift = 0.05) {
    const g = field.gradAt(x, z);
    obj.position.set(x, field.heightAt(x, z) + lift, z);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-g.x, 1, -g.z).normalize());
  }

  /** Full-shot preview from a simulated (perfect-swing) shot. */
  showShot(field: HoleField, r: SimResult, opts: { arc: boolean; rest: boolean; landingScale: number }) {
    this.putt.visible = false;
    const s = r.samples;
    const pts: number[] = [];
    const endT = r.landing ? r.landingTime : r.duration;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i] > endT + 1e-6) break;
      pts.push(s[i + 1], s[i + 2], s[i + 3]);
    }
    if (r.landing) pts.push(r.landing.x, r.landing.y, r.landing.z);
    if (pts.length >= 6 && opts.arc) {
      this.arcGeo.dispose();
      this.arcGeo = new LineGeometry();
      this.arcGeo.setPositions(pts);
      this.arc.geometry = this.arcGeo;
      this.arc.computeLineDistances();
      this.arc.visible = true;
    } else this.arc.visible = false;
    if (r.landing) {
      this.landing.visible = true;
      this.orient(this.landing, field, r.landing.x, r.landing.z, 0.03);
      this.landing.scale.setScalar(opts.landingScale);
    } else this.landing.visible = false;
    if (opts.rest && r.outcome !== 'water') {
      this.restMarker.visible = true;
      this.orient(this.restMarker, field, r.rest.x, r.rest.z, 0.03);
      this.restMarker.scale.setScalar(Math.max(0.6, opts.landingScale * 0.8));
    } else this.restMarker.visible = false;
  }

  /** Putt preview line, drawn for a fraction of the roll depending on difficulty. */
  showPutt(field: HoleField, r: SimResult, fraction: number) {
    this.arc.visible = false;
    this.landing.visible = false;
    this.restMarker.visible = false;
    if (fraction <= 0) {
      this.putt.visible = false;
      return;
    }
    const s = r.samples;
    const pts: number[] = [];
    const endT = r.duration * fraction;
    let last = -1;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i] > endT) break;
      const x = s[i + 1], z = s[i + 3];
      if (last >= 0) {
        const lx = pts[last], lz = pts[last + 2];
        if ((x - lx) ** 2 + (z - lz) ** 2 < 0.04) continue;
      }
      last = pts.length;
      pts.push(x, field.heightAt(x, z) + 0.012, z);
    }
    if (pts.length < 6) {
      this.putt.visible = false;
      return;
    }
    this.puttGeo.dispose();
    this.puttGeo = new LineGeometry();
    this.puttGeo.setPositions(pts);
    this.putt.geometry = this.puttGeo;
    this.putt.computeLineDistances();
    this.putt.visible = true;
  }
}

/** Grid laid over the green showing slope: colour = steepness, dots flow downhill. */
export class GreenGrid {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
      uniforms: {
        uTime: terrainTime,
        uCup: { value: new THREE.Vector2() },
        uRadius: { value: 20 },
        uOpacity: { value: 1 },
      },
      vertexShader: `
        attribute vec2 aGrad;
        varying vec2 vGrad;
        varying vec3 vW;
        void main() {
          vGrad = aGrad;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform float uTime, uRadius, uOpacity;
        uniform vec2 uCup;
        varying vec2 vGrad;
        varying vec3 vW;
        void main() {
          float cell = 0.9144;
          vec2 p = vW.xz / cell;
          vec2 f = abs(fract(p - 0.5) - 0.5) / fwidth(p);
          float line = 1.0 - min(min(f.x, f.y), 1.0);
          float slope = length(vGrad);
          // slope colour ramp: blue (flat) -> yellow -> red (steep), 0..4%
          float sN = clamp(slope / 0.04, 0.0, 1.0);
          vec3 col = mix(vec3(0.25, 0.65, 1.0), vec3(1.0, 0.9, 0.2), smoothstep(0.0, 0.5, sN));
          col = mix(col, vec3(1.0, 0.3, 0.15), smoothstep(0.5, 1.0, sN));
          // flowing dots downhill, one per grid cell
          vec2 dir = slope > 1e-4 ? -vGrad / slope : vec2(0.0);
          vec2 cellC = (floor(p) + 0.5);
          float speed = 0.25 + sN * 1.6;
          float ph = fract(uTime * speed * 0.5 + dot(cellC, vec2(0.13, 0.29)));
          vec2 dotPos = cellC + dir * (ph - 0.5) * 0.9;
          float dd = length(p - dotPos);
          float dotA = (1.0 - smoothstep(0.035, 0.06, dd)) * (1.0 - abs(ph - 0.5) * 2.0) * step(1e-4, slope);
          float dist = length(vW.xz - uCup);
          float fade = 1.0 - smoothstep(uRadius * 0.75, uRadius, dist);
          float cupD = length(vW.xz - uCup);
          float ring = (1.0 - smoothstep(0.012, 0.03, abs(cupD - 0.16))) * 0.95;
          float a = max(line * 0.32 + dotA * 0.9, ring) * fade * uOpacity;
          vec3 c = mix(mix(col, vec3(1.0), dotA * 0.6), vec3(1.0), ring);
          if (a < 0.01) discard;
          gl_FragColor = vec4(c, a);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 6;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  build(field: HoleField, cx: number, cz: number, radius: number) {
    const step = 0.5;
    const n = Math.ceil((radius * 2) / step) + 1;
    const pos: number[] = [];
    const grad: number[] = [];
    const x0 = cx - radius, z0 = cz - radius;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step, z = z0 + j * step;
        pos.push(x, field.heightAt(x, z) + 0.012, z);
        const g = field.gradAt(x, z);
        grad.push(g.x, g.z);
      }
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aGrad', new THREE.Float32BufferAttribute(grad, 2));
    geo.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.mat.uniforms.uCup.value.set(cx, cz);
    this.mat.uniforms.uRadius.value = radius;
  }

  setVisible(v: boolean, opacity = 1) {
    this.mesh.visible = v;
    this.mat.uniforms.uOpacity.value = opacity;
  }
}
