// Trees and bushes (procedural, from treeGen.ts) plus rocks and benches from the Blender-built
// environment.glb, all instanced; card impostors fill the band of woodland around the hole.
import * as THREE from 'three';
import { loadGLTF, loadTexture } from '../core/assets';
import { Rng } from '../core/rng';
import { COURSES } from '../data/courses';
import type { TreeCollider } from '../physics/ballPhysics';
import { HoleField, Surf, type TreeSpot } from './holeGen';
import { ImpostorAtlas, buildImpostorMesh, type ImpostorInstance, type ImpostorSource } from './impostors';
import type { OuterWorld } from './outerWorld';
import { terrainTime } from './terrain';
import { buildTreeTemplates } from './treeGen';

type Quality = 'low' | 'medium' | 'high';

interface Template {
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4; depthMaterial?: THREE.Material; leaf?: boolean }[];
  height: number;
  radius: number;
  /** Ball-collision shape at scale 1 (trees only). */
  dims?: { trunkR: number; crownY: number; crownR: number; crownH: number };
}

const windUniforms = { uTime: terrainTime, uWind: { value: new THREE.Vector2(1, 0) } };
export function setVegetationWind(x: number, z: number) {
  const l = Math.hypot(x, z);
  windUniforms.uWind.value.set(x, z).multiplyScalar(Math.min(1.5, 0.25 + l / 6) / (l || 1));
}

const templateCache = new Map<Quality, Promise<Map<string, Template[]>>>();
const atlasCache = new Map<Quality, Promise<ImpostorAtlas>>();

/** Tree and bush templates (several variants per kind), built once per quality level. */
function getTemplates(quality: Quality): Promise<Map<string, Template[]>> {
  let p = templateCache.get(quality);
  if (!p) {
    p = loadTemplates(quality);
    templateCache.set(quality, p);
  }
  return p;
}

function getAtlas(quality: Quality): Promise<ImpostorAtlas> {
  let p = atlasCache.get(quality);
  if (!p) {
    p = getTemplates(quality).then((tpls) => {
      const sources: ImpostorSource[] = [];
      const tints = new Set(COURSES.flatMap((c) => c.foliage ?? []));
      for (const [kind, list] of tpls) {
        if (!/^(Tree_|Bush_)/.test(kind)) continue;
        list.forEach((t, i) => {
          sources.push({ key: `${kind}#${i}`, parts: t.parts });
          // autumn versions of the broadleaf trees
          if (kind === 'Tree_Pine' || !t.parts.some((p) => p.leaf)) return;
          for (const tint of tints)
            sources.push({ key: `${kind}#${i}@${tint}`, parts: t.parts.map((p) => (p.leaf ? { ...p, material: autumnLeaf(p.material as THREE.MeshStandardMaterial, tint) } : p)) });
        });
      }
      return new ImpostorAtlas(sources);
    });
    atlasCache.set(quality, p);
  }
  return p;
}

