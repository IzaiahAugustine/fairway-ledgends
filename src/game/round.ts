// One 9-hole match: loads each hole, runs player and AI turns, plays shots back, applies
// penalties and gimmes, resolves holes in match play and reports the result.
import * as THREE from 'three';
import { sfx } from '../audio/sfx';
import { Rng, clamp, toYards } from '../core/rng';
import { playerLevel, save, type Difficulty } from '../core/save';
import { CLUBS, PUTT_SHOT, SHOT_TYPES, TIERS, animFor, shotTypeById, type ClubDef, type ShotTypeDef } from '../data/clubs';
import { DRIVING_RANGE, traits, type CourseDef } from '../data/courses';
import { ballColor } from '../data/cosmetics';
import { BALL_R, TreeIndex, airDensityAt, sampleAt, simulateShot, type SimEnv, type SimResult } from '../physics/ballPhysics';
import { Hud } from '../ui/hud';
import { SkyEnvironment } from '../world/environment';
import { HoleField, SURF_NAME, Surf } from '../world/holeGen';
import { AimOverlay, GreenGrid } from '../world/overlays';
import { Ball, CourseProps } from '../world/props';
import { Landmarks } from '../world/landmarks';
import type { OnlineMatch } from '../net/online';
import { buildTerrainMesh, cloudUniforms, loadTerrainTextures, terrainSurfaceAt, terrainTime } from '../world/terrain';
import { GrassField } from '../world/grass';
import { Divots } from '../world/divots';
import { Rain, pickWeather, type Weather } from '../world/weather';
import { Birds } from '../world/birds';
import { Crowd } from '../world/crowd';
import { OuterWorld } from '../world/outerWorld';
import { Vegetation, setVegetationWind } from '../world/vegetation';
import { RangeTargets, type RangeTarget } from '../world/rangeTargets';
import { AI_SKILL, planAiShot, type Opponent } from './ai';
import { swingStyleById, type SwingStyleId } from '../data/swingStyles';
import { CameraDirector } from './cameraDirector';
import { Golfer } from './golfer';
import { MatchState, WIN_XP, bonusXp, scoreName, xpMul, type Format, type MatchOptions, type Side } from './match';
import { PERFECT_SWING, SPIN_MODS, altitudeCarryGain, errorScale, fullCarry, launchFor, lieMods, setAltitude, type ShotSetup, type SwingResult } from './shotModel';
import { SwingInput } from './swingInput';

export interface RoundConfig {
  /** The course cut down to the holes being played. */
  course: CourseDef;
  difficulty: Difficulty;
  opponent: Opponent;
  seed: number;
  format: Format;
  /** Number of the first hole played (10 for the back nine). */
  firstHole: number;
  /** Practice: no opponent, holes loop, no XP. */
  practice: boolean;
  options: MatchOptions;
  /** Online match against a friend: the opponent seat is played by the other browser. */
  online?: OnlineMatch;
  /** Awaited between holes (game portals show an ad break here). */
  holeBreak?: (nextHole: number) => Promise<void>;
}

export interface RoundResult {
  match: MatchState;
  course: CourseDef;
  difficulty: Difficulty;
  opponentName: string;
  quit: boolean;
  options: MatchOptions;
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
  style: SwingStyleId;
}

