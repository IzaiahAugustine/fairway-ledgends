// Rigged golfer from golfer.glb (built in Blender): appearance, club swaps and swing playback
// driven by the player's input (the backswing follows the mouse, the downswing plays at the
// player's tempo).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGLTF } from '../core/assets';
import type { Appearance } from '../core/save';
import { TIERS, type SwingAnim } from '../data/clubs';

export interface SwingTiming {
  top: number;
  impact: number;
  finish: number;
  end: number;
}

const FPS = 30;
export const TIMING: Record<SwingAnim, SwingTiming> = {
  Driver: { top: 30 / FPS, impact: 40 / FPS, finish: 70 / FPS, end: 80 / FPS },
  Wood: { top: 30 / FPS, impact: 40 / FPS, finish: 70 / FPS, end: 80 / FPS },
  Iron: { top: 30 / FPS, impact: 40 / FPS, finish: 70 / FPS, end: 80 / FPS },
  Wedge: { top: 26 / FPS, impact: 36 / FPS, finish: 62 / FPS, end: 72 / FPS },
  Chip: { top: 18 / FPS, impact: 26 / FPS, finish: 42 / FPS, end: 50 / FPS },
  Putt: { top: 18 / FPS, impact: 30 / FPS, finish: 45 / FPS, end: 55 / FPS },
};

const DEFAULT_BALL: Record<SwingAnim, THREE.Vector3> = {
  Driver: new THREE.Vector3(0.15, 0.045, 0.86),
  Wood: new THREE.Vector3(0.1, 0.0213, 0.79),
  Iron: new THREE.Vector3(0.03, 0.0213, 0.685),
  Wedge: new THREE.Vector3(0.005, 0.0213, 0.64),
  Chip: new THREE.Vector3(-0.035, 0.0213, 0.53),
  Putt: new THREE.Vector3(0.045, 0.0213, 0.445),
};

type Phase = 'address' | 'backswing' | 'downswing' | 'follow' | 'hold' | 'clip';

/**
 * Cheap subsurface scattering for skin: light wraps past the terminator, reddened by the blood
 * under the skin, and sky-lit shade is warmed so faces don't turn grey.
 */
function skinShading(m: THREE.MeshStandardMaterial) {
  m.onBeforeCompile = (s) => {
    const direct = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
      'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
      `reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
      float sssNL = dot( geometryNormal, directLight.direction );
      float sssWrap = saturate( ( sssNL + 0.45 ) / 1.45 ) - saturate( sssNL );
      reflectedLight.directDiffuse += sssWrap * directLight.color * BRDF_Lambert( material.diffuseColor ) * vec3( 0.9, 0.38, 0.22 );`,
    );
    s.fragmentShader = s.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', direct)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse *= vec3( 1.1, 0.96, 0.9 );');
  };
  m.customProgramCacheKey = () => 'golfer-skin';
}

/** Wet eyes reflect less sky than a mirror, and the sclera darkens toward the lids. */
function eyeShading(m: THREE.MeshStandardMaterial) {
  m.envMapIntensity = 0.55;
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      #ifdef USE_MAP
        diffuseColor.rgb *= mix( 1.0, 0.72, smoothstep( 0.2, 0.42, length( vMapUv - 0.5 ) ) );
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'golfer-eye';
}

export class Golfer {
  readonly root = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private blendActions = new Map<string, THREE.AnimationAction>();
  private ballOffsets = new Map<SwingAnim, THREE.Vector3>();
  private clubs = new Map<string, THREE.Object3D>();
  private mats = new Map<string, THREE.MeshStandardMaterial[]>();
  private morphMeshes: THREE.Mesh[] = [];
  private variants = new Map<string, THREE.Object3D>();
  private scale = 1;
  // swing state
  private anim: SwingAnim = 'Iron';
  private phase: Phase = 'address';
  private t = 0;
  private downFrom = 0;
  private downDur = 0.3;
  private downElapsed = 0;
  private partial = false;
  private impactFired = false;
  private onImpact: (() => void) | null = null;
  private onDone: (() => void) | null = null;
  private clipName = '';
  private clipT = 0;
  private waggleT = 0;
  // fallback rig
  private fallbackClub: THREE.Object3D | null = null;
  hasRig = false;