async function loadTemplates(quality: Quality): Promise<Map<string, Template[]>> {
  const out = new Map<string, Template[]>();
  const trees = await buildTreeTemplates(windUniforms, { quality });
  for (const [kind, list] of trees) {
    out.set(
      kind,
      list.map((t) => ({ parts: t.parts, height: t.height, radius: t.radius, dims: kind.startsWith('Tree_') ? { trunkR: t.trunkR, crownY: t.crownY, crownR: t.crownR, crownH: t.crownH } : undefined })),
    );
  }
  // rocks, benches, palms and cacti come from the Blender props
  const gltf = await loadGLTF('models/environment.glb');
  if (!gltf) return out;
  const rockTex = await loadTexture('rock_face_03_diff_1k.jpg').catch(() => null);
  const rockNrm = await loadTexture('rock_face_03_nor_gl_1k.jpg', false).catch(() => null);
  const matCache = new Map<THREE.Material, THREE.Material>();
  const fix = (m: THREE.Material): THREE.Material => {
    const c = matCache.get(m);
    if (c) return c;
    const rm = (m as THREE.MeshStandardMaterial).clone();
    if (m.name.startsWith('Rock') && rockTex) {
      rm.map = rockTex.tex;
      if (rockNrm) rm.normalMap = rockNrm.tex;
      rm.color.setRGB(0.12 / Math.max(0.05, rockTex.avg.r), 0.105 / Math.max(0.05, rockTex.avg.g), 0.09 / Math.max(0.05, rockTex.avg.b));
      rm.roughness = 0.9;
    }
    matCache.set(m, rm);
    return rm;
  };
  for (const root of gltf.scene.children) {
    const name = root.name;
    if (!/^(Rock_|Bench|Tree_Palm_|Tree_Saguaro_|Bush_Barrel_)/.test(name)) continue;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const parts: Template['parts'] = [];
    const box = new THREE.Box3();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const local = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      // split multi-material meshes into groups
      if (mats.length > 1 && mesh.geometry.groups.length > 0) {
        for (const g of mesh.geometry.groups) {
          const sub = mesh.geometry.clone();
          sub.clearGroups();
          sub.setDrawRange(g.start, g.count);
          parts.push({ geometry: sub, material: fix(mats[g.materialIndex ?? 0]), matrix: local });
        }
      } else {
        parts.push({ geometry: mesh.geometry, material: fix(mats[0]), matrix: local });
      }
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(local));
    });
    const height = box.max.y;
    const radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
    // variants (Tree_Palm_A, _B, ...) group into one kind
    const kind = /^(Tree_|Bush_)/.test(name) ? name.replace(/_[A-Z]$/, '') : name;
    const dims = kind === 'Tree_Palm'
      ? { trunkR: 0.22, crownY: height - 1.6, crownR: radius * 0.8, crownH: 1.6 }
      : kind === 'Tree_Saguaro'
        ? { trunkR: 0.34, crownY: height * 0.6, crownR: 0.9, crownH: height * 0.4 }
        : undefined;
    const list = out.get(kind) ?? [];
    list.push({ parts, height, radius, dims });
    out.set(kind, list);
  }
  return out;
}

const autumnCache = new Map<string, THREE.Material>();
/** A leaf material tinted to an autumn colour (shares the original's shader). */
function autumnLeaf(m: THREE.MeshStandardMaterial, tint: number): THREE.Material {
  const key = `${m.uuid}|${tint}`;
  let c = autumnCache.get(key);
  if (!c) {
    const mm = m.clone();
    const base = m.onBeforeCompile;
    const baseKey = m.customProgramCacheKey();
    const uAutumn = { value: new THREE.Color(tint) };
    // the photo leaves are green: keep their light and shade, swap the hue for the autumn colour
    mm.onBeforeCompile = (shader, r) => {
      base.call(m, shader, r);
      shader.uniforms.uAutumn = uAutumn;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uAutumn;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = dot(diffuseColor.rgb, vec3(0.35, 0.55, 0.1)) * uAutumn * 1.9;');
    };
    mm.customProgramCacheKey = () => `${baseKey}-autumn`;
    c = mm;
    autumnCache.set(key, c);
  }
  return c;
}

function fallbackTemplate(kind: string): Template {
  const tall = kind === 'Tree_Pine' ? 16 : kind === 'Tree_Cypress' ? 8 : kind.startsWith('Bush') ? 1.5 : 12;
  const trunk = new THREE.CylinderGeometry(0.18, 0.35, tall * 0.6, 7);
  trunk.translate(0, tall * 0.3, 0);
  const crown = kind === 'Tree_Pine' ? new THREE.ConeGeometry(tall * 0.22, tall * 0.65, 9) : new THREE.IcosahedronGeometry(tall * 0.32, 1);
  crown.translate(0, tall * (kind === 'Tree_Pine' ? 0.62 : 0.62), 0);
  const parts: Template['parts'] = [];
  if (!kind.startsWith('Bush')) parts.push({ geometry: trunk, material: new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 }), matrix: new THREE.Matrix4() });
  else crown.translate(0, -tall * 0.4, 0);
  parts.push({ geometry: crown, material: new THREE.MeshStandardMaterial({ color: kind === 'Bush_Gorse' ? 0x4a5a22 : 0x2f4a22, roughness: 0.9, flatShading: true }), matrix: new THREE.Matrix4() });
  return { parts, height: tall, radius: tall * 0.3 };
}

