// Persists the web app's settings object as one JSON file in userData,
// written atomically (temp file + rename). The defaults the UI relies on live
// in src/web/defaults.mjs; only what the main process itself needs is here.

const fs = require('fs');
const path = require('path');

const MAIN_DEFAULTS = {
  topmost: false,
  hideFromCapture: false,
  theme: 'dark',
  globalShortcut: process.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Alt+Space',
  windowBounds: null
};

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...MAIN_DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // First run or unreadable file: start from defaults.
    }
  }

  get(key) {
    return key ? this.data[key] : { ...this.data };
  }

  set(patch) {
    Object.assign(this.data, patch);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save settings:', err);
    }
  }
}

module.exports = { SettingsStore };
