// Billboard impostors for distant trees: every tree template is rendered once into an atlas, then
// drawn as camera-facing cards. The cards use the scene's own lights, fog and shadows through a
// MeshStandardMaterial with a rounded "canopy" normal, so they blend with the real trees.
import * as THREE from 'three';

export interface ImpostorSource {
  key: string;
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[];
}

interface Entry {
  uv: THREE.Vector4; // offset u, offset v, scale u, scale v
  width: number;
  height: number;
  baseY: number;
}

let bakeRenderer: THREE.WebGLRenderer | null = null;
/** The renderer used to bake atlases (set once at startup). */
export function setImpostorRenderer(r: THREE.WebGLRenderer) {
  bakeRenderer = r;
}

export class ImpostorAtlas {
  readonly texture: THREE.Texture;
  private entries = new Map<string, Entry>();
  private rt: THREE.WebGLRenderTarget | null = null;

  constructor(sources: ImpostorSource[], tile = 384) {
    const r = bakeRenderer;
    const cols = Math.max(1, Math.ceil(Math.sqrt(sources.length)));
    const rows = Math.max(1, Math.ceil(sources.length / cols));
    if (!r) {
      this.texture = new THREE.Texture();
      return;
    }
    const rt = new THREE.WebGLRenderTarget(cols * tile, rows * tile, {
      samples: 4,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.rt = rt;
    const scene = new THREE.Scene();
    // mostly flat light (≈ albedo) with a soft key so the canopy keeps some volume
    scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.62));
    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.55);
    key.position.set(0.3, 0.8, 1);
    scene.add(key);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    const prevScissor = r.getScissorTest();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.autoClear = false;
    r.clear(true, true, true);
    r.setScissorTest(true);
    const box = new THREE.Box3();
    sources.forEach((src, i) => {
      const group = new THREE.Group();
      box.makeEmpty();
      for (const p of src.parts) {
        const m = new THREE.Mesh(p.geometry, p.material);
        m.matrixAutoUpdate = false;
        m.matrix.copy(p.matrix);
        group.add(m);
        p.geometry.computeBoundingBox();
        box.union(p.geometry.boundingBox!.clone().applyMatrix4(p.matrix));
      }
      scene.add(group);
      const halfW = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * 1.04;
      const h = box.max.y * 1.03;
      const baseY = Math.min(0, box.min.y);
      // square tiles: fit the larger of width and height, with a 3% margin against mip bleeding
      const span = Math.max(halfW * 2, h - baseY) * 1.06;
      cam.left = -span / 2;
      cam.right = span / 2;
      cam.bottom = baseY - (span - (h - baseY)) * 0.03;
      cam.top = cam.bottom + span;
      cam.position.set(0, 0, 200);
      cam.lookAt(0, 0, 0);
      cam.position.y = 0;
      cam.updateProjectionMatrix();
      const cx = i % cols, cy = Math.floor(i / cols);
      r.setViewport(cx * tile, cy * tile, tile, tile);
      r.setScissor(cx * tile, cy * tile, tile, tile);
      r.render(scene, cam);
      scene.remove(group);
      this.entries.set(src.key, {
        uv: new THREE.Vector4(cx / cols, cy / rows, 1 / cols, 1 / rows),
        width: span,
        height: span,
        baseY: cam.bottom,
      });
    });
    r.setScissorTest(prevScissor);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.autoClear = prevAuto;
    r.setViewport(0, 0, r.domElement.width / r.getPixelRatio(), r.domElement.height / r.getPixelRatio());
    this.texture = rt.texture;
    this.texture.anisotropy = 4;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  dispose() {
    this.rt?.dispose();
  }
}

export interface ImpostorInstance {
  key: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  tint?: THREE.Color;
}

/** One instanced draw of camera-facing tree cards. */
export function buildImpostorMesh(atlas: ImpostorAtlas, list: ImpostorInstance[]): THREE.InstancedMesh | null {
  const items = list.filter((it) => atlas.has(it.key));
  if (items.length === 0) return null;
  const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const size = new Float32Array(items.length * 3);
  const tile = new Float32Array(items.length * 4);
  const mat = new THREE.MeshStandardMaterial({
    map: atlas.texture,
    alphaTest: 0.38,
    alphaToCoverage: true,
    roughness: 0.85,
    metalness: 0,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m = new THREE.Matrix4();
  const white = new THREE.Color(1, 1, 1);
  items.forEach((it, i) => {
    const e = atlas.get(it.key)!;
    size[i * 3] = e.width;
    size[i * 3 + 1] = e.height;
    size[i * 3 + 2] = e.baseY;
    tile[i * 4] = e.uv.x;
    tile[i * 4 + 1] = e.uv.y;
    tile[i * 4 + 2] = e.uv.z;
    tile[i * 4 + 3] = e.uv.w;
    m.makeScale(it.scale, it.scale, it.scale).setPosition(it.x, it.y, it.z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, it.tint ?? white);
  });
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 3));
  geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 4));
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aSize;
         attribute vec4 aTile;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 bbPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
         vec3 bbToCam = cameraPosition - bbPos;
         bbToCam.y = 0.0;
         bbToCam = normalize(bbToCam + vec3(1e-4, 0.0, 0.0));
         vec3 bbRight = vec3(bbToCam.z, 0.0, -bbToCam.x);
         float bbH = (position.y * aSize.y + aSize.z) / max(aSize.y, 1e-3);
         // rounded canopy normal: sideways at the card edges, up near the top, toward the viewer in the middle
         vec3 objectNormal = normalize(bbRight * position.x * 1.5 + vec3(0.0, 1.0, 0.0) * (bbH - 0.45) * 1.3 + bbToCam * 0.75);`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = bbRight * position.x * aSize.x + vec3(0.0, 1.0, 0.0) * (position.y * aSize.y + aSize.z);`,
      )
      .replace('#include <uv_vertex>', `#include <uv_vertex>
         vMapUv = aTile.xy + uv * aTile.zw;`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);');
  };
  mat.customProgramCacheKey = () => 'impostor-v1';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'Impostors';
  return mesh;
}
