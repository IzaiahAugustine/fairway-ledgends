// The menu backdrop: a real course scene (Pebble Beach's 7th, by the ocean) with the player's
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

export type StageMode = 'menu' | 'editor' | 'shop' | 'none';

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

  constructor(renderer: THREE.WebGLRenderer) {
    this.env = new SkyEnvironment(renderer, this.scene);
    this.env.useSceneFog = false;
  }

  async build(quality: Quality) {
    const course = courseById('pebble');
    const field = new HoleField(course, 6, 7);
    this.field = field;
    const tex = await loadTerrainTextures();
    const terrain = buildTerrainMesh(field, course, tex, 2);
    this.scene.add(terrain);
    const outer = new OuterWorld(field, course, tex);
    this.scene.add(outer.group);
    const veg = new Vegetation();
    this.scene.add(veg.group);
    await veg.build(field, quality, outer);
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
    const loop = () => g.playClip('Idle', loop);
    loop();
    const bx = this.stand.x + right.x * 1.3 - field.teeDir.x * 0.8, bz = this.stand.z + right.z * 1.3 - field.teeDir.z * 0.8;
    props.placeBag(bx, bz, field.heightAt(bx, bz), Math.atan2(field.teeDir.x, field.teeDir.z) + 0.6);
    props.placeTeePeg(0, -10, 0, false);
    props.setFlagVisible(true);
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
    let pos: THREE.Vector3, look: THREE.Vector3, face: number;
    if (mode === 'editor' || mode === 'shop') {
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
    this.golfer.root.rotation.y = face;
    const k = this.first ? 1 : 1 - Math.exp(-dt * 4.5);
    this.first = false;
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
    this.grass?.update(camera, this.field.heightAt(camera.position.x, camera.position.z));
    this.env.focus(s);
  }
}
