// Downloads voice packs into the app's data folder. Runs in the main process,
// so there are no CORS limits.
//   vosk packs:      voice-packs/<folder>.zip           (one archive)
//   zipformer packs: voice-packs/<folder>/<file>...     (several model files)

const fs = require('fs');
const path = require('path');
const https = require('https');

class VoicePacks {
  constructor(rootDir, languages) {
    this.dir = rootDir;
    this.languages = languages;
    this.active = new Map(); // code -> { cancelled, request }
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** [{ url, dest, bytes }] for every file a language needs. */
  filesFor(lang) {
    if (lang.files) {
      return lang.files.map((f) => ({ url: f.url, dest: path.join(this.dir, lang.folder, f.name), bytes: f.bytes }));
    }
    return [{ url: lang.url, dest: path.join(this.dir, lang.file), bytes: lang.bytes }];
  }

  isInstalled(lang) {
    return this.filesFor(lang).every((f) => fs.existsSync(f.dest));
  }

  list() {
    return this.languages.map((l) => ({
      code: l.code,
      installed: this.isInstalled(l),
      downloading: this.active.has(l.code)
    }));
  }

  remove(code) {
    const lang = this.languages.find((l) => l.code === code);
    if (!lang) return;
    for (const f of this.filesFor(lang)) fs.rmSync(f.dest, { force: true });
    if (lang.files) fs.rmSync(path.join(this.dir, lang.folder), { recursive: true, force: true });
  }

  cancel(code) {
    const job = this.active.get(code);
    if (job) {
      job.cancelled = true;
      job.request?.destroy(new Error('Cancelled'));
    }
  }

  async install(code, onProgress) {
    const lang = this.languages.find((l) => l.code === code);
    if (!lang) throw new Error(`Unknown language ${code}`);
    if (this.active.has(code)) throw new Error('Already downloading');

    const job = { cancelled: false, request: null };
    this.active.set(code, job);
    const files = this.filesFor(lang);
    const total = files.reduce((s, f) => s + f.bytes, 0);
    let done = 0;
    try {
      for (const f of files) {
        if (fs.existsSync(f.dest)) {
          done += f.bytes;
          continue;
        }
        fs.mkdirSync(path.dirname(f.dest), { recursive: true });
        const partial = `${f.dest}.partial`;
        try {
          await download(f.url, partial, job, (received) => onProgress({ received: done + received, total }));
          if (job.cancelled) throw new Error('Cancelled');
          fs.renameSync(partial, f.dest);
        } finally {
          fs.rmSync(partial, { force: true });
        }
        done += f.bytes;
      }
    } finally {
      this.active.delete(code);
    }
  }
}

function download(url, dest, job, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, job, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (HTTP ${res.statusCode})`));
      }
      let received = 0;
      let lastReport = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastReport > 150) {
          lastReport = now;
          onProgress(received);
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    job.request = req;
    req.on('error', reject);
  });
}

module.exports = { VoicePacks };
