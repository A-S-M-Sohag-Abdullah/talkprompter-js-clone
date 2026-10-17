// Dev smoke test: launches the real desktop app, prints renderer console
// errors, drives a short simulated reading session and saves screenshots to
// .cache/shots/. Usage: npx electron scripts/electron-smoke.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SHOTS = path.join(__dirname, '..', '.cache', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event;
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) {
      console.log(`[renderer ${level}] ${message} (${sourceId}:${lineNumber})`);
    }
  });
  win.webContents.once('did-finish-load', async () => {
    // Each snippet runs in its own scope so declarations don't collide.
    const js = (code) => win.webContents.executeJavaScript(`(() => eval(${JSON.stringify(code)}))()`);
    const shot = async (name) => {
      await wait(400);
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      console.log('[smoke] saved', name);
    };
    try {
      await wait(1500);
      // Close the first-run language dialog if it is up, enable simulation.
      await js(`document.getElementById('langDialog').hidden || document.getElementById('btnLangClose').click();
        const sim = document.getElementById('chkSim'); if (!sim.checked) sim.click();
        document.getElementById('chkCountdown').checked && document.getElementById('chkCountdown').click();
        document.getElementById('btnReset').click(); true`);
      await shot('1-ready');
      await js(`document.getElementById('btnToggle').click(); true`);
      await wait(9000);
      console.log('[smoke] status:', await js(`document.getElementById('statusText').textContent`));
      console.log('[smoke] current word:', await js(`document.querySelector('#column .w.cur')?.textContent`));
      await shot('2-tracking');
      await js(`document.getElementById('btnToggle').click(); document.getElementById('btnSettings').click(); true`);
      await shot('3-settings');
      await js(`document.getElementById('btnSettings').click(); document.getElementById('btnLanguage').click(); true`);
      await shot('4-language');
      await js(`document.getElementById('btnLangClose').click(); document.getElementById('btnEdit').click(); true`);
      await shot('5-editor');
      await js(`document.getElementById('btnDone').click(); document.getElementById('selTheme').value='light'; document.getElementById('selTheme').dispatchEvent(new Event('change')); true`);
      await shot('6-light');
      await js(`document.getElementById('selTheme').value='dark'; document.getElementById('selTheme').dispatchEvent(new Event('change'));
        const sim = document.getElementById('chkSim'); if (sim.checked) sim.click();
        const cd = document.getElementById('chkCountdown'); if (!cd.checked) cd.click(); true`);
      win.setSize(400, 820);
      await shot('7-narrow');
    } catch (err) {
      console.log('[smoke] ERROR', err);
    }
    app.quit();
  });
});

require('../src/electron/main.js');
