// Assembles the static web app into dist/web — used by the web/PWA build and
// as Capacitor's webDir for Android/iOS. Layout (same as Electron's app://):
//   dist/web/            <- src/web
//   dist/web/core/       <- src/core
//   dist/web/vendor/     <- vosk-browser, mammoth (browser builds)
//   dist/web/voice-packs <- web-packs/ (optional, from `npm run fetch-packs`)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'web');
const require = createRequire(import.meta.url);
const withPacks = !process.argv.includes('--no-packs');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'src', 'web'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'src', 'core'), path.join(OUT, 'core'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.copyFileSync(require.resolve('vosk-browser/dist/vosk.js'), path.join(OUT, 'vendor', 'vosk.js'));
fs.copyFileSync(require.resolve('mammoth/mammoth.browser.min.js'), path.join(OUT, 'vendor', 'mammoth.browser.min.js'));

const packsDir = path.join(ROOT, 'web-packs');
if (withPacks && fs.existsSync(path.join(packsDir, 'index.json'))) {
  fs.cpSync(packsDir, path.join(OUT, 'voice-packs'), { recursive: true });
  console.log('Included self-hosted voice packs from web-packs/');
}
console.log(`Web app built in ${path.relative(ROOT, OUT)}`);
