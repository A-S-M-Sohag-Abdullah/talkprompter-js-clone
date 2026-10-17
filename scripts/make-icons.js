// Renders src/web/icons/icon.svg to the PNG sizes the platforms need, by
// drawing it onto an exact-size canvas (immune to display scaling).
// Usage: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
app.setPath('userData', path.join(ROOT, '.cache', 'icon-render'));
const svg = fs.readFileSync(path.join(ROOT, 'src', 'web', 'icons', 'icon.svg'), 'utf8');

// [output, size, maskable (full-bleed background, icon in the safe zone)]
const OUT = [
  ['src/web/icons/icon-192.png', 192, false],
  ['src/web/icons/icon-512.png', 512, false],
  ['src/web/icons/icon-maskable-512.png', 512, true],
  ['build/icon.png', 1024, false],
  ['resources/icon.png', 1024, true] // Capacitor (@capacitor/assets) source
];

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('about:blank');
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  for (const [rel, size, maskable] of OUT) {
    const dataUrl = await w.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(src)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const g = c.getContext('2d');
      if (${maskable}) {
        g.fillStyle = '#0F1115';
        g.fillRect(0, 0, ${size}, ${size});
        const inset = ${size} * 0.14;
        g.drawImage(img, inset, inset, ${size} - 2 * inset, ${size} - 2 * inset);
      } else {
        g.drawImage(img, 0, 0, ${size}, ${size});
      }
      return c.toDataURL('image/png');
    })()`);
    const out = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', rel);
  }
  app.quit();
});
