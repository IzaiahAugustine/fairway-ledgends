// Standalone tree lineup for checking treeGen visuals: every kind and variant, instanced on grass
// under the HDRI sky. Camera presets by hash: #<kind>-<view>, e.g. #oak-near, #pine-far, #all-far.
// Query: ?q=low|medium|high, ?wind=0.8, ?t=12 (freeze time), ?ui=0, ?exp=0.8&sun=5&env=0.6, ?leaves=0
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { loadTexture } from './core/assets';
import { SkyEnvironment } from './world/environment';
import { buildTreeTemplates, type TreeTemplate, type WindUniforms } from './world/treeGen';

const qs = new URLSearchParams(location.search);
const quality = (qs.get('q') ?? 'high') as 'low' | 'medium' | 'high';
const freezeT = qs.has('t') ? Number(qs.get('t')) : null;
const info = document.getElementById('info')!;
if (qs.get('ui') === '0') info.style.display = 'none';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = Number(qs.get('exp') ?? 0.8);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

// same post chain as the game: MSAA target (needed for alphaToCoverage), light bloom, grade
const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.14, 0.45, 0.92));
composer.addPass(new OutputPass());
composer.addPass(
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

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const env = new SkyEnvironment(renderer, scene);
(window as unknown as Record<string, unknown>).__env = env;
const wind: WindUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0.35).normalize().multiplyScalar(Number(qs.get('wind') ?? 0.7)) } };

const KINDS = ['Tree_Oak', 'Tree_Pine', 'Tree_Birch', 'Tree_Cypress', 'Bush_Gorse', 'Bush_Green'];
const SHORT: Record<string, string> = { oak: 'Tree_Oak', pine: 'Tree_Pine', birch: 'Tree_Birch', cypress: 'Tree_Cypress', gorse: 'Bush_Gorse', green: 'Bush_Green' };
const clusters = new Map<string, { x: number; r: number; h: number }>();

async function buildGround() {
  const g = new THREE.PlaneGeometry(20000, 20000);
  g.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a5a2a, roughness: 1 });
  const ground = new THREE.Mesh(g, mat);
  ground.receiveShadow = true;
  scene.add(ground);
  const [diff, nor] = await Promise.all([loadTexture('grass005_diff_1k.jpg'), loadTexture('grass005_nor_gl_1k.jpg', false)]);
  for (const t of [diff.tex, nor.tex]) t.repeat.set(5000, 5000);
  mat.map = diff.tex;
  mat.normalMap = nor.tex;
  const lum = diff.avg.r * 0.2126 + diff.avg.g * 0.7152 + diff.avg.b * 0.0722;
  mat.color.setScalar(0.06 / Math.max(lum, 0.01));
  mat.needsUpdate = true;
}

function place(templates: Map<string, TreeTemplate[]>) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  let x = 0;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const kind of KINDS) {
    const list = templates.get(kind);
    if (!list) continue;
    const r = Math.max(...list.map((t) => t.radius));
    const h = Math.max(...list.map((t) => t.height));
    const spacing = r * 2 * 1.02;
    const cx = x + spacing;
    clusters.set(kind, { x: cx, r, h });
    list.forEach((tpl, vi) => {
      // two copies of each variant: a front row and a staggered back row
      const spots = [
        { x: cx + (vi - 1) * spacing, z: 0 },
        { x: cx + (vi - 0.5) * spacing, z: -spacing * 1.1 },
      ];
      for (const part of tpl.parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, spots.length);
        spots.forEach((s, i) => {
          const sc = 0.85 + rand() * 0.3;
          q.setFromAxisAngle(up, rand() * Math.PI * 2);
          m.compose(new THREE.Vector3(s.x, -0.15, s.z), q, new THREE.Vector3(sc, sc, sc));
          m.multiply(part.matrix);
          inst.setMatrixAt(i, m);
          tint.setRGB(1, 1, 1).offsetHSL(0, 0, (rand() - 0.5) * 0.08);
          inst.setColorAt(i, tint);
        });
        if (part.depthMaterial) inst.customDepthMaterial = part.depthMaterial;
        if (qs.get('leaves') === '0' && part.material.alphaTest > 0) inst.visible = false;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        scene.add(inst);
      }
    });
    x = cx + spacing * 2.2;
  }
}

