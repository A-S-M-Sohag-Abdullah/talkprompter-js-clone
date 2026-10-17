// Dev end-to-end test of the real voice pipeline in the desktop app:
// installs the English pack through the app's own downloader, replaces the
// microphone with a recorded WAV (.cache/probe/speech.wav), and checks that
// Vosk + the matcher move the highlight through the script.
// Usage: npx electron scripts/voice-e2e.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const WAV = path.join(__dirname, '..', '.cache', 'probe', 'speech.wav');
const SCRIPT = 'As you read this text aloud, the script scrolls itself to keep pace with your voice. '
  + 'If you stop speaking or wander off script, the scrolling pauses and waits for you. '
  + 'The moment you start reading again, it picks up right where you left off.';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) console.log('[renderer error]', e.message);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    try {
      await wait(1200);
      const wav = fs.readFileSync(WAV).toString('base64');
      // Fake microphone: play the WAV into a MediaStream.
      await js(`
        const bytes = Uint8Array.from(atob(${JSON.stringify(wav)}), (c) => c.charCodeAt(0));
        window.__fakeMic = async () => {
          const ctx = new AudioContext();
          const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
          const src = ctx.createBufferSource(); src.buffer = buf;
          const dest = ctx.createMediaStreamDestination();
          src.connect(dest); setTimeout(() => src.start(), 600);
          return dest.stream;
        };
        navigator.mediaDevices.getUserMedia = () => window.__fakeMic();
      `);
      // Use the test script, no simulation, no countdown.
      await js(`
        if (!document.getElementById('langDialog').hidden) document.getElementById('btnLangClose').click();
        const sim = document.getElementById('chkSim'); if (sim.checked) sim.click();
        const cd = document.getElementById('chkCountdown'); if (cd.checked) cd.click();
        const heard = document.getElementById('chkHeard'); if (!heard.checked) heard.click();
        document.getElementById('btnEdit').click();
        document.getElementById('scriptText').value = ${JSON.stringify(SCRIPT)};
        document.getElementById('btnDone').click();
        document.getElementById('btnReset').click();
      `);
      // Install English through the app's own UI.
      console.log('[e2e] installing English pack via the app…');
      await js(`document.getElementById('btnLanguage').click();`);
      await wait(300);
      const installed = await js(`
        const row = [...document.querySelectorAll('.lang-row')].find((r) => r.textContent.includes('English'));
        const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Download');
        if (!btn) return 'already';
        btn.click(); return 'started';
      `);
      console.log('[e2e] download:', installed);
      for (let i = 0; i < 240; i++) {
        const st = await js(`return document.getElementById('langStatus').textContent`);
        if (/ready|failed/i.test(st) || installed === 'already') { console.log('[e2e]', st || 'pack present'); break; }
        await wait(1000);
      }
      await js(`document.getElementById('btnLangClose').click();`);

      await js(`document.getElementById('btnToggle').click();`);
      const seen = new Set();
      for (let i = 0; i < 30; i++) {
        await wait(1000);
        const s = await js(`return [document.getElementById('statusText').textContent, document.querySelector('#column .w.cur')?.textContent || '-', document.getElementById('heardText').textContent]`);
        const line = s.join(' | ');
        if (!seen.has(line)) { seen.add(line); console.log('[e2e]', line); }
        if (s[1].startsWith('you') && /done|left/.test(s[0]) && i > 12) break;
      }
      fs.writeFileSync(path.join(__dirname, '..', '.cache', 'shots', 'voice-e2e.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.getElementById('btnToggle').click();`);
      console.log('[e2e] final status:', await js(`return document.getElementById('statusText').textContent`));
    } catch (err) {
      console.log('[e2e] ERROR', err);
    }
    app.quit();
  });
});

require('../src/electron/main.js');
