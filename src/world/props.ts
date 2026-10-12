// Course props: flagstick + waving flag, cup, tee markers, the golf ball and its tracer.
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { loadGLTF } from '../core/assets';
import { BALL_R, CUP_R } from '../physics/ballPhysics';
import type { HoleField } from './holeGen';
import { terrainTime } from './terrain';

const flagUniforms = { uTime: terrainTime, uWindStrength: { value: 0.5 } };

function dimpleNormalMap(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgb(128,128,255)';
  ctx.fillRect(0, 0, size, size);
  const rows = 14;
  for (let r = 0; r < rows; r++) {
    const cols = 28;
    for (let k = 0; k < cols; k++) {
      const x = ((k + (r % 2) * 0.5) / cols) * size;
      const y = ((r + 0.5) / rows) * size;
      const rad = size / cols / 2.3;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgb(128,128,235)');
      g.addColorStop(0.7, 'rgb(128,128,245)');
      g.addColorStop(1, 'rgb(128,128,255)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      // slope sides
      ctx.strokeStyle = 'rgba(100,150,240,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** On-screen ball size: drawn this much larger than a real ball … */
const BALL_SCALE = 1.1;
/** … and never smaller than this fraction of the screen height (about 6 px at 1080p). */
const BALL_MIN_SCREEN = 0.006;
/** Shot tracer core and glow: widths in pixels, and opacities. */
const TRACER_W = 4;
const TRACER_OPACITY = 0.95;
const TRACER_GLOW_W = 12;
const TRACER_GLOW_OPACITY = 0.22;

export class Ball {
  readonly mesh: THREE.Mesh;
  readonly shadowBlob: THREE.Mesh;
  private tracer: Line2;
  private tracerGlow: Line2;
  private tracerGeo: LineGeometry;
  private tracerPts: number[] = [];
  private tracerAge = 0;
  readonly tracerMat: LineMaterial;
  private glowMat: LineMaterial;
  private pos = new THREE.Vector3();
  private groundY: number | null = null;

  constructor(scene: THREE.Scene, color = 0xffffff, tracerColor = '#ffffff') {
    const mat = new THREE.MeshPhysicalMaterial({ color, emissive: color, emissiveIntensity: 0, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.15, normalMap: dimpleNormalMap(), normalScale: new THREE.Vector2(0.6, 0.6) });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 18), mat);
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    // soft contact shadow for when the sun shadow is too coarse
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.6, 16).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    blob.renderOrder = 2;
    this.shadowBlob = blob;
    scene.add(blob);
    this.tracerGeo = new LineGeometry();
    this.tracerGeo.setPositions([0, 0, 0, 0, 0, 0]);
    // shot tracer: a bright core in the golfer's colour over a soft glow of the same colour, pushed
    // above white so it stays saturated after tone mapping and reads against both sky and trees
    const tc = new THREE.Color(tracerColor).multiplyScalar(1.6);
    this.tracerMat = new LineMaterial({ color: tc, linewidth: TRACER_W, transparent: true, opacity: TRACER_OPACITY, depthWrite: false });
    this.glowMat = new LineMaterial({ color: tc, linewidth: TRACER_GLOW_W, transparent: true, opacity: TRACER_GLOW_OPACITY, depthWrite: false });
    this.tracerGlow = new Line2(this.tracerGeo, this.glowMat);
    this.tracer = new Line2(this.tracerGeo, this.tracerMat);
    for (const [i, l] of [this.tracerGlow, this.tracer].entries()) {
      l.frustumCulled = false;
      l.visible = false;
      l.renderOrder = 3 + i;
      scene.add(l);
    }
  }

  setColor(hex: number) {
    const m = this.mesh.material as THREE.MeshPhysicalMaterial;
    m.color.setHex(hex);
    m.emissive.setHex(hex);
  }

  setPosition(p: THREE.Vector3, groundY: number | null) {
    this.pos.copy(p);
    this.groundY = groundY;
    this.place();
  }

  /** Mesh and contact shadow from the physics position, keeping the enlarged ball's base where the real one's is. */
  private place() {
    const s = this.mesh.scale.x;
    const p = this.pos;
    this.mesh.position.set(p.x, p.y + (s - 1) * BALL_R, p.z);
    const groundY = this.groundY;
    if (groundY !== null && p.y - groundY < 0.6) {
      this.shadowBlob.visible = this.mesh.visible;
      this.shadowBlob.position.set(p.x, groundY + 0.004, p.z);
      const h = 1 + (p.y - groundY) * 2;
      this.shadowBlob.scale.setScalar(h * s);
      (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.35 / h;
    } else this.shadowBlob.visible = false;
  }

  setVisible(v: boolean) {
    this.mesh.visible = v;
    if (!v) this.shadowBlob.visible = false;
  }

  /**
   * Draw the ball a little larger than life, and never smaller than a fixed share of the screen
   * height, so it stays easy to pick out at the golfer's feet, in the air and resting far away.
   */
  updateScale(cam: THREE.PerspectiveCamera) {
    const d = cam.position.distanceTo(this.pos);
    const viewH = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const s = Math.max(BALL_SCALE, (BALL_MIN_SCREEN * viewH) / (2 * BALL_R));
    this.mesh.scale.setScalar(s);
    // a far ball is a dot seen through haze and shade: lift it so it stays a crisp white dot
    (this.mesh.material as THREE.MeshPhysicalMaterial).emissiveIntensity = Math.min(0.4, (s - BALL_SCALE) * 0.05);
    this.place();
  }

  clearTracer() {
    this.tracerPts = [];
    this.setTracerVisible(false);
    this.tracerAge = 0;
    this.tracerMat.opacity = TRACER_OPACITY;
    this.glowMat.opacity = TRACER_GLOW_OPACITY;
  }

  private setTracerVisible(v: boolean) {
    this.tracer.visible = v;
    this.tracerGlow.visible = v;
  }

  /** Called while this ball is not in flight: hold the finished trail for a moment, then fade it out. */
  fadeTracer(dt: number) {
    if (!this.tracer.visible) return;
    this.tracerAge += dt;
    const k = 1 - THREE.MathUtils.clamp((this.tracerAge - 1.5) / 1.0, 0, 1);
    this.tracerMat.opacity = TRACER_OPACITY * k;
    this.glowMat.opacity = TRACER_GLOW_OPACITY * k;
    if (k <= 0) this.setTracerVisible(false);
  }

  addTracerPoint(p: THREE.Vector3) {
    const n = this.tracerPts.length;
    if (n >= 3) {
      const dx = p.x - this.tracerPts[n - 3], dy = p.y - this.tracerPts[n - 2], dz = p.z - this.tracerPts[n - 1];
      if (dx * dx + dy * dy + dz * dz < 1) return;
    }
    this.tracerPts.push(p.x, p.y, p.z);
    if (this.tracerPts.length >= 6) {
      this.tracerGeo.dispose();
      this.tracerGeo = new LineGeometry();
      this.tracerGeo.setPositions(this.tracerPts);
      this.tracer.geometry = this.tracerGeo;
      this.tracerGlow.geometry = this.tracerGeo;
      this.setTracerVisible(true);
    }
  }

  setResolution(w: number, h: number) {
    this.tracerMat.resolution.set(w, h);
    this.glowMat.resolution.set(w, h);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.shadowBlob.removeFromParent();
    this.tracer.removeFromParent();
    this.tracerGlow.removeFromParent();
    this.tracerGeo.dispose();
  }
}

export class CourseProps {
  readonly group = new THREE.Group();
  readonly flagGroup = new THREE.Group();
  private cupDisc: THREE.Mesh;
  private teeMarkers: THREE.Object3D[] = [];
  private loaded = false;
  private bagTemplate: THREE.Object3D | null = null;
  private teePegTemplate: THREE.Object3D | null = null;
  bag: THREE.Object3D | null = null;
  teePeg: THREE.Object3D | null = null;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.group.add(this.flagGroup);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(CUP_R, 32).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(CUP_R * 0.82, CUP_R * 0.97, 32).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }),
    );
    rim.position.y = 0.0005;
    disc.add(rim);
    this.cupDisc = disc;
    this.group.add(disc);
  }

  async init() {
    if (this.loaded) return;
    this.loaded = true;
    const gltf = await loadGLTF('models/environment.glb');
    const find = (n: string) => gltf?.scene.getObjectByName(n) ?? null;
    const pole = find('Flagstick');
    const flag = find('Flag');
    if (pole) {
      const p = pole.clone();
      p.position.set(0, 0, 0);
      p.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      this.flagGroup.add(p);
    } else {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 2.13, 8).translate(0, 1.065, 0), new THREE.MeshStandardMaterial({ color: 0xf5f5f5 }));
      p.castShadow = true;
      this.flagGroup.add(p);
    }
    let fm: THREE.Object3D;
    if (flag) {
      fm = flag.clone();
      fm.position.set(fm.position.x, fm.position.y, fm.position.z);
    } else {
      const g = new THREE.PlaneGeometry(0.5, 0.36, 12, 8).translate(0.25, 1.93, 0);
      fm = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffd400, side: THREE.DoubleSide }));
    }
    fm.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
      mat.side = THREE.DoubleSide;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = flagUniforms.uTime;
        shader.uniforms.uWindStrength = flagUniforms.uWindStrength;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWindStrength;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             float fu = clamp(uv.x, 0.0, 1.0);
             float wave = sin(uTime * (5.0 + uWindStrength * 4.0) - fu * 7.0 + transformed.y * 3.0) * 0.07 + sin(uTime * 9.0 - fu * 13.0) * 0.02;
             transformed.z += wave * fu * (0.4 + uWindStrength);
             transformed.y -= fu * fu * 0.12 * (1.0 - min(uWindStrength, 1.0));
             transformed.x -= fu * 0.06 * (1.0 - min(uWindStrength, 1.0));`,
          );
      };
      mat.customProgramCacheKey = () => 'flag-wave';
      mesh.material = mat;
    });
    this.flagGroup.add(fm);

    const marker = find('TeeMarker');
    for (let i = 0; i < 2; i++) {
      let m: THREE.Object3D;
      if (marker) m = marker.clone();
      else m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12).translate(0, 0.07, 0), new THREE.MeshStandardMaterial({ color: 0x1a4fd0 }));
      m.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      this.teeMarkers.push(m);
      this.group.add(m);
    }
    this.bagTemplate = find('GolfBag');
    this.teePegTemplate = find('Tee');
    if (this.bagTemplate) {
      this.bag = this.bagTemplate.clone();
      this.bag.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.material = (mesh.material as THREE.Material).clone();
      });
      this.group.add(this.bag);
    }
    const peg = this.teePegTemplate ? this.teePegTemplate.clone() : new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.0015, 0.054, 8).translate(0, -0.002, 0), new THREE.MeshStandardMaterial({ color: 0xd8c39a }));
    this.teePeg = peg;
    this.group.add(peg);
  }

  place(field: HoleField) {
    const cup = field.cup;
    const h = field.heightAt(cup.x, cup.z);
    const g = field.gradAt(cup.x, cup.z);
    const n = new THREE.Vector3(-g.x, 1, -g.z).normalize();
    this.cupDisc.position.set(cup.x, h + 0.003, cup.z);
    this.cupDisc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    this.flagGroup.position.set(cup.x, h - 0.08, cup.z);
    // tee markers either side of the tee box
    const t = field.tee, d = field.teeDir;
    const r = { x: -d.z, z: d.x };
    this.teeMarkers.forEach((m, i) => {
      const s = i === 0 ? -1 : 1;
      const x = t.x + r.x * 3.6 * s + d.x * 0.6, z = t.z + r.z * 3.6 * s + d.z * 0.6;
      m.position.set(x, field.heightAt(x, z), z);
      m.rotation.y = Math.atan2(d.x, d.z);
    });
  }

  setFlagVisible(v: boolean) {
    this.flagGroup.visible = v;
  }

  setWind(x: number, z: number) {
    const sp = Math.hypot(x, z);
    flagUniforms.uWindStrength.value = Math.min(1.6, sp / 5);
    // flag extends along +X: point it downwind
    if (sp > 0.05) this.flagGroup.rotation.y = Math.atan2(-z, x);
  }

  placeBag(x: number, z: number, y: number, rotY: number, color?: string) {
    if (!this.bag) return;
    this.bag.visible = true;
    if (color) {
      this.bag.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && m.name === 'Bag') m.color.set(color);
      });
    }
    this.bag.position.set(x, y, z);
    this.bag.rotation.y = rotY;
  }

  hideBag() {
    if (this.bag) this.bag.visible = false;
  }

  placeTeePeg(x: number, y: number, z: number, visible: boolean) {
    if (!this.teePeg) return;
    this.teePeg.visible = visible;
    this.teePeg.position.set(x, y, z);
  }
}
