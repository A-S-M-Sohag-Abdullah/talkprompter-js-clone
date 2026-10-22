// Desktop shell (Windows / macOS / Linux). Serves the shared web app from
// app://talkprompter/ and adds what a browser can't: native voice-pack
// downloads, Word-file sync, camera strip, always-on-top, a global hotkey and
// hiding the window from screen recordings.

const {
  app, BrowserWindow, ipcMain, dialog, protocol, net, screen, shell,
  globalShortcut, systemPreferences, nativeTheme, session
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { SettingsStore } = require('./settingsStore');
const { VoicePacks } = require('./voicePacks');

const ROOT = path.join(__dirname, '..', '..');
const isMac = process.platform === 'darwin';

// While developing (not packaged), keep ALL app data — settings, voice packs,
// Chromium caches, IndexedDB, temp files — inside the project folder rather
// than the system drive. A packaged app uses the normal per-user location.
// Where a packaged app keeps its data instead of the per-user folder:
//  1. TALKPROMPTER_DATA_DIR, if set, or
//  2. a "data" folder next to the app (portable mode — create the folder to
//     opt in, e.g. to keep everything off the system drive). The portable
//     .exe runs from a temp copy, so "next to the app" means next to the .exe.
function customDataDir() {
  if (process.env.TALKPROMPTER_DATA_DIR) return path.resolve(process.env.TALKPROMPTER_DATA_DIR);
  if (!app.isPackaged) return null;
  const appDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const dir = path.join(appDir, 'data');
  return fs.existsSync(dir) ? dir : null;
}

const dataDir = customDataDir();
if (dataDir) {
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
  app.setPath('userData', dataDir);
  app.setPath('sessionData', dataDir);
  app.setPath('crashDumps', path.join(dataDir, 'crashes'));
  app.setPath('temp', path.join(dataDir, 'tmp'));
} else if (!app.isPackaged) {
  const devData = path.join(ROOT, '.userdata');
  fs.mkdirSync(devData, { recursive: true });
  fs.mkdirSync(path.join(ROOT, '.cache', 'tmp'), { recursive: true });
  app.setPath('userData', devData);
  app.setPath('sessionData', devData);
  app.setPath('crashDumps', path.join(devData, 'crashes'));
  app.setPath('temp', path.join(ROOT, '.cache', 'tmp'));
}

const USER_DATA = app.getPath('userData');
const PACKS_DIR = path.join(USER_DATA, 'voice-packs');

// A stable, secure origin for the app (IndexedDB, workers, fetch of packs).
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8'
};

let settings;
let packs;
let win;
let fileWatcher = null;
let cameraRestore = null;

// app://talkprompter/ mirrors the layout of the web build (scripts/build-web.mjs):
//   /           -> src/web        /core/         -> src/core
//   /vendor/    -> vendor/        /voice-packs/  -> downloaded packs
function resolveAppUrl(url) {
  const p = decodeURIComponent(new URL(url).pathname);
  const mounts = [
    ['/voice-packs/', PACKS_DIR],
    ['/vendor/', path.join(ROOT, 'vendor')],
    ['/core/', path.join(ROOT, 'src', 'core')],
    ['/', path.join(ROOT, 'src', 'web')]
  ];
  const [prefix, base] = mounts.find(([m]) => p.startsWith(m));
  const file = path.normalize(path.join(base, p.slice(prefix.length) || 'index.html'));
  return file.startsWith(base + path.sep) ? file : null;
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const file = resolveAppUrl(request.url);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers();
    headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    headers.set('Content-Length', String(fs.statSync(file).size));
    return new Response(res.body, { status: 200, headers });
  });
}

