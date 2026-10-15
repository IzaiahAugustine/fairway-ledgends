// Fairway Legends — entry point: renderer + post-processing, the menu stage, and the game loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { music } from './audio/music';
import { sfx } from './audio/sfx';
import { hashString } from './core/rng';
import { TEXT_SCALE, persist, save, type Appearance } from './core/save';
import { HOLE_SETS, courseById, courseForSet } from './data/courses';
import { careerEvent } from './data/career';
import { FORMATS, type MatchOptions } from './game/match';
import { PERSONALITIES, makeOpponent, planAiShot, type Opponent } from './game/ai';
import type { OnlineMatch } from './net/online';
import { portal } from './platform/portal';
import { MenuStage, type StageMode } from './game/menuStage';
import { Round } from './game/round';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
import { TouchControls, isTouch } from './ui/touch';
import { uiScale } from './ui/dom';
import './ui/style.css';
import { AtmospherePass } from './world/atmosphere';
import { SkyEnvironment } from './world/environment';
import { setImpostorRenderer } from './world/impostors';
import { setHiResTextures } from './core/assets';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

setImpostorRenderer(renderer);

const camera = new THREE.PerspectiveCamera(50, 1, 0.08, 16000);

// --- course scene (rounds)
const courseScene = new THREE.Scene();
const courseEnv = new SkyEnvironment(renderer, courseScene);
courseEnv.useSceneFog = false;

// --- menu stage (main menu, golfer editor, golf bag)
const stage = new MenuStage(renderer);
const STAGE_EXPOSURE = 0.85 * 0.92;
let stageMode: StageMode = 'menu';
let dragging = false;
let dragX = 0;

/** GTAO at half resolution: ambient occlusion is soft, so the saving is free. */
class HalfResGTAO extends GTAOPass {
  setSize(width: number, height: number) {
    super.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
  }
}

interface Pipeline {
  composer: EffectComposer;
  atmosphere: AtmospherePass;
  gtao: HalfResGTAO;
  finish: ShaderPass;
  env: SkyEnvironment;
}

/**
 * MSAA samples for the scene pass. Always on: besides smoothing edges, the leaf cards, hair and
 * grass rely on alpha-to-coverage, which only works with MSAA (without it they turn into hard,
 * stair-stepped cut-outs).
 */
const MSAA = 4;

/**
 * Scene pass → contact shadows (GTAO) → aerial perspective → bloom → tone mapping → grade.
 * The AO and haze passes both read the scene pass depth from render target 1.
 */
