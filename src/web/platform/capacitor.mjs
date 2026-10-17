// Android / iOS via Capacitor. Voice packs are downloaded natively (no CORS)
// into the app's data folder and served to the WebView through Capacitor's
// local file URL (convertFileSrc), which gives vosk-browser a stable URL.

import { readFileObject, pickScriptFile, localSettings, browserWakeLock, noop, noopSubscribe } from './common.mjs';

export async function createCapacitorPlatform() {
  const Cap = window.Capacitor;
  const Filesystem = Cap.registerPlugin('Filesystem');
  const FileTransfer = Cap.registerPlugin('FileTransfer');
  const KeepAwake = Cap.registerPlugin('KeepAwake');
  const platform = Cap.getPlatform(); // 'android' | 'ios'
  const DIR = 'DATA';
  const active = new Map();
  const uris = new Map();

  // Every file a language needs: one .zip (vosk) or several model files (zipformer).
  const packFiles = (lang) => (lang.files
    ? lang.files.map((f) => ({ name: f.name, url: f.url, bytes: f.bytes, path: `voice-packs/${lang.folder}/${f.name}` }))
    : [{ name: lang.file, url: lang.url, bytes: lang.bytes, path: `voice-packs/${lang.file}` }]);

  async function fileUri(path) {
    if (!uris.has(path)) uris.set(path, (await Filesystem.getUri({ directory: DIR, path })).uri);
    return uris.get(path);
  }

  async function fileExists(path) {
    try {
      await Filesystem.stat({ directory: DIR, path });
      return true;
    } catch {
      return false;
    }
  }

  async function exists(lang) {
    for (const f of packFiles(lang)) if (!(await fileExists(f.path))) return false;
    return true;
  }

  const webWakeLock = browserWakeLock();
  let languagesCache = [];

  return {
    kind: platform,
    label: platform === 'ios' ? 'iOS' : 'Android',
    features: {
      topmost: false,
      camera: false,
      fullscreen: false,
      globalShortcut: false,
      fileWatch: false,
      hideFromCapture: false,
      dataFolder: false,
      packDownload: true,
      keepAwake: true
    },
    ...localSettings(),
    async appInfo() { return { platform, version: '' }; },
    // The WebView asks the OS for the microphone on first getUserMedia.
    async requestMic() { return true; },

    openScript: pickScriptFile,
    async readDroppedFile(file) { return { text: await readFileObject(file), name: file.name }; },
    watchScript: noop,
    onScriptFileChanged: noopSubscribe,

    packs: {
      async list(languages) {
        languagesCache = languages;
        return Promise.all(languages.map(async (l) => ({
          code: l.code,
          available: true,
          installed: await exists(l),
          downloading: active.has(l.code)
        })));
      },
      async install(code, onProgress) {
        const lang = languagesCache.find((l) => l.code === code);
        if (!lang) return { ok: false, error: 'Unknown language' };
        const files = packFiles(lang);
        let done = 0;
        let currentUrl = null;
        const listener = await FileTransfer.addListener('progress', (p) => {
          if (p.url === currentUrl) onProgress({ received: done + p.bytes, total: lang.bytes });
        });
        active.set(code, true);
        try {
          for (const f of files) {
            if (!(await fileExists(f.path))) {
              const dir = f.path.slice(0, f.path.lastIndexOf('/'));
              await Filesystem.mkdir({ directory: DIR, path: dir, recursive: true }).catch(noop);
              currentUrl = f.url;
              await FileTransfer.downloadFile({ url: f.url, path: await fileUri(f.path), progress: true });
            }
            done += f.bytes;
          }
          return { ok: true };
        } catch (err) {
          for (const f of files) await Filesystem.deleteFile({ directory: DIR, path: f.path }).catch(noop);
          return { ok: false, error: err?.message || String(err) };
        } finally {
          active.delete(code);
          listener.remove();
        }
      },
      cancel: noop, // native downloads can't be aborted from JS
      async remove(code) {
        const lang = languagesCache.find((l) => l.code === code);
        if (lang) for (const f of packFiles(lang)) await Filesystem.deleteFile({ directory: DIR, path: f.path }).catch(noop);
      },
      async modelUrl(lang) {
        return Cap.convertFileSrc(await fileUri(packFiles(lang)[0].path));
      },
      async fileUrls(lang) {
        const urls = {};
        for (const f of packFiles(lang)) urls[f.name] = Cap.convertFileSrc(await fileUri(f.path));
        return urls;
      },
      cacheFiles: false,
      markLoaded() {}
    },

    setTopmost: noop,
    setFullscreen: async () => false,
    onFullscreenChanged: noopSubscribe,
    setCameraMode: async () => false,
    setTheme: noop,
    async keepAwake(on) {
      try {
        await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep());
      } catch {
        await webWakeLock(on);
      }
    },
    openDataFolder: noop,
    openExternal(url) { window.open(url, '_blank'); },
    onShortcutToggle: noopSubscribe
  };
}