type State = 'loading' | 'intro' | 'aim' | 'swing' | 'flight' | 'ai' | 'between' | 'replay' | 'over';

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
  private divots: Divots;
  /** Set by Enter during the opponent's turn: rush the rest of that turn. */
  private aiSkip = false;
  /** Easy only: one free replay per hole after finding water or going out of bounds. */
  private mulliganUsed = false;
  /** Driving range: the targets, where the player tees up, what they're aimed at and a tally. */
  private rangeTargets: RangeTargets | null = null;
  private teeSpot = new THREE.Vector3();
  private rangeAim: RangeTarget | null = null;
  private rangeStats = { shots: 0, onTarget: 0, longest: 0 };
  /** The last shot played (either golfer), for the replay key. */
  private lastShot: { comp: Competitor; r: SimResult; setup: ShotSetup; start: THREE.Vector3 } | null = null;
  private replay: { t: number; ev: number; ball: Ball; hidden: boolean } | null = null;
  /** Today's weather (picked per round). */
  private weather: Weather;
  private rain: Rain | null = null;
  private birds = new Birds();
  private crowd = new Crowd();
  private landmarks = new Landmarks();
  private overlay: AimOverlay;
  private grid: GreenGrid;
  private cam: CameraDirector;
  private swing: SwingInput;
  private player!: Competitor;
  private ai!: Competitor;
  private current!: Competitor;
  private honor: Side = 'player';
  /** Strokes played so far in the match by both players: the online record's index. */
  private netShot = 0;
  private flightNetIdx = -1;
  private rng: Rng;
  private wind = { x: 0, z: 0, mph: 0 };
  private treeIndex: TreeIndex | null = null;
  // aim state
  private clubIdx = 0;
  private shotIdx = 0;
  /** Index into SPIN_MODS (C cycles it); resets to Normal for each shot. */
  private spinIdx = 0;
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
  /** Grey skies use the misty sky's own exposure; rain darkens a touch on top. */
  private get isRange(): boolean {
    return this.cfg.course.id === DRIVING_RANGE.id;
  }

  get exposureMul(): number {
    const W = this.weather;
    return W.hdri ? (1 / this.cfg.course.exposure) * W.exposureMul : W.exposureMul;
  }
  /** Compiles the shaders of everything in the scene (set by main) so the first frames don't hitch. */
  precompile: (() => Promise<void>) | null = null;
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
    // online: the host has the honour on the first tee
    if (cfg.online) this.honor = cfg.online.seat === 'host' ? 'player' : 'ai';
    // thin mountain air: club yardages and the ball flight both follow the altitude
    setAltitude(cfg.course.altitude ?? 0);
    this.match = new MatchState(cfg.course.holes.map((h) => h.par), cfg.format, cfg.firstHole);
    this.weather = pickWeather(cfg.course, this.rng, cfg.practice ? 'fair' : save.settings.weather, cfg.options.weather);
    this.props = new CourseProps(scene);
    this.divots = new Divots(scene);
    this.overlay = new AimOverlay(scene);
    this.grid = new GreenGrid(scene);
    this.cam = new CameraDirector(camera);
    this.scene.add(this.veg.group, this.birds.group, this.crowd.group, this.landmarks.group);
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
    let aiTiers: Record<string, number> = {};
    for (const c of CLUBS) aiTiers[c.id] = aiTier;
    // online: the friend plays their own upgraded bag
    if (this.cfg.online?.opponent) aiTiers = { ...aiTiers, ...this.cfg.online.opponent.tiers };
    const mk = (side: Side, name: string, color: string, golfer: Golfer, tiers: Record<string, number>, style: SwingStyleId): Competitor => ({
      side, name, color, golfer, ball: new Ball(this.scene, 0xffffff, color), pos: new THREE.Vector3(), lie: Surf.Tee, teed: true, strokes: 0, holed: false, pickedUp: false,
      prev: { pos: new THREE.Vector3(), lie: Surf.Tee, teed: true }, tiers, style,
    });
    this.player = mk('player', save.name || 'Player', '#f2c14e', pg, save.clubs, save.swingStyle);
    const bc = ballColor(save.appearance.ball);
    this.player.ball.setFinish(bc.hex, bc.metal);
    this.ai = mk('ai', this.cfg.opponent.name, '#ff6b5b', ag, aiTiers, this.cfg.opponent.personality.style);
    // each golfer's swing looks like their style: backswing length and downswing speed
    for (const c of [this.player, this.ai]) {
      const st = swingStyleById(c.style);
      c.golfer.swingLength = Math.min(1, st.backswing);
      c.golfer.swingSpeed = st.downswing;
    }
    this.swing.style = swingStyleById(save.swingStyle);
    this.current = this.player;
    await this.props.init();
    await this.divots.init();
    await this.crowd.init();
    await this.landmarks.init(this.cfg.course.id);
    await loadTerrainTextures();
    this.hud.show(true);
    this.hud.setHelp(false, save.settings.swingMode);
    sfx.startAmbience();
    await this.loadHole(0);
  }

  // ---------------------------------------------------------------- holes

  private async loadHole(i: number) {
    // cut to black while the next hole is built, like a broadcast cutting between holes, so the
    // build never shows as a freeze
    this.state = 'loading';
    if (i !== 0 || this.terrain) await this.hud.cut(true);
    if (this.disposed) return;
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
    this.landmarks.place(field, this.outer, course.holes.length, this.cfg.seed + i * 61);
    this.treeIndex = new TreeIndex([...this.veg.colliders, ...this.landmarks.colliders]);
    this.mulliganUsed = false;
    this.lastShot = null;
    // birds over the hole (fewer in the rain)
    const mid = new THREE.Vector3((field.tee.x + field.cup.x) / 2, Math.max(field.teeH, field.heightAt(field.cup.x, field.cup.z)), (field.tee.z + field.cup.z) / 2);
    // the gallery (none in practice)
    if (this.cfg.practice) this.crowd.group.visible = false;
    else this.crowd.place(field, this.cfg.seed + i * 53);
    if (this.weather.kind === 'rain') this.birds.clear();
    else this.birds.place(mid, Math.max(120, field.length), this.cfg.seed + i * 31);
    for (const c of [this.player, this.ai]) c.ball.setMarked(false);
    this.props.place(field, terrainSurfaceAt(field, this.terrain.userData.step as number, field.cup.x, field.cup.z));
    this.divots.reset(field);
    this.props.setFlagVisible(true);
    if (this.rangeTargets) {
      this.scene.remove(this.rangeTargets.group);
      this.rangeTargets.dispose();
      this.rangeTargets = null;
    }
    if (this.isRange) {
      this.rangeTargets = new RangeTargets(field);
      this.scene.add(this.rangeTargets.group);
    }
    this.grid.build(field, field.cup.x, field.cup.z, Math.max(field.green.rx, field.green.rz) * 1.5);
    const playDir = new THREE.Vector2(field.cup.x - field.tee.x, field.cup.z - field.tee.z).normalize();
    // a strong key sun with less sky fill reads as a bright broadcast day
    const W = this.weather;
    // time of day: the desert plays in warm, low late-afternoon sun; grey days are cool
    const T = traits(course);
    const golden = T.golden && !W.hdri;
    await this.env.apply(W.hdri ?? course.hdri, {
      envIntensity: course.envIntensity * 0.75 * W.envMul,
      sunIntensity: course.sunIntensity * 1.35 * W.sunMul * (golden ? 1.06 : 1),
      playDir,
      sunOffsetDeg: 150 + this.rng.range(-35, 35),
      minSunY: golden ? 0.27 : 0.32,
      sunColor: golden ? new THREE.Color(1, 0.9, 0.78) : W.hdri ? new THREE.Color(0.9, 0.94, 1) : undefined,
    });
    const misty = !!W.hdri;
    this.env.haze = {
      density: (misty ? 0.0007 : T.haze) * W.hazeMul,
      falloff: 1 / 380,
      base: Math.min(field.teeH, field.seaLevel + 12) - 8,
      skyHaze: misty ? 0.85 : 0.55,
    };
    // rain streaks and sound
    if (W.kind === 'rain' && !this.rain) {
      this.rain = new Rain();
      this.scene.add(this.rain.mesh);
    }
    sfx.setRain(W.kind === 'rain');
    this.hud.setWeather(W.kind === 'fair' ? '' : W.label);
    // wind
    const windSetting = { calm: 0.4, light: 0.7, full: 1 }[this.cfg.online?.settings?.wind ?? save.settings.wind] ?? 0.7;
    const mph = this.rng.range(course.windMin, course.windMax) * W.windMul * windSetting;
    const wa = this.rng.range(0, Math.PI * 2);
    this.wind = { x: Math.cos(wa) * mph * 0.447 * 0.75, z: Math.sin(wa) * mph * 0.447 * 0.75, mph };
    this.props.setWind(this.wind.x, this.wind.z);
    sfx.setCourseAmbience(T, mph);
    setVegetationWind(this.wind.x, this.wind.z);
    this.grass?.setWind(this.wind.x, this.wind.z);
    // cloud shadows drift with the wind
    const cs = (mph * 0.447 + 4) * 0.0016 * 0.6;
    cloudUniforms.uCloud.value.set(Math.cos(wa) * cs, Math.sin(wa) * cs);
    cloudUniforms.uCloudCover.value = W.cloudCover ?? T.cloudCover;
    // competitors to the tee
    const t = field.tee;
    const right = { x: -field.teeDir.z, z: field.teeDir.x };
    for (const c of [this.player, this.ai]) {
      const off = c.side === 'player' ? -0.8 : 0.8;
      const x = t.x + right.x * off, z = t.z + right.z * off;
      c.pos.set(x, field.heightAt(x, z), z);
      if (c.side === 'player') this.teeSpot.copy(c.pos);
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
    if (this.cfg.practice) {
      // practice: the opponent sits this one out
      this.ai.pickedUp = true;
      this.ai.ball.setVisible(false);
    }
    this.hud.buildMinimap(field);
    const d = course.holes[i];
    const holeNo = i + this.cfg.firstHole;
    if (this.isRange) this.hud.setRange(course.name, 'Targets at 60 · 100 · 150 · 200 · 250 yds');
    else this.hud.setHole(course.name, holeNo, d.par, d.yards, d.name, this.pinSheet());
    this.refreshHudScores();
    this.hud.setMatch(this.statusText(), this.match.holes, i, this.cfg.firstHole);
    this.refreshXp();
    // flyover intro
    this.state = 'intro';
    const o = this.cfg.opponent;
    const extra: string[] = [];
    if (i === 0 && !this.cfg.practice) extra.push(`vs ${o.name} · ${o.personality.label}: ${o.personality.blurb}`);
    if (i === 0 && (course.altitude ?? 0) > 300) extra.push(`Altitude ${Math.round(((course.altitude ?? 0) * 3.281) / 100) * 100} ft: the ball flies ${Math.round((altitudeCarryGain() - 1) * 100)}% farther`);
    if (!this.isRange) extra.push(`Pin: ${this.pinSheet()}`);
    if (this.isRange) extra.push('Targets at 60, 100, 150, 200 and 250 yards · ←/→ change club and it aims at the matching target · the ball comes back to the tee after every shot');
    else if (this.cfg.practice) extra.push('N next hole · B putting practice');
    const wx = this.weather.kind === 'fair' ? '' : ` · ${this.weather.label}`;
    this.hud.showIntro(holeNo, d.par, d.yards, d.name, this.isRange ? 'Practice ground' : this.cfg.practice ? `${course.name} · Practice` : `${course.name}${wx} · ${this.statusText()}`, extra, this.isRange ? course.name : undefined);
    // compile every new shader now, behind the intro card, instead of hitching mid-flyover; the
    // divot pieces are shown for a couple of frames too so their shadow shaders are ready
    const unwarm = this.divots.warmup(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(3).add(this.camera.position));
    await this.precompile?.();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    unwarm();
    if (this.disposed) return;
    void this.hud.cut(false, 450);
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
    this.hud.setStrokes(this.cfg.practice ? [row(this.player)] : [row(this.player), row(this.ai)]);
  }

  /** Keep the sun's shadow map over what the camera is looking at. */
  private updateShadowFocus() {
    const fwd = this.tmpFwd;
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const wide = this.cam.mode === 'flight' || this.cam.mode === 'target' || this.cam.mode === 'flyover' || this.cam.mode === 'green';
    // a tight shadow box while addressing the ball keeps the golfer's and the gallery's shadows crisp
    const ext = wide ? 130 : this.cam.mode === 'putt' ? 40 : 55;
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
    // a ball on the green is marked with a coin while the other golfer plays
    for (const c of [this.player, this.ai]) c.ball.setMarked(c !== next && !c.holed && !c.pickedUp && c.lie === Surf.Green);
    this.refreshHudScores();
    // hide the other golfer, show this one
    for (const c of [this.player, this.ai]) c.golfer.root.visible = c === next;
    this.env.focus(next.pos);
    const onGreen = next.lie === Surf.Green;
    this.props.setFlagVisible(!onGreen);
    // the gallery walks with the players (the tee and green already have theirs)
    if (!this.cfg.practice && !next.teed && next.lie !== Surf.Green) {
      const cup = this.field.cup, d = Math.hypot(cup.x - next.pos.x, cup.z - next.pos.z) || 1;
      this.crowd.gatherAt(next.pos, (cup.x - next.pos.x) / d, (cup.z - next.pos.z) / d);
    }
    if (next.side === 'player') this.setupPlayerAim();
    else if (this.cfg.online) void this.remoteTurn();
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
    if (this.isRange && this.rangeStats.shots > 0) {
      // the range: keep the club you were hitting
    } else if (c.lie === Surf.Green || (c.lie === Surf.Fringe && dist < 12)) this.clubIdx = CLUBS.length - 1;
    else this.clubIdx = this.suggestClubIdx(dist);
    this.shotIdx = 0;
    this.spinIdx = 0;
    if (this.club.kind !== 'putter' && dist < 40 && !this.isRange) {
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
      const full = fullCarry(cl, c.tiers[cl.id] ?? 0, SHOT_TYPES[0], c.lie, c.teed, c.style) * 1.06;
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
    this.rangeAim = null;
    if (this.rangeTargets && club.kind !== 'putter') {
      // the range: aim at the target that suits this club, or straight down the middle with the long clubs
      const carry = toYards(fullCarry(club, c.tiers[club.id] ?? 0, this.shotType, c.lie, c.teed, c.style));
      let best: RangeTarget | null = null;
      for (const t of this.rangeTargets.targets) if (!best || Math.abs(t.yards - carry) < Math.abs(best.yards - carry)) best = t;
      if (best && carry < best.yards * 1.18) {
        this.rangeAim = best;
        tx = best.x;
        tz = best.z;
      } else {
        const p = this.field.pointAt(Math.min(this.field.length, carry * 0.9144));
        tx = p.x;
        tz = p.z;
      }
    } else if (club.kind !== 'putter') {
      const full = fullCarry(club, c.tiers[club.id] ?? 0, this.shotType, c.lie, c.teed, c.style);
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
    return { club: this.club, tier: c.tiers[this.club.id] ?? 0, shot: this.shotType, power, aimX: a.x, aimZ: a.z, x: c.pos.x, y: c.pos.y, z: c.pos.z, lie: c.lie, teed: c.teed, puttScale: this.puttScale, style: c.style, spin: this.club.kind === 'putter' ? 'normal' : SPIN_MODS[this.spinIdx].id };
  }

  private simEnv(forPreview: boolean, putting: boolean): SimEnv {
    return {
      ground: this.field,
      wind: { x: this.wind.x, z: this.wind.z },
      firmness: this.cfg.course.firmness * (1 - 0.15 * this.weather.wet),
      wet: this.weather.wet,
      air: airDensityAt(this.cfg.course.altitude ?? 0),
      cup: this.field.cup,
      flagIn: !putting,
      trees: forPreview ? undefined : this.treeIndex ?? undefined,
      seed: forPreview ? 1 : this.rng.int(1, 1e9),
    };
  }

  private autoPower() {
    const c = this.player;
    let dist = this.distToCup(c);
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
    const full = fullCarry(this.club, c.tiers[this.club.id] ?? 0, this.shotType, c.lie, c.teed, c.style);
    if (this.isRange) {
      // the range: full swings unless a target is in reach, then enough to finish beside its flag
      if (!this.rangeAim) {
        this.power = 1;
        this.swing.target = 1;
        return;
      }
      dist = Math.hypot(this.rangeAim.x - c.pos.x, this.rangeAim.z - c.pos.z);
    }
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
    this.swing.errScale = putting ? Math.pow(1 / TIERS[c.tiers[this.club.id] ?? 0].accuracy, 0.9) * swingStyleById(c.style).shortError : errorScale(this.currentSetup());
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

  /**
   * How a putt hit straight at the hole with the current pace would curve: e.g. "6 in right".
   * Measured where the ball passes the hole (or where it stops, if it comes up short).
   */
  private readBreak(): string {
    const c = this.player, cup = this.field.cup;
    const dx = cup.x - c.pos.x, dz = cup.z - c.pos.z;
    const L = Math.hypot(dx, dz);
    if (L < 0.6) return 'Straight';
    const fx = dx / L, fz = dz / L;
    const setup = { ...this.currentSetup(), aimX: fx, aimZ: fz };
    const r = simulateShot(launchFor(setup, PERFECT_SWING(this.power)), { ...this.simEnv(true, true), cup: null });
    const sm = r.samples;
    let lateral = 0;
    for (let i = 0; i < sm.length; i += 4) {
      const px = sm[i + 1] - c.pos.x, pz = sm[i + 3] - c.pos.z;
      lateral = px * -fz + pz * fx;
      if (px * fx + pz * fz >= L) break;
    }
    const inches = Math.abs(lateral) / 0.0254;
    if (inches < 1.5) return 'Straight';
    const amount = inches < 24 ? `${Math.round(inches)} in` : `${(inches / 12).toFixed(1)} ft`;
    return `${amount} ${lateral > 0 ? 'right' : 'left'}`;
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
      spin: putting ? null : SPIN_MODS[this.spinIdx].name,
      lie: putting && c.lie === Surf.Green ? 'Green' : lm.label,
      toPin: this.distToCup(c),
      elevation: cupH - this.field.heightAt(c.pos.x, c.pos.z),
      power: this.power,
      carry: putting ? null : r.carry,
      total: putting ? null : diff === 'hard' ? null : r.total,
      putting,
      puttScale: this.puttScale,
      breakText: putting && diff !== 'hard' ? this.readBreak() : null,
    });
    this.hud.setClubBar(
      CLUBS.map((cl) => ({ short: cl.short, tier: c.tiers[cl.id] ?? 0, carry: cl.kind === 'putter' ? 0 : fullCarry(cl, c.tiers[cl.id] ?? 0, SHOT_TYPES[0], c.lie, c.teed, c.style), enabled: true })),
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
    if (k === 'Enter' && this.aiTurnActive()) {
      e.preventDefault();
      this.aiSkip = true;
      return;
    }
    if (this.state !== 'aim' || this.swing.active) return;
    const putting = this.club.kind === 'putter';
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      const n = CLUBS.length;
      this.clubIdx = (this.clubIdx + (k === 'ArrowRight' ? 1 : n - 1)) % n;
      sfx.bagRattle();
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
    } else if (k === 'p') {
      this.startReplay();
    } else if (k === 'n' && this.cfg.practice && !this.isRange) {
      this.swing.enabled = false;
      this.state = 'between';
      this.nextPracticeHole();
    } else if (k === 'b' && this.cfg.practice && !this.isRange) {
      this.puttingPractice();
    } else if (k === 'c' && !putting) {
      this.spinIdx = (this.spinIdx + 1) % SPIN_MODS.length;
      this.autoPower();
      this.applyAimPose();
      this.previewDirty = true;
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
    this.swooshFor(setup.club.kind, r.power);
    this.player.golfer.startDownswing(dur, () => this.executeShot(this.player, setup, r));
  }

  private executeShot(c: Competitor, setup: ShotSetup, swing: SwingResult) {
    if (this.disposed) return;
    const putting = setup.club.kind === 'putter';
    const launch = launchFor(setup, swing);
    const r = simulateShot(launch, this.simEnv(false, putting));
    this.flightNetIdx = this.netShot++;
    if (this.cfg.online && c === this.player) {
      this.cfg.online.sendShot(this.flightNetIdx, {
        hole: this.holeIdx,
        setup: {
          club: setup.club.id, shot: setup.shot.id, tier: setup.tier, power: setup.power, aimX: setup.aimX, aimZ: setup.aimZ,
          x: setup.x, y: setup.y, z: setup.z, lie: setup.lie, teed: setup.teed, puttScale: setup.puttScale, style: setup.style, spin: setup.spin,
        },
        swing: { ...swing },
      });
    }
    c.prev = { pos: c.pos.clone(), lie: c.lie, teed: c.teed };
    this.lastShot = { comp: c, r, setup, start: c.pos.clone() };
    this.tearDivot(c, setup, swing);
    this.flight = { comp: c, r, t: 0, ev: 0, setup, swing, start: c.pos.clone(), speed: 1 };
    this.state = 'flight';
    this.overlay.hide();
    this.grid.setVisible(false);
    this.hud.setAimUi(false);
    this.hud.setTurn('');
    c.ball.clearTracer();
    this.props.placeTeePeg(0, -10, 0, false);
    sfx.strike(setup.club.kind, swing.quality);
    if (c.prev.teed && setup.club.kind !== 'putter') sfx.teePop();
    // someone in the gallery shouts when it's heading for the trees or out of bounds
    if (setup.club.kind !== 'putter' && (r.outcome === 'ob' || r.events.some((e) => e.type === 'tree'))) this.after(Math.min(1.2, (r.landingTime || 2) * 0.4), () => sfx.fore());
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

  /** Irons and wedges (and woods off the deck, barely) take turf after the ball; mishits take more. */
  private tearDivot(c: Competitor, setup: ShotSetup, swing: SwingResult) {
    const kind = setup.club.kind;
    if (kind === 'putter' || kind === 'driver') return;
    if (c.lie !== Surf.Fairway && c.lie !== Surf.Rough && c.lie !== Surf.Deep && c.lie !== Surf.Tee) return;
    const sweep = kind === 'wood' || kind === 'hybrid';
    if (sweep && c.teed) return;
    let s = sweep ? 0.5 : kind === 'wedge' ? 1.05 : 0.9;
    if (c.teed) s *= 0.65;
    const shot = setup.shot.id;
    if (shot === 'chip' || shot === 'bump') s *= 0.45;
    else if (shot === 'pitch' || shot === 'flop') s *= 0.8;
    else if (shot === 'punch') s *= 1.1;
    if (swing.quality < 0.6) s *= 1.2; // hit it fat
    if (c.lie === Surf.Deep) s *= 0.8;
    s *= 0.9 + Math.random() * 0.2;
    this.divots.add(c.pos.x, c.pos.z, setup.aimX, setup.aimZ, s, s >= 0.6);
  }

  private updateFlight(dt: number) {
    const f = this.flight!;
    if (this.aiSkip && f.comp === this.ai) {
      // skip the rest of the opponent's ball flight: no tracer, no landing sounds, straight to the result
      this.flight = null;
      f.comp.ball.clearTracer();
      f.comp.ball.setVisible(f.r.outcome !== 'water');
      this.finishShot(f.comp, f.r, f);
      return;
    }
    const ff = this.keys.has(' ') ? 3 : 1;
    f.t += dt * ff;
    const r = f.r;
    sampleAt(r, f.t, this.tmp);
    const c = f.comp;
    const g = this.field.heightAt(this.tmp.x, this.tmp.z);
    c.ball.setPosition(this.tmp, g);
    // visible backspin in the air (a capped, readable rate), rolling on the ground
    c.ball.spinWithMotion(dt * ff, f.setup.club.kind === 'putter' ? 0 : Math.min(6, 1.5 + f.setup.club.spin / 1800));
    const inAir = !r.landing || f.t < r.landingTime;
    if (inAir && f.setup.club.kind !== 'putter') c.ball.addTracerPoint(this.tmp);
    this.rollSound(inAir && f.setup.club.kind !== 'putter', g, dt * ff);
    while (f.ev < r.events.length && r.events[f.ev].t <= f.t) {
      const e = r.events[f.ev++];
      this.playEvent(e, c.ball);
      // approach shots that land hard on the green leave a pitch mark
      if (e.type === 'bounce' && e.surf === Surf.Green && (e.speed ?? 0) > 4 && f.setup.club.kind !== 'putter') this.divots.addPitchMark(e.x, e.z);
    }
    if (f.t >= r.duration + 0.6) {
      this.flight = null;
      sfx.setRoll(0);
      this.finishShot(c, r, f);
    }
  }

  private rollPrev = new THREE.Vector3();

  /** The ball rolling across a green makes a soft rumble that follows its speed. */
  private rollSound(inAir: boolean, groundY: number, dt: number) {
    const p = this.tmp;
    const speed = dt > 0 ? Math.hypot(p.x - this.rollPrev.x, p.z - this.rollPrev.z) / dt : 0;
    this.rollPrev.copy(p);
    const onGreen = !inAir && p.y - groundY < 0.05 && this.field.surfAt(p.x, p.z) === Surf.Green;
    sfx.setRoll(onGreen && speed < 8 ? speed / 2.2 : 0);
  }

  /** Club whoosh on the way down: louder and brighter for the long clubs and full swings. */
  private swooshFor(kind: ClubDef['kind'], power: number) {
    if (kind === 'putter') return;
    const k = kind === 'driver' ? 1.25 : kind === 'wood' || kind === 'hybrid' ? 1.1 : kind === 'wedge' ? 0.75 : 0.9;
    this.after(0.04, () => sfx.swoosh(k * (0.5 + 0.5 * Math.min(1, power))));
  }

  /** Sound (and splash) for one moment of a shot, live or replayed. */
  private playEvent(e: SimResult['events'][number], ball: Ball) {
    if (e.type === 'bounce' && e.speed !== undefined && e.speed > 0.8) {
      const s = e.surf === Surf.Green || e.surf === Surf.Fringe ? 'green' : e.surf === Surf.Bunker ? 'sand' : e.surf === Surf.Rough || e.surf === Surf.Deep ? 'rough' : 'fairway';
      sfx.land(s, e.speed);
    } else if (e.type === 'tree') sfx.tree();
    else if (e.type === 'splash') { sfx.splash(); ball.setVisible(false); }
    else if (e.type === 'cup') sfx.cup();
    else if (e.type === 'pin') sfx.land('green', 8);
    else if (e.type === 'lip') sfx.ooh(1);
  }

  // ---------------------------------------------------------------- replay

  /** Watch the last shot again (either golfer's) from the shot's own camera, then aim again. */
  private startReplay() {
    const L = this.lastShot;
    if (!L || this.replay) return;
    this.state = 'replay';
    this.swing.enabled = false;
    this.hud.setAimUi(false);
    this.overlay.hide();
    this.grid.setVisible(false);
    this.hud.setTurn('REPLAY  ·  Space to speed up', 'var(--blue)');
    const ball = new Ball(this.scene, 0xffffff, L.comp.color);
    if (L.comp === this.player) {
      const bc = ballColor(save.appearance.ball);
      ball.setFinish(bc.hex, bc.metal);
    }
    ball.setPosition(L.start, this.field.heightAt(L.start.x, L.start.z));
    // the real ball sits where this shot finished: hide it so there aren't two
    const hidden = L.comp.ball.mesh.visible;
    L.comp.ball.setVisible(false);
    for (const c of [this.player, this.ai]) c.golfer.root.visible = false;
    this.props.setFlagVisible(L.setup.club.kind !== 'putter');
    this.cam.startReplay(this.field, L.r, L.start, L.setup.aimX, L.setup.aimZ, L.setup.club.kind === 'putter');
    this.replay = { t: -0.5, ev: 0, ball, hidden };
  }

  private updateReplay(dt: number) {
    const R = this.replay!, L = this.lastShot!;
    R.t += dt * (this.keys.has(' ') ? 3 : 1);
    const r = L.r;
    sampleAt(r, Math.max(0, R.t), this.tmp);
    R.ball.setPosition(this.tmp, this.field.heightAt(this.tmp.x, this.tmp.z));
    R.ball.spinWithMotion(dt, L.setup.club.kind === 'putter' ? 0 : Math.min(6, 1.5 + L.setup.club.spin / 1800));
    const inAir = !r.landing || R.t < r.landingTime;
    if (R.t > 0 && inAir && L.setup.club.kind !== 'putter') R.ball.addTracerPoint(this.tmp);
    while (R.ev < r.events.length && r.events[R.ev].t <= R.t) this.playEvent(r.events[R.ev++], R.ball);
    if (R.t >= r.duration + 1.2) this.endReplay();
  }

  private endReplay() {
    const R = this.replay, L = this.lastShot;
    if (!R || !L) return;
    R.ball.dispose();
    this.replay = null;
    if (R.hidden) L.comp.ball.setVisible(true);
    for (const c of [this.player, this.ai]) c.golfer.root.visible = c === this.current;
    this.props.setFlagVisible(this.player.lie !== Surf.Green);
    this.state = 'aim';
    this.hud.setTurn('YOUR SHOT');
    this.hud.setAimUi(true);
    this.applyAimPose();
    this.swing.reset();
    this.swing.enabled = true;
    this.previewDirty = true;
  }

  private finishShot(c: Competitor, r: SimResult, f: { setup: ShotSetup; swing: SwingResult; start: THREE.Vector3 }) {
    if (this.rangeTargets) {
      this.finishRangeShot(c, r, f);
      return;
    }
    if (c.side === 'player' && !this.cfg.online && this.cfg.difficulty === 'easy' && !this.mulliganUsed && (r.outcome === 'water' || r.outcome === 'ob')) {
      // Easy: the first ball into water or out of bounds on a hole is a free do-over
      this.mulliganUsed = true;
      c.pos.copy(c.prev.pos);
      c.lie = c.prev.lie;
      c.teed = c.prev.teed;
      c.ball.setVisible(true);
      this.placeBall(c);
      this.hud.showBanner('MULLIGAN', `${r.outcome === 'water' ? 'Wet one' : 'Out of bounds'} — free replay from the same spot (one per hole on Easy)`, 'good', 2600);
      sfx.groan();
      this.refreshHudScores();
      this.state = 'between';
      this.after(2.0, () => this.beginTurn());
      return;
    }
    c.strokes++;
    const xp = c.side === 'player' && !this.cfg.practice ? this.swingXp(c, r, f) : null;
    c.teed = false;
    const putting = f.setup.club.kind === 'putter';
    let delay = 1.25;
    const field = this.field;
    if (r.outcome === 'holed') {
      c.holed = true;
      // the ball stays where it dropped, at the bottom of the cup
      c.ball.setPosition(this.tmp.set(r.rest.x, this.props.cupFloorY + BALL_R, r.rest.z), field.heightAt(field.cup.x, field.cup.z));
      c.pos.set(field.cup.x, field.heightAt(field.cup.x, field.cup.z), field.cup.z);
      const name = scoreName(c.strokes, field.def.par);
      const good = c.strokes <= field.def.par;
      const who = c.side === 'player' ? '' : `${c.name}: `;
      this.hud.showBanner(c.strokes === 1 ? 'HOLE IN ONE!' : name.toUpperCase(), `${who}${c.strokes} ${c.strokes === 1 ? 'stroke' : 'strokes'}`, c.side === 'player' ? (good ? 'good' : '') : '', 2600);
      // bigger roars for birdies, chip-ins and long putts; the holer reacts either way
      const startD = Math.hypot(f.start.x - field.cup.x, f.start.z - field.cup.z);
      const special = c.strokes < field.def.par || !putting || startD > 6;
      if (special) {
        sfx.cheer(c.strokes <= field.def.par - 2 || c.strokes === 1 ? 1.4 : 1);
        this.crowd.cheer(1);
      } else {
        sfx.crowd(0.5);
        this.crowd.cheer(0.35);
      }
      if (c.golfer.root.visible) c.golfer.playClip(good || special ? 'Celebrate' : 'Idle');
      delay = 2.2;
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
      if (c.golfer.root.visible) c.golfer.playClip('Dejected');
      delay = 2.2;
    } else if (r.outcome === 'ob') {
      c.strokes++;
      c.pos.copy(c.prev.pos);
      c.lie = c.prev.lie;
      c.teed = c.prev.teed;
      c.ball.setVisible(true);
      this.placeBall(c);
      this.hud.showBanner('OUT OF BOUNDS', 'Stroke and distance — replay from the previous spot', c.side === 'player' ? 'bad' : '', 2600);
      sfx.groan();
      if (c.golfer.root.visible) c.golfer.playClip('Dejected');
      delay = 2.2;
    } else {
      c.pos.set(r.rest.x, 0, r.rest.z);
      c.lie = r.restSurf;
      this.placeBall(c);
      const dist = this.distToCup(c);
      // gimme
      if ((this.cfg.online?.settings?.gimmes ?? save.settings.gimmes) && (c.lie === Surf.Green || c.lie === Surf.Fringe) && dist < GIMME[this.cfg.difficulty]) {
        c.strokes++;
        c.holed = true;
        c.ball.setVisible(false);
        const name = scoreName(c.strokes, field.def.par);
        this.hud.showBanner(name.toUpperCase(), `${c.side === 'player' ? 'Putt conceded' : c.name + "'s putt conceded"} — ${c.strokes} strokes`, c.side === 'player' && c.strokes <= field.def.par ? 'good' : '', 2200);
        delay = 1.9;
      } else if (!putting) {
        const carry = toYards(r.carry), total = toYards(r.total);
        this.hud.shotResult(`<span>${c.side === 'player' ? 'You' : c.name}</span><span>Carry <b>${carry.toFixed(0)}</b> yds</span><span>Total <b>${total.toFixed(0)}</b> yds</span><span><b>${SURF_NAME[c.lie]}</b></span><span>To pin <b>${toYards(dist).toFixed(0)}</b> yds</span>${xp ? `<span class="xp">XP <b>+${xp.xp}</b></span>` : ''}`);
        // the gallery applauds a good one: stiffed approaches loudest, then greens hit and big drives down the middle
        const fromGreen = c.prev.lie === Surf.Green || c.prev.lie === Surf.Fringe;
        if (!fromGreen && c.lie === Surf.Green) {
          sfx.golfClap(dist < 3 ? 1 : dist < 8 ? 0.7 : 0.4);
          this.crowd.cheer(dist < 3 ? 0.6 : 0.25);
        } else if (c.prev.teed && c.lie === Surf.Fairway && total >= 240) sfx.golfClap(0.45);
      } else {
        this.hud.shotResult(`<span>${c.side === 'player' ? 'You' : c.name}</span><span><b>${(dist / 0.3048).toFixed(1)} ft</b> left</span>${xp ? `<span class="xp">XP <b>+${xp.xp}</b></span>` : ''}`);
        // so close: the crowd reacts and the golfer can't believe it
        if (r.closest < 0.15) {
          if (!r.events.some((e) => e.type === 'lip')) sfx.ooh(0.8);
          if (c.golfer.root.visible) c.golfer.playClip('Dejected');
        }
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
    if (this.aiSkip && c === this.ai) delay = Math.min(delay, 1.2);
    const proceed = () =>
      this.after(delay, () => {
        if (this.holeDecided()) this.endHole();
        else this.beginTurn();
      });
    const net = this.cfg.online;
    if (!net) proceed();
    else if (c === this.player) {
      net.sendSettle(this.flightNetIdx, { x: c.pos.x, y: c.pos.y, z: c.pos.z, lie: c.lie, teed: c.teed, strokes: c.strokes, holed: c.holed, pickedUp: c.pickedUp });
      proceed();
    } else {
      // adopt the shooter's own result, so both rounds always agree on where the ball is
      void net.settled(this.flightNetIdx).then((w) => {
        if (this.disposed || !w.settle) return;
        const st = w.settle;
        const moved = Math.hypot(st.x - c.pos.x, st.z - c.pos.z) > 0.01;
        c.pos.set(st.x, st.y, st.z);
        c.lie = st.lie as Surf;
        c.teed = st.teed;
        c.strokes = st.strokes;
        c.holed = st.holed;
        c.pickedUp = st.pickedUp;
        c.ball.setVisible(!c.holed && !c.pickedUp);
        if (moved) this.placeBall(c);
        this.refreshHudScores();
        proceed();
      });
    }
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
    this.hud.setXp({ ...lv, balance: save.xp, match: bonusXp(this.match, this.cfg.difficulty).total, win: WIN_XP[this.cfg.difficulty], last: this.lastSwingXp, practice: this.cfg.practice });
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
    const done = (c: Competitor) => c.holed || c.pickedUp;
    // practice: the hole is over when you're in; stroke play: both golfers hole out
    if (this.cfg.practice) return done(p);
    if (this.cfg.format === 'stroke') return done(p) && done(a);
    if (p.pickedUp || a.pickedUp) return true;
    if (p.holed && a.holed) return true;
    if (p.holed && !a.holed && a.strokes >= p.strokes) return true;
    if (a.holed && !p.holed && p.strokes >= a.strokes) return true;
    return false;
  }

  /** Where the hole is cut, as on a pin sheet: "Back left · 24 yds on". */
  private pinSheet(): string {
    const f = this.field, g = f.green, cup = f.cup;
    const app = f.pointAt(Math.max(0, f.length - 35));
    let dx = g.x - app.x, dz = g.z - app.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const R = Math.max(g.rx, g.rz);
    const depth = ((cup.x - g.x) * dx + (cup.z - g.z) * dz) / R;
    const side = ((cup.x - g.x) * -dz + (cup.z - g.z) * dx) / R;
    const fb = depth > 0.3 ? 'Back' : depth < -0.3 ? 'Front' : 'Middle';
    const lr = side > 0.3 ? 'right' : side < -0.3 ? 'left' : '';
    const on = Math.max(1, Math.round(toYards(depth * R + R)));
    return `${fb}${lr ? ' ' + lr : fb === 'Middle' ? '' : ' centre'} · ${on} yds on`;
  }

  /** Header status: the match/stroke/skins state, or PRACTICE. */
  private statusText(): string {
    return this.cfg.practice ? 'PRACTICE' : this.match.statusText();
  }

  /** Driving range: measure the shot, then tee up another. */
  private finishRangeShot(c: Competitor, r: SimResult, f: { setup: ShotSetup; swing: SwingResult; start: THREE.Vector3 }) {
    const field = this.field;
    const st = this.rangeStats;
    const putting = f.setup.club.kind === 'putter';
    const rest = r.outcome === 'water' && r.waterEntry ? r.waterEntry : r.rest;
    // sideways from the line you aimed down (+ right)
    const off = toYards((rest.x - f.start.x) * -f.setup.aimZ + (rest.z - f.start.z) * f.setup.aimX);
    const carry = toYards(r.carry), total = toYards(r.total);
    st.shots++;
    if (r.outcome === 'ob' || r.outcome === 'water') {
      this.hud.showBanner(r.outcome === 'ob' ? 'OUT OF BOUNDS' : 'IN THE WATER', 'Tee up another', 'bad', 1800);
      sfx.groan();
    } else {
      st.longest = Math.max(st.longest, total);
      const near = this.rangeTargets!.nearest(rest.x, rest.z);
      const onTarget = !putting && near.dist <= near.target.r;
      if (onTarget) {
        st.onTarget++;
        const close = toYards(near.dist);
        this.hud.showBanner(close < 3 ? 'STIFFED IT!' : 'ON TARGET', `${near.target.yards}-yard ${near.target.name} flag · ${close.toFixed(0)} yds away`, 'good', 2200);
        sfx.golfClap(close < 3 ? 0.9 : 0.5);
      } else if (r.outcome === 'holed') {
        this.hud.showBanner('IN THE HOLE!', 'On the range, too', 'good', 2200);
        sfx.cheer(1);
      }
      const side = Math.abs(off) < 1 ? 'Online' : `<b>${Math.abs(off).toFixed(0)}</b> yds ${off > 0 ? 'right' : 'left'}`;
      this.hud.shotResult(`<span>${f.setup.club.short}</span><span>Carry <b>${carry.toFixed(0)}</b> yds</span><span>Total <b>${total.toFixed(0)}</b> yds</span><span>${side}</span><span>On target <b>${st.onTarget}/${st.shots}</b></span><span>Longest <b>${st.longest.toFixed(0)}</b></span>`, 4200);
    }
    this.state = 'between';
    this.after(r.outcome === 'ob' || r.outcome === 'water' ? 1.6 : 2.0, () => {
      if (this.disposed) return;
      // a fresh ball on the tee
      c.pos.copy(this.teeSpot);
      c.lie = Surf.Tee;
      c.teed = true;
      c.strokes = 0;
      c.holed = false;
      c.ball.setVisible(true);
      c.ball.clearTracer();
      this.placeBall(c);
      this.divots.reset(field);
      this.beginTurn();
      // cut straight back to the tee instead of flying back from the landing area
      const a = this.aimDir;
      this.cam.setAddress(field, c.pos, a.x, a.z, false, true, this.targetHeight());
    });
  }

  private endHole() {
    if (this.state === 'over') return;
    this.state = 'between';
    const p = this.player, a = this.ai;
    const par = this.field.def.par;
    if (this.cfg.practice) {
      this.endPracticeHole();
      return;
    }
    let conceded: Side | undefined;
    if (this.cfg.format !== 'stroke') {
      if (p.pickedUp && !a.pickedUp) conceded = 'player';
      else if (a.pickedUp && !p.pickedUp) conceded = 'ai';
      else if (p.holed && !a.holed) conceded = 'ai';
      else if (a.holed && !p.holed) conceded = 'player';
    }
    const potBefore = this.match.skins().pot;
    const xpBefore = bonusXp(this.match, this.cfg.difficulty).total;
    this.match.record(this.holeIdx, p.strokes, a.strokes, conceded, p.holed);
    const hr = this.match.holes[this.holeIdx];
    const xpGain = bonusXp(this.match, this.cfg.difficulty).total - xpBefore;
    if (xpGain > 0) {
      const parts: string[] = [];
      if (hr.winner === 'player') parts.push(this.cfg.format === 'skins' ? `${potBefore} skin${potBefore > 1 ? 's' : ''}` : 'Hole won');
      if (p.holed && p.strokes - par <= -1) parts.push(scoreName(p.strokes, par));
      this.after(1.2, () => {
        this.hud.xpPop(xpGain, parts.join(' · '));
        sfx.xp();
        this.refreshXp();
      });
    } else this.refreshXp();
    const desc = (c: Competitor) => (c.holed ? `${c.strokes} (${scoreName(c.strokes, par)})` : `${c.strokes} — ${this.cfg.format === 'stroke' ? 'picked up' : 'conceded'}`);
    const scores = `You ${desc(p)} · ${a.name.split(' ')[0]} ${desc(a)} · ${this.match.statusText()}`;
    const fmt = this.cfg.format;
    const skins = (n: number) => `${n} SKIN${n > 1 ? 'S' : ''}`;
    if (hr.winner === 'player') {
      this.honor = 'player';
      const big = fmt === 'skins' ? `YOU WIN ${skins(potBefore)}` : fmt === 'stroke' ? 'BEST SCORE ON THE HOLE' : 'YOU WIN THE HOLE';
      this.hud.showBanner(big, scores, 'good', 3200);
      sfx.crowd(fmt === 'skins' ? Math.min(1.4, 0.6 + potBefore * 0.2) : 0.8);
      p.golfer.root.visible = true;
      a.golfer.root.visible = false;
      p.golfer.playClip('Celebrate');
    } else if (hr.winner === 'ai') {
      this.honor = 'ai';
      const big = fmt === 'skins' ? `${a.name.split(' ')[0].toUpperCase()} WINS ${skins(potBefore)}` : fmt === 'stroke' ? `${a.name.split(' ')[0].toUpperCase()} TAKES THE HOLE` : `${a.name.toUpperCase()} WINS THE HOLE`;
      this.hud.showBanner(big, scores, 'bad', 3200);
      if (p.golfer.root.visible) p.golfer.playClip('Dejected');
    } else {
      const big = fmt === 'skins' ? `${skins(potBefore)} CARR${potBefore > 1 ? 'Y' : 'IES'} OVER` : fmt === 'stroke' ? 'SAME SCORE' : 'HOLE HALVED';
      this.hud.showBanner(big, scores, '', 3200);
    }
    this.hud.setMatch(this.match.statusText(), this.match.holes, this.holeIdx, this.cfg.firstHole);
    this.refreshHudScores();
    this.after(3.0, () => {
      if (this.match.finished || this.holeIdx >= this.cfg.course.holes.length - 1) {
        this.match.finished = true;
        this.state = 'over';
        this.onExit?.({ match: this.match, course: this.cfg.course, difficulty: this.cfg.difficulty, opponentName: this.cfg.opponent.name, quit: false, options: this.cfg.options });
      } else {
        const next = this.holeIdx + 1;
        void (async () => {
          if (this.cfg.holeBreak) await this.cfg.holeBreak(next);
          if (!this.disposed) await this.loadHole(next);
        })();
      }
    });
  }

  /** Practice: show the score, then play on (the holes loop until you quit). */
  private endPracticeHole() {
    const p = this.player, par = this.field.def.par;
    this.match.record(this.holeIdx, p.strokes, p.strokes, undefined, p.holed);
    this.hud.showBanner(p.holed ? scoreName(p.strokes, par).toUpperCase() : 'PICKED UP', `Hole ${this.holeIdx + this.cfg.firstHole} · ${p.strokes} strokes`, p.holed && p.strokes <= par ? 'good' : '', 2600);
    this.hud.setMatch(this.statusText(), this.match.holes, this.holeIdx, this.cfg.firstHole);
    this.after(2.8, () => this.nextPracticeHole());
  }

  private nextPracticeHole() {
    const n = this.cfg.course.holes.length;
    if (this.holeIdx >= n - 1) this.match = new MatchState(this.cfg.course.holes.map((h) => h.par), this.cfg.format, this.cfg.firstHole);
    void this.loadHole((this.holeIdx + 1) % n);
  }

  /** Practice: drop the ball somewhere on the green for putting practice. */
  private puttingPractice() {
    const f = this.field, cup = f.cup, c = this.player;
    for (let k = 0; k < 60; k++) {
      const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(1.5, 11);
      const x = cup.x + Math.cos(a) * d, z = cup.z + Math.sin(a) * d;
      if (f.surfAt(x, z) !== Surf.Green) continue;
      c.pos.set(x, 0, z);
      c.lie = Surf.Green;
      c.teed = false;
      c.ball.setVisible(true);
      this.placeBall(c);
      this.hud.showBanner('PUTTING PRACTICE', `${(d / 0.3048).toFixed(0)} ft from the hole`, '', 1600);
      this.beginTurn();
      return;
    }
  }

  // ---------------------------------------------------------------- AI

  private async aiTurn() {
    const c = this.ai;
    this.state = 'ai';
    this.aiSkip = false;
    this.hud.setAimUi(false);
    this.hud.setTurn(`${c.name} (${this.cfg.opponent.personality.label}) is lining up…  ·  Enter to skip`, 'var(--bad)');
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
      { field: this.field, ball: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, lie: c.lie, teed: c.teed, env: { ...this.simEnv(false, putting0), trees: this.treeIndex ?? undefined, seed: 7 }, difficulty: this.cfg.difficulty, personality: this.cfg.opponent.personality },
      this.rng,
    );
    if (this.disposed) return;
    const wait = Math.max(0, 0.85 - (performance.now() - t0) / 1000);
    await this.aiPause(wait);
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
    this.hud.setTurn(`${c.name} · ${s.club.name}${s.shot.id !== 'normal' && s.shot.id !== 'putt' ? ' · ' + s.shot.name : ''}  ·  Enter to skip`, 'var(--bad)');
    await this.aiPause(0.45);
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
        if (this.aiSkip) {
          c.golfer.setBackswing(target);
          res();
        } else if (u >= 1) res();
        else this.after(1 / 60, step);
      };
      step();
    });
    if (this.disposed) return;
    if (!this.aiSkip) this.swooshFor(s.club.kind, plan.swing.power);
    c.golfer.startDownswing(this.aiSkip ? 0.08 : putting ? 0.35 : 0.24, () => this.executeShot(c, s, plan.swing));
  }

  /** Online: wait for the friend's stroke, then play it out exactly as they hit it. */
  private async remoteTurn() {
    const c = this.ai;
    const net = this.cfg.online!;
    this.state = 'ai';
    this.aiSkip = false;
    this.hud.setAimUi(false);
    this.hud.setTurn(`${c.name} is lining up…`, 'var(--bad)');
    const dist = this.distToCup(c);
    const dirToCup = { x: (this.field.cup.x - c.pos.x) / (dist || 1), z: (this.field.cup.z - c.pos.z) / (dist || 1) };
    const putting0 = c.lie === Surf.Green;
    c.golfer.setClub(putting0 ? 'Club_Putter' : 'Club_Iron', c.tiers['7i'] ?? 0);
    c.golfer.placeForShot(c.pos, dirToCup.x, dirToCup.z, putting0 ? 'Putt' : 'Iron', (x, z) => this.field.heightAt(x, z));
    this.cam.setAddress(this.field, c.pos, dirToCup.x, dirToCup.z, putting0, false);
    this.placeBagFor(c, dirToCup);
    const w = await net.shot(this.netShot);
    if (this.disposed) return;
    const club = CLUBS.find((k) => k.id === w.setup.club) ?? CLUBS[0];
    const s: ShotSetup = {
      ...w.setup,
      club,
      shot: shotTypeById(w.setup.shot),
      lie: w.setup.lie as Surf,
      style: w.setup.style as ShotSetup['style'],
      spin: w.setup.spin as ShotSetup['spin'],
    };
    const swing = w.swing as SwingResult;
    const anim = animFor(s.club, s.shot);
    c.golfer.setClub(s.club.model, s.tier);
    c.golfer.placeForShot(c.pos, s.aimX, s.aimZ, anim, (x, z) => this.field.heightAt(x, z));
    this.props.placeTeePeg(c.pos.x, this.field.heightAt(c.pos.x, c.pos.z), c.pos.z, c.teed && s.club.kind !== 'putter');
    const putting = s.club.kind === 'putter';
    this.props.setFlagVisible(!(putting && c.lie === Surf.Green));
    this.cam.setAddress(this.field, c.pos, s.aimX, s.aimZ, putting, false, this.field.heightAt(this.field.cup.x, this.field.cup.z));
    this.placeBagFor(c, { x: s.aimX, z: s.aimZ });
    this.hud.setTurn(`${c.name} · ${s.club.name}${s.shot.id !== 'normal' && s.shot.id !== 'putt' ? ' · ' + s.shot.name : ''}`, 'var(--bad)');
    // their backswing, then the strike
    const target = Math.min(1, putting ? 0.35 + 0.65 * Math.min(1, (s.puttScale ?? 5) / 20) : swing.power);
    const dur = putting ? 0.7 : 0.95;
    await new Promise<void>((res) => {
      let t = 0;
      const step = () => {
        if (this.disposed) return;
        t += 1 / 60;
        const u = Math.min(1, t / dur);
        c.golfer.setBackswing(target * (1 - (1 - u) * (1 - u)));
        if (u >= 1) res();
        else this.after(1 / 60, step);
      };
      step();
    });
    if (this.disposed) return;
    this.swooshFor(s.club.kind, swing.power);
    c.golfer.startDownswing(putting ? 0.35 : 0.24, () => this.executeShot(c, s, swing));
  }

  /** Which on-screen touch buttons apply right now. */
  touchState(): { aim: boolean; putting: boolean; skip: boolean; inRound: boolean } {
    const aim = !this.paused && this.state === 'aim' && this.swing.enabled && !this.swing.active;
    return {
      aim,
      putting: this.club?.kind === 'putter',
      skip: !this.paused && (this.state === 'intro' || this.aiTurnActive()),
      inRound: this.state !== 'loading' && this.state !== 'over',
    };
  }

  /** The opponent is lining up, swinging, or their ball is in the air. */
  private aiTurnActive(): boolean {
    if (this.paused || !this.ai) return false;
    return this.state === 'ai' || (this.state === 'flight' && this.flight?.comp === this.ai);
  }

  /** Wait during the opponent's turn; ends early once the player asks to skip. */
  private aiPause(sec: number): Promise<void> {
    return new Promise((res) => {
      let left = sec;
      const step = () => {
        if (this.disposed) return;
        if (this.aiSkip || left <= 0) res();
        else {
          left -= 1 / 30;
          this.after(1 / 30, step);
        }
      };
      step();
    });
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
      status: this.statusText(),
      firstHole: this.cfg.firstHole,
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
    if (this.state === 'replay' && this.replay) this.updateReplay(dt);
    for (const c of [this.player, this.ai]) c.golfer.update(dt);
    const focusBall = this.replay ? this.replay.ball.mesh.position : this.flight ? this.flight.comp.ball.mesh.position : this.current.pos;
    this.cam.update(dt, this.field, focusBall);
    this.divots.update(dt);
    this.rain?.update(dt, this.camera, this.wind.x, this.wind.z);
    this.birds.update(dt);
    this.crowd.update(dt, this.camera);
    this.grass?.update(this.camera, this.field.heightAt(this.camera.position.x, this.camera.position.z));
    this.veg.cull(this.camera);
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
    this.replay?.ball.updateScale(this.camera);
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
    this.onExit?.({ match: this.match, course: this.cfg.course, difficulty: this.cfg.difficulty, opponentName: this.cfg.opponent.name, quit: true, options: this.cfg.options });
  }

  dispose() {
    this.disposed = true;
    setAltitude(0);
    this.swing.enabled = false;
    this.replay?.ball.dispose();
    this.replay = null;
    this.rain?.dispose();
    this.rain = null;
    this.birds.dispose();
    this.crowd.dispose();
    this.landmarks.dispose();
    this.scene.remove(this.landmarks.group);
    this.rangeTargets?.dispose();
    this.rangeTargets = null;
    sfx.setRain(false);
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('keyup', this.keyUpHandler);
    this.canvas.removeEventListener('wheel', this.wheelHandler);
    this.swing.dispose();
    this.unloadTerrain();
    this.veg.dispose();
    this.scene.remove(this.veg.group, this.props.group, this.overlay.group, this.grid.mesh);
    this.divots.dispose();
    for (const c of [this.player, this.ai]) {
      if (!c) continue;
      this.scene.remove(c.golfer.root);
      c.ball.dispose();
    }
    this.hud.show(false);
    this.hud.showScorecard(false);
  }
}