function makePipeline(scene: THREE.Scene, env: SkyEnvironment): Pipeline {
  const depth = new THREE.DepthTexture(2, 2);
  depth.type = THREE.UnsignedIntType;
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: MSAA, depthTexture: depth });
  const c = new EffectComposer(renderer, rt);
  // only the scene pass needs MSAA and depth; the second buffer just takes full-screen passes
  c.renderTarget2.samples = 0;
  c.renderTarget2.depthBuffer = false;
  c.renderTarget2.depthTexture = null;
  c.addPass(new RenderPass(scene, camera));
  const d = c.renderTarget1.depthTexture!;
  const gtao = new HalfResGTAO(scene, camera, 2, 2);
  // (passing the depth texture to the constructor trips a three.js bug; attach it afterwards)
  gtao.setGBuffer(d);
  gtao.blendIntensity = 0.6;
  // 8 samples (+ denoise) at half resolution: soft contact shadows for about half the old cost
  gtao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.6, thickness: 2.5, scale: 1.0, samples: 8 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 8 });
  c.addPass(gtao);
  const atmosphere = new AtmospherePass(camera, d);
  c.addPass(atmosphere);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.14, 0.45, 0.92);
  // the sun and the sky around it are far brighter than anything else: cap what feeds the bloom
  // so a shot into the sun glows instead of veiling the whole frame in white
  const hp = bloom.materialHighPassFilter;
  hp.fragmentShader = hp.fragmentShader.replace(
    'gl_FragColor = mix( outputColor, texel, alpha );',
    'vec4 bc = mix( outputColor, texel, alpha );\n gl_FragColor = vec4( bc.rgb * min( 1.0, 2.0 / max( luminance( bc.rgb ), 1e-4 ) ), bc.a );',
  );
  hp.needsUpdate = true;
  c.addPass(bloom);
  c.addPass(new OutputPass());
  // broadcast-camera finish: contrast-adaptive sharpening (restores crispness when rendering below
  // the screen's native resolution), then vignette and a touch of contrast/saturation
  const finish = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) }, uSharp: { value: 0.3 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uSharp; varying vec2 vUv;
        void main(){
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 col = c.rgb;
          if (uSharp > 0.0) {
            // AMD CAS-style: sharpen less where local contrast is already high, so edges don't ring
            vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
            vec3 s = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
            vec3 e = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
            vec3 w = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
            vec3 mn = min(col, min(min(n, s), min(e, w)));
            vec3 mx = max(col, max(max(n, s), max(e, w)));
            vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
            vec3 wgt = -amp * mix(0.125, 0.2, uSharp);
            col = clamp((col + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt), 0.0, 1.0);
          }
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          // turf: pull pure greens toward a natural sunlit yellow-green and take a little saturation
          // out, so fairways read like grass rather than lime paint
          float greenness = clamp((col.g - max(col.r, col.b)) * 3.5, 0.0, 1.0);
          col = mix(col, mix(vec3(l), col, 0.86) * vec3(1.05, 1.0, 0.9), greenness * 0.55);
          col = mix(vec3(l), col, 1.06);
          // gentle filmic S-curve, then split-tone: cool shadows, warm highlights
          col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
          l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col *= mix(vec3(0.96, 0.99, 1.04), vec3(1.035, 1.0, 0.955), smoothstep(0.15, 0.75, l));
          col = (col - 0.5) * 1.02 + 0.5;
          vec2 d = vUv - 0.5;
          col *= 1.0 - dot(d, d) * 0.42;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
        }`,
  });
  c.addPass(finish);
  return { composer: c, atmosphere, gtao, finish, env };
}

function renderPipeline(p: Pipeline, dt: number) {
  const e = p.env;
  p.atmosphere.setParams({
    sunDir: e.sunDirWorld,
    sunColor: e.sun.color.clone().multiplyScalar(e.sun.intensity),
    horizon: e.horizonRadiance,
    density: e.haze.density,
    falloff: e.haze.falloff,
    baseHeight: e.haze.base,
    skyHaze: e.haze.skyHaze,
  });
  // the scene pass must always land in render target 1, whose depth the AO and haze read
  if (p.composer.readBuffer !== p.composer.renderTarget1) p.composer.swapBuffers();
  p.composer.render(dt);
}

const coursePipe = makePipeline(courseScene, courseEnv);
const stagePipe = makePipeline(stage.scene, stage.env);

const hud = new Hud(uiRoot);
let round: Round | null = null;
let paused = false;

const menus = new Menus(uiRoot, {
  startMatch: (opts) => void startMatch(opts),
  startOnline: (m) => {
    const st = m.settings!;
    void startMatch({ courseId: st.courseId, difficulty: st.difficulty, format: st.format, holes: st.holes, weather: st.weather }, m);
  },
  previewAppearance: (a) => applyStageAppearance(a),
  showroom: (m) => {
    stageMode = m;
    if (m !== 'swing') stage.setSwingDemo(null);
  },
  swingDemo: (st) => stage.setSwingDemo(st),
  settingsChanged: () => {
    sfx.setEnabled(save.settings.sound);
    applyAudio();
    applyQuality();
    applyTextSize();
  },
  resume: () => setPaused(false),
  quitMatch: () => {
    setPaused(false);
    round?.quit();
  },
});

/**
 * Render quality vs speed. Each quality level has a pixel budget, so a Retina laptop (2x density)
 * draws about as many pixels as a desktop monitor instead of 2-3x more. When frames still run slow,
 * an adaptive ladder gives up the least visible things first: ambient occlusion, then a little
 * resolution at a time (never below DYN_MIN), and climbs back up when there is headroom.
 * Rendering below native resolution is compensated by the sharpening in the finish pass.
 */
const PIXEL_BUDGET = { high: 2_100_000, medium: 1_400_000, low: 800_000 };
const PR_CAP = { high: 1.5, medium: 1.15, low: 0.85 };
/** Phones: small screens held close need more of their native density to look sharp. */
const PR_CAP_TOUCH = { high: 2.4, medium: 2, low: 1.6 };
/**
 * Ladder rung -> resolution scale. Rung 1 only drops ambient occlusion; from rung 6 MSAA is halved,
 * and the last rungs keep going down for laptop GPUs (an M1 Air still runs below 30 fps at 0.75).
 */
const DYN_SCALES = [1, 1, 0.93, 0.86, 0.8, 0.75, 0.75, 0.68, 0.6];
const MSAA_LOW_RUNG = 6;
/** Phones stop at 0.8: lower than that, a phone held close looks smeared. */
const DYN_MAX = isTouch ? 4 : DYN_SCALES.length - 1;
const dynRes = { level: 0, avgMs: 16.7, cooldown: 0 };

function targetPixelRatio(): number {
  const q = save.settings.quality;
  const css = window.innerWidth * window.innerHeight;
  const budget = Math.sqrt(PIXEL_BUDGET[q] / Math.max(1, css));
  return Math.min(window.devicePixelRatio, (isTouch ? PR_CAP_TOUCH : PR_CAP)[q], Math.max(0.5, budget));
}

function applyRenderLevel() {
  const q = save.settings.quality;
  const samples = dynRes.level >= MSAA_LOW_RUNG ? 2 : MSAA;
  for (const p of [coursePipe, stagePipe]) {
    // phones skip contact shadows: costly, and hard to see on a small screen
    p.gtao.enabled = q !== 'low' && !isTouch && dynRes.level === 0;
    const rt = p.composer.renderTarget1;
    if (rt.samples !== samples) {
      rt.samples = samples;
      rt.dispose();
    }
  }
  const pr = Math.round(targetPixelRatio() * DYN_SCALES[dynRes.level] * 40) / 40;
  if (Math.abs(pr - renderer.getPixelRatio()) < 0.01) return;
  renderer.setPixelRatio(pr);
  resize();
}

/** Called once per frame with the real frame time: steps down a rung when slower than the chosen target, up when there is headroom. */
function updateDynamicResolution(frameMs: number) {
  dynRes.avgMs += (Math.min(frameMs, 100) - dynRes.avgMs) * 0.05;
  dynRes.cooldown -= frameMs / 1000;
  if (dynRes.cooldown > 0) return;
  // frame-time window to hold: Smooth ~50-60 fps, Balanced ~38-48 fps, Best looking ~28-33 fps
  const [slow, fast] = { smooth: [20, 17.2], balanced: [26, 21], quality: [36, 30] }[save.settings.gfxPriority] ?? [26, 21];
  let l = dynRes.level;
  if (dynRes.avgMs > slow) l = Math.min(DYN_MAX, l + 1);
  else if (dynRes.avgMs < fast) l = Math.max(0, l - 1);
  autoLowerQuality(frameMs, slow);
  if (l === dynRes.level) return;
  // climbing back up costs more than it saves if it immediately drops again: wait longer before trying
  dynRes.cooldown = l < dynRes.level ? 4 : 1.5;
  dynRes.level = l;
  applyRenderLevel();
}

/**
 * Auto graphics: when a round keeps running slowly even at the bottom of the resolution ladder,
 * step the quality setting down. The new grass, tree and terrain detail take effect from the next
 * hole (rebuilding them mid-hole would hitch); the shadow map shrinks straight away.
 */
let slowFor = 0;
function autoLowerQuality(frameMs: number, slow: number) {
  const st = save.settings;
  // phones stop at Medium: their Medium is already pared down, and Low is mostly just blurrier
  const floor = isTouch ? 'medium' : 'low';
  if (!round || paused || !st.autoGfx || st.quality === floor || st.quality === 'low' || st.gfxPriority === 'quality') {
    slowFor = 0;
    return;
  }
  const atBottom = dynRes.level === DYN_MAX;
  slowFor = atBottom && dynRes.avgMs > slow ? slowFor + frameMs / 1000 : Math.max(0, slowFor - frameMs / 2000);
  if (slowFor < 8) return;
  slowFor = 0;
  st.quality = st.quality === 'high' ? 'medium' : 'low';
  persist();
  courseEnv.setQuality(st.quality);
  setHiResTextures(false);
  hud.showBanner('SMOOTHER GRAPHICS', `Switched to ${st.quality === 'medium' ? 'Medium' : 'Low'} quality from the next hole · change it in Settings`, '', 3200);
}

function applyQuality() {
  const q = save.settings.quality;
  setHiResTextures(q === 'high');
  dynRes.level = 0;
  dynRes.cooldown = 2;
  renderer.setPixelRatio(targetPixelRatio());
  courseEnv.setQuality(q);
  stage.env.setQuality(q);
  for (const p of [coursePipe, stagePipe]) p.gtao.enabled = q !== 'low' && !isTouch;
  renderer.shadowMap.needsUpdate = true;
  resize();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  // sharpen more the further below the screen's native resolution we render (and without MSAA)
  const under = 1 - Math.min(1, pr / window.devicePixelRatio);
  // light touch only: strong sharpening brings back the jaggies the anti-aliasing removed
  const sharp = Math.min(0.4, 0.08 + under * 0.4);
  for (const p of [coursePipe, stagePipe]) {
    // phones: only the pipeline on screen keeps full-size render targets (memory)
    const idle = isTouch && p !== (round ? coursePipe : stagePipe);
    p.composer.setPixelRatio(idle ? 1 : pr);
    p.composer.setSize(idle ? 1 : w, idle ? 1 : h);
    p.finish.uniforms.uTexel.value.set(1 / Math.max(1, Math.round(w * pr)), 1 / Math.max(1, Math.round(h * pr)));
    p.finish.uniforms.uSharp.value = sharp;
  }
  round?.setResolution(w, h);
}
window.addEventListener('resize', () => {
  resize();
  applyRenderLevel();
});

async function buildStage() {
  await stage.build(save.settings.quality);
  stage.applyAppearance(save.appearance);
  stage.setClub('Club_Iron', save.clubs['7i'] ?? 0);
}

function applyStageAppearance(a: Appearance) {
  stage.applyAppearance(a);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!round && stageMode === 'editor') {
    dragging = true;
    dragX = e.clientX;
  }
});
window.addEventListener('pointermove', (e) => {
  if (dragging) {
    stage.angle += (e.clientX - dragX) * 0.01;
    dragX = e.clientX;
  }
});
window.addEventListener('pointerup', () => (dragging = false));

function setPaused(p: boolean) {
  paused = p;
  if (round) round.paused = p;
  if (p) menus.showPause();
  else menus.hide();
  if (round) {
    if (p) portal.gameplayStop();
    else portal.gameplayStart();
  }
}

// while a portal ad plays: the game stands still, makes no sound and takes no input
const adShield = document.createElement('div');
adShield.style.cssText = 'position:fixed;inset:0;z-index:99999;display:none;';
document.body.append(adShield);
const swallowKeys = (e: KeyboardEvent) => {
  e.preventDefault();
  e.stopImmediatePropagation();
};
portal.onAdStart = () => {
  if (round) round.paused = true;
  void sfx.context()?.suspend();
  adShield.style.display = 'block';
  window.addEventListener('keydown', swallowKeys, true);
  window.addEventListener('keyup', swallowKeys, true);
};
portal.onAdEnd = () => {
  if (round) round.paused = paused;
  void sfx.context()?.resume();
  adShield.style.display = 'none';
  window.removeEventListener('keydown', swallowKeys, true);
  window.removeEventListener('keyup', swallowKeys, true);
};

async function startMatch(opts: MatchOptions, online?: OnlineMatch) {
  const full = courseById(opts.courseId);
  const { course, firstHole } = courseForSet(full, opts.practice ? 'all' : opts.holes);
  const diff = opts.difficulty;
  const ev = careerEvent(opts.careerEvent);
  const title = opts.practice ? 'Heading to the practice ground' : ev ? ev.title : 'Heading to the first tee';
  const setName = HOLE_SETS.find((x) => x.id === opts.holes)?.name ?? '';
  const fmtName = FORMATS.find((x) => x.id === opts.format)?.name ?? '';
  menus.showLoading(title, opts.practice ? `${course.name} · Practice` : `${course.name} · ${setName} · ${fmtName} · ${diff[0].toUpperCase()}${diff.slice(1)}`);
  stageMode = 'none';
  if (round) {
    round.dispose();
    round = null;
  }
  await new Promise((r) => setTimeout(r, 30));
  const seed = online?.settings ? online.settings.seed : (hashString(course.id) ^ Date.now()) >>> 0;
  // a career event always brings the same opponent; online it's the friend
  const friend = online?.opponent;
  const opp: Opponent = friend
    ? { name: friend.name, appearance: friend.appearance, personality: { ...PERSONALITIES[0], id: 'friend', label: 'Friend', style: friend.style } }
    : ev
      ? makeOpponent(hashString(ev.id), ev.personality)
      : makeOpponent(seed);
  renderer.toneMappingExposure = course.exposure * 0.92;
  courseEnv.setQuality(save.settings.quality);
  const r = new Round(courseScene, camera, courseEnv, hud, canvas, {
    course, difficulty: diff, opponent: opp, seed, format: opts.practice ? 'stroke' : opts.format, firstHole, practice: !!opts.practice, options: opts, online,
    // portals: an ad break every third hole
    holeBreak: (next) => (next % 3 === 0 ? portal.commercialBreak() : Promise.resolve()),
  });
  if (online) {
    online.onOpponentLeft = () => {
      hud.showBanner('FRIEND LEFT', `${opp.name} has left the match`, 'bad', 3500);
      setTimeout(() => r.quit(), 3500);
    };
  }
  round = r;
  resize();
  r.onPause = () => setPaused(!paused);
  applyAudio();
  // compile for the composer's HDR target (no tone mapping, linear output): compiling for the
  // canvas would build different shader variants and the real ones would still hitch mid-play
  r.precompile = () => {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(coursePipe.composer.renderTarget1);
    const p = renderer.compileAsync(courseScene, camera);
    renderer.setRenderTarget(prev);
    return p.then(() => undefined).catch(() => undefined);
  };
  renderer.toneMappingExposure = course.exposure * 0.92 * r.exposureMul;
  r.onExit = (res) => {
    portal.gameplayStop();
    if (online) {
      if (res.quit) online.leave();
      else online.finish();
      online.onOpponentLeft = null;
    }
    r.dispose();
    if (round === r) round = null;
    resize();
    renderer.toneMappingExposure = STAGE_EXPOSURE;
    stage.applyAppearance(save.appearance);
    paused = false;
    applyAudio();
    if (res.quit || res.options.practice) menus.showMain();
    else menus.showResults(res.match, res.course, res.difficulty, res.opponentName, res.options, () => menus.showMain());
  };
  resize();
  try {
    await r.start();
    menus.hide();
    portal.gameplayStart();
  } catch (e) {
    console.error(e);
    menus.showLoading('Something went wrong loading the course', String(e));
  }
}

const clock = new THREE.Clock();
const debug = { timeScale: 1 };
function frame() {
  requestAnimationFrame(frame);
  const raw = clock.getDelta();
  // hidden tabs pause rAF: don't read the long gap as a slow frame
  if (raw < 0.25 && !document.hidden) updateDynamicResolution(raw * 1000);
  const dt = Math.min(0.05, raw) * debug.timeScale;
  if (round) {
    round.update(paused ? 0 : dt);
    touch?.update(!paused && !menus.visible ? round.touchState() : null);
    renderPipeline(coursePipe, dt);
  } else {
    touch?.update(null);
    stage.update(dt, camera, stageMode, dragging);
    renderPipeline(stagePipe, dt);
  }
}

function applyAudio() {
  const st = save.settings;
  sfx.setVolumes({ master: st.volMaster, effects: st.volEffects, ambience: st.volAmbience, music: st.volMusic });
  music.play(round ? (st.musicInRound ? 'course' : 'off') : 'menu');
}

// browsers only allow sound after the first click or key press
const unlockAudio = () => {
  sfx.context();
  applyAudio();
};
window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
window.addEventListener('keydown', unlockAudio, { once: true, capture: true });

// Phones drop texture source images once uploaded (see releaseAfterUpload), so a lost GPU context
// can't be rebuilt in place: start the page over instead.
if (isTouch) canvas.addEventListener('webglcontextlost', () => location.reload());

// Phones and tablets: on-screen buttons stand in for the keyboard
const touch = isTouch ? new TouchControls(document.getElementById('app') as HTMLElement, () => round && setPaused(!paused)) : null;
if (isTouch) {
  document.documentElement.classList.add('touch-ui');
  // a phone's browser bars eat a lot of a landscape screen: go fullscreen on the first tap where allowed
  const full = () => {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
      .catch(() => {});
  };
  window.addEventListener('pointerup', full, { once: true, capture: true });
}

/**
 * The HUD is laid out for a 1280×720-ish screen: on smaller ones it's shrunk as a whole (--uiz).
 * The menus already flow with the screen size, so for them only the text scale shrinks (--fs-menu).
 */
function applyUiScale() {
  const z = Math.max(0.42, Math.min(1, window.innerHeight / 700, window.innerWidth / 1150));
  uiScale.value = z;
  const root = document.documentElement.style;
  const fs = TEXT_SCALE[save.settings.textSize] ?? 1.25;
  root.setProperty('--uiz', z.toFixed(3));
  root.setProperty('--fs', String(fs));
  root.setProperty('--fs-menu', (fs * Math.max(0.6, z)).toFixed(3));
}
applyUiScale();
window.addEventListener('resize', applyUiScale);

function applyTextSize() {
  applyUiScale();
}

async function boot() {
  // game portal SDK first (no-op off-portal); never hold the game up for it
  await Promise.race([portal.init(), new Promise((r) => setTimeout(r, 6000))]);
  // phones that auto-dropped to Low before the phone build got lighter: back to Medium, once
  if (isTouch && save.settings.quality === 'low') {
    try {
      if (!localStorage.getItem('fairwayLegends.phoneGfx')) {
        save.settings.quality = 'medium';
        persist();
      }
      localStorage.setItem('fairwayLegends.phoneGfx', '1');
    } catch {
      // storage blocked: leave the setting alone
    }
  }
  applyQuality();
  applyTextSize();
  sfx.setEnabled(save.settings.sound);
  menus.showLoading('Fairway Legends', 'Loading the clubhouse…');
  renderer.toneMappingExposure = STAGE_EXPOSURE;
  try {
    await buildStage();
  } catch (e) {
    console.error(e);
  }
  menus.showMain();
  portal.loadingFinished();
  frame();
  // invite link: ?join=CODE opens Play Online and joins straight away
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    // drop the code from the address bar (so a reload doesn't rejoin) but keep any other flags
    params.delete('join');
    history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
    menus.showOnline(joinCode);
  }
  // debug hook for automated testing (dev server, or ?debug)
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug'))
    (window as unknown as Record<string, unknown>).__golf = { startMatch, dynRes, music, sfx, get round() { return round; }, save, debug, menus, planAiShot, renderer, courseEnv, stage, gtao: coursePipe.gtao, pipes: { course: coursePipe, stage: stagePipe } };
}

void boot();
