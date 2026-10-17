// Dev probe: loads a voice pack in vosk-browser inside Electron and feeds a WAV
// file through it, printing what it recognized. Usage:
//   electron scripts/vosk-probe.js <pack file in .cache/probe> [grammar words...]
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const DIR = path.join(__dirname, '..', '.cache', 'probe');
app.setPath('userData', path.join(DIR, 'ud'));
app.setPath('sessionData', path.join(DIR, 'ud'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const pack = process.argv[2] || 'en.zip';
const grammar = process.argv.slice(3);
const page = `<!doctype html><script src="app://p/vosk.js"></script><script>
(async () => {
  const log = (...a) => console.log('[probe]', ...a);
  try {
    const t0 = performance.now();
    const model = await Vosk.createModel('app://p/${pack}');
    log('model loaded in', Math.round(performance.now() - t0), 'ms');
    const ctx = new AudioContext({ sampleRate: 16000 });
    const buf = await ctx.decodeAudioData(await (await fetch('app://p/speech.wav')).arrayBuffer());
    const g = ${JSON.stringify(grammar)};
    const rec = g.length ? new model.KaldiRecognizer(16000, JSON.stringify([...g, '[unk]'])) : new model.KaldiRecognizer(16000);
    let partials = 0;
    rec.on('partialresult', (m) => { if (m.result.partial) partials++; });
    rec.on('result', (m) => log('RESULT:', m.result.text));
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 4096) {
      const chunk = data.subarray(i, i + 4096);
      const ab = ctx.createBuffer(1, chunk.length, 16000); ab.copyToChannel(chunk, 0);
      rec.acceptWaveform(ab);
      await new Promise(r => setTimeout(r, 5));
    }
    rec.retrieveFinalResult();
    await new Promise(r => setTimeout(r, 3000));
    log('partials:', partials, 'DONE');
  } catch (e) { log('ERROR', String(e)); }
})();
</script>`;
app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname).slice(1);
    if (name === '' || name === 'index.html') return new Response(page, { headers: { 'content-type': 'text/html' } });
    if (name === 'vosk.js') return net.fetch(pathToFileURL(require.resolve('vosk-browser/dist/vosk.js')).toString());
    return net.fetch(pathToFileURL(path.join(DIR, name)).toString());
  });
  const w = new BrowserWindow({ show: false });
  w.webContents.on('console-message', (_e, _l, msg) => {
    if (msg.startsWith('[probe]')) { console.log(msg); if (/DONE|ERROR/.test(msg)) setTimeout(() => app.quit(), 200); }
  });
  w.loadURL('app://p/index.html');
  setTimeout(() => { console.log('[probe] TIMEOUT'); app.quit(); }, 180000);
});
