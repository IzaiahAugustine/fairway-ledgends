// Rigged golfer from golfer.glb (built in Blender): appearance, club swaps and swing playback
// driven by the player's input (the backswing follows the mouse, the downswing plays at the
// player's tempo).
import * as THREE from 'three';
import { clubFinish, shirtPatternCode } from '../data/cosmetics';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGLTF, releaseAfterUpload } from '../core/assets';
import { assetUrl } from '../core/device';
import type { Appearance, FaceStyle } from '../core/save';
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

/** Face variants share the head's UV layout, so they drop straight in as the skin map. */
const faceLoader = new THREE.TextureLoader();
const faceMaps = new Map<FaceStyle, Promise<THREE.Texture>>();
function faceMap(f: FaceStyle): Promise<THREE.Texture> {
  let p = faceMaps.get(f);
  if (!p) {
    p = faceLoader.loadAsync(assetUrl(`assets/golfer/faces/${f.toLowerCase()}.jpg`)).then((t) => {
      t.flipY = false; // glTF UV convention, as the map it replaces
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      releaseAfterUpload(t);
      return t;
    });
    faceMaps.set(f, p);
  }
  return p;
}

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
      reflectedLight.directDiffuse += sssWrap * directLight.color * BRDF_Lambert( material.diffuseColor ) * vec3( 0.55, 0.3, 0.2 );`,
    );
    s.fragmentShader = s.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', direct)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse *= vec3( 1.04, 0.99, 0.95 );');
  };
  m.customProgramCacheKey = () => 'golfer-skin';
}

/**
 * Wet eyes reflect less sky than a mirror (at full strength the whites mirror the blue sky and
 * read as glassy blue), the sclera is an off-white, and it darkens toward the lids.
 */
function eyeShading(m: THREE.MeshStandardMaterial) {
  m.envMapIntensity = 0.18;
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      #ifdef USE_MAP
        diffuseColor.rgb *= vec3( 0.9, 0.86, 0.82 ) * mix( 1.0, 0.62, smoothstep( 0.16, 0.42, length( vMapUv - 0.5 ) ) );
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
  // follow-through: fast off the ball, easing into the finish, then a held finish
  private followElapsed = 0;
  private followDur = 0.9;
  private neck: THREE.Object3D | null = null;
  /** Shirt pattern (data/cosmetics code) and its accent colour, read by the shirt shader. */
  private shirtUniforms = { uPattern: { value: 0 }, uAccent: { value: new THREE.Color(0x1c2b4a) } };
  private finish = clubFinish('standard');
  private clubTier = 0;
  /** Chin lift (radians) on full swings: eyes on the ball without burying the chin. */
  static CHIN_LIFT = 0.13;
  /** Seconds over which the head comes up after impact to watch the ball. */
  static HEAD_RELEASE = 0.7;
  private head: THREE.Object3D | null = null;
  /** Head orientation (model space) at the last pre-impact pose, eased out of after impact. */
  private headHold = new THREE.Quaternion();
  private headHeld = false;
  /** Neck and head as the animation last posed them, before the chin lift / head hold. */
  private neckBase: THREE.Quaternion | null = null;
  private headBase: THREE.Quaternion | null = null;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
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
    this.mats.get('Shirt')?.forEach((m) => this.shirtPattern(m));
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
    this.neck = model.getObjectByName('Neck') ?? null;
    this.head = model.getObjectByName('Head') ?? null;
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

  private standardFace: THREE.Texture | null | undefined;
  private faceReq = 0;

  private applyFace(f: FaceStyle) {
    const skin = this.mats.get('Skin');
    if (!skin?.length) return;
    if (this.standardFace === undefined) this.standardFace = skin[0].map;
    const req = ++this.faceReq;
    const set = (t: THREE.Texture | null) => {
      if (req !== this.faceReq) return; // a later choice won the race
      for (const m of skin) {
        m.map = t;
        m.needsUpdate = true;
      }
    };
    if (f === 'Standard') set(this.standardFace);
    else faceMap(f).then(set, () => set(this.standardFace ?? null));
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
    this.applyFace(a.face ?? 'Standard');
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
    this.shirtUniforms.uPattern.value = shirtPatternCode(a.shirtPattern);
    this.shirtUniforms.uAccent.value.set(a.shirtAccent ?? '#1c2b4a');
    this.finish = clubFinish(a.clubFinish);
    this.paintClubHead();
  }

  /**
   * Shirt patterns drawn in the shader from the body's rest pose (metres, Y up, arms out): the
   * pattern stays put on the fabric however the golfer moves.
   */
  private shirtPattern(m: THREE.MeshStandardMaterial) {
    const u = this.shirtUniforms;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uPattern;
          uniform vec3 uAccent;
          varying vec3 vBind;
          float band(float v, float lo, float hi) {
            float w = fwidth(v);
            return smoothstep(lo - w, lo + w, v) - smoothstep(hi - w, hi + w, v);
          }
          float shirtMask() {
            vec3 p = vBind;
            float sleeve = smoothstep(0.19, 0.205, abs(p.x));
            if (uPattern < 0.5) return 0.0;
            // pinstripe: thin vertical lines down the body
            if (uPattern < 1.5) return (1.0 - sleeve) * band(fract(p.x * 26.0 + 0.5), 0.0, 0.2);
            // hoops: wide horizontal bands
            if (uPattern < 2.5) return band(fract((p.y - 1.0) * 8.0), 0.5, 1.0);
            // chest band
            if (uPattern < 3.5) return (1.0 - sleeve) * band(p.y, 1.31, 1.4);
            // two-tone: contrast sleeves
            return sleeve;
          }`,
        )
        .replace('#include <map_fragment>', 'diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, shirtMask());\n#include <map_fragment>');
    };
    m.customProgramCacheKey = () => 'golfer-shirt-v1';
    m.needsUpdate = true;
  }

  /** Club head look: the upgrade tier's, unless a level-unlocked finish is chosen. */
  private paintClubHead() {
    const h = this.finish.head ?? TIERS[this.clubTier].head;
    this.mats.get('ClubHead')?.forEach((m) => {
      m.color.setHex(h.color);
      m.metalness = h.metalness;
      m.roughness = h.roughness;
    });
  }

  setClub(model: string, tier: number) {
    for (const [n, o] of this.clubs) o.visible = n === model;
    this.clubTier = tier;
    this.paintClubHead();
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
    // the mixer only writes a bone when its animated value changes, so undo last frame's chin lift
    // and head hold first; otherwise they pile up frame after frame and the head spins
    if (this.neck && this.neckBase) this.neck.quaternion.copy(this.neckBase);
    if (this.head && this.headBase) this.head.quaternion.copy(this.headBase);
    this.mixer.update(0);
    if (this.neck) (this.neckBase ??= new THREE.Quaternion()).copy(this.neck.quaternion);
    if (this.head) (this.headBase ??= new THREE.Quaternion()).copy(this.head.quaternion);
    if (this.neck && clip.startsWith('Swing_') && this.anim !== 'Putt' && this.anim !== 'Chip') {
      const tm = this.timing;
      // lift the chin a little so the face shows over the ball, as on tour; eases out after impact
      const fade = time <= tm.impact ? 1 : Math.max(0, 1 - (time - tm.impact) / 0.3);
      if (fade > 0) this.neck.rotateX(-Golfer.CHIN_LIFT * fade);
      // the clip whips the head round to the target in a tenth of a second after impact; instead
      // it stays down through the ball and comes up smoothly to watch the shot
      const head = this.head;
      if (head?.parent) {
        if (time <= tm.impact) {
          this.modelQuat(head, this.headHold);
          this.headHeld = true;
        } else if (this.headHeld) {
          // real seconds since impact while playing (the follow-through runs faster than the
          // clip), clip time when a pose is set directly
          const since = this.phase === 'follow' ? this.followElapsed : time - tm.impact;
          const u = Math.min(1, since / Golfer.HEAD_RELEASE);
          const hold = 1 - u * u * (3 - 2 * u);
          if (hold > 0) {
            const want = this.modelQuat(head.parent, this.tmpQ).invert().multiply(this.headHold);
            head.quaternion.slerp(want, hold);
          }
        }
      }
    }
  }

  /** An object's orientation relative to the golfer model. */
  private modelQuat(o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    const model = this.model!;
    model.updateMatrixWorld(true);
    this.tmpM.copy(model.matrixWorld).invert().multiply(o.matrixWorld);
    this.tmpM.decompose(this.tmpV, out, this.tmpV);
    return out;
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
          // the club keeps accelerating all the way to the ball (fastest at impact)
          const e = 0.25 * u + 0.75 * u * u;
          this.t = this.downFrom + (tm.impact - this.downFrom) * e;
          this.applyPose(clip, this.t);
        }
        if (u >= 1) {
          this.t = tm.impact;
          this.phase = 'follow';
          this.followElapsed = 0;
          // leave the ball at the speed the club arrived with, then ease into the finish
          const arrive = (1.75 * Math.max(0.01, tm.impact - this.downFrom)) / this.downDur;
          this.followDur = THREE.MathUtils.clamp((3 * (tm.finish - tm.impact)) / arrive, 0.55, 1.3);
          if (!this.impactFired) {
            this.impactFired = true;
            this.onImpact?.();
          }
        }
        break;
      }
      case 'follow': {
        this.followElapsed += dt;
        if (this.anim === 'Putt' || this.anim === 'Chip') this.t += dt;
        else if (this.followElapsed < this.followDur) {
          const u = this.followElapsed / this.followDur;
          this.t = tm.impact + (tm.finish - tm.impact) * (1 - (1 - u) ** 3);
        } else this.t = tm.finish + (this.followElapsed - this.followDur);
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
