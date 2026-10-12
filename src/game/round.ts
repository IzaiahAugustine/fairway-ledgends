// One 9-hole match: loads each hole, runs player and AI turns, plays shots back, applies
// penalties and gimmes, resolves holes in match play and reports the result.
import * as THREE from 'three';
import { sfx } from '../audio/sfx';
import { Rng, clamp, toYards } from '../core/rng';
import { playerLevel, save, type Appearance, type Difficulty } from '../core/save';
import { CLUBS, PUTT_SHOT, SHOT_TYPES, TIERS, animFor, type ClubDef, type ShotTypeDef } from '../data/clubs';
import type { CourseDef } from '../data/courses';
import { TreeIndex, sampleAt, simulateShot, type SimEnv, type SimResult } from '../physics/ballPhysics';
import { Hud } from '../ui/hud';
import { SkyEnvironment } from '../world/environment';
import { HoleField, SURF_NAME, Surf } from '../world/holeGen';
import { AimOverlay, GreenGrid } from '../world/overlays';
import { Ball, CourseProps } from '../world/props';
import { buildTerrainMesh, cloudUniforms, loadTerrainTextures, terrainTime } from '../world/terrain';
import { GrassField } from '../world/grass';
import { OuterWorld } from '../world/outerWorld';
import { Vegetation, setVegetationWind } from '../world/vegetation';
import { AI_SKILL, planAiShot } from './ai';
import { CameraDirector } from './cameraDirector';
import { Golfer } from './golfer';
import { MatchState, WIN_XP, bonusXp, scoreName, xpMul, type Side } from './match';
import { PERFECT_SWING, errorScale, fullCarry, launchFor, lieMods, type ShotSetup, type SwingResult } from './shotModel';
import { SwingInput } from './swingInput';

export interface RoundConfig {
  course: CourseDef;
  difficulty: Difficulty;
  opponent: { name: string; appearance: Appearance };
  seed: number;
}

export interface RoundResult {
  match: MatchState;
  course: CourseDef;
  difficulty: Difficulty;
  opponentName: string;
  quit: boolean;
}

interface Competitor {
  side: Side;
  name: string;
  color: string;
  golfer: Golfer;
  ball: Ball;
  pos: THREE.Vector3;
  lie: Surf;
  teed: boolean;
  strokes: number;
  holed: boolean;
  pickedUp: boolean;
  prev: { pos: THREE.Vector3; lie: Surf; teed: boolean };
  tiers: Record<string, number>;
}

type State = 'loading' | 'intro' | 'aim' | 'swing' | 'flight' | 'ai' | 'between' | 'over';

const PUTT_SCALES = [3, 6, 10, 15, 22, 30, 42];
/** Putts inside this range (metres) are conceded. */
const GIMME: Record<Difficulty, number> = { easy: 1.25, medium: 0.95, hard: 0.75 };

