// Assembles the static web app into dist/web — used by the web/PWA build and
// as Capacitor's webDir for Android/iOS. Layout (same as Electron's app://):
//   dist/web/            <- src/web
//   dist/web/core/       <- src/core
//   dist/web/vendor/     <- vendor/ (browser runtimes, from scripts/vendor.mjs)
//   dist/web/voice-packs <- web-packs/ (optional, from `npm run fetch-packs`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'web');
const withPacks = !process.argv.includes('--no-packs');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'src', 'web'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'src', 'core'), path.join(OUT, 'core'), { recursive: true });
await import('./vendor.mjs');
fs.cpSync(path.join(ROOT, 'vendor'), path.join(OUT, 'vendor'), { recursive: true });

const packsDir = path.join(ROOT, 'web-packs');
if (withPacks && fs.existsSync(path.join(packsDir, 'index.json'))) {
  fs.cpSync(packsDir, path.join(OUT, 'voice-packs'), { recursive: true });
  console.log('Included self-hosted voice packs from web-packs/');
}
console.log(`Web app built in ${path.relative(ROOT, OUT)}`);
