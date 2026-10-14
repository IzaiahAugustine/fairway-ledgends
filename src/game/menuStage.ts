// The menu backdrop: a real course scene (Coral Cove's 6th, by the sea) with the player's
// golfer standing on the tee, lit and rendered exactly like a round, with a slow cinematic drift.
import * as THREE from 'three';
import type { Appearance, Quality } from '../core/save';
import { courseById } from '../data/courses';
import { SkyEnvironment } from '../world/environment';
import { GrassField } from '../world/grass';
import { HoleField } from '../world/holeGen';
import { OuterWorld } from '../world/outerWorld';
import { CourseProps } from '../world/props';
import { buildTerrainMesh, loadTerrainTextures, terrainTime } from '../world/terrain';
import { Vegetation, setVegetationWind } from '../world/vegetation';
import { Golfer } from './golfer';
import { sfx } from '../audio/sfx';
import type { SwingStyle } from '../data/swingStyles';

export type StageMode = 'menu' | 'editor' | 'shop' | 'swing' | 'none';

export class MenuStage {
  readonly scene = new THREE.Scene();
  readonly env: SkyEnvironment;
  golfer: Golfer | null = null;
  private field: HoleField | null = null;
  private grass: GrassField | null = null;
  private stand = new THREE.Vector3();
  private down = new THREE.Vector2(0, -1);
  private t = 0;
  angle = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private first = true;
  private heightAt: (x: number, z: number) => number = () => 0;
  /** Swing-style screen: the golfer loops a driver swing in the selected style. */
  private demo: { style: SwingStyle; phase: 'address' | 'back' | 'down' | 'finish'; t: number } | null = null;
  private demoBall: THREE.Mesh | null = null;
  private idle = true;
  private props: CourseProps | null = null;
  private veg: Vegetation | null = null;
  private bagAt: [number, number, number, number] | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.env = new SkyEnvironment(renderer, this.scene);
    this.env.useSceneFog = false;
  }

  async build(quality: Quality) {
    const course = courseById('coral-cove');
    const field = new HoleField(course, 5, 7);
    this.field = field;
    const tex = await loadTerrainTextures();
    const terrain = buildTerrainMesh(field, course, tex, 2);
    this.scene.add(terrain);
    const outer = new OuterWorld(field, course, tex);
    this.scene.add(outer.group);
    const veg = new Vegetation();
    this.scene.add(veg.group);
    await veg.build(field, quality, outer);
    this.veg = veg;
    this.grass = new GrassField(field, course, tex, terrain.userData.maps, quality);
    this.scene.add(this.grass.group);
    const props = new CourseProps(this.scene);
    await props.init();
    props.place(field);
    const playDir = new THREE.Vector2(field.cup.x - field.tee.x, field.cup.z - field.tee.z).normalize();
    this.down.copy(playDir);
    await this.env.apply(course.hdri, { envIntensity: course.envIntensity * 0.75, sunIntensity: course.sunIntensity * 1.35, playDir, sunOffsetDeg: 205 });
    this.env.haze = { density: 0.00026, falloff: 1 / 380, base: Math.min(field.teeH, field.seaLevel + 12) - 8, skyHaze: 0.55 };
    this.env.setShadowExtent(18);
    setVegetationWind(2.2, 1.1);
    this.grass.setWind(2.2, 1.1);
    props.setWind(2.2, 1.1);
    // the golfer stands on the tee box, beside the markers
    const t = field.tee;
    const right = { x: -field.teeDir.z, z: field.teeDir.x };
    this.stand.set(t.x + right.x * 0.6 - field.teeDir.x * 1.5, 0, t.z + right.z * 0.6 - field.teeDir.z * 1.5);
    this.stand.y = field.heightAt(this.stand.x, this.stand.z);
    const g = await Golfer.create();
    g.setClub('Club_Iron', 0);
    g.root.position.copy(this.stand);
    this.scene.add(g.root);
    this.golfer = g;
    this.heightAt = (x, z) => field.heightAt(x, z);
    this.startIdle();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.0235, 24, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }));
    ball.castShadow = true;
    ball.visible = false;
    this.scene.add(ball);
    this.demoBall = ball;
    const bx = this.stand.x + right.x * 1.3 - field.teeDir.x * 0.8, bz = this.stand.z + right.z * 1.3 - field.teeDir.z * 0.8;
    props.placeBag(bx, bz, field.heightAt(bx, bz), Math.atan2(field.teeDir.x, field.teeDir.z) + 0.6);
    this.props = props;
    this.bagAt = [bx, bz, field.heightAt(bx, bz), Math.atan2(field.teeDir.x, field.teeDir.z) + 0.6];
    props.placeTeePeg(0, -10, 0, false);
    props.setFlagVisible(true);
  }

  private startIdle() {
    const g = this.golfer;
    if (!g) return;
    this.idle = true;
    g.swingLength = 1;
    g.swingSpeed = 1;
    g.root.position.copy(this.stand);
    const loop = () => {
      if (this.idle) g.playClip('Idle', loop);
    };
    loop();
  }

  /** Show a style's swing on loop (null: back to standing idle). */
  setSwingDemo(style: SwingStyle | null) {
    const g = this.golfer;
    if (!g) return;
    if (!style) {
      if (this.demo) {
        this.demo = null;
        if (this.demoBall) this.demoBall.visible = false;
        if (this.bagAt) this.props?.placeBag(...this.bagAt);
        g.setClub('Club_Iron', 0);
        this.startIdle();
      }
      return;
    }
    this.idle = false;
    g.swingLength = Math.min(1, style.backswing);
    g.swingSpeed = style.downswing;
    if (!this.demo) g.setClub('Club_Driver', 0);
    // the bag would stand between the camera and the swing
    this.props?.hideBag();
    this.demo = { style, phase: 'address', t: 0 };
    this.addressDemo();
  }

  private addressDemo() {
    const g = this.golfer!;
    const d = this.down;
    g.placeForShot(this.stand, d.x, d.y, 'Driver', this.heightAt);
    if (this.demoBall) {
      this.demoBall.position.set(this.stand.x, this.heightAt(this.stand.x, this.stand.z) + 0.045, this.stand.z);
      this.demoBall.visible = true;
    }
  }

  private updateDemo(dt: number) {
    const D = this.demo!, g = this.golfer!, st = D.style;
    D.t += dt;
    // backswing time follows the style's tempo: quick for the bomber, unhurried for smooth tempo
    const backDur = 0.9 * st.tempoSpeed * (0.85 + 0.15 * st.backswing);
    if (D.phase === 'address' && D.t > 0.9) {
      D.phase = 'back';
      D.t = 0;
    } else if (D.phase === 'back') {
      const u = Math.min(1, D.t / backDur);
      g.setBackswing(1 - (1 - u) * (1 - u) * (1 - u * 0.4));
      if (u >= 1 && D.t > backDur + 0.08) {
        D.phase = 'down';
        D.t = 0;
        sfx.swoosh(st.power > 1.02 ? 1.2 : st.backswing < 0.95 ? 0.8 : 1);
        g.startDownswing(0.24, () => {
          sfx.strike('driver', 1);
          if (this.demoBall) this.demoBall.visible = false;
        });
      }
    } else if (D.phase === 'down' && D.t > 1.0) {
      D.phase = 'finish';
      D.t = 0;
    } else if (D.phase === 'finish' && D.t > 1.6) {
      D.phase = 'address';
      D.t = 0;
      this.addressDemo();
    }
  }

  applyAppearance(a: Appearance) {
    this.golfer?.applyAppearance(a);
  }

  setClub(model: string, tier: number) {
    this.golfer?.setClub(model, tier);
  }

  /** Horizontal direction from the golfer to the editor camera: 0.85 rad off the sun, on the side nearer the tee. */
  private editorCamDir(fwd: THREE.Vector3): THREE.Vector3 {
    const sun = this.env.sunDirWorld;
    const az = Math.atan2(sun.x, sun.z);
    const a = new THREE.Vector3(Math.sin(az + 0.85), 0, Math.cos(az + 0.85));
    const b = new THREE.Vector3(Math.sin(az - 0.85), 0, Math.cos(az - 0.85));
    return a.dot(fwd) < b.dot(fwd) ? a : b;
  }

  /** Frames the golfer: on the right of the screen for the main menu, left for the editor. */
  update(dt: number, camera: THREE.PerspectiveCamera, mode: StageMode, dragging: boolean) {
    if (!this.field || !this.golfer) return;
    this.t += dt;
    terrainTime.value += dt;
    this.golfer.update(dt);
    const d = this.down;
    const right = new THREE.Vector3(-d.y, 0, d.x);
    const fwd = new THREE.Vector3(d.x, 0, d.y);
    const s = this.stand;
    let pos: THREE.Vector3, look: THREE.Vector3, face: number | null = null;
    if (mode === 'swing') {
      if (this.demo) this.updateDemo(dt);
      // face-on, the way swings are filmed on tour: camera opposite the golfer's chest, the golfer
      // framed on the left (the panel is on the right)
      const gp = this.golfer.root.position;
      // halfway between the golfer and the ball, so both are in the shot
      const mid = gp.clone().lerp(this.stand, 0.5);
      const side = new THREE.Vector3().subVectors(this.stand, gp).setY(0).normalize();
      pos = mid.clone().addScaledVector(side, 3.4).addScaledVector(fwd, 0.25);
      pos.y = gp.y + 1.0;
      // aim to the right of the golfer so they sit in the left part of the screen
      // camera's right = view direction (-side) x up
      const screenRight = new THREE.Vector3(side.z, 0, -side.x);
      look = mid.clone().addScaledVector(screenRight, 0.95);
      look.y = gp.y + 0.92;
    } else if (mode === 'editor' || mode === 'shop') {
      if (!dragging) this.angle += dt * 0.12;
      // camera on the sunny side, a little off the sun line so the face has some modelling;
      // golfer framed on the left (the panel is on the right)
      const camDir = this.editorCamDir(fwd);
      const lookDir = camDir.clone().negate();
      const screenRight = new THREE.Vector3(-lookDir.z, 0, lookDir.x);
      pos = s.clone().addScaledVector(camDir, 3.5).addScaledVector(screenRight, -0.4);
      pos.y = s.y + 1.35;
      look = s.clone().addScaledVector(screenRight, 1.05);
      look.y = s.y + 0.98;
      face = Math.atan2(camDir.x, camDir.z) + this.angle;
    } else {
      // behind and left of the golfer looking down the hole to the green and the ocean;
      // the golfer sits on the right third, turned three-quarters toward the camera
      const drift = Math.sin(this.t * 0.06) * 0.25;
      pos = s.clone().addScaledVector(fwd, -4.2 + drift).addScaledVector(right, -1.0);
      pos.y = s.y + 1.5;
      look = s.clone().addScaledVector(fwd, 20).addScaledVector(right, -4.0);
      look.y = s.y + 0.6;
      const toCam = pos.clone().sub(s);
      face = Math.atan2(toCam.x, toCam.z) + 0.55;
    }
    if (face !== null) this.golfer.root.rotation.y = face;
    const k = this.first ? 1 : 1 - Math.exp(-dt * 4.5);
    this.first = false;
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
    this.grass?.update(camera, this.field.heightAt(camera.position.x, camera.position.z));
    this.veg?.cull(camera);
    this.env.focus(s);
  }
}
