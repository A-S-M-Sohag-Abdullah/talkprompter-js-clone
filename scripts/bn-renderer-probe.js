// Dev probe: inside the real desktop renderer, loads the installed Bangla pack
// with onnxruntime-web and decodes .cache/bn/test.wav directly (no mic).
// Usage: npx electron scripts/bn-renderer-probe.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const wav = fs.readFileSync(path.join(__dirname, '..', '.cache', 'bn', 'test.wav'));
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => console.log(`[renderer ${e.level}]`, e.message));
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const sp = await import('./speech.mjs');
        const { findLanguage } = await import('./core/languages.mjs');
        const lang = findLanguage('bn');
        const urls = Object.fromEntries(lang.files.map((f) => [f.name, 'app://talkprompter/voice-packs/' + lang.folder + '/' + f.name]));
        const t0 = performance.now();
        const model = await sp.loadZipformerModel(lang, urls);
        const loadMs = Math.round(performance.now() - t0);
        const bytes = Uint8Array.from(atob(${JSON.stringify(wav.toString('base64'))}), (c) => c.charCodeAt(0));
        const pcm = new Int16Array(bytes.buffer.slice(44));
        const x = Float32Array.from(pcm, (v) => v / 32768);
        const s = model.createStream();
        const t1 = performance.now();
        for (let i = 0; i < x.length; i += 4096) await s.acceptWaveform(x.subarray(i, i + 4096));
        await s.acceptWaveform(new Float32Array(16000));
        const direct = { loadMs, decodeMs: Math.round(performance.now() - t1), text: s.text };

        // Now the live path: ZipformerEngine fed by a fake microphone.
        navigator.mediaDevices.getUserMedia = async () => {
          const ctx = new AudioContext();
          const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
          const src = ctx.createBufferSource(); src.buffer = buf;
          const dest = ctx.createMediaStreamDestination(); src.connect(dest);
          setTimeout(() => src.start(), 300);
          return dest.stream;
        };
        const eng = new sp.ZipformerEngine({ lang, urls, cache: false });
        const hyps = [];
        let levels = 0;
        eng.onHypothesis = (h) => hyps.push((h.isFinal ? 'FINAL ' : '') + h.text);
        eng.onLevel = (v) => { if (v > 0) levels++; };
        await eng.start();
        await new Promise((r) => setTimeout(r, 10000));
        const debug = { ctxRate: eng.ctx?.sampleRate, ctxState: eng.ctx?.state, levels, pendingFeatures: eng.stream?.features.length, fbankFrames: eng.stream?.fbank.framesDone };
        eng.stop();
        return { direct, live: { hyps: hyps.slice(-3), count: hyps.length, debug } };
      })()`);
      console.log('[probe]', JSON.stringify(result));
    } catch (err) {
      console.log('[probe] ERROR', err.message);
    }
    app.quit();
  });
});
require('../src/electron/main.js');
