// Copies the few browser runtime files the app needs out of node_modules into
// vendor/ (served at /vendor/ by Electron, copied into the web build).
// onnxruntime-web alone is ~140 MB on disk; the app needs 3 files (~14 MB).
// Runs automatically before start / builds.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'vendor');
const require = createRequire(import.meta.url);
const ortDist = path.join(path.dirname(require.resolve('onnxruntime-web')), '..', 'dist');
const ortDir = fs.existsSync(path.join(ortDist, 'ort.wasm.min.mjs')) ? ortDist : path.dirname(require.resolve('onnxruntime-web'));

const FILES = [
  [require.resolve('vosk-browser/dist/vosk.js'), 'vosk.js'],
  [require.resolve('mammoth/mammoth.browser.min.js'), 'mammoth.browser.min.js'],
  [path.join(ortDir, 'ort.wasm.min.mjs'), 'ort/ort.wasm.min.mjs'],
  [path.join(ortDir, 'ort-wasm-simd-threaded.mjs'), 'ort/ort-wasm-simd-threaded.mjs'],
  [path.join(ortDir, 'ort-wasm-simd-threaded.wasm'), 'ort/ort-wasm-simd-threaded.wasm']
];

for (const [src, rel] of FILES) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stale = !fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs;
  if (stale) fs.copyFileSync(src, dest);
}
console.log('vendor/ ready');