/** One kind's instances, drawn only where the camera can see them (or their shadows). */
interface CullSet {
  /** Bounding sphere per instance: x, y, z, radius. */
  spheres: Float32Array;
  meshes: { inst: THREE.InstancedMesh; all: Float32Array }[];
  shown: Int32Array;
  nShown: number;
}

export class Vegetation {
  readonly group = new THREE.Group();
  colliders: TreeCollider[] = [];
  private cullSets: CullSet[] = [];
  private frustum = new THREE.Frustum();
  private viewProj = new THREE.Matrix4();
  private sphere = new THREE.Sphere();

  async build(field: HoleField, quality: Quality, outer?: OuterWorld) {
    const templates = await getTemplates(quality);
    const spots = new Map<string, TreeSpot[]>();
    const variantOf = (s: { x: number; z: number }, n: number) => (n <= 1 ? 0 : Math.abs(Math.floor(s.x * 13.37 + s.z * 7.91)) % n);
    for (const s of [...field.trees, ...field.bushes, ...Vegetation.extraSpots(field)]) {
      const nv = templates.get(s.kind)?.length ?? 1;
      const key = `${s.kind}#${variantOf(s, nv)}`;
      if (!spots.has(key)) spots.set(key, []);
      spots.get(key)!.push(s);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    // autumn: each variant of the broadleaf trees takes one of the course's leaf colours
    const foliage = field.course.foliage;
    for (const [key, list] of spots) {
      const [kind, vs] = key.split('#');
      const tpl = templates.get(kind)?.[Number(vs)] ?? fallbackTemplate(kind);
      const tint = foliage && kind !== 'Tree_Pine' && kind.startsWith('Tree_') ? foliage[Number(vs) % foliage.length] : null;
      // bounding spheres padded by about two tree heights, so a tree just out of view still casts
      // its shadow into it
      const spheres = new Float32Array(list.length * 4);
      list.forEach((s, i) => {
        const h = tpl.height * s.scale;
        spheres.set([s.x, field.heightAt(s.x, s.z) + h * 0.5, s.z, Math.max(h * 0.5, tpl.radius * s.scale) + h * 2], i * 4);
      });
      const set: CullSet = { spheres, meshes: [], shown: new Int32Array(list.length).fill(-1), nShown: -1 };
      this.cullSets.push(set);
      for (const part of tpl.parts) {
        const material = part.leaf && tint !== null ? autumnLeaf(part.material as THREE.MeshStandardMaterial, tint) : part.material;
        const inst = new THREE.InstancedMesh(part.geometry, material, list.length);
        list.forEach((s, i) => {
          const prop = kind === 'Bench';
          const y = field.heightAt(s.x, s.z) - (prop ? 0 : kind.startsWith('Rock') ? 0.25 * s.scale : 0.15);
          q.setFromAxisAngle(up, s.rot);
          m.compose(new THREE.Vector3(s.x, y, s.z), q, new THREE.Vector3(s.scale, s.scale * (prop ? 1 : 0.92 + ((i * 37) % 17) / 100), s.scale));
          m.multiply(part.matrix);
          inst.setMatrixAt(i, m);
        });
        if (part.depthMaterial) inst.customDepthMaterial = part.depthMaterial;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        inst.frustumCulled = true;
        set.meshes.push({ inst, all: (inst.instanceMatrix.array as Float32Array).slice() });
        this.group.add(inst);
      }
      const dims = (tpl as Template).dims;
      if (dims) {
        for (const s of list) {
          const base = field.heightAt(s.x, s.z);
          this.colliders.push({ x: s.x, z: s.z, base, trunkR: dims.trunkR * s.scale, crownY: base + dims.crownY * s.scale, crownR: dims.crownR * s.scale, crownH: dims.crownH * s.scale });
        }
      }
    }
    this.buildObStakes(field);
    if (outer) await this.buildImpostors(outer, templates, quality, field.course.foliage);
  }

  /**
   * Draw only the instances whose (shadow-padded) bounds are in view: on a typical hole most of
   * the trees are behind or beside the camera, and each costs its full mesh in the main and shadow
   * passes. Matrices are only re-uploaded when the visible set changes.
   */
  cull(camera: THREE.Camera) {
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    const sp = this.sphere;
    for (const set of this.cullSets) {
      const S = set.spheres;
      let k = 0, same = true;
      for (let i = 0, n = S.length / 4; i < n; i++) {
        sp.center.set(S[i * 4], S[i * 4 + 1], S[i * 4 + 2]);
        sp.radius = S[i * 4 + 3];
        if (!this.frustum.intersectsSphere(sp)) continue;
        if (set.shown[k] !== i) {
          set.shown[k] = i;
          same = false;
        }
        k++;
      }
      if (same && k === set.nShown) continue;
      set.nShown = k;
      for (const m of set.meshes) {
        const dst = m.inst.instanceMatrix.array as Float32Array;
        for (let j = 0; j < k; j++) {
          const i = set.shown[j];
          dst.set(m.all.subarray(i * 16, i * 16 + 16), j * 16);
        }
        m.inst.count = k;
        m.inst.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Card trees in the band around the hole. */
  private async buildImpostors(outer: OuterWorld, templates: Map<string, Template[]>, quality: Quality, foliage?: number[]) {
    const atlas = await getAtlas(quality);
    const tint = new THREE.Color();
    const list: ImpostorInstance[] = outer.impostorSpots().map((s, i) => {
      const nv = templates.get(s.kind)?.length ?? 1;
      const v = (i * 2654435761) % nv;
      const k = 0.98 + ((i * 40503) % 100) / 100 * 0.3;
      const autumn = foliage && atlas.has(`${s.kind}#${v}@${foliage[v % foliage.length]}`) ? `@${foliage[v % foliage.length]}` : '';
      return { key: `${s.kind}#${v}${autumn}`, x: s.x, y: s.y, z: s.z, scale: s.scale, tint: tint.setRGB(k, k * (0.97 + ((i * 7) % 10) / 160), k * 0.95).clone() };
    });
    const mesh = buildImpostorMesh(atlas, list);
    if (mesh) {
      mesh.userData.owned = true;
      this.group.add(mesh);
    }
  }

  /** Coastal boulders below the cliffs and a bench beside the tee. */
  static extraSpots(field: HoleField): TreeSpot[] {
    const out: TreeSpot[] = [];
    const rng = new Rng(field.index * 4099 + 5);
    if (field.hasOcean) {
      const sea = field.seaLevel;
      for (let n = 0; n < 9000 && out.length < 140; n++) {
        const x = field.minX + rng.next() * (field.nx - 1) * 0.5;
        const z = field.minZ + rng.next() * (field.nz - 1) * 0.5;
        const h = field.heightAt(x, z);
        if (h < sea - 1.0 || h > sea + 2.5) continue;
        const gr = field.gradAt(x, z);
        if (Math.hypot(gr.x, gr.z) > 0.45) continue;
        out.push({ x, z, kind: rng.chance(0.6) ? 'Rock_A' : 'Rock_B', scale: rng.range(0.8, 3.2), rot: rng.range(0, Math.PI * 2) });
      }
    }
    const t = field.tee, d = field.teeDir;
    const r = { x: -d.z, z: d.x };
    const side = rng.chance(0.5) ? 1 : -1;
    const bx = t.x + r.x * 8.5 * side - d.x * 5, bz = t.z + r.z * 8.5 * side - d.z * 5;
    if (field.surfAt(bx, bz) !== Surf.Water) out.push({ x: bx, z: bz, kind: 'Bench', scale: 1, rot: Math.atan2(-r.x * side, -r.z * side) });
    return out;
  }

  private buildObStakes(field: HoleField) {
    if (field.obStakes.length === 0) return;
    const g = new THREE.CylinderGeometry(0.035, 0.035, 1.0, 6);
    g.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
    const inst = new THREE.InstancedMesh(g, mat, field.obStakes.length);
    const m = new THREE.Matrix4();
    field.obStakes.forEach((p, i) => {
      m.makeTranslation(p.x, field.heightAt(p.x, p.z) - 0.05, p.z);
      inst.setMatrixAt(i, m);
    });
    inst.castShadow = true;
    this.group.add(inst);
  }

  dispose() {
    this.group.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh) return;
      im.dispose();
      if (im.userData.owned) {
        im.geometry.dispose();
        (im.material as THREE.Material).dispose();
      }
    });
    this.group.clear();
    this.colliders = [];
    this.cullSets = [];
  }
}