export class Round {
  private state: State = 'loading';
  private match: MatchState;
  private holeIdx = 0;
  private field!: HoleField;
  private terrain: THREE.Group | null = null;
  private outer: OuterWorld | null = null;
  private grass: GrassField | null = null;
  private veg = new Vegetation();
  private props: CourseProps;
  private overlay: AimOverlay;
  private grid: GreenGrid;
  private cam: CameraDirector;
  private swing: SwingInput;
  private player!: Competitor;
  private ai!: Competitor;
  private current!: Competitor;
  private honor: Side = 'player';
  private rng: Rng;
  private wind = { x: 0, z: 0, mph: 0 };
  private treeIndex: TreeIndex | null = null;
  // aim state
  private clubIdx = 0;
  private shotIdx = 0;
  private power = 1;
  private aimAngle = 0;
  private puttScale = 6;
  private previewDirty = true;
  private previewTimer = 0;
  private lastPreview: SimResult | null = null;
  private keys = new Set<string>();
  private targetView = false;
  private greenView = false;
  // flight playback
  private tmpFwd = new THREE.Vector3();
  private tmpFocus = new THREE.Vector3();
  private lastSwingXp: number | null = null;
  private flight: { comp: Competitor; r: SimResult; t: number; ev: number; setup: ShotSetup; swing: SwingResult; start: THREE.Vector3; speed: number } | null = null;
  private tmp = new THREE.Vector3();
  private timers: { t: number; fn: () => void }[] = [];
  private disposed = false;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e, true);
  private keyUpHandler = (e: KeyboardEvent) => this.onKey(e, false);
  private wheelHandler = (e: WheelEvent) => this.onWheel(e);
  paused = false;
  onExit: ((r: RoundResult) => void) | null = null;
  onPause: (() => void) | null = null;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private env: SkyEnvironment,
    private hud: Hud,
    private canvas: HTMLCanvasElement,
    private cfg: RoundConfig,
  ) {
    this.rng = new Rng(cfg.seed);
    this.match = new MatchState(cfg.course.holes.map((h) => h.par));
    this.props = new CourseProps(scene);
    this.overlay = new AimOverlay(scene);
    this.grid = new GreenGrid(scene);
    this.cam = new CameraDirector(camera);
    this.scene.add(this.veg.group);
    this.swing = new SwingInput(canvas, {
      onBackswing: (f) => this.onBackswing(f),
      onDownswing: () => {},
      onResult: (r) => this.onSwingResult(r),
      onCancel: () => {
        this.player.golfer.cancelSwing();
        if (this.state === 'swing') this.state = 'aim';
      },
      onMeter: (m) => this.hud.meterState(m),
    });
    this.swing.mode = save.settings.swingMode;
    this.swing.difficulty = cfg.difficulty;
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('keyup', this.keyUpHandler);
    canvas.addEventListener('wheel', this.wheelHandler, { passive: false });
  }

  async start() {
    const pg = await Golfer.create();
    pg.applyAppearance(save.appearance);
    const ag = await Golfer.create();
    ag.applyAppearance(this.cfg.opponent.appearance);
    this.scene.add(pg.root, ag.root);
    const aiTier = AI_SKILL[this.cfg.difficulty].tier;
    const aiTiers: Record<string, number> = {};
    for (const c of CLUBS) aiTiers[c.id] = aiTier;
    const mk = (side: Side, name: string, color: string, golfer: Golfer, tiers: Record<string, number>): Competitor => ({
      side, name, color, golfer, ball: new Ball(this.scene, 0xffffff, color), pos: new THREE.Vector3(), lie: Surf.Tee, teed: true, strokes: 0, holed: false, pickedUp: false,
      prev: { pos: new THREE.Vector3(), lie: Surf.Tee, teed: true }, tiers,
    });
    this.player = mk('player', save.name || 'Player', '#f2c14e', pg, save.clubs);
    this.ai = mk('ai', this.cfg.opponent.name, '#ff6b5b', ag, aiTiers);
    this.current = this.player;
    await this.props.init();
    await loadTerrainTextures();
    this.hud.show(true);
    this.hud.setHelp(false, save.settings.swingMode);
    sfx.startAmbience();
    await this.loadHole(0);
  }

  // ---------------------------------------------------------------- holes

  private async loadHole(i: number) {
    this.state = 'loading';
    this.holeIdx = i;
    this.match.current = i;
    this.hud.setAimUi(false);
    this.overlay.hide();
    this.grid.setVisible(false);
    const course = this.cfg.course;
    const q = save.settings.quality;
    this.unloadTerrain();
    this.veg.dispose();
    const field = new HoleField(course, i, this.cfg.seed + i * 977);
    this.field = field;
    const tex = await loadTerrainTextures();
    this.terrain = buildTerrainMesh(field, course, tex, q === 'high' ? 2 : q === 'medium' ? 3 : 4);
    this.scene.add(this.terrain);
    this.outer = new OuterWorld(field, course, tex);
    this.scene.add(this.outer.group);
    this.grass = new GrassField(field, course, tex, this.terrain.userData.maps, q);
    this.scene.add(this.grass.group);
    await this.veg.build(field, q, this.outer ?? undefined);
    this.treeIndex = new TreeIndex(this.veg.colliders);
    this.props.place(field);
    this.props.setFlagVisible(true);
    this.grid.build(field, field.cup.x, field.cup.z, Math.max(field.green.rx, field.green.rz) * 1.5);
    const playDir = new THREE.Vector2(field.cup.x - field.tee.x, field.cup.z - field.tee.z).normalize();
    // a strong key sun with less sky fill reads as a bright broadcast day
    await this.env.apply(course.hdri, { envIntensity: course.envIntensity * 0.75, sunIntensity: course.sunIntensity * 1.35, playDir, sunOffsetDeg: 150 + this.rng.range(-35, 35) });
    const misty = course.id === 'standrews';
    this.env.haze = {
      density: misty ? 0.0007 : course.style === 'coastal' ? 0.00026 : 0.00022,
      falloff: 1 / 380,
      base: Math.min(field.teeH, field.seaLevel + 12) - 8,
      skyHaze: misty ? 0.85 : 0.55,
    };
    // wind
    const mph = this.rng.range(course.windMin, course.windMax);
    const wa = this.rng.range(0, Math.PI * 2);
    this.wind = { x: Math.cos(wa) * mph * 0.447 * 0.75, z: Math.sin(wa) * mph * 0.447 * 0.75, mph };
    this.props.setWind(this.wind.x, this.wind.z);
    setVegetationWind(this.wind.x, this.wind.z);
    this.grass?.setWind(this.wind.x, this.wind.z);
    // cloud shadows drift with the wind
    const cs = (mph * 0.447 + 4) * 0.0016 * 0.6;
    cloudUniforms.uCloud.value.set(Math.cos(wa) * cs, Math.sin(wa) * cs);
    cloudUniforms.uCloudCover.value = course.id === 'standrews' ? 0.45 : course.id === 'pebble' ? 0.18 : 0.3;
    // competitors to the tee
    const t = field.tee;
    const right = { x: -field.teeDir.z, z: field.teeDir.x };
    for (const c of [this.player, this.ai]) {
      const off = c.side === 'player' ? -0.8 : 0.8;
      const x = t.x + right.x * off, z = t.z + right.z * off;
      c.pos.set(x, field.heightAt(x, z), z);
      c.lie = Surf.Tee;
      c.teed = true;
      c.strokes = 0;
      c.holed = false;
      c.pickedUp = false;
      c.ball.setVisible(true);
      c.ball.clearTracer();
      c.golfer.root.visible = false;
    }
    this.placeBall(this.player);
    this.placeBall(this.ai);
    this.hud.buildMinimap(field);
    const d = course.holes[i];
    this.hud.setHole(course.name, i + 1, d.par, d.yards, d.name);
    this.refreshHudScores();
    this.hud.setMatch(this.match.statusText(), this.match.holes, i);
    this.refreshXp();
    // flyover intro
    this.state = 'intro';
    this.hud.showIntro(i + 1, d.par, d.yards, d.name, `${course.name} · ${this.match.statusText()}`);
    this.cam.startFlyover(field, () => {
      this.hud.hideIntro();
      this.beginTurn();
    });
  }

  private unloadTerrain() {
    if (this.grass) {
      this.scene.remove(this.grass.group);
      this.grass.dispose();
      this.grass = null;
    }
    if (this.outer) {
      this.scene.remove(this.outer.group);
      this.outer.dispose();
      this.outer = null;
    }
    if (!this.terrain) return;
    this.scene.remove(this.terrain);
    this.terrain.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      for (const d of (m.userData.disposables ?? []) as { dispose(): void }[]) d.dispose();
    });
    this.terrain = null;
  }

  private placeBall(c: Competitor) {
    const y = this.field.heightAt(c.pos.x, c.pos.z);
    c.pos.y = y + (c.teed ? 0.045 : 0.0213);
    c.ball.setPosition(c.pos, y);
  }

  private refreshHudScores() {
    const row = (c: Competitor) => ({ name: c.name, strokes: c.strokes, color: c.color, active: c === this.current && this.state !== 'between', holed: c.holed, lie: SURF_NAME[c.lie] });
    this.hud.setStrokes([row(this.player), row(this.ai)]);
  }

  /** Keep the sun's shadow map over what the camera is looking at. */
  private updateShadowFocus() {
    const fwd = this.tmpFwd;
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const wide = this.cam.mode === 'flight' || this.cam.mode === 'target' || this.cam.mode === 'flyover' || this.cam.mode === 'green';
    const ext = wide ? 130 : 70;
    if (this.env.shadowSize !== ext) this.env.setShadowExtent(ext);
    const p = this.tmpFocus.copy(this.camera.position).addScaledVector(fwd, ext * 0.62);
    p.y = this.field.heightAt(p.x, p.z);
    this.env.focus(p);
  }

  private distToCup(c: Competitor) {
    return Math.hypot(c.pos.x - this.field.cup.x, c.pos.z - this.field.cup.z);
  }

  private nextCompetitor(): Competitor | null {
    const open = [this.player, this.ai].filter((c) => !c.holed && !c.pickedUp);
    if (open.length === 0) return null;
    if (open.length === 1) return open[0];
    const notStarted = open.filter((c) => c.strokes === 0);
    if (notStarted.length === 2) return this.honor === 'player' ? this.player : this.ai;
    if (notStarted.length === 1) return notStarted[0];
    return this.distToCup(this.player) >= this.distToCup(this.ai) ? this.player : this.ai;
  }

  private beginTurn() {
    if (this.disposed) return;
    const next = this.nextCompetitor();
    if (!next) {
      this.endHole();
      return;
    }
    this.current = next;
    this.refreshHudScores();
    // hide the other golfer, show this one
    for (const c of [this.player, this.ai]) c.golfer.root.visible = c === next;
    this.env.focus(next.pos);
    const onGreen = next.lie === Surf.Green;
    this.props.setFlagVisible(!onGreen);
    if (next.side === 'player') this.setupPlayerAim();
    else void this.aiTurn();
  }

  // ---------------------------------------------------------------- player aiming

  private get club(): ClubDef {
    return CLUBS[this.clubIdx];
  }

  private allowedShots(club: ClubDef): ShotTypeDef[] {
    if (club.kind === 'putter') return [PUTT_SHOT];
    return SHOT_TYPES.filter((s) => s.allowed(club));
  }

  private get shotType(): ShotTypeDef {
    const list = this.allowedShots(this.club);
    return list[Math.min(this.shotIdx, list.length - 1)];
  }

  private setupPlayerAim() {
    const c = this.player;
    this.state = 'aim';
    this.targetView = false;
    this.greenView = false;
    const dist = this.distToCup(c);
    // choose a club
    if (c.lie === Surf.Green || (c.lie === Surf.Fringe && dist < 12)) this.clubIdx = CLUBS.length - 1;
    else this.clubIdx = this.suggestClubIdx(dist);
    this.shotIdx = 0;
    if (this.club.kind !== 'putter' && dist < 40) {
      const list = this.allowedShots(this.club);
      const chip = list.findIndex((s) => s.id === 'chip');
      if (chip >= 0) this.shotIdx = chip;
    }
    this.resetAim();
    this.hud.setTurn('YOUR SHOT');
    this.hud.setAimUi(true);
    this.hud.setHelp(this.club.kind === 'putter', save.settings.swingMode);
    this.swing.reset();
    this.swing.enabled = true;
  }

  private suggestClubIdx(dist: number): number {
    const c = this.player;
    const allowDriver = c.teed && this.field.def.par > 3;
    let best = 0, bestErr = Infinity;
    CLUBS.forEach((cl, i) => {
      if (cl.kind === 'putter') return;
      if (cl.kind === 'driver' && !allowDriver) return;
      const full = fullCarry(cl, c.tiers[cl.id] ?? 0, SHOT_TYPES[0], c.lie, c.teed) * 1.06;
      const need = dist / full;
      const err = need > 1.0 ? (need - 1) * 3 : Math.abs(0.92 - need);
      if (err < bestErr) { bestErr = err; best = i; }
    });
    return best;
  }

  private resetAim() {
    const c = this.player;
    const club = this.club;
    const cup = this.field.cup;
    let tx = cup.x, tz = cup.z;
    const dist = this.distToCup(c);
    if (club.kind !== 'putter') {
      const full = fullCarry(club, c.tiers[club.id] ?? 0, this.shotType, c.lie, c.teed);
      if (full * 1.12 < dist - 15) {
        // lay up along the centre line
        let s = Math.max(0, this.field.pathCoords(c.pos.x, c.pos.z).s);
        let p = this.field.pointAt(s);
        while (s < this.field.length && Math.hypot(p.x - c.pos.x, p.z - c.pos.z) < full * 1.08) { s += 2; p = this.field.pointAt(s); }
        tx = p.x; tz = p.z;
      }
    }
    this.aimAngle = Math.atan2(tx - c.pos.x, -(tz - c.pos.z));
    this.autoPower();
    this.applyAimPose();
    this.previewDirty = true;
  }

  private get aimDir() {
    return { x: Math.sin(this.aimAngle), z: -Math.cos(this.aimAngle) };
  }

  private currentSetup(power = this.power): ShotSetup {
    const c = this.player;
    const a = this.aimDir;
    return { club: this.club, tier: c.tiers[this.club.id] ?? 0, shot: this.shotType, power, aimX: a.x, aimZ: a.z, x: c.pos.x, y: c.pos.y, z: c.pos.z, lie: c.lie, teed: c.teed, puttScale: this.puttScale };
  }

  private simEnv(forPreview: boolean, putting: boolean): SimEnv {
    return {
      ground: this.field,
      wind: { x: this.wind.x, z: this.wind.z },
      firmness: this.cfg.course.firmness,
      cup: this.field.cup,
      flagIn: !putting,
      trees: forPreview ? undefined : this.treeIndex ?? undefined,
      seed: forPreview ? 1 : this.rng.int(1, 1e9),
    };
  }

  private autoPower() {
    const c = this.player;
    const dist = this.distToCup(c);
    if (this.club.kind === 'putter') {
      const flat = dist + 0.3;
      this.puttScale = PUTT_SCALES.find((s) => s >= flat * 1.15) ?? PUTT_SCALES[PUTT_SCALES.length - 1];
      // account for elevation (fully on easy, partly on harder settings)
      const dh = this.field.heightAt(this.field.cup.x, this.field.cup.z) - this.field.heightAt(c.pos.x, c.pos.z);
      const target = flat + dh * (this.cfg.difficulty === 'easy' ? 9 : this.cfg.difficulty === 'medium' ? 7 : 5);
      this.power = clamp(target / this.puttScale, 0.03, 1);
      this.swing.target = this.power;
      return;
    }
    const full = fullCarry(this.club, c.tiers[this.club.id] ?? 0, this.shotType, c.lie, c.teed);
    let p = clamp(dist / (full * 1.08), 0.2, 1);
    // refine on the real terrain so the ball finishes near the pin when it is reachable
    if (dist < full * 1.15) {
      for (let k = 0; k < 3; k++) {
        const r = simulateShot(launchFor(this.currentSetup(p), PERFECT_SWING(p)), this.simEnv(true, false));
        const tot = Math.hypot(r.rest.x - c.pos.x, r.rest.z - c.pos.z);
        if (tot < 1) break;
        p = clamp(p * (dist / tot), 0.15, 1);
      }
    } else p = 1;
    this.power = Math.round(p * 100) / 100;
    this.swing.target = this.power;
  }

  private applyAimPose() {
    const c = this.player;
    const a = this.aimDir;
    const anim = animFor(this.club, this.shotType);
    c.golfer.setClub(this.club.model, c.tiers[this.club.id] ?? 0);
    c.golfer.placeForShot(c.pos, a.x, a.z, anim, (x, z) => this.field.heightAt(x, z));
    const putting = this.club.kind === 'putter';
    if (!this.targetView && !this.greenView) this.cam.setAddress(this.field, c.pos, a.x, a.z, putting, false, this.targetHeight());
    this.placeBag(c);
    this.props.placeTeePeg(c.pos.x, this.field.heightAt(c.pos.x, c.pos.z), c.pos.z, c.teed && this.club.kind !== 'putter');
    this.swing.putting = putting;
    this.swing.errScale = putting ? Math.pow(1 / TIERS[c.tiers[this.club.id] ?? 0].accuracy, 0.9) : errorScale(this.currentSetup());
    this.hud.setHelp(putting, save.settings.swingMode);
  }

  /** Ground height where the current shot is aimed (for camera framing). */
  private targetHeight(): number {
    const r = this.lastPreview;
    if (r && r.landing) return r.landing.y;
    const c = this.field.cup;
    return this.field.heightAt(c.x, c.z);
  }

  private placeBag(c: Competitor) {
    const a = this.aimDir;
    const right = { x: -a.z, z: a.x };
    const x = c.pos.x - a.x * 2.4 - right.x * 1.6, z = c.pos.z - a.z * 2.4 - right.z * 1.6;
    if (this.field.surfAt(x, z) === Surf.Water) this.props.hideBag();
    else this.props.placeBag(x, z, this.field.heightAt(x, z), this.aimAngle, save.appearance.shirt);
  }

  private updatePreview() {
    const c = this.player;
    const putting = this.club.kind === 'putter';
    const setup = this.currentSetup();
    const r = simulateShot(launchFor(setup, PERFECT_SWING(this.power)), this.simEnv(true, putting));
    this.lastPreview = r;
    const diff = this.cfg.difficulty;
    if (putting) {
      this.overlay.showPutt(this.field, r, diff === 'easy' ? 1 : diff === 'medium' ? 0.75 : 0.4);
      this.grid.setVisible(true, 1);
    } else {
      const dist = this.camera.position.distanceTo(r.landing ? this.tmp.set(r.landing.x, r.landing.y, r.landing.z) : c.pos);
      this.overlay.showShot(this.field, r, { arc: true, rest: diff !== 'hard', landingScale: clamp(dist / 60, 0.35, 3) });
      this.grid.setVisible(c.lie === Surf.Fringe || this.distToCup(c) < 40, 0.6);
    }
    const lm = lieMods(c.lie, this.club, c.teed);
    const cupH = this.field.heightAt(this.field.cup.x, this.field.cup.z);
    this.hud.setShotInfo({
      club: this.club.name,
      tier: c.tiers[this.club.id] ?? 0,
      shotName: this.shotType.name,
      shotDesc: this.shotType.desc,
      lie: putting && c.lie === Surf.Green ? 'Green' : lm.label,
      toPin: this.distToCup(c),
      elevation: cupH - this.field.heightAt(c.pos.x, c.pos.z),
      power: this.power,
      carry: putting ? null : r.carry,
      total: putting ? null : diff === 'hard' ? null : r.total,
      putting,
      puttScale: this.puttScale,
    });
    this.hud.setClubBar(
      CLUBS.map((cl) => ({ short: cl.short, tier: c.tiers[cl.id] ?? 0, carry: cl.kind === 'putter' ? 0 : fullCarry(cl, c.tiers[cl.id] ?? 0, SHOT_TYPES[0], c.lie, c.teed), enabled: true })),
      this.clubIdx,
    );
    this.swing.target = this.power;
    this.hud.meterState({ mode: save.settings.swingMode, phase: 'idle', power: 0, needle: 0, drift: 0, target: this.power, zone: 0.04 });
  }

  // ---------------------------------------------------------------- input

  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.disposed) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'Tab') {
      e.preventDefault();
      this.hud.showScorecard(down, this.scorecardData());
      return;
    }
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down) return;
    if (k === 'Escape') {
      this.onPause?.();
      return;
    }
    if (this.paused) return;
    if (k === ' ') {
      e.preventDefault();
      if (this.state === 'intro') this.cam.skipFlyover();
      return;
    }
    if (this.state !== 'aim' || this.swing.active) return;
    const putting = this.club.kind === 'putter';
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      const n = CLUBS.length;
      this.clubIdx = (this.clubIdx + (k === 'ArrowRight' ? 1 : n - 1)) % n;
      if (this.club.kind === 'driver' && !(this.player.teed || this.player.lie === Surf.Fairway)) this.clubIdx = (this.clubIdx + (k === 'ArrowRight' ? 1 : n - 1)) % n;
      this.shotIdx = 0;
      this.resetAim();
    } else if ((k === 'q' || k === 'e') && !putting) {
      const list = this.allowedShots(this.club);
      this.shotIdx = (this.shotIdx + (k === 'e' ? 1 : list.length - 1)) % list.length;
      this.autoPower();
      this.applyAimPose();
      this.previewDirty = true;
    } else if (k === 'r') {
      this.resetAim();
    } else if (k === 'v') {
      this.targetView = !this.targetView;
      this.greenView = false;
      if (this.targetView && this.lastPreview) {
        const r = this.lastPreview;
        const p = r.landing ?? r.rest;
        this.cam.setTargetView(this.field, new THREE.Vector3(p.x, p.y, p.z), this.player.pos);
      } else this.applyAimPose();
    } else if (k === 'g') {
      this.greenView = !this.greenView;
      this.targetView = false;
      if (this.greenView) {
        this.cam.setGreenView(this.field, this.player.pos, this.field.cup);
        this.grid.setVisible(true, 1);
      } else this.applyAimPose();
    }
  }

  private onWheel(e: WheelEvent) {
    if (this.state !== 'aim' || this.swing.active) return;
    e.preventDefault();
    this.power = clamp(this.power + (e.deltaY < 0 ? 0.01 : -0.01), 0.03, 1);
    this.previewDirty = true;
  }

  private handleHeldKeys(dt: number) {
    if (this.state !== 'aim' || this.swing.active) return;
    const putting = this.club.kind === 'putter';
    const fine = this.keys.has('Shift');
    let changed = false;
    const aimRate = ((putting ? (fine ? 1.5 : 7) : fine ? 4 : 22) * Math.PI) / 180;
    if (this.keys.has('a')) { this.aimAngle -= aimRate * dt; changed = true; }
    if (this.keys.has('d')) { this.aimAngle += aimRate * dt; changed = true; }
    const pRate = fine ? 0.08 : 0.35;
    if (this.keys.has('w')) { this.power = clamp(this.power + pRate * dt, 0.03, 1); changed = true; }
    if (this.keys.has('s')) { this.power = clamp(this.power - pRate * dt, 0.03, 1); changed = true; }
    if (this.keys.has('ArrowUp')) { this.power = clamp(this.power + pRate * dt, 0.03, 1); changed = true; }
    if (this.keys.has('ArrowDown')) { this.power = clamp(this.power - pRate * dt, 0.03, 1); changed = true; }
    if (changed) {
      if (this.keys.has('a') || this.keys.has('d')) {
        const a = this.aimDir;
        const c = this.player;
        c.golfer.placeForShot(c.pos, a.x, a.z, animFor(this.club, this.shotType), (x, z) => this.field.heightAt(x, z));
        if (!this.targetView && !this.greenView) this.cam.setAddress(this.field, c.pos, a.x, a.z, putting, false, this.targetHeight());
        this.placeBag(c);
      }
      this.previewDirty = true;
    }
  }

  // ---------------------------------------------------------------- swinging

  private onBackswing(frac: number) {
    if (this.state !== 'aim' && this.state !== 'swing') return;
    if (this.state === 'aim') {
      this.state = 'swing';
      // swing from the address view
      if (this.targetView || this.greenView) {
        this.targetView = this.greenView = false;
        this.applyAimPose();
      }
    }
    this.player.golfer.setBackswing(frac);
  }

  private onSwingResult(r: SwingResult) {
    if (this.state !== 'swing' && this.state !== 'aim') return;
    this.state = 'swing';
    this.swing.enabled = false;
    const setup = this.currentSetup(r.power);
    const dur = save.settings.swingMode === 'stick' ? 0.2 : 0.22;
    this.player.golfer.startDownswing(dur, () => this.executeShot(this.player, setup, r));
  }

  private executeShot(c: Competitor, setup: ShotSetup, swing: SwingResult) {
    if (this.disposed) return;
    const putting = setup.club.kind === 'putter';
    const launch = launchFor(setup, swing);
    const r = simulateShot(launch, this.simEnv(false, putting));
    c.prev = { pos: c.pos.clone(), lie: c.lie, teed: c.teed };
    this.flight = { comp: c, r, t: 0, ev: 0, setup, swing, start: c.pos.clone(), speed: 1 };
    this.state = 'flight';
    this.overlay.hide();
    this.grid.setVisible(false);
    this.hud.setAimUi(false);
    this.hud.setTurn('');
    c.ball.clearTracer();
    this.props.placeTeePeg(0, -10, 0, false);
    sfx.strike(setup.club.kind, swing.quality);
    this.cam.startFlight(this.field, r, putting || r.duration < 1.2);
    if (c.side === 'player') {
      const tone = (t: string) => (t === 'Perfect' ? 'good' : t === 'Good' ? 'ok' : 'bad') as 'good' | 'ok' | 'bad';
      this.hud.feedback([
        { text: `Power ${Math.round(swing.power * 100)}%`, tone: Math.abs(swing.power - this.power) < 0.04 ? 'good' : 'ok' },
        { text: `Tempo: ${swing.tempo}`, tone: tone(swing.tempo) },
        { text: swing.path, tone: swing.path === 'Straight' ? 'good' : 'bad' },
      ]);
    }
    // prepare rough grass near the landing spot for the landing camera
  }

  private updateFlight(dt: number) {
    const f = this.flight!;
    const ff = this.keys.has(' ') ? 3 : 1;
    f.t += dt * ff;
    const r = f.r;
    sampleAt(r, f.t, this.tmp);
    const c = f.comp;
    const g = this.field.heightAt(this.tmp.x, this.tmp.z);
    c.ball.setPosition(this.tmp, g);
    const inAir = !r.landing || f.t < r.landingTime;
    if (inAir && f.setup.club.kind !== 'putter') c.ball.addTracerPoint(this.tmp);
    while (f.ev < r.events.length && r.events[f.ev].t <= f.t) {
      const e = r.events[f.ev++];
      if (e.type === 'bounce' && e.speed !== undefined && e.speed > 1.5) {
        const s = e.surf === Surf.Green || e.surf === Surf.Fringe ? 'green' : e.surf === Surf.Bunker ? 'sand' : e.surf === Surf.Rough || e.surf === Surf.Deep ? 'rough' : 'fairway';
        sfx.land(s, e.speed);
      } else if (e.type === 'tree') sfx.tree();
      else if (e.type === 'splash') { sfx.splash(); c.ball.setVisible(false); }
      else if (e.type === 'cup') sfx.cup();
      else if (e.type === 'pin') sfx.land('green', 8);
    }
    if (f.t >= r.duration + 0.9) {
      this.flight = null;
      this.finishShot(c, r, f);
    }
  }

  private finishShot(c: Competitor, r: SimResult, f: { setup: ShotSetup; swing: SwingResult; start: THREE.Vector3 }) {
    c.strokes++;
    const xp = c.side === 'player' ? this.swingXp(c, r, f) : null;
    c.teed = false;
    const putting = f.setup.club.kind === 'putter';
    let delay = 1.6;
    const field = this.field;
    if (r.outcome === 'holed') {
      c.holed = true;
      c.ball.setVisible(false);
      c.pos.set(field.cup.x, field.heightAt(field.cup.x, field.cup.z), field.cup.z);
      const name = scoreName(c.strokes, field.def.par);
      const good = c.strokes <= field.def.par;
      const who = c.side === 'player' ? '' : `${c.name}: `;
      this.hud.showBanner(c.strokes === 1 ? 'HOLE IN ONE!' : name.toUpperCase(), `${who}${c.strokes} ${c.strokes === 1 ? 'stroke' : 'strokes'}`, c.side === 'player' ? (good ? 'good' : '') : '', 2600);
      sfx.crowd(c.strokes < field.def.par ? 1 : 0.5);
      if (c.side === 'player') c.golfer.playClip(good ? 'Celebrate' : 'Idle');
      delay = 2.6;
    } else if (r.outcome === 'water') {
      c.strokes++;
      const e = r.waterEntry ?? { x: r.rest.x, z: r.rest.z };
      const drop = this.findDrop(e.x, e.z, f.start);
      c.pos.set(drop.x, 0, drop.z);
      c.lie = field.surfAt(drop.x, drop.z);
      c.ball.setVisible(true);
      this.placeBall(c);
      this.hud.showBanner('WATER HAZARD', `${c.side === 'player' ? 'You take' : c.name + ' takes'} a 1-stroke penalty drop`, c.side === 'player' ? 'bad' : '', 2600);
      sfx.groan();
      delay = 2.6;
    } else if (r.outcome === 'ob') {
      c.strokes++;
      c.pos.copy(c.prev.pos);
      c.lie = c.prev.lie;
      c.teed = c.prev.teed;
      c.ball.setVisible(true);
      this.placeBall(c);
      this.hud.showBanner('OUT OF BOUNDS', 'Stroke and distance — replay from the previous spot', c.side === 'player' ? 'bad' : '', 2600);
      sfx.groan();
      delay = 2.6;
    } else {
      c.pos.set(r.rest.x, 0, r.rest.z);
      c.lie = r.restSurf;
      this.placeBall(c);
      const dist = this.distToCup(c);
      // gimme
      if (save.settings.gimmes && (c.lie === Surf.Green || c.lie === Surf.Fringe) && dist < GIMME[this.cfg.difficulty]) {
        c.strokes++;
        c.holed = true;
        c.ball.setVisible(false);
        const name = scoreName(c.strokes, field.def.par);
        this.hud.showBanner(name.toUpperCase(), `${c.side === 'player' ? 'Putt conceded' : c.name + "'s putt conceded"} — ${c.strokes} strokes`, c.side === 'player' && c.strokes <= field.def.par ? 'good' : '', 2200);
        delay = 2.2;
      } else if (!putting) {
        const carry = toYards(r.carry), total = toYards(r.total);
        this.hud.shotResult(`<span>${c.side === 'player' ? 'You' : c.name}</span><span>Carry <b>${carry.toFixed(0)}</b> yds</span><span>Total <b>${total.toFixed(0)}</b> yds</span><span><b>${SURF_NAME[c.lie]}</b></span><span>To pin <b>${toYards(dist).toFixed(0)}</b> yds</span>${xp ? `<span class="xp">XP <b>+${xp.xp}</b></span>` : ''}`);
      } else {
        this.hud.shotResult(`<span>${c.side === 'player' ? 'You' : c.name}</span><span><b>${(dist / 0.3048).toFixed(1)} ft</b> left</span>${xp ? `<span class="xp">XP <b>+${xp.xp}</b></span>` : ''}`);
        if (r.closest < 0.15) sfx.groan();
      }
    }
    this.refreshHudScores();
    if (xp) {
      this.match.swingXp += xp.xp;
      this.match.swingCount++;
      this.lastSwingXp = xp.xp;
      if (xp.xp > 0) {
        this.hud.xpPop(xp.xp, xp.labels.join(' · '));
        sfx.xp();
      }
      this.refreshXp();
    }
    // pick up if hopeless
    if (!c.holed && c.strokes >= field.def.par + 5) {
      c.pickedUp = true;
      c.ball.setVisible(false);
      this.hud.showBanner('PICKED UP', `${c.side === 'player' ? 'You concede' : c.name + ' concedes'} the hole`, '', 2200);
    }
    this.state = 'between';
    this.after(delay, () => {
      if (this.holeDecided()) this.endHole();
      else this.beginTurn();
    });
  }

  /**
   * XP for one player swing: strike quality (only for the first `par` strokes of a hole, so
   * tapping the ball around can't farm it) plus what the shot achieved.
   */
  private swingXp(c: Competitor, r: SimResult, f: { setup: ShotSetup; swing: SwingResult; start: THREE.Vector3 }): { xp: number; labels: string[] } {
    const parts: [string, number][] = [];
    const putting = f.setup.club.kind === 'putter';
    const par = this.field.def.par;
    const cup = this.field.cup;
    const startDist = Math.hypot(f.start.x - cup.x, f.start.z - cup.z);
    if (!putting && c.strokes <= par) {
      if (f.swing.tempo === 'Perfect') parts.push(['Perfect tempo', 3]);
      else if (f.swing.tempo === 'Good') parts.push(['Good tempo', 1]);
      if (f.swing.path === 'Straight') parts.push(['Straight', 2]);
    }
    if (r.outcome === 'holed') {
      if (putting) parts.push(startDist >= 4.5 ? ['Long putt made', 8] : ['Putt made', 2]);
      else parts.push([c.strokes === 1 ? 'Ace' : 'Holed out', 15]);
    } else if (r.outcome === 'rest') {
      const dist = Math.hypot(r.rest.x - cup.x, r.rest.z - cup.z);
      if (putting) {
        if (startDist >= 9 && dist < 1) parts.push(['Great lag', 3]);
      } else {
        const fromGreen = c.prev.lie === Surf.Green || c.prev.lie === Surf.Fringe;
        if (c.prev.teed && par >= 4 && r.restSurf === Surf.Fairway) parts.push(['Fairway hit', 4]);
        if (f.setup.club.kind === 'driver' && toYards(r.total) >= 280) parts.push(['Big drive', 3]);
        if (r.restSurf === Surf.Green && !fromGreen) {
          parts.push(['Green hit', 4]);
          if (dist < 3) parts.push([`Stuck it ${Math.max(1, Math.round(dist / 0.3048))} ft`, 5]);
        }
      }
    }
    const mul = xpMul(this.cfg.difficulty);
    return { xp: Math.round(parts.reduce((a, p) => a + p[1], 0) * mul), labels: parts.map((p) => p[0]) };
  }

  private refreshXp() {
    const lv = playerLevel(save.xpEarned);
    this.hud.setXp({ ...lv, balance: save.xp, match: bonusXp(this.match, this.cfg.difficulty).total, win: WIN_XP[this.cfg.difficulty], last: this.lastSwingXp });
  }

  private findDrop(x: number, z: number, from: THREE.Vector3) {
    const dx = from.x - x, dz = from.z - z;
    const l = Math.hypot(dx, dz) || 1;
    for (let d = 2; d < 120; d += 1) {
      const px = x + (dx / l) * d, pz = z + (dz / l) * d;
      const s = this.field.surfAt(px, pz);
      if (s !== Surf.Water && s !== Surf.OB && !this.field.nearWater(px, pz, 1.5)) return { x: px, z: pz };
    }
    return { x: from.x, z: from.z };
  }

  private holeDecided(): boolean {
    const p = this.player, a = this.ai;
    if (p.pickedUp || a.pickedUp) return true;
    if (p.holed && a.holed) return true;
    if (p.holed && !a.holed && a.strokes >= p.strokes) return true;
    if (a.holed && !p.holed && p.strokes >= a.strokes) return true;
    return false;
  }

  private endHole() {
    if (this.state === 'over') return;
    this.state = 'between';
    const p = this.player, a = this.ai;
    let conceded: Side | undefined;
    if (p.pickedUp && !a.pickedUp) conceded = 'player';
    else if (a.pickedUp && !p.pickedUp) conceded = 'ai';
    else if (p.holed && !a.holed) conceded = 'ai';
    else if (a.holed && !p.holed) conceded = 'player';
    const xpBefore = bonusXp(this.match, this.cfg.difficulty).total;
    this.match.record(this.holeIdx, p.strokes, a.strokes, conceded, p.holed);
    const hr = this.match.holes[this.holeIdx];
    const par = this.field.def.par;
    const xpGain = bonusXp(this.match, this.cfg.difficulty).total - xpBefore;
    if (xpGain > 0) {
      const parts: string[] = [];
      if (hr.winner === 'player') parts.push('Hole won');
      if (p.holed && p.strokes - par <= -1) parts.push(scoreName(p.strokes, par));
      this.after(1.2, () => {
        this.hud.xpPop(xpGain, parts.join(' · '));
        sfx.xp();
        this.refreshXp();
      });
    } else this.refreshXp();
    const desc = (c: Competitor) => (c.holed ? `${c.strokes} (${scoreName(c.strokes, par)})` : `${c.strokes} — conceded`);
    const scores = `You ${desc(p)} · ${a.name.split(' ')[0]} ${desc(a)} · ${this.match.statusText()}`;
    if (hr.winner === 'player') {
      this.honor = 'player';
      this.hud.showBanner('YOU WIN THE HOLE', scores, 'good', 3200);
      sfx.crowd(0.8);
      p.golfer.root.visible = true;
      a.golfer.root.visible = false;
      p.golfer.playClip('Celebrate');
    } else if (hr.winner === 'ai') {
      this.honor = 'ai';
      this.hud.showBanner(`${a.name.toUpperCase()} WINS THE HOLE`, scores, 'bad', 3200);
      if (p.golfer.root.visible) p.golfer.playClip('Dejected');
    } else {
      this.hud.showBanner('HOLE HALVED', scores, '', 3200);
    }
    this.hud.setMatch(this.match.statusText(), this.match.holes, this.holeIdx);
    this.refreshHudScores();
    this.after(3.6, () => {
      if (this.match.finished || this.holeIdx >= this.cfg.course.holes.length - 1) {
        this.match.finished = true;
        this.state = 'over';
        this.onExit?.({ match: this.match, course: this.cfg.course, difficulty: this.cfg.difficulty, opponentName: this.cfg.opponent.name, quit: false });
      } else void this.loadHole(this.holeIdx + 1);
    });
  }

  // ---------------------------------------------------------------- AI

  private async aiTurn() {
    const c = this.ai;
    this.state = 'ai';
    this.hud.setAimUi(false);
    this.hud.setTurn(`${c.name} is lining up…`, 'var(--bad)');
    const dist = this.distToCup(c);
    const dirToCup = { x: (this.field.cup.x - c.pos.x) / (dist || 1), z: (this.field.cup.z - c.pos.z) / (dist || 1) };
    const putting0 = c.lie === Surf.Green;
    const preClub = putting0 ? 'Club_Putter' : 'Club_Iron';
    c.golfer.setClub(preClub, c.tiers['7i']);
    c.golfer.placeForShot(c.pos, dirToCup.x, dirToCup.z, putting0 ? 'Putt' : 'Iron', (x, z) => this.field.heightAt(x, z));
    this.cam.setAddress(this.field, c.pos, dirToCup.x, dirToCup.z, putting0, false);
    this.placeBagFor(c, dirToCup);
    const t0 = performance.now();
    const plan = await planAiShot(
      { field: this.field, ball: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, lie: c.lie, teed: c.teed, env: { ...this.simEnv(false, putting0), trees: this.treeIndex ?? undefined, seed: 7 }, difficulty: this.cfg.difficulty },
      this.rng,
    );
    if (this.disposed) return;
    const wait = Math.max(0, 1.3 - (performance.now() - t0) / 1000);
    await new Promise((res) => this.after(wait, () => res(null)));
    if (this.disposed) return;
    const s = plan.setup;
    const anim = animFor(s.club, s.shot);
    c.golfer.setClub(s.club.model, s.tier);
    c.golfer.placeForShot(c.pos, s.aimX, s.aimZ, anim, (x, z) => this.field.heightAt(x, z));
    this.props.placeTeePeg(c.pos.x, this.field.heightAt(c.pos.x, c.pos.z), c.pos.z, c.teed && s.club.kind !== 'putter');
    const putting = s.club.kind === 'putter';
    this.props.setFlagVisible(!(putting && c.lie === Surf.Green));
    this.cam.setAddress(this.field, c.pos, s.aimX, s.aimZ, putting, false, this.field.heightAt(this.field.cup.x, this.field.cup.z));
    this.placeBagFor(c, { x: s.aimX, z: s.aimZ });
    this.hud.setTurn(`${c.name} · ${s.club.name}${s.shot.id !== 'normal' && s.shot.id !== 'putt' ? ' · ' + s.shot.name : ''}`, 'var(--bad)');
    await new Promise((res) => this.after(0.7, () => res(null)));
    if (this.disposed) return;
    // animated backswing then strike
    const target = Math.min(1, putting ? 0.35 + 0.65 * Math.min(1, (s.puttScale ?? 5) / 20) : plan.swing.power);
    const back = { t: 0 };
    const dur = putting ? 0.7 : 0.95;
    await new Promise<void>((res) => {
      const step = () => {
        if (this.disposed) return;
        back.t += 1 / 60;
        const u = Math.min(1, back.t / dur);
        c.golfer.setBackswing(target * (1 - (1 - u) * (1 - u)));
        if (u >= 1) res();
        else this.after(1 / 60, step);
      };
      step();
    });
    c.golfer.startDownswing(putting ? 0.35 : 0.24, () => this.executeShot(c, s, plan.swing));
  }

  private placeBagFor(c: Competitor, a: { x: number; z: number }) {
    const right = { x: -a.z, z: a.x };
    const x = c.pos.x - a.x * 2.4 - right.x * 1.6, z = c.pos.z - a.z * 2.4 - right.z * 1.6;
    if (this.field.surfAt(x, z) === Surf.Water) this.props.hideBag();
    else this.props.placeBag(x, z, this.field.heightAt(x, z), Math.atan2(a.x, -a.z), this.cfg.opponent.appearance.shirt);
  }

  // ---------------------------------------------------------------- loop

  private after(sec: number, fn: () => void) {
    this.timers.push({ t: sec, fn });
  }

  scorecardData() {
    return {
      course: this.cfg.course.name,
      holes: this.match.holes,
      yards: this.cfg.course.holes.map((h) => h.yards),
      names: [this.player?.name ?? 'You', this.ai?.name ?? 'AI'] as [string, string],
      status: this.match.statusText(),
    };
  }

  update(dt: number) {
    if (this.disposed) return;
    terrainTime.value += dt;
    if (this.paused) return;
    // timers
    if (this.timers.length) {
      const due: (() => void)[] = [];
      this.timers = this.timers.filter((t) => {
        t.t -= dt;
        if (t.t <= 0) { due.push(t.fn); return false; }
        return true;
      });
      for (const fn of due) fn();
    }
    if (!this.field || !this.player) return;
    this.swing.update(dt);
    this.handleHeldKeys(dt);
    if (this.state === 'aim') {
      this.previewTimer -= dt;
      if (this.previewDirty && this.previewTimer <= 0) {
        this.previewDirty = false;
        this.previewTimer = 0.05;
        this.updatePreview();
      }
    }
    if (this.state === 'flight' && this.flight) this.updateFlight(dt);
    for (const c of [this.player, this.ai]) c.golfer.update(dt);
    const focusBall = this.flight ? this.flight.comp.ball.mesh.position : this.current.pos;
    this.cam.update(dt, this.field, focusBall);
    this.grass?.update(this.camera, this.field.heightAt(this.camera.position.x, this.camera.position.z));
    this.updateShadowFocus();
    // HUD bits
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const camAng = Math.atan2(camDir.x, -camDir.z);
    const windAng = Math.atan2(this.wind.x, -this.wind.z);
    this.hud.setWind(this.wind.mph, ((windAng - camAng) * 180) / Math.PI);
    this.hud.update(dt);
    const showTags = this.state !== 'intro' && this.state !== 'loading';
    for (const c of [this.player, this.ai]) {
      const visible = showTags && !c.holed && !c.pickedUp && c.ball.mesh.visible && !(this.state === 'flight' && this.flight?.comp === c) && (c !== this.current || this.state === 'between');
      const label = `${c.side === 'player' ? 'YOU' : c.name.split(' ')[0].toUpperCase()} · ${c.lie === Surf.Green ? (this.distToCup(c) / 0.3048).toFixed(0) + ' ft' : toYards(this.distToCup(c)).toFixed(0) + ' yds'}`;
      this.hud.setTag(c.side, label, visible ? this.tmp.copy(c.pos).setY(c.pos.y + 0.3) : null, this.camera, c.side === 'ai');
    }
    this.minimapTimer -= dt;
    if (this.minimapTimer <= 0) {
      this.minimapTimer = 0.1;
      const balls = [this.player, this.ai].filter((c) => !c.holed && !c.pickedUp).map((c) => ({ x: c.pos.x, z: c.pos.z, color: c.color }));
      if (this.flight) {
        const p = this.flight.comp.ball.mesh.position;
        balls.push({ x: p.x, z: p.z, color: '#ffffff' });
      }
      let aim: { from: { x: number; z: number }; to: { x: number; z: number } } | null = null;
      if (this.state === 'aim' && this.lastPreview) {
        const r = this.lastPreview;
        const to = r.landing ?? r.rest;
        aim = { from: { x: this.player.pos.x, z: this.player.pos.z }, to: { x: to.x, z: to.z } };
      }
      this.hud.drawMinimap(this.field, balls, aim);
    }
    for (const c of [this.player, this.ai]) {
      c.ball.updateScale(this.camera);
      if (this.flight?.comp !== c) c.ball.fadeTracer(dt);
    }
  }

  private minimapTimer = 0;

  setResolution(w: number, h: number) {
    this.overlay.setResolution(w, h);
    this.player?.ball.setResolution(w, h);
    this.ai?.ball.setResolution(w, h);
  }

  quit() {
    this.onExit?.({ match: this.match, course: this.cfg.course, difficulty: this.cfg.difficulty, opponentName: this.cfg.opponent.name, quit: true });
  }

  dispose() {
    this.disposed = true;
    this.swing.enabled = false;
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('keyup', this.keyUpHandler);
    this.canvas.removeEventListener('wheel', this.wheelHandler);
    this.swing.dispose();
    this.unloadTerrain();
    this.veg.dispose();
    this.scene.remove(this.veg.group, this.props.group, this.overlay.group, this.grid.mesh);
    for (const c of [this.player, this.ai]) {
      if (!c) continue;
      this.scene.remove(c.golfer.root);
      c.ball.dispose();
    }
    this.hud.show(false);
    this.hud.showScorecard(false);
  }
}

