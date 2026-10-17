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

  const packPath = (lang) => `voice-packs/${lang.file}`;

  async function fileUri(lang) {
    if (!uris.has(lang.code)) {
      const { uri } = await Filesystem.getUri({ directory: DIR, path: packPath(lang) });
      uris.set(lang.code, uri);
    }
    return uris.get(lang.code);
  }

  async function exists(lang) {
    try {
      await Filesystem.stat({ directory: DIR, path: packPath(lang) });
      return true;
    } catch {
      return false;
    }
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
        await Filesystem.mkdir({ directory: DIR, path: 'voice-packs', recursive: true }).catch(noop);
        const path = await fileUri(lang);
        const listener = await FileTransfer.addListener('progress', (p) => {
          if (p.url === lang.url) onProgress({ received: p.bytes, total: p.contentLength || lang.bytes });
        });
        active.set(code, true);
        try {
          await FileTransfer.downloadFile({ url: lang.url, path, progress: true });
          return { ok: true };
        } catch (err) {
          await Filesystem.deleteFile({ directory: DIR, path: packPath(lang) }).catch(noop);
          return { ok: false, error: err?.message || String(err) };
        } finally {
          active.delete(code);
          listener.remove();
        }
      },
      cancel: noop, // native downloads can't be aborted from JS
      async remove(code) {
        const lang = languagesCache.find((l) => l.code === code);
        if (lang) await Filesystem.deleteFile({ directory: DIR, path: packPath(lang) }).catch(noop);
      },
      async modelUrl(lang) {
        return Cap.convertFileSrc(await fileUri(lang));
      },
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