function createWindow() {
  const saved = settings.get('windowBounds');
  win = new BrowserWindow({
    width: saved?.width ?? 1180,
    height: saved?.height ?? 780,
    x: saved?.x,
    y: saved?.y,
    minWidth: 360,
    minHeight: 240,
    title: 'TalkPrompter',
    backgroundColor: '#0F1115',
    icon: path.join(ROOT, 'src', 'web', 'icons', 'icon-512.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  if (settings.get('topmost')) win.setAlwaysOnTop(true, isMac ? 'floating' : 'normal');
  win.setContentProtection(!!settings.get('hideFromCapture'));
  if (!isMac) win.removeMenu();

  win.loadURL('app://talkprompter/index.html');

  const saveBounds = () => {
    if (!win || win.isFullScreen() || cameraRestore) return;
    settings.set({ windowBounds: win.getNormalBounds() });
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', saveBounds);
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen-changed', false));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Only microphone access is ever granted to the page.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const accel = settings.get('globalShortcut');
  if (!accel) return { ok: true };
  try {
    const ok = globalShortcut.register(accel, () => win?.webContents.send('shortcut:toggle'));
    return ok ? { ok } : { ok, error: 'Shortcut is taken by another app' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function readScriptFile(filePath) {
  if (path.extname(filePath).toLowerCase() === '.docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

function watchFile(filePath) {
  fileWatcher?.close();
  fileWatcher = null;
  if (!filePath || !fs.existsSync(filePath)) return;
  let timer = null;
  // Watch the folder: Word saves by replacing the file, which breaks a plain file watch.
  fileWatcher = fs.watch(path.dirname(filePath), (_evt, name) => {
    if (name && name !== path.basename(filePath)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        if (!fs.existsSync(filePath)) return;
        const text = await readScriptFile(filePath);
        win?.webContents.send('script:file-changed', { filePath, text });
      } catch {
        // The file may be mid-save; the next event retries.
      }
    }, 400);
  });
}

function setupIpc() {
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    settings.set(patch);
    if ('hideFromCapture' in patch) win?.setContentProtection(!!patch.hideFromCapture);
    if ('globalShortcut' in patch) return registerShortcut();
    return { ok: true };
  });

  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));

  ipcMain.handle('mic:request', async () => {
    if (!isMac) return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });

  ipcMain.handle('script:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Scripts', extensions: ['docx', 'txt', 'md'] }]
    });
    if (canceled || !filePaths[0]) return null;
    return { filePath: filePaths[0], text: await readScriptFile(filePaths[0]) };
  });
  ipcMain.handle('script:read', async (_e, filePath) => ({ filePath, text: await readScriptFile(filePath) }));
  ipcMain.handle('script:watch', (_e, filePath) => watchFile(filePath));

  ipcMain.handle('packs:list', () => packs.list());
  ipcMain.handle('packs:cancel', (_e, code) => packs.cancel(code));
  ipcMain.handle('packs:remove', async (_e, code) => {
    packs.remove(code);
    // Drop the extracted copy vosk-browser keeps in IndexedDB.
    await session.defaultSession.clearStorageData({ storages: ['indexdb'] });
  });
  ipcMain.handle('packs:install', async (e, code) => {
    try {
      await packs.install(code, (p) => e.sender.send('packs:progress', { code, ...p }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('window:topmost', (_e, on) => {
    win.setAlwaysOnTop(!!on, isMac ? 'floating' : 'normal');
    settings.set({ topmost: !!on });
  });
  ipcMain.handle('window:fullscreen', (_e, on) => {
    const next = on ?? !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  });
  ipcMain.handle('window:camera', (_e, on) => {
    if (on && !cameraRestore) {
      if (win.isFullScreen()) win.setFullScreen(false);
      cameraRestore = { bounds: win.getNormalBounds(), topmost: win.isAlwaysOnTop() };
      // Target the display the window is on — the webcam sits above *that* screen.
      const work = screen.getDisplayMatching(win.getBounds()).workArea;
      // A short strip: the eyes stay within a few centimetres of the lens.
      const width = Math.min(620, work.width);
      const height = Math.max(240, Math.round(work.height * 0.4));
      win.setBounds({ x: Math.round(work.x + (work.width - width) / 2), y: work.y, width, height });
      win.setAlwaysOnTop(true, isMac ? 'screen-saver' : 'normal');
      if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      return true;
    }
    if (!on && cameraRestore) {
      win.setBounds(cameraRestore.bounds);
      win.setAlwaysOnTop(cameraRestore.topmost, isMac ? 'floating' : 'normal');
      if (isMac) win.setVisibleOnAllWorkspaces(false);
      cameraRestore = null;
    }
    return false;
  });

  ipcMain.handle('window:buttons', (_e, visible) => {
    if (isMac) win.setWindowButtonVisibility(!!visible);
  });

  ipcMain.handle('theme:set', (_e, mode) => {
    nativeTheme.themeSource = mode === 'auto' ? 'system' : mode;
  });
  ipcMain.handle('shell:openDataFolder', () => shell.openPath(USER_DATA));
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(async () => {
  settings = new SettingsStore(USER_DATA);
  const { LANGUAGES } = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'languages.mjs')).toString());
  packs = new VoicePacks(PACKS_DIR, LANGUAGES);
  const theme = settings.get('theme');
  nativeTheme.themeSource = theme === 'auto' ? 'system' : theme;

  registerAppProtocol();
  setupIpc();
  createWindow();
  registerShortcut();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
