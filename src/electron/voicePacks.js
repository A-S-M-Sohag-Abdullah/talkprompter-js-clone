// Downloads Vosk voice packs (.zip, loaded directly by vosk-browser) into the
// app's data folder. Runs in the main process, so there are no CORS limits.

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

  fileName(lang) {
    return `${lang.folder}.zip`;
  }

  filePath(lang) {
    return path.join(this.dir, this.fileName(lang));
  }

  list() {
    return this.languages.map((l) => ({
      code: l.code,
      installed: fs.existsSync(this.filePath(l)),
      downloading: this.active.has(l.code)
    }));
  }

  remove(code) {
    const lang = this.languages.find((l) => l.code === code);
    if (lang) fs.rmSync(this.filePath(lang), { force: true });
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
    const partial = `${this.filePath(lang)}.partial`;
    try {
      await download(lang.url, partial, job, (received, total) =>
        onProgress({ received, total: total || lang.bytes }));
      if (job.cancelled) throw new Error('Cancelled');
      fs.renameSync(partial, this.filePath(lang));
    } finally {
      this.active.delete(code);
      fs.rmSync(partial, { force: true });
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
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastReport = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastReport > 150) {
          lastReport = now;
          onProgress(received, total);
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
