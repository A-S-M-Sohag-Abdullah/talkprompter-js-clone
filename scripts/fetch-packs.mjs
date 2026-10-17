// Downloads voice packs into web-packs/ so the web build can serve them from
// its own origin (needed for languages without a public CORS mirror).
//   npm run fetch-packs            -> all languages
//   npm run fetch-packs -- nl pl   -> just these
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../src/core/languages.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web-packs');
const wanted = process.argv.slice(2);
// Only single-archive Vosk packs need self-hosting; zipformer packs (Bangla)
// download straight from Hugging Face, which allows CORS.
const VOSK_LANGS = LANGUAGES.filter((l) => l.engine === 'vosk');
const langs = wanted.length ? VOSK_LANGS.filter((l) => wanted.includes(l.code)) : VOSK_LANGS;
fs.mkdirSync(OUT, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const out = fs.createWriteStream(`${dest}.partial`);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(`${dest}.partial`, dest); resolve(); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

for (const lang of langs) {
  const dest = path.join(OUT, lang.file);
  if (fs.existsSync(dest)) { console.log(`✓ ${lang.englishName} (already there)`); continue; }
  process.stdout.write(`↓ ${lang.englishName} (${Math.round(lang.bytes / 1e6)} MB)… `);
  await download(lang.url, dest);
  console.log('done');
}

const index = VOSK_LANGS.filter((l) => fs.existsSync(path.join(OUT, l.file))).map((l) => ({ code: l.code, file: l.file }));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
console.log(`web-packs/index.json lists ${index.length} pack(s). Run "npm run build:web" to include them.`);
