// Fairway Legends — entry point: renderer + post-processing, the menu stage, and the game loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { sfx } from './audio/sfx';
import { hashString } from './core/rng';
import { TEXT_SCALE, save, type Appearance, type Difficulty } from './core/save';
import { courseById } from './data/courses';
import { makeOpponent, planAiShot } from './game/ai';
import { MenuStage, type StageMode } from './game/menuStage';
import { Round } from './game/round';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
import './ui/style.css';
import { AtmospherePass } from './world/atmosphere';
import { SkyEnvironment } from './world/environment';
import { setImpostorRenderer } from './world/impostors';

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
  env: SkyEnvironment;
}

/**
 * Scene pass → contact shadows (GTAO) → aerial perspective → bloom → tone mapping → grade.
 * The AO and haze passes both read the scene pass depth from render target 1.
 */
function makePipeline(scene: THREE.Scene, env: SkyEnvironment): Pipeline {
  const depth = new THREE.DepthTexture(2, 2);
  depth.type = THREE.UnsignedIntType;
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4, depthTexture: depth });
  const c = new EffectComposer(renderer, rt);
  c.addPass(new RenderPass(scene, camera));
  const d = c.renderTarget1.depthTexture!;
  const gtao = new HalfResGTAO(scene, camera, 2, 2);
  // (passing the depth texture to the constructor trips a three.js bug; attach it afterwards)
  gtao.setGBuffer(d);
  gtao.blendIntensity = 0.6;
  gtao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.6, thickness: 2.5, scale: 1.0, samples: 12 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
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
  // gentle broadcast-camera finish: vignette and a touch of contrast/saturation
  c.addPass(
    new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 col = c.rgb;
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, 1.06);
          col = (col - 0.5) * 1.04 + 0.5;
          vec2 d = vUv - 0.5;
          col *= 1.0 - dot(d, d) * 0.42;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
        }`,
    }),
  );
  return { composer: c, atmosphere, gtao, env };
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
  startMatch: (id, diff) => void startMatch(id, diff),
  previewAppearance: (a) => applyStageAppearance(a),
  showroom: (m) => {
    stageMode = m;
  },
  settingsChanged: () => {
    sfx.setEnabled(save.settings.sound);
    applyQuality();
    applyTextSize();
  },
  resume: () => setPaused(false),
  quitMatch: () => {
    setPaused(false);
    round?.quit();
  },
});

function applyQuality() {
  const q = save.settings.quality;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q === 'high' ? 1.5 : q === 'medium' ? 1.15 : 0.85));
  courseEnv.setQuality(q);
  stage.env.setQuality(q);
  for (const p of [coursePipe, stagePipe]) p.gtao.enabled = q !== 'low';
  renderer.shadowMap.needsUpdate = true;
  resize();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  for (const p of [coursePipe, stagePipe]) {
    p.composer.setPixelRatio(pr);
    p.composer.setSize(w, h);
  }
  round?.setResolution(w, h);
}
window.addEventListener('resize', resize);

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
}

async function startMatch(courseId: string, diff: Difficulty) {
  const course = courseById(courseId);
  menus.showLoading('Heading to the first tee', `${course.name} · ${diff[0].toUpperCase()}${diff.slice(1)}`);
  stageMode = 'none';
  if (round) {
    round.dispose();
    round = null;
  }
  await new Promise((r) => setTimeout(r, 30));
  const seed = (hashString(course.id) ^ Date.now()) >>> 0;
  const opp = makeOpponent(seed);
  renderer.toneMappingExposure = course.exposure * 0.92;
  courseEnv.setQuality(save.settings.quality);
  const r = new Round(courseScene, camera, courseEnv, hud, canvas, { course, difficulty: diff, opponent: opp, seed });
  round = r;
  r.onPause = () => setPaused(!paused);
  r.onExit = (res) => {
    r.dispose();
    if (round === r) round = null;
    renderer.toneMappingExposure = STAGE_EXPOSURE;
    stage.applyAppearance(save.appearance);
    paused = false;
    if (res.quit) menus.showMain();
    else menus.showResults(res.match, res.course, res.difficulty, res.opponentName, () => menus.showMain());
  };
  resize();
  try {
    await r.start();
    menus.hide();
  } catch (e) {
    console.error(e);
    menus.showLoading('Something went wrong loading the course', String(e));
  }
}

const clock = new THREE.Clock();
const debug = { timeScale: 1 };
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta()) * debug.timeScale;
  if (round) {
    round.update(paused ? 0 : dt);
    renderPipeline(coursePipe, dt);
  } else {
    stage.update(dt, camera, stageMode, dragging);
    renderPipeline(stagePipe, dt);
  }
}

function applyTextSize() {
  document.documentElement.style.setProperty('--fs', String(TEXT_SCALE[save.settings.textSize] ?? 1.25));
}

async function boot() {
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
  frame();
  // debug hook for automated testing (dev server, or ?debug)
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug'))
    (window as unknown as Record<string, unknown>).__golf = { startMatch, get round() { return round; }, save, debug, menus, planAiShot, renderer, courseEnv, stage, gtao: coursePipe.gtao, pipes: { course: coursePipe, stage: stagePipe } };
}

void boot();