const target = new THREE.Vector3();
function applyHash() {
  const hash = location.hash.replace('#', '') || 'oak-mid';
  let [k, view] = hash.split('-');
  if (!view) { view = k; k = 'oak'; }
  const all = k === 'all';
  const c = all
    ? { x: (clusters.get('Tree_Oak')!.x + clusters.get('Bush_Green')!.x) / 2, r: 60, h: 16 }
    : clusters.get(SHORT[k] ?? 'Tree_Oak')!;
  const bush = c.h < 4;
  const dist = view === 'near' ? (bush ? 4 : 12 + c.r * 0.6) : view === 'mid' ? 40 : view === 'far' ? 150 : view === 'vfar' ? 300 : 40;
  const eye = bush ? 1.6 : 1.7;
  target.set(c.x, c.h * (bush ? 0.4 : 0.45), -c.r * 0.5);
  if (view === 'canopy' || view === 'up') {
    camera.position.set(c.x + c.r * 0.25, 1.7, c.r * 0.15);
    target.set(c.x, c.h * 0.75, -c.r * 0.1);
  } else if (view === 'back') {
    camera.position.set(c.x - 10, eye + 1, -c.r * 2.4 - 30);
    target.set(c.x, c.h * 0.5, 0);
  } else if (view === 'top') {
    camera.position.set(c.x + 30, 45, 55);
  } else {
    camera.position.set(c.x, all ? 12 : eye + (view === 'far' ? 3 : 0), dist);
  }
  camera.lookAt(target);
  controls.target.copy(target);
  controls.update();
}
window.addEventListener('hashchange', applyHash);

async function main() {
  const t0 = performance.now();
  await Promise.all([
    env.apply('kloofendal_48d_partly_cloudy_puresky', { envIntensity: Number(qs.get('env') ?? 0.6), sunIntensity: Number(qs.get('sun') ?? 5), playDir: new THREE.Vector2(0, -1), sunOffsetDeg: 150 }),
    buildGround(),
  ]);
  env.setShadowExtent(60);
  const templates = await buildTreeTemplates(wind, { quality });
  const genMs = performance.now() - t0;
  place(templates);
  (window as unknown as Record<string, unknown>).__templates = templates;
  applyHash();
  const stats: Record<string, number[]> = {};
  for (const [k, list] of templates) stats[k] = list.map((t) => t.triangles);
  const dims: Record<string, unknown> = {};
  for (const [k, list] of templates)
    dims[k] = list.map((t) => ({ h: +t.height.toFixed(2), r: +t.radius.toFixed(2), trunkR: +t.trunkR.toFixed(3), crownY: +t.crownY.toFixed(2), crownR: +t.crownR.toFixed(2), crownH: +t.crownH.toFixed(2) }));
  (window as unknown as Record<string, unknown>).__treeStats = { stats, dims, genMs };
  let frames = 0;
  let last = performance.now();
  let fps = 0;
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    wind.uTime.value = freezeT ?? t;
    controls.update();
    env.focus(controls.target);
    renderer.info.reset();
    composer.render();
    frames++;
    const now = performance.now();
    if (now - last > 500) {
      fps = (frames * 1000) / (now - last);
      frames = 0;
      last = now;
      const ri = renderer.info.render;
      info.textContent =
        `q=${quality}  fps ${fps.toFixed(0)}  calls ${ri.calls}  tris ${(ri.triangles / 1e6).toFixed(2)}M  gen ${genMs.toFixed(0)}ms\n` +
        Object.entries(stats).map(([k, v]) => `${k.padEnd(13)} ${v.join(' / ')}`).join('\n');
      (window as unknown as Record<string, unknown>).__ready = true;
    }
  });
}
void main();
