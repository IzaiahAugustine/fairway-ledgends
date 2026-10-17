// Shrinks the built game's models for download: run on a build's output folder after `vite build`.
//   node blender/pack_models.mjs dist
// Textures inside every .glb are re-encoded as WebP and the geometry is Meshopt-compressed
// (three.js decodes both; see src/core/assets.ts). Vertex positions stay exact floats: some code
// uses a mesh's geometry without its node (the crowd's instanced spectators), and quantising
// positions moves part of the shape into the node's transform.
// The source models in public/ stay as Blender exports them.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { quantize, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const root = process.argv[2];
if (!root) throw new Error('usage: node blender/pack_models.mjs <build folder>');

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.ERROR))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.glb')) files.push(p);
  }
};
walk(root);

let before = 0, after = 0;
for (const f of files) {
  const size = statSync(f).size;
  const doc = await io.read(f);
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 88 }),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    // everything but positions (and morph target positions) is quantised
    quantize({ pattern: /^(?!POSITION)/, patternTargets: /^(?!POSITION)/ }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(f, doc);
  before += size;
  after += statSync(f).size;
}
console.log(`packed ${files.length} models: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