  static async create(): Promise<Golfer> {
    const g = new Golfer();
    const gltf = await loadGLTF('models/golfer.glb');
    if (gltf) g.setupModel(gltf.scene, gltf.animations);
    else g.setupFallback();
    return g;
  }

  private setupModel(scene: THREE.Object3D, clips: THREE.AnimationClip[]) {
    const model = SkeletonUtils.clone(scene);
    this.model = model;
    this.root.add(model);
    this.hasRig = true;
    // per-instance materials so two golfers can wear different outfits
    const cloned = new Map<THREE.Material, THREE.Material>();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const swap = (m: THREE.Material) => {
        let c = cloned.get(m);
        if (!c) {
          c = m.clone();
          cloned.set(m, c);
          // fabric weave and skin detail stay crisp at the glancing angles of the address camera
          const sm = c as THREE.MeshStandardMaterial;
          for (const t of [sm.map, sm.normalMap, sm.roughnessMap, sm.metalnessMap, sm.aoMap]) if (t) t.anisotropy = 8;
          const name = m.name.replace(/\.\d+$/, '');
          if (!this.mats.has(name)) this.mats.set(name, []);
          this.mats.get(name)!.push(c as THREE.MeshStandardMaterial);
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      if (mesh.morphTargetDictionary && mesh.morphTargetDictionary['Heavy'] !== undefined) this.morphMeshes.push(mesh);
    });
    this.mats.get('Skin')?.forEach(skinShading);
    this.mats.get('Eyes')?.forEach(eyeShading);
    // soft hairline / brow / lash edges: with no alpha cutoff the texture's alpha gradient maps
    // straight to MSAA coverage (the scene renders into a 4x MSAA target; shadows still cut at 0.5)
    for (const n of ['Hair', 'Lashes'])
      this.mats.get(n)?.forEach((m) => {
        m.alphaToCoverage = true;
        m.alphaTest = 0;
      });
    for (const n of ['Club_Driver', 'Club_Wood', 'Club_Hybrid', 'Club_Iron', 'Club_Wedge', 'Club_Putter']) {
      const o = model.getObjectByName(n);
      if (o) this.clubs.set(n, o);
    }
    for (const n of ['Hat_Cap', 'Hat_Visor', 'Hat_Bucket', 'Hair_Short', 'Hair_Long', 'Sunglasses']) {
      const o = model.getObjectByName(n);
      if (o) this.variants.set(n, o);
    }
    model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    for (const a of Object.keys(DEFAULT_BALL) as SwingAnim[]) {
      const o = model.getObjectByName(`Ball_${a}`);
      if (o) {
        const p = new THREE.Vector3();
        o.getWorldPosition(p).applyMatrix4(inv);
        this.ballOffsets.set(a, p);
      } else this.ballOffsets.set(a, DEFAULT_BALL[a].clone());
    }
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of clips) {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      this.actions.set(clip.name, a);
      const b = this.mixer.clipAction(clip.clone());
      b.setLoop(THREE.LoopOnce, 1);
      b.clampWhenFinished = true;
      this.blendActions.set(clip.name, b);
    }
    this.setAnim('Iron');
  }

  private setupFallback() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xc68a62, name: 'Skin' });
    const shirt = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, name: 'Shirt' });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2d3440, name: 'Pants' });
    const hat = new THREE.MeshStandardMaterial({ color: 0x1c2b4a, name: 'Hat' });
    this.mats.set('Skin', [skin]);
    this.mats.set('Shirt', [shirt]);
    this.mats.set('Pants', [pants]);
    this.mats.set('Hat', [hat]);
    const body = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.5, 6, 12), shirt);
    torso.position.set(0, 1.25, 0);
    const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.7, 6, 12), pants);
    legs.position.set(0, 0.5, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), skin);
    head.position.set(0, 1.68, 0.02);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), hat);
    cap.position.set(0, 1.71, 0.02);
    body.add(torso, legs, head, cap);
    body.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    const club = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.009, 1.0, 6).translate(0, -0.5, 0), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 1, roughness: 0.3 }));
    const headM = new THREE.MeshStandardMaterial({ color: 0x7a4a2c, metalness: 0.7, roughness: 0.5, name: 'ClubHead' });
    this.mats.set('ClubHead', [headM]);
    const clubHead = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.05).translate(0, -1.0, 0), headM);
    club.add(shaft, clubHead);
    club.position.set(0, 1.0, 0.3);
    club.rotation.x = -0.6;
    this.fallbackClub = club;
    body.add(club);
    this.model = body;
    this.root.add(body);
    for (const a of Object.keys(DEFAULT_BALL) as SwingAnim[]) this.ballOffsets.set(a, DEFAULT_BALL[a].clone());
  }

  applyAppearance(a: Appearance) {
    const set = (name: string, hex: string) => this.mats.get(name)?.forEach((m) => m.color.set(hex));
    set('Skin', a.skin);
    set('Hair', a.hair);
    set('Shirt', a.shirt);
    set('Pants', a.pants);
    set('Shoes', a.shoes);
    set('Belt', a.belt);
    set('Hat', a.hatColor);
    for (const [n, o] of this.variants) {
      if (n.startsWith('Hat_')) o.visible = a.hat !== 'None' && n === `Hat_${a.hat}`;
      else if (n.startsWith('Hair_')) o.visible = a.hairStyle !== 'None' && n === `Hair_${a.hairStyle}`;
      else if (n === 'Sunglasses') o.visible = a.sunglasses;
    }
    for (const m of this.morphMeshes) {
      const i = m.morphTargetDictionary!['Heavy'];
      if (m.morphTargetInfluences) m.morphTargetInfluences[i] = a.build;
    }
    this.scale = a.height / 1.8;
    if (this.model) this.model.scale.setScalar(this.scale);
  }

  setClub(model: string, tier: number) {
    for (const [n, o] of this.clubs) o.visible = n === model;
    const t = TIERS[tier];
    this.mats.get('ClubHead')?.forEach((m) => {
      m.color.setHex(t.head.color);
      m.metalness = t.head.metalness;
      m.roughness = t.head.roughness;
    });
    if (this.fallbackClub) this.fallbackClub.visible = true;
  }

  ballOffset(anim: SwingAnim): THREE.Vector3 {
    return (this.ballOffsets.get(anim) ?? DEFAULT_BALL[anim]).clone().multiplyScalar(this.scale);
  }

  /** Stand at the ball, facing so the target line (local +X) points along aim. */
  placeForShot(ball: THREE.Vector3, aimX: number, aimZ: number, anim: SwingAnim, heightAt: (x: number, z: number) => number) {
    const theta = Math.atan2(-aimZ, aimX);
    this.root.rotation.set(0, theta, 0);
    const off = this.ballOffset(anim);
    off.y = 0;
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), theta);
    const x = ball.x - off.x, z = ball.z - off.z;
    this.root.position.set(x, heightAt(x, z), z);
    this.root.visible = true;
    this.setAnim(anim);
  }

  setAnim(anim: SwingAnim) {
    this.anim = anim;
    this.phase = 'address';
    this.t = 0;
    this.waggleT = 0;
    this.impactFired = false;
    this.applyPose(`Swing_${anim}`, 0);
  }

  get timing(): SwingTiming {
    return TIMING[this.anim];
  }

  /** Scrub the backswing: fraction 0..1.1 of the way to the top. */
  /** Swing style: backswing length (1 = full) and downswing duration multiplier. */
  swingLength = 1;
  swingSpeed = 1;

  setBackswing(frac: number) {
    if (this.phase !== 'address' && this.phase !== 'backswing') return;
    this.phase = 'backswing';
    this.t = Math.max(0, Math.min(1, frac * this.swingLength)) * this.timing.top;
    this.applyPose(`Swing_${this.anim}`, this.t);
  }

  cancelSwing() {
    this.phase = 'address';
    this.t = 0;
    this.applyPose(`Swing_${this.anim}`, 0);
  }

  /** Start the downswing from the current backswing position. */
  startDownswing(duration: number, onImpact: () => void, onDone?: () => void) {
    const tm = this.timing;
    this.downFrom = this.t;
    this.partial = this.t < tm.top * 0.8;
    this.downDur = Math.max(0.12, duration * this.swingSpeed);
    this.downElapsed = 0;
    this.phase = 'downswing';
    this.onImpact = onImpact;
    this.onDone = onDone ?? null;
    this.impactFired = false;
  }

  playClip(name: 'Idle' | 'Celebrate' | 'Dejected', onDone?: () => void) {
    if (!this.actions.has(name)) {
      onDone?.();
      return;
    }
    this.phase = 'clip';
    this.clipName = name;
    this.clipT = 0;
    this.onDone = onDone ?? null;
  }

  get busy(): boolean {
    return this.phase === 'downswing' || this.phase === 'follow' || this.phase === 'clip';
  }

  private applyPose(clip: string, time: number, blendClip?: string, blendTime?: number, w = 0) {
    if (!this.mixer) {
      this.fallbackPose(time);
      return;
    }
    for (const a of this.actions.values()) {
      a.enabled = false;
      a.setEffectiveWeight(0);
    }
    for (const a of this.blendActions.values()) {
      a.enabled = false;
      a.setEffectiveWeight(0);
    }
    const a = this.actions.get(clip);
    if (a) {
      a.enabled = true;
      a.play();
      a.paused = true;
      a.time = Math.min(time, a.getClip().duration);
      a.setEffectiveWeight(1 - w);
    }
    if (blendClip && w > 0) {
      const b = this.blendActions.get(blendClip);
      if (b) {
        b.enabled = true;
        b.play();
        b.paused = true;
        b.time = Math.min(blendTime ?? 0, b.getClip().duration);
        b.setEffectiveWeight(w);
      }
    }
    this.mixer.update(0);
  }

  private fallbackPose(time: number) {
    const club = this.fallbackClub;
    if (!club) return;
    const tm = this.timing;
    let ang: number;
    if (time <= tm.top) ang = -0.6 + (time / tm.top) * 3.2;
    else if (time <= tm.impact) ang = 2.6 - ((time - tm.top) / (tm.impact - tm.top)) * 3.2;
    else ang = -0.6 - Math.min(1, (time - tm.impact) / (tm.finish - tm.impact)) * 2.8;
    club.rotation.set(0, 0, 0);
    club.rotateOnAxis(new THREE.Vector3(0, 0, 1), ang * 0.9);
    club.rotateOnAxis(new THREE.Vector3(1, 0, 0), -0.6);
  }

  update(dt: number) {
    const clip = `Swing_${this.anim}`;
    const tm = this.timing;
    switch (this.phase) {
      case 'address': {
        // gentle waggle while lining up
        this.waggleT += dt;
        const w = this.anim === 'Putt' ? 0 : Math.max(0, Math.sin(this.waggleT * 1.6)) * 0.06 * Math.max(0, 1 - this.waggleT / 6);
        this.applyPose(clip, w * tm.top);
        break;
      }
      case 'downswing': {
        this.downElapsed += dt;
        const u = Math.min(1, this.downElapsed / this.downDur);
        if (this.partial) {
          // replay the backswing in reverse, then blend into the authored impact frame
          const back = this.downFrom * (1 - u);
          const w = THREE.MathUtils.smoothstep(u, 0.55, 1);
          this.applyPose(clip, back, clip, tm.impact - (1 - u) * 0.05, w);
        } else {
          const e = u * u * (3 - 2 * u) * 0.35 + u * 0.65; // accelerate into the ball
          this.t = this.downFrom + (tm.impact - this.downFrom) * e;
          this.applyPose(clip, this.t);
        }
        if (u >= 1) {
          this.t = tm.impact;
          this.phase = 'follow';
          if (!this.impactFired) {
            this.impactFired = true;
            this.onImpact?.();
          }
        }
        break;
      }
      case 'follow': {
        this.t += dt;
        this.applyPose(clip, this.t);
        if (this.t >= tm.end) {
          this.phase = 'hold';
          const cb = this.onDone;
          this.onDone = null;
          cb?.();
        }
        break;
      }
      case 'clip': {
        const a = this.actions.get(this.clipName);
        if (!a) break;
        this.clipT += dt;
        const dur = a.getClip().duration;
        if (this.clipName === 'Idle') this.clipT %= dur;
        this.applyPose(this.clipName, this.clipT);
        if (this.clipName !== 'Idle' && this.clipT >= dur) {
          this.phase = 'hold';
          const cb = this.onDone;
          this.onDone = null;
          cb?.();
        }
        break;
      }
      default:
        break;
    }
  }

  /** World position of the club head (approx.), for effects. */
  getWorldPosition(out: THREE.Vector3) {
    return this.root.getWorldPosition(out);
  }

  /** Model for previews (editor). */
  get object(): THREE.Object3D {
    return this.root;
  }
}
